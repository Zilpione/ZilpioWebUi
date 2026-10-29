import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_LITERAL_PATHSPECS: '1' };
export async function repositoryChanges(path) {
 let stdout;
 try {
  ({ stdout } = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--', '.'], {
   cwd: path, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  }));
 } catch (error) {
  if (error.code === 128 && /not a git repository/i.test(error.stderr || '')) return null;
  throw new Error('Stato Git non disponibile');
 }
 const counts = { modified: 0, added: 0, deleted: 0, untracked: 0, total: 0 };
 const entries = stdout.split('\0');
 for (let i = 0; i < entries.length; i++) {
  if (!entries[i]) continue;
  const status = entries[i].slice(0, 2);
  if (/[RC]/.test(status)) i++; // With -z, renamed/copied files have a second path entry.
  if (status === '!!') continue;
  const kind = status === '??' ? 'untracked' : status.includes('U') || status === 'AA' || status === 'DD' ? 'modified' : status.includes('D') ? 'deleted' : status.includes('A') ? 'added' : 'modified';
  counts[kind]++;
  counts.total++;
 }
 return counts;
}
async function changeEntries(path) {
 const { stdout } = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { cwd: path, env, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
 const entries = stdout.split('\0'), files = [];
 for (let i = 0; i < entries.length; i++) {
  if (!entries[i]) continue;
  const status = entries[i].slice(0, 2), name = entries[i].slice(3);
  const oldName = /[RC]/.test(status) ? entries[++i] : null;
  files.push({ name, status, oldName });
 }
 return files;
}
export async function repositoryBranch(path) {
 const { stdout } = await command('git', ['branch', '--show-current'], path);
 return stdout.trim() || null;
}
export async function repositoryDiffs(path) {
 const files = await changeEntries(path);
 for (const file of files) {
  const names = file.oldName ? [file.name, file.oldName] : [file.name];
  if (file.status === '??') {
   try { file.diff = (await run('git', ['diff', '--no-index', '--', '/dev/null', file.name], { cwd: path, env, maxBuffer: 8 * 1024 * 1024 })).stdout; }
   catch (error) { if (error.code !== 1) throw new Error('Diff non disponibile per ' + file.name); file.diff = error.stdout; }
  } else {
   const staged = await command('git', ['diff', '--cached', '--no-ext-diff', '--', ...names], path);
   const unstaged = await command('git', ['diff', '--no-ext-diff', '--', ...names], path);
   file.diff = [staged.stdout && 'Staged:\n' + staged.stdout, unstaged.stdout && 'Non staged:\n' + unstaged.stdout].filter(Boolean).join('\n') || 'Diff non disponibile (conflitto o modifica del submodule).';
  }
 }
 return files;
}
export async function discardRepositoryChange(path, name) {
 const file = (await changeEntries(path)).find(entry => entry.name === name);
 if (!file) throw new Error('Modifica non più disponibile.');
 if (file.status === '??' || file.status[0] === 'A') {
  if (file.status !== '??') await command('git', ['rm', '--cached', '--force', '--', file.name], path);
  const target = join(path, file.name);
  if (existsSync(target) && lstatSync(target).isDirectory()) throw new Error('Impossibile scartare una directory o un submodule.');
  rmSync(target, { force: true });
 } else {
  if (file.oldName) {
   await command('git', ['restore', '--source=HEAD', '--staged', '--', file.name, file.oldName], path);
   await command('git', ['restore', '--source=HEAD', '--worktree', '--', file.oldName], path);
   rmSync(join(path, file.name), { force: true });
  } else await command('git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', file.name], path);
 }
}
export async function commitAndPush(path, message) {
 if (typeof message !== 'string' || !message.trim() || message.length > 1000) throw new Error('Inserisci un messaggio di commit valido.');
 await command('git', ['add', '--all', '--', '.'], path);
 await command('git', ['commit', '-m', message.trim(), '--', '.'], path);
 try { await command('git', ['push'], path); }
 catch { throw new Error('Commit creato, ma push non riuscito. Controlla il remote e riprova il push.'); }
}
async function command(bin, args, cwd) {
 try { return await run(bin, args, { cwd, env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }); }
 catch { throw new Error('Operazione Git non riuscita. Controlla accesso e configurazione Git.'); }
}
export function detachRepository(path) {
 const git = join(path, '.git');
 if (!existsSync(git) || !lstatSync(git).isDirectory() || lstatSync(git).isSymbolicLink()) throw new Error('La cartella non contiene un repository Git standard.');
 rmSync(git, { recursive: true });
}
export async function repositoryStatus(path) {
 const git = join(path, '.git');
 if (!existsSync(git)) return { assigned: false };
 if (!lstatSync(git).isDirectory() || lstatSync(git).isSymbolicLink()) return { assigned: true, removable: false, remote: '' };
 let remote = ''; try { remote = (await command('git', ['remote', 'get-url', 'origin'], path)).stdout.trim(); } catch {}
 return { assigned: true, removable: true, remote };
}
export async function listRepositories(gh = 'gh') {
 const fetchPages = async endpoint => {
  const { stdout } = await command(gh, ['api', '--paginate', '--slurp', endpoint]);
  return JSON.parse(stdout).flat();
 };
 const [repos, stars] = await Promise.all([fetchPages('user/repos?per_page=100&affiliation=owner,collaborator,organization_member'), fetchPages('user/starred?per_page=100')]);
 const starred = new Set(stars.map(r => r.full_name));
 return repos.filter(r => typeof r.full_name === 'string').map(r => ({ name: r.full_name, starred: starred.has(r.full_name), private: !!r.private })).sort((a,b) => Number(b.starred)-Number(a.starred) || a.name.localeCompare(b.name));
}
export async function assignRepository(path, name, gh = 'gh') {
 if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Repository non valido');
 if (existsSync(join(path,'.git'))) throw new Error('Il progetto contiene già un repository Git');
 const available = await listRepositories(gh);
 if (!available.some(repo => repo.name.toLowerCase() === name.toLowerCase())) throw new Error('Repository non accessibile');
 const populated = readdirSync(path).length > 0;
 const temp = mkdtempSync(join(dirname(path), '.webui-clone-'));
 try {
  await command(gh, ['repo', 'clone', name, temp], path);
  let hasHistory = true; try { await command('git', ['rev-parse', '--verify', 'HEAD'], temp); } catch { hasHistory = false; }
  if (populated && hasHistory) throw new Error('La cartella e il repository contengono già file. Gestisci il collegamento dalla chat per evitare sovrascritture.');
  if (readdirSync(path).some(entry => entry === '.git') || (!populated && readdirSync(path).length)) throw new Error('La cartella è cambiata durante il clone. Riprova.');
  if (populated) renameSync(join(temp,'.git'),join(path,'.git'));
  else for (const entry of readdirSync(temp)) renameSync(join(temp,entry),join(path,entry));
  return { populated, emptyRemote: populated };
 } finally { rmSync(temp,{recursive:true,force:true}); }
}
export async function pushInitial(path) {
 try { await command('git', ['rev-parse', '--verify', 'HEAD'], path); throw new Error('Il repository contiene già commit.'); } catch (error) { if (error.message === 'Il repository contiene già commit.') throw error; }
 const remoteHeads = await command('git', ['ls-remote', '--heads', 'origin'], path);
 if (remoteHeads.stdout.trim()) throw new Error('Il repository remoto non è più vuoto. Gestiscilo dalla chat.');
 const { stdout } = await command('git', ['status','--porcelain'],path);
 if (!stdout.trim()) throw new Error('Non ci sono file da pubblicare.');
 await command('git',['add','--all'],path);
 await command('git',['commit','-m','Initial commit'],path);
 await command('git',['push','-u','origin','HEAD'],path);
}
