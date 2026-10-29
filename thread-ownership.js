import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, lstatSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, resolve, parse, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export function ensureSafeDirectory(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try { const stat = lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe directory'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; mkdirSync(current, { mode: 0o700 }); }
  }
}

export class ThreadOwnership {
  constructor(file) {
    this.file = file;
    ensureSafeDirectory(dirname(file));
    if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error('Unsafe thread ownership state');
    this.records = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    if (!this.records || typeof this.records !== 'object' || Array.isArray(this.records)) throw new Error('Invalid thread ownership state');
  }
  project(environment, thread) { return this.records[JSON.stringify([environment, thread])]?.project; }
  setProject(environment, thread, project) { const key=JSON.stringify([environment, thread]); this.persist({...this.records, [key]:{...this.records[key], project}}); }
  hasAccount(account) { return Object.values(this.records).some(value => typeof value === 'string' ? value === account : (!value?.deletion?.finished && (value?.owner === account || value?.accounts?.includes(account)))); }
  owner(environment, thread) { const value = this.records[JSON.stringify([environment, thread])]; return typeof value === 'string' ? value : value?.owner; }
  isTransferred(environment, thread) { return this.records[JSON.stringify([environment, thread])]?.transferred === true; }
  isHidden(environment, thread) { return this.records[JSON.stringify([environment, thread])]?.hidden === true; }
  hide(environment, thread) {
    const key=JSON.stringify([environment, thread]), current=this.records[key];
    this.persist({...this.records, [key]:{...(typeof current === 'string' ? {owner:current} : current), hidden:true}});
  }
  isDeleted(environment, thread) { return !!this.records[JSON.stringify([environment, thread])]?.deletion; }
  pendingIntents(environment) { return Object.entries(this.records).flatMap(([key, value]) => { try { const [env, thread] = JSON.parse(key); return env === environment && value?.intent ? [{threadId:thread, accountId:value.owner}] : []; } catch { return []; } }); }
  pendingDeletions(environment) { return Object.entries(this.records).flatMap(([key, value]) => { try { const [env, thread] = JSON.parse(key); return env === environment && value?.deletion && !value.deletion.finished ? [{threadId:thread, accountId:value.owner}] : []; } catch { return []; } }); }
  deletionPlan(environment, thread) { const value=this.records[JSON.stringify([environment, thread])]; return value?.path && value?.accounts && !value?.intent ? {path:value.path, accounts:value.accounts, completed:value.deletion?.completed || []} : null; }
  deletion(environment, thread) { const value = this.records[JSON.stringify([environment, thread])]; return value?.deletion ? {path:value.path, accounts:value.accounts, completed:value.deletion.completed, started:value.deletion.started || []} : null; }
  registerLink(environment, thread, source, target, path, sourceHash = null, sourceSize = null, name = null) {
    if (this.owner(environment, thread) !== source || this.isDeleted(environment, thread)) throw new Error('Chat account changed');
    const key = JSON.stringify([environment, thread]), current = this.records[key];
    if (current?.intent) throw new Error('Previous handoff requires reconciliation');
    if (current?.path && current.path !== path) throw new Error('Rollout path changed');
    const accounts = [...new Set([...(current?.accounts || []), source, target])];
    this.persist({...this.records, [key]:{owner:source, transferred:true, path, accounts, hashes:{...(current?.hashes || {}), ...(sourceHash ? {[source]:sourceHash} : {})}, intent:{target, path, sourceHash, sourceSize, name, priorAccounts:current?.accounts || [source], previousHash:current?.hashes?.[target] || null}}});
  }
  snapshotHash(environment, thread, account) { return this.records[JSON.stringify([environment, thread])]?.hashes?.[account] || null; }
  recordSnapshot(environment, thread, account, hash) { const key=JSON.stringify([environment,thread]), current=this.records[key]; this.persist({...this.records,[key]:{...current, hashes:{...(current.hashes || {}),[account]:hash}}}); }
  linkIntent(environment, thread) { return this.records[JSON.stringify([environment, thread])]?.intent || null; }
  finishIntent(environment, thread) {
    const key=JSON.stringify([environment, thread]), current=this.records[key];
    if (!current?.intent) return;
    const {intent, ...rest}=current; this.persist({...this.records, [key]:rest});
  }
  cancelUnlinkedIntent(environment, thread) {
    const key=JSON.stringify([environment, thread]), current=this.records[key];
    if (!current?.intent) return;
    const {intent, ...rest}=current;
    this.persist({...this.records, [key]:{...rest, accounts:intent.priorAccounts}});
  }
  beginDeletion(environment, thread, expected) {
    const key = JSON.stringify([environment, thread]), current = this.records[key];
    if (current?.owner !== expected || current?.intent || !current?.path || !Array.isArray(current?.accounts)) throw new Error('Cannot safely delete this transferred chat');
    if (!current.deletion) { const {pendingName, ...rest}=current; this.persist({...this.records, [key]:{...rest, deletion:{completed:[]}}}); }
  }
  startDeletionAccount(environment, thread, account) {
    const key=JSON.stringify([environment, thread]), current=this.records[key];
    if (!current?.deletion || !current.accounts.includes(account)) throw new Error('Invalid deletion account');
    const started=[...new Set([...(current.deletion.started || []), account])];
    this.persist({...this.records, [key]:{...current, deletion:{...current.deletion, started}}});
  }
  checkpointDeletion(environment, thread, account) {
    const key = JSON.stringify([environment, thread]), current = this.records[key];
    if (!current?.deletion || !current.accounts.includes(account)) throw new Error('Invalid deletion checkpoint');
    const completed = [...new Set([...current.deletion.completed, account])];
    this.persist({...this.records, [key]:{...current, deletion:{...current.deletion, completed, finished:completed.length === current.accounts.length}}});
  }
  remember(environment, thread, account) {
    if (this.owner(environment, thread)) return;
    this.save(environment, thread, account);
  }
  pendingNames(environment, account) { return Object.entries(this.records).flatMap(([key,value])=>{try {const [env,threadId]=JSON.parse(key);return env===environment && value?.owner===account && value?.pendingName ? [{threadId,name:value.pendingName}] : [];}catch{return [];}}); }
  clearPendingName(environment, thread) { const key=JSON.stringify([environment,thread]), current=this.records[key]; if (!current?.pendingName) return; const {pendingName,...rest}=current; this.persist({...this.records,[key]:rest}); }
  change(environment, thread, expected, account, recoveryName = null) {
    if (this.owner(environment, thread) !== expected) throw new Error('Chat account changed; reload the chat');
    const key = JSON.stringify([environment, thread]), current = this.records[key];
    if (typeof current === 'object' && current.accounts) { const {intent, ...rest}=current; this.persist({...this.records, [key]:{...rest, owner:account, transferred:true, ...(recoveryName ? {pendingName:recoveryName} : {})}}); }
    else this.save(environment, thread, account, true);
  }
  forget(environment, thread) {
    const next = { ...this.records }; delete next[JSON.stringify([environment, thread])]; this.persist(next);
  }
  save(environment, thread, account, transferred = false) {
    const next = { ...this.records, [JSON.stringify([environment, thread])]: transferred ? {owner: account, transferred: true} : account };
    this.persist(next);
  }
  persist(next) {
    ensureSafeDirectory(dirname(this.file));
    const temp = this.file + '.' + randomUUID();
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    const file = openSync(temp, 'r'); try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temp, this.file);
    const directory = openSync(dirname(this.file), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    this.records = next;
  }
}
