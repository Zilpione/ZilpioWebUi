import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, chmodSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, parse } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type Workspace = { id: string; label: string; path: string; codexHome: string };
export type PublicAccount = { id: string; label: string; email: string | null; planType: string | null; active: boolean };
type Account = Omit<PublicAccount, 'active'> & { identity: string | null };
type Options = { defaultHome: string; loginsDir: string; stateDir: string; workspaces: Workspace[] };
type State = { initialized: boolean; accountId: string; workspaceId: string; accounts: Account[] };
const CONFIG_ASSETS = ['config.toml', 'managed_config.toml', 'rules', 'skills', 'AGENTS.md', 'instructions.md', 'hooks', 'plugins', 'prompts'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
function present(path: string) { try { lstatSync(path); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; } }
function directories(path: string, create = false) {
 const absolute = resolve(path); let current = parse(absolute).root;
 for (const segment of absolute.slice(current.length).split('/').filter(Boolean)) {
  current = join(current, segment);
  if (!present(current)) { if (!create) throw new Error('Missing directory'); mkdirSync(current, { mode: 0o700 }); }
  const stat = lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe directory');
 }
}
function regular(path: string) { directories(dirname(path)); const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe file'); }
function atomic(path: string, value: string) {
 directories(dirname(path)); if (present(path)) regular(path);
 const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
 try { writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); } finally { if (present(temporary)) unlinkSync(temporary); }
}
function tokenData(raw: any) {
 const tokens = raw?.tokens;
 if (!tokens || !['id_token','access_token','refresh_token'].every(key => typeof tokens[key] === 'string' && tokens[key].length > 0)) throw new Error('Invalid token auth');
 let payload: any;
 try { const parts = tokens.id_token.split('.'); if (parts.length !== 3) throw new Error(); payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(); } catch { throw new Error('Invalid identity token'); }
 const claims = payload['https://api.openai.com/auth'];
 const email = typeof payload.email === 'string' ? payload.email : null;
 const planType = typeof claims?.chatgpt_plan_type === 'string' ? claims.chatgpt_plan_type : null;
 const account = typeof tokens.account_id === 'string' ? tokens.account_id : typeof claims?.chatgpt_account_id === 'string' ? claims.chatgpt_account_id : null;
 return { email, planType, identity: account ? JSON.stringify([account,email]) : email ? JSON.stringify([null,email]) : null };
}
export class AccountStore {
 private options: Options;
 private state: State;
 private prepared = false;
 private runtimeAccounts = new Map<string,string>();
 private accountRuntimeVaults = new Map<string,string>();
 constructor(options: Options) {
  if (!options.workspaces.length) throw new Error('Workspace required');
  this.options = { ...options, defaultHome: resolve(options.defaultHome), loginsDir: resolve(options.loginsDir), stateDir: resolve(options.stateDir), workspaces: options.workspaces.map(w => ({...w,path:resolve(w.path),codexHome:resolve(w.codexHome)})) };
  const paths = [this.options.defaultHome,this.options.loginsDir,this.options.stateDir,...this.options.workspaces.map(w=>w.codexHome)];
  if (paths.some((path,index) => paths.some((other,otherIndex) => index !== otherIndex && (path === other || path.startsWith(other + '/'))))) throw new Error('Storage paths must be separate');
  const ids=new Set<string>(); for (const workspace of options.workspaces) { this.validateId(workspace.id); if(ids.has(workspace.id)) throw new Error('Duplicate workspace');ids.add(workspace.id); }
  this.state = { initialized: false, accountId: '', workspaceId: options.workspaces[0].id, accounts: [] };
 }
 private validateId(id: string) { if (typeof id !== 'string' || !ID.test(id) || ['constructor','prototype','__proto__'].includes(id)) throw new Error('Invalid identifier'); }
 private workspace(id: string) { this.validateId(id); const workspace=this.options.workspaces.find(w=>w.id===id);if(!workspace)throw new Error('Unknown workspace');return workspace; }
 private account(id: string) { this.validateId(id);const account=this.state.accounts.find(a=>a.id===id);if(!account)throw new Error('Unknown account');return account; }
 private requirePrepared() { if(!this.prepared)throw new Error('Store not prepared'); }
 private persist() { atomic(join(this.options.stateDir,'accounts.json'),JSON.stringify(this.state)); }
 private publicAccount(account: Account): PublicAccount { return { id:account.id,label:account.label,email:account.email,planType:account.planType,active:account.id===this.state.accountId }; }
 prepare() {
  for (const path of [this.options.loginsDir,this.options.stateDir]) {directories(path,true);chmodSync(path,0o700);}
  const file=join(this.options.stateDir,'accounts.json');
  if (!this.prepared && present(file)) {
   regular(file);const loaded=JSON.parse(readFileSync(file,'utf8'));
   if (!loaded || !Array.isArray(loaded.accounts) || typeof loaded.accountId !== 'string' || typeof loaded.workspaceId !== 'string') throw new Error('Invalid account state');
   this.workspace(loaded.workspaceId); const ids=new Set<string>();
   const accounts: Account[]=loaded.accounts.map((a:any)=> {this.validateId(a.id);if(ids.has(a.id)||typeof a.label!=='string')throw new Error('Invalid account state');ids.add(a.id);return {id:a.id,label:a.label,email:typeof a.email==='string'?a.email:null,planType:typeof a.planType==='string'?a.planType:null,identity:typeof a.identity==='string'?a.identity:null};});
   if (loaded.accountId && !ids.has(loaded.accountId)) throw new Error('Invalid selected account');
   this.state={initialized:true,accountId:loaded.accountId,workspaceId:loaded.workspaceId,accounts};
  }
  if (!this.state.initialized) {
   const original=join(this.options.defaultHome,'auth.json');
   if(present(original)) {regular(original);const raw=readFileSync(original,'utf8');const data=tokenData(JSON.parse(raw));const target=join(this.options.loginsDir,'default.json');if(present(target))throw new Error('Unmanaged auth file');atomic(target,raw);this.state.accounts.push({id:'default',label:data.email || 'Default',...data});this.state.accountId='default';}
   this.state.initialized=true;
  }
  this.prepared=true;this.persist();
 }
 getState() { this.requirePrepared();return {accountId:this.state.accountId,workspaceId:this.state.workspaceId,accounts:this.state.accounts.map(a=>this.publicAccount(a)),workspaces:this.options.workspaces.map(({id,label,path})=>({id,label,path}))}; }
 authPath(id: string) { this.requirePrepared();this.account(id);const path=join(this.options.loginsDir,`${id}.json`);regular(path);return path; }
 findAuthAccount(raw: object): PublicAccount | null {
  this.requirePrepared();const {identity}=tokenData(raw);
  const account=identity ? this.state.accounts.find(account=>account.identity===identity) : undefined;
  return account ? this.publicAccount(account) : null;
 }
 addAuth(raw: object, label?: string): PublicAccount {
  this.requirePrepared();const data=tokenData(raw);if(label!==undefined && (typeof label!=='string'||!label.trim()||label.length>200))throw new Error('Invalid label');
  const existing=data.identity ? this.state.accounts.find(a=>a.identity===data.identity) : undefined;
  const id=existing?.id || randomUUID();const path=existing?this.authPath(id):join(this.options.loginsDir,`${id}.json`);atomic(path,JSON.stringify(raw));
  if(existing) {existing.email=data.email;existing.planType=data.planType;if(label)existing.label=label.trim();this.persist();return this.publicAccount(existing);}
  const account={id,label:label?.trim() || data.email || 'Account',...data};this.state.accounts.push(account);this.persist();return this.publicAccount(account);
 }
 rename(id: string,label: string) {this.requirePrepared();const account=this.account(id);if(typeof label!=='string'||!label.trim()||label.length>200)throw new Error('Invalid label');account.label=label.trim();this.persist();}
 remove(id: string) {this.requirePrepared();this.account(id);if(id===this.state.accountId)throw new Error('Cannot remove active account');const path=this.authPath(id);unlinkSync(path);this.state.accounts=this.state.accounts.filter(a=>a.id!==id);this.persist();}
 commitSelection(accountId: string,workspaceId: string) {this.requirePrepared();if(accountId || this.state.accounts.length || this.state.accountId)this.account(accountId);this.workspace(workspaceId);this.state.accountId=accountId;this.state.workspaceId=workspaceId;this.persist();}
 private link(path:string,target:string) {const temporary=join(dirname(path),`.link-${randomUUID()}`);try {symlinkSync(target,temporary);renameSync(temporary,path);}finally{if(present(temporary))unlinkSync(temporary);}}
 prepareWorkspace(accountId:string,workspaceId:string,options: { preserveRefresh?: boolean } = {}) {
  this.requirePrepared();const workspace=this.workspace(workspaceId);const auth=accountId ? this.authPath(accountId) : null;
  directories(workspace.codexHome,true);chmodSync(workspace.codexHome,0o700);directories(workspace.path,true);
  for(const name of CONFIG_ASSETS) {const source=join(this.options.defaultHome,name);if(!present(source))continue;const destination=join(workspace.codexHome,name);if(present(destination)) {const stat=lstatSync(destination);if(!stat.isSymbolicLink())continue;if(readlinkSync(destination)!==source)throw new Error('Unsafe configuration link');}else this.link(destination,source);}
  const destination=join(workspace.codexHome,'auth.json');
  if(present(destination)) {const stat=lstatSync(destination);if(stat.isSymbolicLink()){const target=readlinkSync(destination);const filename=basename(target);if(dirname(target)!==this.options.loginsDir||!filename.endsWith('.json')||!ID.test(filename.slice(0,-5)))throw new Error('Unsafe auth link');}else if(!stat.isFile())throw new Error('Unsafe runtime auth');}
  if(options.preserveRefresh !== false && auth && present(destination) && !lstatSync(destination).isSymbolicLink() && !this.runtimeAccounts.has(workspaceId) && accountId===this.state.accountId && workspaceId===this.state.workspaceId) {
   regular(destination);const refreshed=readFileSync(destination,'utf8');const identity=tokenData(JSON.parse(refreshed)).identity;
   if(!identity || identity!==this.account(accountId).identity)throw new Error('Runtime identity mismatch');
   atomic(auth,refreshed);
  }
  if(auth) this.link(destination,auth);else if(present(destination))unlinkSync(destination);
  this.runtimeAccounts.set(workspaceId,accountId);return {codexHome:workspace.codexHome,cwd:workspace.path};
 }
 private accountRuntimeHome(accountId:string,workspaceId:string) { this.account(accountId);this.workspace(workspaceId);return join(this.options.stateDir,'runtime-homes',accountId,workspaceId); }
 private vaultFingerprint(path:string) { regular(path);return createHash('sha256').update(readFileSync(path)).digest('hex'); }
 // Call only while the account's app-server is stopped. A running process may replace auth.json.
 prepareAccountRuntime(accountId:string,workspaceId:string) {
  this.requirePrepared();const workspace=this.workspace(workspaceId);const auth=this.authPath(accountId);const home=this.accountRuntimeHome(accountId,workspaceId);
  directories(home,true);chmodSync(home,0o700);directories(workspace.path,true);
  for(const name of CONFIG_ASSETS) {const source=join(this.options.defaultHome,name);if(!present(source))continue;const destination=join(home,name);if(present(destination)) {const stat=lstatSync(destination);if(!stat.isSymbolicLink() || readlinkSync(destination)!==source)throw new Error('Unsafe configuration link');}else this.link(destination,source);}
  const destination=join(home,'auth.json');const snapshot=join(home,'.vault-fingerprint');
  if(present(snapshot))regular(snapshot);
  if(present(destination)) {
   const stat=lstatSync(destination);
   if(stat.isSymbolicLink()) {if(readlinkSync(destination)!==auth)throw new Error('Unsafe runtime auth link');}
   else {
    regular(destination);const raw=readFileSync(destination,'utf8');const data=tokenData(JSON.parse(raw));const account=this.account(accountId);
    if(!account.identity || account.identity!==data.identity)throw new Error('Runtime identity mismatch');
    if(!present(snapshot) || readFileSync(snapshot,'utf8')!==this.vaultFingerprint(auth))throw new Error('Runtime auth conflicts with vault');
    atomic(auth,raw);this.link(destination,auth);
   }
  } else this.link(destination,auth);
  const fingerprint=this.vaultFingerprint(auth);atomic(snapshot,fingerprint);this.accountRuntimeVaults.set(JSON.stringify([accountId,workspaceId]),fingerprint);
  return {codexHome:home,cwd:workspace.path};
 }
 // Call only after the account's app-server has stopped.
 saveAccountRuntimeAuth(accountId:string,workspaceId:string) {
  this.requirePrepared();const home=this.accountRuntimeHome(accountId,workspaceId);directories(home);const target=this.authPath(accountId);const source=join(home,'auth.json');const stat=lstatSync(source);
  if(stat.isSymbolicLink()) {if(readlinkSync(source)!==target)throw new Error('Unsafe runtime auth link');return;}
  regular(source);const raw=readFileSync(source,'utf8');const data=tokenData(JSON.parse(raw));const account=this.account(accountId);
  if(!account.identity || account.identity!==data.identity)throw new Error('Runtime identity mismatch');
  const fingerprint=this.accountRuntimeVaults.get(JSON.stringify([accountId,workspaceId]));if(!fingerprint || fingerprint!==this.vaultFingerprint(target))throw new Error('Runtime auth conflicts with vault');
  atomic(target,raw);this.link(source,target);const next=this.vaultFingerprint(target);atomic(join(home,'.vault-fingerprint'),next);this.accountRuntimeVaults.set(JSON.stringify([accountId,workspaceId]),next);
 }
 saveRuntimeAuth(accountId:string,workspaceId:string) {
  this.requirePrepared();const workspace=this.workspace(workspaceId);if(this.runtimeAccounts.get(workspaceId)!==accountId)throw new Error('Runtime account mismatch');const target=this.authPath(accountId);directories(workspace.codexHome);const source=join(workspace.codexHome,'auth.json');const stat=lstatSync(source);
  if(stat.isSymbolicLink()){if(readlinkSync(source)!==target)throw new Error('Unsafe runtime auth link');return;}
  regular(source);const raw=readFileSync(source,'utf8');const data=tokenData(JSON.parse(raw));const account=this.account(accountId);if(account.identity && account.identity!==data.identity)throw new Error('Runtime identity mismatch');atomic(target,raw);this.link(source,target);
 }
}
