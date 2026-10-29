import {afterEach, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {migrateToWorkspace} from '../workspace-migration.ts';
import {AccountStore} from '../account-store.ts';

const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});});
function setup() {const base = mkdtempSync(join(tmpdir(), 'workspace-migration-')); roots.push(base); mkdirSync(join(base, '.webui')); return base;}
function json(path: string, data: any) {mkdirSync(join(path, '..'), {recursive: true}); writeFileSync(path, JSON.stringify(data));}
function history(home: string, id: string) {
  mkdirSync(join(home, 'sessions'), {recursive: true});
  const rollout = join(home, 'sessions', id + '.jsonl');
  writeFileSync(rollout, JSON.stringify({type: 'session_meta', payload: {id}}) + '\n');
  const db = new Database(join(home, 'state_5.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, name TEXT, cwd TEXT NOT NULL); CREATE TABLE IF NOT EXISTS thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY);');
  db.query('INSERT INTO threads VALUES (?, ?, ?, ?)').run(id, rollout, 'Name ' + id, '/existing/project');
  const turns = new Database(join(home, 'thread_history_1.sqlite'));
  turns.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_json TEXT, PRIMARY KEY(thread_id, turn_id, item_id));');
  turns.query('INSERT INTO thread_items VALUES (?, ?, ?, ?)').run(id, 'turn', 'item', JSON.stringify({text: 'history ' + id}));
  return {db, turns, close() {db.close(); turns.close();}};
}
function threads(home: string) {const db = new Database(join(home, 'state_5.sqlite'), {readonly: true}); try {return db.query('SELECT * FROM threads ORDER BY id').all() as any[];} finally {db.close();}}

test('merges conversations, WAL databases, titles, messages, and project lists into Workspace', () => {
  const base = setup(), source = join(base, '.legacy'), target = join(base, '.workspace');
  const a = history(source, 'legacy-chat'), b = history(target, 'workspace-chat');
  // Both are deliberately left open in WAL mode to exercise a consistent backup.
  const folder = join(base, 'legacy', 'project'); mkdirSync(folder, {recursive: true});
  writeFileSync(join(folder, 'keep.txt'), 'project files');
  json(join(base, '.webui', 'projects.json.legacy'), [{path: folder, color: '#ff0000', icon: 'star', hidden: false}]);
  json(join(base, '.webui', 'projects.json.workspace'), [{path: folder, color: null, icon: 'folder', hidden: true}]);
  json(join(base, '.webui', 'accounts.json'), {workspaceId: 'legacy', accounts: [], accountId: ''});
  a.close(); b.close();
  const report = migrateToWorkspace(base);
  expect(threads(target).map(t => t.id)).toEqual(['legacy-chat', 'workspace-chat']);
  expect(existsSync(join(source, 'sessions'))).toBe(false);
  expect(existsSync(join(source, 'state_5.sqlite'))).toBe(false);
  expect(threads(target)[0]).toMatchObject({name: 'Name legacy-chat', rollout_path: join(target, 'sessions', 'legacy-chat.jsonl'), cwd: '/existing/project'});
  const db = new Database(join(target, 'thread_history_1.sqlite'));
  expect(db.query('SELECT count(*) AS n FROM thread_items').get()).toEqual({n: 2}); db.close();
  expect(readFileSync(join(target, 'sessions', 'legacy-chat.jsonl'), 'utf8')).toContain('legacy-chat');
  expect(JSON.parse(readFileSync(join(base, '.webui', 'projects.json.workspace'), 'utf8'))).toEqual([{path: folder, color: '#ff0000', icon: 'star', hidden: false}]);
  expect(JSON.parse(readFileSync(join(base, '.webui', 'accounts.json'), 'utf8')).workspaceId).toBe('workspace');
  expect(existsSync(join(base, '.webui', 'projects.json.legacy'))).toBe(false);
  expect(readFileSync(join(folder, 'keep.txt'), 'utf8')).toBe('project files');
  expect(threads(join(report.backup, 'main', 'source'))[0].rollout_path).toContain('/.legacy/');
  expect(threads(join(report.backup, 'main', 'target')).map(t => t.id)).toEqual(['workspace-chat']);
});

test('archives committed data still in a WAL before merging', () => {
  const base = setup(), source = join(base, '.legacy'), target = join(base, '.workspace');
  const a = history(source, 'wal-chat');
  // No target process is running. Source connection holds a committed WAL open.
  try {migrateToWorkspace(base); expect(threads(target)[0].id).toBe('wal-chat');} finally {a.close();}
});

test('migrates each account runtime and ownership, pending handoff, deletion and AutoReload state', () => {
  const base = setup(), state = join(base, '.webui');
  const home = join(state, 'runtime-homes', 'second', 'legacy'); history(home, 'account-chat').close();
  const ownership = {owner: 'second', transferred: true, path: 'account-chat.jsonl', accounts: ['default', 'second'], intent: {target: 'default'}, deletion: {completed: ['default']}};
  json(join(state, 'thread-ownership.json'), {[JSON.stringify(['legacy', 'account-chat'])]: ownership});
  json(join(state, 'auto-reload.json'), {records: [{scope: JSON.stringify(['legacy', 'default']), threadId: 'account-chat', enabled: true, pendingId: 'existing-id'}]});
  migrateToWorkspace(base);
  expect(threads(join(state, 'runtime-homes', 'second', 'workspace'))[0].id).toBe('account-chat');
  expect(JSON.parse(readFileSync(join(state, 'thread-ownership.json'), 'utf8'))).toEqual({[JSON.stringify(['workspace', 'account-chat'])]: ownership});
  expect(JSON.parse(readFileSync(join(state, 'auto-reload.json'), 'utf8')).records[0]).toMatchObject({scope: JSON.stringify(['workspace', 'default']), enabled: true, pendingId: 'existing-id'});
});

test('completed migration is idempotent and cannot resurrect subsequently deleted chats or projects', () => {
  const base = setup(), target = join(base, '.workspace'); history(join(base, '.legacy'), 'chat').close();
  const first = migrateToWorkspace(base);
  const db = new Database(join(target, 'state_5.sqlite')); db.exec('DELETE FROM threads'); db.close();
  rmSync(join(target, 'sessions', 'chat.jsonl'));
  expect(migrateToWorkspace(base)).toEqual(first); expect(threads(target)).toEqual([]);
});

test('conflicting rollout files abort before replacing any destination or metadata', () => {
  const base = setup(), source = join(base, '.legacy'), target = join(base, '.workspace');
  history(source, 'same').close(); history(target, 'same').close();
  writeFileSync(join(target, 'sessions', 'same.jsonl'), 'divergent\n');
  const before = readFileSync(join(target, 'state_5.sqlite'));
  json(join(base, '.webui', 'accounts.json'), {workspaceId: 'legacy'});
  expect(() => migrateToWorkspace(base)).toThrow('Conflicting');
  expect(readFileSync(join(target, 'state_5.sqlite'))).toEqual(before);
  expect(JSON.parse(readFileSync(join(base, '.webui', 'accounts.json'), 'utf8')).workspaceId).toBe('legacy');
  expect(readFileSync(join(target, 'sessions', 'same.jsonl'), 'utf8')).toBe('divergent\n');
});

test('a metadata conflict leaves all staged databases uninstalled and can be retried', () => {
  const base = setup(), target = join(base, '.workspace'), state = join(base, '.webui');
  history(join(base, '.legacy'), 'source').close(); history(target, 'target').close();
  json(join(state, 'thread-ownership.json'), {[JSON.stringify(['legacy', 'source'])]: 'one', [JSON.stringify(['workspace', 'source'])]: 'two'});
  expect(() => migrateToWorkspace(base)).toThrow('ownership'); expect(threads(target).map(t => t.id)).toEqual(['target']);
  json(join(state, 'thread-ownership.json'), {[JSON.stringify(['legacy', 'source'])]: 'one'});
  migrateToWorkspace(base); expect(threads(target).map(t => t.id)).toEqual(['source', 'target']);
});

test('rejects unsafe symlinks and missing rollout files without changing the destination', () => {
  const base = setup(), source = join(base, '.legacy'), target = join(base, '.workspace');
  history(source, 'source').close(); history(target, 'target').close();
  rmSync(join(source, 'sessions', 'source.jsonl'));
  expect(() => migrateToWorkspace(base)).toThrow(); expect(threads(target).map(t => t.id)).toEqual(['target']);
  symlinkSync(join(target, 'sessions', 'target.jsonl'), join(source, 'sessions', 'source.jsonl'));
  expect(() => migrateToWorkspace(base)).toThrow('Unsafe'); expect(threads(target).map(t => t.id)).toEqual(['target']);
});

test('single-workspace AccountStore accepts the migrated persisted legacy selection', () => {
  const base = setup(); mkdirSync(join(base, '.codex'));
  json(join(base, '.webui', 'accounts.json'), {initialized: true, workspaceId: 'legacy', accountId: '', accounts: []});
  migrateToWorkspace(base);
  const store = new AccountStore({defaultHome: join(base, '.codex'), stateDir: join(base, '.webui'), loginsDir: join(base, '.codex-logins'), workspaces: [{id: 'workspace', label: 'Workspace', path: join(base, 'workspace'), codexHome: join(base, '.workspace')}]});
  store.prepare(); expect(store.getState().workspaceId).toBe('workspace'); expect(store.getState().workspaces.map(w => w.label)).toEqual(['Workspace']);
  expect(() => store.prepareWorkspace('', 'legacy')).toThrow('Unknown workspace');
});
