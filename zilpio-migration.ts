import { Database } from 'bun:sqlite';
import { copyFileSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ensureSafeDirectory } from './thread-ownership.js';

const migration = 'el-to-zilpio-v1';
const trees = ['sessions', 'archived_sessions', 'shell_snapshots'];
const indexes = ['history.jsonl', 'session_index.jsonl'];
const databaseName = /^(state|thread_history|goals|memories|queue)_\d+\.sqlite$/;
const bookkeeping = new Set(['backfill_state', 'consolidation_progress', 'rollout_migration_state', 'rollout_migration_skipped_rollouts']);
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
function present(path: string) { try { lstatSync(path); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; } }
function regular(path: string) { const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe migration file: ${path}`); }
function readJson(path: string, fallback: any) { if (!present(path)) return fallback; regular(path); return JSON.parse(readFileSync(path, 'utf8')); }
function atomic(path: string, data: string | Uint8Array) {
  ensureSafeDirectory(dirname(path)); if (present(path)) regular(path);
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, data, {mode: 0o600, flag: 'wx'});
    const file = openSync(temporary, 'r'); try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (present(temporary)) rmSync(temporary); }
}
function files(path: string, prefix = ''): string[] {
  if (!present(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe migration directory: ${path}`);
  return readdirSync(path, {withFileTypes: true}).flatMap(entry => {
    const name = join(prefix, entry.name), absolute = join(path, entry.name);
    if (entry.isDirectory()) return files(absolute, name);
    regular(absolute); return [name];
  });
}
function snapshot(source: string, target: string) {
  regular(source); ensureSafeDirectory(dirname(target));
  const db = new Database(source, {readonly: true});
  try { atomic(target, db.serialize()); } finally { db.close(); }
}
function copyTree(source: string, target: string) {
  for (const name of files(source)) { const out = join(target, name); ensureSafeDirectory(dirname(out)); copyFileSync(join(source, name), out); }
}
function mergeTree(source: string, target: string) {
  for (const name of files(source)) {
    const from = join(source, name), to = join(target, name);
    if (present(to)) {
      regular(to);
      const a = readFileSync(from), b = readFileSync(to);
      if (a.equals(b)) continue;
      // A stale copy may be a prefix of a longer rollout, but diverging chats
      // must never be silently overwritten.
      if (name.endsWith('.jsonl') && a.subarray(0, b.length).equals(b)) { atomic(to, a); continue; }
      if (name.endsWith('.jsonl') && b.subarray(0, a.length).equals(a)) continue;
      throw new Error(`Conflicting conversation files: ${name}`);
    }
    ensureSafeDirectory(dirname(to)); copyFileSync(from, to);
  }
}
function mergeIndex(source: string, target: string) {
  if (!present(source)) return;
  regular(source); if (present(target)) regular(target);
  const lines = [...new Set([...(present(target) ? readFileSync(target, 'utf8').split('\n') : []), ...readFileSync(source, 'utf8').split('\n')].filter(Boolean))];
  // Index names are appended over time. Preserve chronological order so that
  // the most recent rename wins after combining the two histories.
  if (target.endsWith('session_index.jsonl')) lines.sort((a, b) => String(JSON.parse(a).updated_at || '').localeCompare(String(JSON.parse(b).updated_at || '')));
  atomic(target, lines.join('\n') + (lines.length ? '\n' : ''));
}
function mergeDatabase(source: string, target: string, sourceHome: string, targetHome: string) {
  const input = new Database(source, {readonly: true});
  const output = new Database(target);
  try {
    output.exec('PRAGMA foreign_keys = OFF; PRAGMA journal_mode = DELETE;');
    output.transaction(() => {
      const tables = input.query("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqlx_%'").all() as {name: string; sql: string}[];
      for (const table of tables) {
        if (bookkeeping.has(table.name)) continue;
        if (!output.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.name)) output.exec(table.sql);
        const columns = input.query(`PRAGMA table_info(${quote(table.name)})`).all() as {name: string; pk: number}[];
        const destinationColumns = new Set((output.query(`PRAGMA table_info(${quote(table.name)})`).all() as {name: string}[]).map(c => c.name));
        if (columns.some(c => !destinationColumns.has(c.name))) throw new Error(`Incompatible database schema: ${table.name}`);
        const rows = input.query(`SELECT * FROM ${quote(table.name)}`).all() as Record<string, any>[];
        for (const row of rows) {
          for (const column of columns) {
            const value = row[column.name];
            if (typeof value === 'string' && value.startsWith(sourceHome + '/')) row[column.name] = targetHome + value.slice(sourceHome.length);
          }
          if (table.name === 'queued_thread_revisions') {
            output.query('INSERT OR IGNORE INTO queued_thread_revisions (thread_id) VALUES (?)').run(row.thread_id); continue;
          }
          const keys = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk);
          if (!keys.length && rows.length) throw new Error(`Cannot merge unkeyed table: ${table.name}`);
          const existing = keys.length ? output.query(`SELECT * FROM ${quote(table.name)} WHERE ${keys.map(c => `${quote(c.name)} IS ?`).join(' AND ')}`).get(...keys.map(c => row[c.name])) as Record<string, any> | null : null;
          if (existing) {
            if (columns.some(c => !isDeepStrictEqual(existing[c.name], row[c.name]))) throw new Error(`Conflicting database records: ${table.name}`);
          } else output.query(`INSERT INTO ${quote(table.name)} (${columns.map(c => quote(c.name)).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(c => row[c.name]));
        }
      }
      const check = output.query('PRAGMA integrity_check').get() as any;
      if (check.integrity_check !== 'ok') throw new Error('Migrated database failed integrity check');
      if ((output.query('PRAGMA foreign_key_check').all()).length) throw new Error('Migrated database has invalid references');
    })();
  } finally { input.close(); output.close(); }
}

function retireElHistories(base: string) {
  const sources = [join(base, '.El')], runtimeRoot = join(base, '.webui', 'runtime-homes');
  if (present(runtimeRoot)) {
    ensureSafeDirectory(runtimeRoot);
    for (const account of readdirSync(runtimeRoot)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(account)) throw new Error('Unsafe runtime account');
      ensureSafeDirectory(join(runtimeRoot, account));
      sources.push(join(runtimeRoot, account, 'El'));
    }
  }
  for (const source of sources) {
    if (!present(source)) continue;
    ensureSafeDirectory(source);
    for (const name of readdirSync(source)) {
      if (trees.includes(name) || indexes.includes(name) || /\.sqlite(?:-wal|-shm)?$/.test(name)) rmSync(join(source, name), {recursive: true, force: true});
    }
  }
  const oldProjects = join(base, '.webui', 'projects.json.El');
  if (present(oldProjects)) { regular(oldProjects); rmSync(oldProjects); }
}

// Run before starting any Codex processes. Each attempt stages and validates all
// changes before installation. Original histories and metadata remain in backup.
// A failed/interrupted attempt is safe to retry; the server never starts midway.
export function migrateToZilpio(base: string) {
  base = resolve(base);
  const state = join(base, '.webui'), directory = join(state, 'migrations', migration), complete = join(directory, 'complete.json');
  ensureSafeDirectory(state);
  if (present(complete)) {
    const report = readJson(complete, null);
    if (report?.migration !== migration || typeof report.backup !== 'string' || !report.backup.startsWith(directory + '/')) throw new Error('Invalid migration completion marker');
    if (!report.retiredAt) {
      if (!present(report.backup)) throw new Error('Missing migration backup');
      ensureSafeDirectory(report.backup);
      retireElHistories(base);
      report.retiredAt = new Date().toISOString();
      atomic(complete, JSON.stringify(report, null, 2));
    }
    return report;
  }
  const attempt = join(directory, randomUUID()), backup = join(attempt, 'backup'), stage = join(attempt, 'stage');
  ensureSafeDirectory(backup); ensureSafeDirectory(stage);
  const homes = [{source: join(base, '.El'), target: join(base, '.zilpio'), key: 'main'}];
  const runtimeRoot = join(state, 'runtime-homes');
  if (present(runtimeRoot)) {
    ensureSafeDirectory(runtimeRoot);
    for (const account of readdirSync(runtimeRoot)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(account)) throw new Error('Unsafe runtime account');
      ensureSafeDirectory(join(runtimeRoot, account));
      homes.push({source: join(runtimeRoot, account, 'El'), target: join(runtimeRoot, account, 'zilpio'), key: account});
    }
  }
  const plans: {source: string; target: string; staged: string; names: string[]}[] = [];
  for (const home of homes) {
    if (!present(home.source)) continue;
    ensureSafeDirectory(home.source);
    if (present(home.target)) ensureSafeDirectory(home.target);
    const staged = join(stage, home.key); ensureSafeDirectory(staged);
    for (const [kind, path] of [['source', home.source], ['target', home.target]]) {
      if (!present(path)) continue;
      const saved = join(backup, home.key, kind); ensureSafeDirectory(saved);
      // Back up ALL SQLite files, including diagnostics, with their WAL data.
      for (const name of readdirSync(path).filter(n => n.endsWith('.sqlite'))) snapshot(join(path, name), join(saved, name));
      for (const tree of trees) copyTree(join(path, tree), join(saved, tree));
      for (const index of indexes) if (present(join(path, index))) { regular(join(path, index)); copyFileSync(join(path, index), join(saved, index)); }
    }
    const sourceBackup = join(backup, home.key, 'source'), targetBackup = join(backup, home.key, 'target');
    if (present(targetBackup)) copyTree(targetBackup, staged);
    // Diagnostics are kept in the backup; their independent sequence IDs must
    // not be merged into the live database.
    for (const name of readdirSync(staged).filter(n => n.endsWith('.sqlite') && !databaseName.test(n))) rmSync(join(staged, name));
    for (const tree of trees) mergeTree(join(sourceBackup, tree), join(staged, tree));
    for (const index of indexes) mergeIndex(join(sourceBackup, index), join(staged, index));
    for (const name of readdirSync(sourceBackup).filter(n => databaseName.test(n))) {
      const to = join(staged, name);
      if (!present(to)) {
        // Start from a snapshot of the source schema, then remap its paths.
        copyFileSync(join(sourceBackup, name), to);
        const db = new Database(to);
        try {
          db.exec('PRAGMA journal_mode = DELETE');
          for (const table of db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqlx_%'").all() as {name: string}[]) {
            for (const column of db.query(`PRAGMA table_info(${quote(table.name)})`).all() as {name: string}[]) db.query(`UPDATE ${quote(table.name)} SET ${quote(column.name)} = ? || substr(${quote(column.name)}, ?) WHERE typeof(${quote(column.name)}) = 'text' AND substr(${quote(column.name)}, 1, ?) = ?`).run(home.target, home.source.length + 1, home.source.length + 1, home.source + '/');
          }
        } finally { db.close(); }
      } else mergeDatabase(join(sourceBackup, name), to, home.source, home.target);
    }
    for (const name of readdirSync(staged).filter(n => databaseName.test(n))) {
      const db = new Database(join(staged, name), {readonly: true});
      try {
        if ((db.query('PRAGMA integrity_check').get() as any).integrity_check !== 'ok') throw new Error('Migrated database failed integrity check');
        if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('Migrated database has invalid references');
        if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'").get()) {
          for (const row of db.query('SELECT rollout_path FROM threads').all() as {rollout_path: string}[]) {
            if (!row.rollout_path.startsWith(home.target + '/')) throw new Error('Conversation points outside its runtime home');
            const rollout = join(staged, relative(home.target, row.rollout_path)); regular(rollout);
          }
        }
      } finally { db.close(); }
    }
    plans.push({...home, staged, names: files(staged)});
  }
  const metadataNames = ['accounts.json', 'projects.json', 'projects.json.El', 'projects.json.zilpio', 'thread-ownership.json', 'auto-reload.json'];
  for (const name of metadataNames) if (present(join(state, name))) { regular(join(state, name)); ensureSafeDirectory(join(backup, 'metadata')); copyFileSync(join(state, name), join(backup, 'metadata', name)); }
  const accounts = readJson(join(state, 'accounts.json'), null);
  if (accounts?.workspaceId === 'El') accounts.workspaceId = 'zilpio';
  const sourceProjects = readJson(join(state, 'projects.json.El'), []), targetProjects = readJson(join(state, 'projects.json.zilpio'), []), legacyProjects = readJson(join(state, 'projects.json'), []);
  if (![sourceProjects, targetProjects, legacyProjects].every(Array.isArray)) throw new Error('Invalid project metadata');
  const projects = new Map<string, any>();
  for (const project of [...legacyProjects, ...sourceProjects, ...targetProjects]) {
    if (!project || typeof project.path !== 'string') throw new Error('Invalid project metadata');
    const previous = projects.get(project.path);
    projects.set(project.path, previous && !previous.hidden && project.hidden ? previous : {...previous, ...project});
  }
  const ownership = readJson(join(state, 'thread-ownership.json'), {}), merged: Record<string, any> = {};
  for (const [key, value] of Object.entries(ownership)) {
    const [environment, thread] = JSON.parse(key), destination = JSON.stringify([environment === 'El' ? 'zilpio' : environment, thread]);
    if (Object.hasOwn(merged, destination) && !isDeepStrictEqual(merged[destination], value)) throw new Error(`Conflicting chat account ownership: ${thread}`);
    merged[destination] = value;
  }
  const auto = readJson(join(state, 'auto-reload.json'), null);
  if (auto) {
    if (!Array.isArray(auto.records)) throw new Error('Invalid AutoReload metadata');
    const records = new Map<string, any>();
    // Process canonical records last if both environments contain the same ID.
    for (const record of [...auto.records].sort((a, b) => Number(a.scope?.startsWith('["zilpio"')) - Number(b.scope?.startsWith('["zilpio"')))) {
      let scope; try { scope = JSON.parse(record.scope); } catch { scope = null; }
      const next = Array.isArray(scope) && scope[0] === 'El' ? {...record, scope: JSON.stringify(['zilpio', ...scope.slice(1)])} : record;
      records.set(JSON.stringify([next.scope, next.threadId]), next);
    }
    auto.records = [...records.values()];
  }
  // Installation starts only after every source, database and metadata file has
  // passed validation. A startup failure preserves the backups for recovery.
  for (const plan of plans) for (const name of plan.names) {
    const destination = join(plan.target, name);
    ensureSafeDirectory(dirname(destination));
    if (name.endsWith('.sqlite')) {
      // This function runs with all app-servers stopped; checkpoint old sidecars
      // before replacing the database to avoid replaying an obsolete WAL.
      if (present(destination)) { regular(destination); const db = new Database(destination); try { const checkpoint = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as any; if (checkpoint?.busy) throw new Error('Codex history is still in use; stop all runtimes before migration'); } finally { db.close(); } }
      for (const suffix of ['-wal', '-shm']) if (present(destination + suffix)) { regular(destination + suffix); rmSync(destination + suffix); }
    }
    atomic(destination, readFileSync(join(plan.staged, name)));
  }
  if (accounts) atomic(join(state, 'accounts.json'), JSON.stringify(accounts));
  if (projects.size || sourceProjects.length || targetProjects.length || legacyProjects.length) atomic(join(state, 'projects.json.zilpio'), JSON.stringify([...projects.values()]));
  if (present(join(state, 'thread-ownership.json'))) atomic(join(state, 'thread-ownership.json'), JSON.stringify(merged));
  if (auto) atomic(join(state, 'auto-reload.json'), JSON.stringify(auto));
  const report = {migration, retiredAt: null as string | null, completedAt: new Date().toISOString(), backup, homes: plans.map(p => ({source: p.source, target: p.target})), projects: projects.size};
  atomic(complete, JSON.stringify(report, null, 2));
  // Retire the old live history only after the durable completion marker.
  // The source and destination snapshots remain available in the private backup.
  retireElHistories(base);
  report.retiredAt = new Date().toISOString();
  atomic(complete, JSON.stringify(report, null, 2));
  return report;
}
