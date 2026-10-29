import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../account-store';
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive:true, force:true }); });
function auth(email = 'first\x40example.test', account = 'account-1') {
 const token = Buffer.from(JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_account_id:account, chatgpt_plan_type:'plus' } })).toString('base64url');
 return { tokens:{ id_token:`header.${token}.signature`, access_token:'secret-access', refresh_token:'secret-refresh', account_id:account } };
}
function setup(withAuth = true) {
 const root=mkdtempSync(join(tmpdir(),'account-store-')); roots.push(root);
 const opts={ defaultHome:join(root,'.codex'), loginsDir:join(root,'.codex-logins'), stateDir:join(root,'.webui'), workspaces:[{id:'legacy',label:'legacy',path:join(root,'legacy'),codexHome:join(root,'.legacy')},{id:'workspace',label:'workspace',path:join(root,'workspace'),codexHome:join(root,'.workspace')}] };
 mkdirSync(opts.defaultHome); if(withAuth) writeFileSync(join(opts.defaultHome,'auth.json'),JSON.stringify(auth()));
 writeFileSync(join(opts.defaultHome,'config.toml'),'model = "example"'); mkdirSync(join(opts.defaultHome,'skills'));
 return { root,opts,store:new AccountStore(opts) };
}
test('imports once, protects auth, shares configuration and isolates histories',()=>{
 const {opts,store}=setup(); const original=readFileSync(join(opts.defaultHome,'auth.json'),'utf8'); store.prepare();
 expect(store.getState().accountId).toBe('default'); expect(store.getState().workspaceId).toBe('legacy');
 expect(store.getState().accounts[0]).toEqual({id:'default',label:'first\x40example.test',email:'first\x40example.test',planType:'plus',active:true});
 const first=store.prepareWorkspace('default','legacy'); const second=store.prepareWorkspace('default','workspace');
 expect(first).toEqual({cwd:opts.workspaces[0].path,codexHome:opts.workspaces[0].codexHome});
 expect(readlinkSync(join(first.codexHome,'auth.json'))).toBe(store.authPath('default'));
 expect(readlinkSync(join(first.codexHome,'config.toml'))).toBe(join(opts.defaultHome,'config.toml'));
 expect(readlinkSync(join(second.codexHome,'skills'))).toBe(join(opts.defaultHome,'skills'));
 writeFileSync(join(first.codexHome,'history.jsonl'),'private legacy history'); expect(existsSync(join(second.codexHome,'history.jsonl'))).toBe(false);
 expect(readFileSync(join(opts.defaultHome,'auth.json'),'utf8')).toBe(original);
 writeFileSync(join(opts.defaultHome,'auth.json'),JSON.stringify(auth('changed\x40example.test'))); store.prepare();
 expect(readFileSync(store.authPath('default'),'utf8')).toBe(original);
 expect(lstatSync(opts.loginsDir).mode & 0o777).toBe(0o700); expect(lstatSync(store.authPath('default')).mode & 0o777).toBe(0o600);
 expect(readdirSync(opts.loginsDir)).toEqual(['default.json']);
 expect(JSON.stringify(store.getState())).not.toMatch(/secret-access|secret-refresh|id_token|signature/);
});
test('adds, deduplicates, renames, persists selections and removes inactive accounts',()=>{
 const {opts,store}=setup(); store.prepare(); const added=store.addAuth(auth('second\x40example.test','account-2'),'Work');
 expect(added.label).toBe('Work'); expect(added.active).toBe(false);
 expect(store.addAuth(auth('second\x40example.test','account-2')).id).toBe(added.id);
 store.rename(added.id,'Updated'); store.commitSelection(added.id,'workspace');
 const reload=new AccountStore(opts); reload.prepare(); expect(reload.getState().accountId).toBe(added.id); expect(reload.getState().workspaceId).toBe('workspace'); expect(reload.getState().accounts.find(a=>a.id===added.id)?.label).toBe('Updated');
 expect(()=>reload.remove(added.id)).toThrow(); reload.remove('default'); expect(existsSync(join(opts.loginsDir,'default.json'))).toBe(false);
 reload.prepare(); expect(reload.getState().accounts.map(a=>a.id)).toEqual([added.id]);
 expect(JSON.stringify(readdirSync(opts.stateDir).map(f=>readFileSync(join(opts.stateDir,f),'utf8')))).not.toMatch(/secret-access|secret-refresh|id_token/);
});
test('rejects malformed auth, traversal and symlink escapes without touching targets',()=>{
 const {root,opts,store}=setup(); store.prepare();
 for(const raw of [{},{tokens:{}},{tokens:{access_token:'x'}},{tokens:{access_token:'x',refresh_token:'r',id_token:'invalid'}}]) expect(()=>store.addAuth(raw)).toThrow();
 for(const id of ['../escape','/tmp/escape','default/../default','constructor','']) expect(()=>store.authPath(id)).toThrow();
 expect(()=>store.prepareWorkspace('default','../escape')).toThrow(); expect(()=>store.commitSelection('missing','legacy')).toThrow();
 const outside=join(root,'outside'); writeFileSync(outside,'unchanged'); const added=store.addAuth(auth('second\x40example.test','account-2'));
 rmSync(store.authPath(added.id)); symlinkSync(outside,join(opts.loginsDir,`${added.id}.json`));
 expect(()=>store.authPath(added.id)).toThrow(); expect(()=>store.remove(added.id)).toThrow(); expect(readFileSync(outside,'utf8')).toBe('unchanged');
});
test('rejects symlinked vault directories and preserves existing runtime history',()=>{
 const {root,opts,store}=setup(); mkdirSync(opts.workspaces[0].codexHome); writeFileSync(join(opts.workspaces[0].codexHome,'history.jsonl'),'existing'); store.prepare(); store.prepareWorkspace('default','legacy'); expect(readFileSync(join(opts.workspaces[0].codexHome,'history.jsonl'),'utf8')).toBe('existing');
 const other=join(root,'other');mkdirSync(other); const bad=new AccountStore({...opts,loginsDir:join(root,'vault-link')});symlinkSync(other,join(root,'vault-link'));expect(()=>bad.prepare()).toThrow();expect(readdirSync(other)).toEqual([]);
});
test('allows login bootstrap without auth and saves atomically refreshed runtime auth',()=>{
 const empty=setup(false);empty.store.prepare();expect(empty.store.getState().accountId).toBe('');const bootstrap=empty.store.prepareWorkspace('','legacy');expect(existsSync(join(bootstrap.codexHome,'auth.json'))).toBe(false);
 const {store}=setup();store.prepare();const runtime=store.prepareWorkspace('default','legacy');rmSync(join(runtime.codexHome,'auth.json'));writeFileSync(join(runtime.codexHome,'auth.json'),JSON.stringify({...auth(),last_refresh:'new'}));
 store.saveRuntimeAuth('default','legacy');expect(JSON.parse(readFileSync(store.authPath('default'),'utf8')).last_refresh).toBe('new');expect(readlinkSync(join(runtime.codexHome,'auth.json'))).toBe(store.authPath('default'));
 expect(()=>store.saveRuntimeAuth('default','workspace')).toThrow();
});
test('can revisit a workspace after deleting its previously selected account',()=>{
 const {store}=setup();store.prepare();store.prepareWorkspace('default','legacy');const added=store.addAuth(auth('second\x40example.test','account-2'));store.prepareWorkspace(added.id,'workspace');store.commitSelection(added.id,'workspace');store.remove('default');const runtime=store.prepareWorkspace(added.id,'legacy');expect(readlinkSync(join(runtime.codexHome,'auth.json'))).toBe(store.authPath(added.id));
});
test('rejects storage paths nested inside the original Codex home',()=>{
 const {opts}=setup();expect(()=>new AccountStore({...opts,loginsDir:join(opts.defaultHome,'logins')})).toThrow();
});
test('persists a workspace selection before first login',()=>{
 const {opts,store}=setup(false);store.prepare();store.commitSelection('','workspace');const reload=new AccountStore(opts);reload.prepare();expect(reload.getState().workspaceId).toBe('workspace');
 const existing=setup();existing.store.prepare();expect(()=>existing.store.commitSelection('','workspace')).toThrow();
});
test('preserves refreshed auth in selected workspace across process restart',()=>{
 const {opts,store}=setup();store.prepare();const runtime=store.prepareWorkspace('default','legacy');rmSync(join(runtime.codexHome,'auth.json'));writeFileSync(join(runtime.codexHome,'auth.json'),JSON.stringify({...auth(),last_refresh:'restart-refresh'}));const reload=new AccountStore(opts);reload.prepare();reload.prepareWorkspace('default','legacy');expect(JSON.parse(readFileSync(reload.authPath('default'),'utf8')).last_refresh).toBe('restart-refresh');
});
test('finds an existing auth identity without mutating vault or leaking tokens',()=>{
 const {opts,store}=setup();store.prepare();const before=readFileSync(store.authPath('default'),'utf8');const metadata=JSON.stringify(store.getState());
 const fresh={...auth(),tokens:{...auth().tokens,access_token:'fresh-access',refresh_token:'fresh-refresh'}};
 expect(store.findAuthAccount(fresh)).toEqual(store.getState().accounts[0]);
 expect(store.findAuthAccount(auth('other\x40example.test','other-account'))).toBeNull();
 expect(JSON.stringify(store.findAuthAccount(fresh))).not.toMatch(/secret-access|secret-refresh|fresh-access|fresh-refresh|id_token/);
 expect(readFileSync(store.authPath('default'),'utf8')).toBe(before);expect(JSON.stringify(store.getState())).toBe(metadata);expect(readdirSync(opts.loginsDir)).toEqual(['default.json']);
 expect(()=>store.findAuthAccount({tokens:{}})).toThrow();
});
test('explicit coordinated relink preserves newly saved login over stale regular runtime auth',()=>{
 const {opts,store}=setup();store.prepare();const runtime=store.prepareWorkspace('default','legacy');rmSync(join(runtime.codexHome,'auth.json'));writeFileSync(join(runtime.codexHome,'auth.json'),JSON.stringify({...auth(),last_refresh:'old-runtime'}));
 const reload=new AccountStore(opts);reload.prepare();const fresh={...auth(),last_refresh:'fresh-login'};reload.addAuth(fresh);reload.prepareWorkspace('default','legacy',{preserveRefresh:false});
 expect(JSON.parse(readFileSync(reload.authPath('default'),'utf8')).last_refresh).toBe('fresh-login');expect(readlinkSync(join(runtime.codexHome,'auth.json'))).toBe(reload.authPath('default'));
});
test('account runtime homes keep credentials and histories separate across workspace changes',()=>{
 const {opts,store}=setup();store.prepare();const added=store.addAuth(auth('second\x40example.test','account-2'));
 const first=store.prepareAccountRuntime('default','legacy');const second=store.prepareAccountRuntime(added.id,'legacy');
 expect(first.codexHome).not.toBe(second.codexHome);expect(first.cwd).toBe(opts.workspaces[0].path);
 expect(readlinkSync(join(first.codexHome,'auth.json'))).toBe(store.authPath('default'));
 expect(readlinkSync(join(second.codexHome,'auth.json'))).toBe(store.authPath(added.id));
 expect(readlinkSync(join(first.codexHome,'config.toml'))).toBe(join(opts.defaultHome,'config.toml'));
 writeFileSync(join(first.codexHome,'history.jsonl'),'first history');
 expect(existsSync(join(second.codexHome,'history.jsonl'))).toBe(false);
 const otherWorkspace=store.prepareAccountRuntime('default','workspace');expect(otherWorkspace.codexHome).not.toBe(first.codexHome);expect(otherWorkspace.cwd).toBe(opts.workspaces[1].path);expect(existsSync(join(otherWorkspace.codexHome,'history.jsonl'))).toBe(false);expect(readlinkSync(join(otherWorkspace.codexHome,'auth.json'))).toBe(store.authPath('default'));
 expect(readFileSync(join(first.codexHome,'history.jsonl'),'utf8')).toBe('first history');
});
test('account runtime refresh recovery validates identity and does not overwrite another account',()=>{
 const {opts,store}=setup();store.prepare();const added=store.addAuth(auth('second\x40example.test','account-2'));const first=store.prepareAccountRuntime('default','legacy');const other=store.prepareAccountRuntime(added.id,'legacy');
 rmSync(join(first.codexHome,'auth.json'));writeFileSync(join(first.codexHome,'auth.json'),JSON.stringify({...auth(),last_refresh:'updated'}));
 store.saveAccountRuntimeAuth('default','legacy');expect(JSON.parse(readFileSync(store.authPath('default'),'utf8')).last_refresh).toBe('updated');
 expect(JSON.parse(readFileSync(store.authPath(added.id),'utf8')).last_refresh).toBeUndefined();
 rmSync(join(other.codexHome,'auth.json'));writeFileSync(join(other.codexHome,'auth.json'),JSON.stringify(auth()));
 expect(()=>store.saveAccountRuntimeAuth(added.id,'legacy')).toThrow('identity');
 expect(JSON.parse(readFileSync(store.authPath(added.id),'utf8')).tokens.account_id).toBe('account-2');
 const reload=new AccountStore(opts);reload.prepare();expect(()=>reload.prepareAccountRuntime(added.id,'legacy')).toThrow('identity');
});
test('account runtime rejects symlinked runtime directories and auth escapes',()=>{
 const {root,opts,store}=setup();store.prepare();const outside=join(root,'outside');mkdirSync(outside);mkdirSync(join(opts.stateDir,'runtime-homes'));symlinkSync(outside,join(opts.stateDir,'runtime-homes','default'));
 expect(()=>store.prepareAccountRuntime('default','legacy')).toThrow();expect(readdirSync(outside)).toEqual([]);
 rmSync(join(opts.stateDir,'runtime-homes','default'));const runtime=store.prepareAccountRuntime('default','legacy');rmSync(join(runtime.codexHome,'auth.json'));symlinkSync(join(outside,'auth.json'),join(runtime.codexHome,'auth.json'));
 expect(()=>store.prepareAccountRuntime('default','legacy')).toThrow();expect(()=>store.saveAccountRuntimeAuth('default','legacy')).toThrow();
});
test('refuses to overwrite a newer vault login with a runtime refresh',()=>{
 const {store}=setup();store.prepare();const runtime=store.prepareAccountRuntime('default','legacy');
 rmSync(join(runtime.codexHome,'auth.json'));writeFileSync(join(runtime.codexHome,'auth.json'),JSON.stringify({...auth(),last_refresh:'runtime'}));
 store.addAuth({...auth(),last_refresh:'new-login'});
 expect(()=>store.saveAccountRuntimeAuth('default','legacy')).toThrow('conflicts');
 expect(JSON.parse(readFileSync(store.authPath('default'),'utf8')).last_refresh).toBe('new-login');
});
test('recovers an unchanged account vault from a runtime refresh after restart',()=>{
 const {opts,store}=setup();store.prepare();const home=store.prepareAccountRuntime('default','legacy').codexHome;
 rmSync(join(home,'auth.json'));writeFileSync(join(home,'auth.json'),JSON.stringify({...auth(),last_refresh:'recovered'}));
 const reload=new AccountStore(opts);reload.prepare();reload.prepareAccountRuntime('default','legacy');
 expect(JSON.parse(readFileSync(reload.authPath('default'),'utf8')).last_refresh).toBe('recovered');
 expect(readlinkSync(join(home,'auth.json'))).toBe(reload.authPath('default'));
});
test('refuses restart recovery after vault changed or snapshot is symlinked',()=>{
 const {root,opts,store}=setup();store.prepare();const home=store.prepareAccountRuntime('default','legacy').codexHome;
 rmSync(join(home,'auth.json'));writeFileSync(join(home,'auth.json'),JSON.stringify({...auth(),last_refresh:'stale'}));store.addAuth({...auth(),last_refresh:'new-login'});
 const reload=new AccountStore(opts);reload.prepare();expect(()=>reload.prepareAccountRuntime('default','legacy')).toThrow('conflict');
 expect(JSON.parse(readFileSync(reload.authPath('default'),'utf8')).last_refresh).toBe('new-login');
 const snapshot=join(home,'.vault-fingerprint');rmSync(snapshot);const outside=join(root,'outside');writeFileSync(outside,'unchanged');symlinkSync(outside,snapshot);
 expect(()=>reload.prepareAccountRuntime('default','legacy')).toThrow();expect(readFileSync(outside,'utf8')).toBe('unchanged');
});
