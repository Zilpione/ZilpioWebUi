import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { AccountStore } from '../account-store.ts';

const root = new URL('..', import.meta.url).pathname;
let temp:string, base:string, child:any, authBefore:string;
const headers = {authorization:'Bearer runtime-test-secret', 'content-type':'application/json'};
async function api(path:string, method='GET', data?:any) {
 return fetch(base+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
}
async function rpc(method:string,params:any={}) {const {runtimeRevision}=await (await api('/api/config')).json();return (await (await api('/api/rpc','POST',{id:1,method,params,runtimeRevision})).json()).result;}
async function ready(){for(let i=0;i<150;i++){try{const r=await api('/api/health');if((await r.json()).codex)return;}catch{}await Bun.sleep(30);}throw Error('server not ready');}
beforeAll(async()=>{
 temp=mkdtempSync(join(tmpdir(),'webui-runtime-'));
 const home=join(temp,'home'), codexHome=join(home,'.codex'),bin=join(temp,'bin');
 mkdirSync(codexHome,{recursive:true});mkdirSync(bin);
 authBefore=JSON.stringify({tokens:{access_token:'secret-access',refresh_token:'secret-refresh',id_token:'x.'+Buffer.from(JSON.stringify({email:'test@example.invalid','https://api.openai.com/auth':{chatgpt_account_id:'initial',chatgpt_plan_type:'plus'}})).toString('base64url')+'.x',account_id:'initial'}});
 writeFileSync(join(codexHome,'auth.json'),authBefore);writeFileSync(join(codexHome,'config.toml'),'model = "test"\n');
 writeFileSync(join(bin,'codex'),`#!/usr/bin/env bun
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
const threadsFile=join(process.env.CODEX_HOME,'test-threads.json');
const threads=()=>existsSync(threadsFile)?JSON.parse(readFileSync(threadsFile,'utf8')):[];
const rl=createInterface({input:process.stdin});
for await (const line of rl){let m=JSON.parse(line);if(m.id===undefined)continue;let result={};
if(m.method==='initialize')result={codexHome:process.env.CODEX_HOME};
if(m.method==='account/read')result={account:{type:'chatgpt',email:'test@example.invalid',planType:'plus'}};
if(m.method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:23,windowDurationMins:300,resetsAt:1900000000},secondary:{usedPercent:48,windowDurationMins:10080,resetsAt:1900500000}}};
if(m.method==='thread/list')result={data:threads(),nextCursor:null};
if(m.method==='thread/start'){const data=threads();const thread={id:'thread-'+randomUUID(),cwd:m.params.cwd};data.push(thread);writeFileSync(threadsFile,JSON.stringify(data));result={thread};}
if(m.method==='thread/name/set'){const data=threads();const thread=data.find(t=>t.id===m.params.threadId);if(!thread)throw Error('thread not found');thread.name=m.params.name;writeFileSync(threadsFile,JSON.stringify(data));process.stdout.write(JSON.stringify({method:'thread/name/updated',params:{threadId:thread.id,name:thread.name}})+'\\n');}
if(m.method==='turn/start'){process.stdout.write(JSON.stringify({method:'turn/started',params:{threadId:'thread-test',turn:{id:'turn-test',status:'inProgress'}}})+'\\n');result={turn:{id:'turn-test',status:'inProgress'}};}
if(m.method==='thread/delete'&&m.params.threadId==='crash')process.exit(1);
if(m.method==='turn/interrupt')process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'interrupted'}}})+'\\n');
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}
`,{mode:0o755});
 const store=new AccountStore({defaultHome:codexHome,loginsDir:join(home,'.codex-logins'),stateDir:join(home,'.webui'),workspaces:[{id:'El',label:'El',path:join(home,'el'),codexHome:join(home,'.El')},{id:'zilpio',label:'zilpio',path:join(home,'zilpio'),codexHome:join(home,'.zilpio')}]});
 store.prepare();
 store.addAuth({tokens:{id_token:'x.'+Buffer.from(JSON.stringify({email:'second@example.invalid','https://api.openai.com/auth':{chatgpt_account_id:'second',chatgpt_plan_type:'plus'}})).toString('base64url')+'.x',access_token:'second-access',refresh_token:'second-refresh',account_id:'second'}},'Second account');
 const port=await new Promise<number>(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=(s.address() as any).port;s.close(()=>resolve(p));});});
 base='http://127.0.0.1:'+port;
 child=Bun.spawn(['bun','run','server.ts'],{cwd:root,env:{...process.env,PATH:bin+':'+process.env.PATH,HOME:home,CODEX_HOME:codexHome,CODEX_WEBUI_MANAGED_ACCOUNTS:'true',CODEX_WEBUI_CONTAINER_RESTART:'true',HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_ACCESS_TOKEN:'runtime-test-secret',CODEX_WEBUI_PASSWORD:'',CODEX_WEBUI_PROJECTLESS:'false',CODEX_WEBUI_WORKSPACE_BASE:home},stdout:'ignore',stderr:'pipe'});
 await ready();
},15000);
afterAll(async()=>{child?.kill();if(child)await child.exited;rmSync(temp,{recursive:true,force:true});});
test('renames a chat through the managed browser RPC and persists its name',async()=>{
 const started=await rpc('thread/start',{cwd:join(temp,'home','el')});
 const {runtimeRevision}=await (await api('/api/config')).json();
 const renamed=await (await api('/api/rpc','POST',{id:301,method:'thread/name/set',params:{threadId:started.thread.id,name:'Nome di prova'},runtimeRevision})).json();
 expect(renamed.type).toBe('rpc/result');
 expect((await rpc('thread/list')).data.find((thread:any)=>thread.id===started.thread.id).name).toBe('Nome di prova');
});
test('management and usage require authentication through proxy',async()=>{
 for(const path of ['/api/runtime','/api/usage','/api/accounts/login'])expect((await fetch(base+path,{headers:{host:'public.example'}})).status).toBe(401);
});
test('login delay increases across client IPs and rejects concurrent attempts',async()=>{
 const login=(password:string)=>fetch(base+'/api/auth/login',{method:'POST',headers:{host:'public.example','content-type':'application/json'},body:JSON.stringify({password})});
 const start=Date.now(), first=login('wrong');
 await Bun.sleep(100);
 expect((await login('runtime-test-secret')).status).toBe(400);
 expect((await first).status).toBe(401);
 expect(Date.now()-start).toBeGreaterThanOrEqual(1900);
 const secondStart=Date.now();
 const secondStatus=await new Promise<number>((resolve,reject)=>{
  const req=httpRequest(base+'/api/auth/login',{method:'POST',localAddress:'127.0.0.2',headers:{host:'public.example','content-type':'application/json'}},res=>{res.resume();resolve(res.statusCode!);});
  req.on('error',reject);req.end(JSON.stringify({password:'runtime-test-secret'}));
 });
 expect(secondStatus).toBe(200);
 expect(Date.now()-secondStart).toBeGreaterThanOrEqual(3900);
},10000);
test('publishes only Zilpio and account metadata without credentials',async()=>{
 const response=await api('/api/runtime');expect(response.status).toBe(200);const state=await response.json();
 expect(state.environments.map((w:any)=>w.label)).toEqual(['Zilpio']);expect(state.environments.every((w:any)=>!('path' in w))).toBe(true);expect(state.accounts).toHaveLength(2);expect(state.accountId).toBe('default');
 expect(JSON.stringify(state)).not.toContain('secret-access');expect(JSON.stringify(state)).not.toContain('secret-refresh');
 expect((await (await api('/api/usage')).json()).rateLimits.primary.usedPercent).toBe(23);
});
test('keeps a single history, default auth and shared configuration',async()=>{
 const state=await (await api('/api/runtime')).json();
 expect((await api('/api/runtime/switch','POST',{environmentId:'zilpio'})).status).toBe(200);
 const config=await (await api('/api/config')).json();expect(config.defaultCwd).toBe(join(temp,'home','zilpio'));expect(config.environmentId).toBe('zilpio');
 expect((await (await api('/api/runtime')).json()).runtimeRevision).toBe(state.runtimeRevision);
 expect(readFileSync(join(temp,'home','.codex','auth.json'),'utf8')).toBe(authBefore);
 expect(readFileSync(join(temp,'home','.zilpio','config.toml'),'utf8')).toBe('model = "test"\n');
 const folders=await (await api('/api/folders?path=~')).json();expect(folders.folders.map((f:any)=>f.name)).toEqual(['el','zilpio']);
 expect((await api('/api/folders?path='+encodeURIComponent(join(temp,'home','.codex')))).status).toBe(400);
});

test('rejects El and outside-root project cwd while allowing harmless Zilpio selections during a turn',async()=>{
 expect((await api('/api/runtime/switch','POST',{accountId:'../escape'})).status).toBe(400);
 const {runtimeRevision}=await (await api('/api/config')).json();
 const bad=await (await api('/api/rpc','POST',{id:9,method:'thread/start',params:{cwd:'/tmp'},runtimeRevision})).json();expect(bad.type).toBe('rpc/error');expect(bad.error).toContain('outside allowed roots');
 await rpc('thread/start',{cwd:join(temp,'home','zilpio')});await rpc('turn/start',{threadId:'thread-test',input:[]});
 const state=await (await api('/api/runtime')).json();expect((await api('/api/runtime/switch','POST',{environmentId:'El'})).status).toBe(400);
 await rpc('turn/interrupt',{threadId:'thread-test',turnId:'turn-test'});
 expect((await api('/api/runtime/switch','POST',{environmentId:state.environments[0].id})).status).toBe(200);
});

test('app-server recovers after a crash without an environment switch',async()=>{
 await rpc('turn/start',{threadId:'thread-test',input:[]});
 await rpc('thread/delete',{threadId:'crash'});
 await Bun.sleep(1200);await ready();
 expect((await api('/api/runtime/switch','POST',{environmentId:'zilpio'})).status).toBe(200);
 expect((await rpc('thread/list')).data.length).toBeGreaterThan(0);
});

test('rejects stale runtime revisions and reconnect advertises the current revision',async()=>{
 const current=await (await api('/api/runtime')).json(),staleRevision='previous-process';
 const stale=await (await api('/api/rpc','POST',{id:77,method:'turn/start',params:{threadId:'thread-test',input:[]},runtimeRevision:staleRevision})).json();
 expect(stale.type).toBe('rpc/error');expect(stale.error).toContain('ricarica');
 const response=await api('/api/events');const reader=response.body!.getReader();const initial=new TextDecoder().decode((await reader.read()).value);await reader.cancel();
 expect(initial).toContain(current.runtimeRevision);
 const staleApproval=await api('/api/codex/respond','POST',{requestId:1,result:{decision:'accept'},runtimeRevision:staleRevision});expect(staleApproval.status).toBe(400);
 expect((await api('/api/runtime/switch','POST',{environmentId:'zilpio',expectedRevision:staleRevision})).status).toBe(409);
});

test('selects accounts per chat without changing the global account or auth files',async()=>{
 const before=await (await api('/api/runtime')).json();const second=before.accounts.find((a:any)=>a.id!=='default');
 const state=await (await api('/api/runtime')).json();expect(state.accountId).toBe('default');expect(state.environmentId).toBe(before.environmentId);expect(state.runtimeRevision).toBe(before.runtimeRevision);
 const home=state.environmentId==='El'?'.El':'.zilpio';
 const cwd=join(temp,'home',state.environmentId==='El'?'el':'zilpio');
 const hidden=join(temp,'home','.webui','runtime-homes',second.id,state.environmentId==='El'?'zilpio':'El','sessions','2026','10','unlisted.jsonl');
 mkdirSync(join(hidden,'..'),{recursive:true});writeFileSync(hidden,'unlisted history');
 expect((await api('/api/accounts/'+second.id,'DELETE')).status).toBe(409);
 rmSync(hidden);
 const archive=join(temp,'home','.webui','runtime-homes',second.id,state.environmentId==='El'?'zilpio':'El','archived_sessions');
 symlinkSync(join(hidden,'..'),archive);
 expect((await api('/api/accounts/'+second.id,'DELETE')).status).toBe(409);
 rmSync(archive);
 const selected=await (await api('/api/rpc','POST',{id:401,accountId:second.id,method:'thread/start',params:{cwd},runtimeRevision:state.runtimeRevision})).json();expect(selected.type).toBe('rpc/result');
 const secondList=await (await api('/api/rpc','POST',{id:402,accountId:second.id,method:'thread/list',params:{},runtimeRevision:state.runtimeRevision})).json();expect(secondList.result.data.some((t:any)=>t.id===selected.result.thread.id)).toBe(true);
 expect(JSON.parse(readFileSync(join(temp,'home',home,'auth.json'),'utf8')).tokens.account_id).toBe('initial');
 expect(readFileSync(join(temp,'home','.codex','auth.json'),'utf8')).toBe(authBefore);
 expect((await api('/api/accounts/'+second.id,'PATCH',{label:'Renamed account'})).status).toBe(200);
 expect((await api('/api/accounts/'+second.id,'DELETE')).status).toBe(409);
});

test('projects from both mounted roots use the same Zilpio history without restarting',async()=>{
 const alpha=join(temp,'home','el','alpha'),beta=join(temp,'home','zilpio','beta');
 mkdirSync(alpha,{recursive:true});mkdirSync(beta,{recursive:true});
 const before=await (await api('/api/runtime')).json();
 const a=await rpc('thread/start',{cwd:alpha});const b=await rpc('thread/start',{cwd:beta});
 expect(a.thread.cwd).toBe(alpha);expect(b.thread.cwd).toBe(beta);
 expect((await api('/api/runtime/switch','POST',{environmentId:'El'})).status).toBe(400);
 expect((await api('/api/runtime/switch','POST',{environmentId:'zilpio'})).status).toBe(200);
 const after=await (await api('/api/runtime')).json();expect(after.environmentId).toBe('zilpio');expect(after.runtimeRevision).toBe(before.runtimeRevision);
 const chats=await rpc('thread/list');expect(chats.data.some((t:any)=>t.cwd===alpha)).toBe(true);expect(chats.data.some((t:any)=>t.cwd===beta)).toBe(true);
});

test('virtual project root is non-selectable and parent navigation cannot expose account storage',async()=>{
 const root=await (await api('/api/folders?path=~')).json();expect(root.selectable).toBe(false);expect(root.parent).toBeNull();
 for(const folder of root.folders){const listing=await (await api('/api/folders?path='+encodeURIComponent(folder.path))).json();expect(listing.parent).toBe(root.path);}
 const escape=join(temp,'home','el','auth-link');symlinkSync(join(temp,'home','.codex'),escape);
 expect((await api('/api/folders?path='+encodeURIComponent(escape))).status).toBe(400);
 const {runtimeRevision}=await (await api('/api/config')).json();
 const denied=await (await api('/api/rpc','POST',{id:91,method:'thread/start',params:{cwd:escape},runtimeRevision})).json();expect(denied.type).toBe('rpc/error');
 const unavailable=await (await api('/api/rpc','POST',{id:92,method:'thread/start',params:{cwd:root.path},runtimeRevision})).json();expect(unavailable.type).toBe('rpc/error');
});

test('creates a project without changing environment, account, revision or existing history',async()=>{
 const before=await (await api('/api/runtime')).json();const cwd=join(temp,'home','el');
 expect((await fetch(base+'/api/projects',{method:'POST',headers:{host:'public.example','content-type':'application/json'},body:JSON.stringify({parent:cwd,name:'blocked'})})).status).toBe(401);
 const response=await api('/api/projects','POST',{parent:cwd,name:'Created project'});expect(response.status).toBe(201);const project=await response.json();expect(project.path).toBe(join(cwd,'Created project'));
 expect((await (await api('/api/folders?path='+encodeURIComponent(cwd))).json()).folders.some((p:any)=>p.name==='Created project')).toBe(true);
 expect(await (await api('/api/runtime')).json()).toEqual(before);
 expect((await api('/api/projects','POST',{parent:cwd,name:'Created project'})).status).toBe(409);
 expect((await api('/api/projects','POST',{parent:join(temp,'home'),name:'outside'})).status).toBe(400);
 expect((await api('/api/projects','POST',{parent:cwd,name:'../outside'})).status).toBe(400);
});

test('project appearance and list removal persist without deleting files, chats or changing runtime',async()=>{
 const parent=join(temp,'home','el');const response=await api('/api/projects','POST',{parent,name:'Styled project'});expect(response.status).toBe(201);const project=await response.json();
 writeFileSync(join(project.path,'keep.txt'),'preserved');const thread=await rpc('thread/start',{cwd:project.path});expect(thread.thread.cwd).toBe(project.path);
 const before=await (await api('/api/runtime')).json();const threadsBefore=await rpc('thread/list');
 const styled=await api('/api/projects','PATCH',{path:project.path,color:'#3366FF',icon:'rocket'});expect(styled.status).toBe(200);
 expect((await styled.json()).project).toMatchObject({color:'#3366ff',icon:'rocket',hidden:false});
 expect((await api('/api/projects','DELETE',{path:project.path})).status).toBe(200);
 const data=await (await api('/api/projects')).json();expect(data.projects.find((p:any)=>p.path===project.path)).toMatchObject({hidden:true,color:'#3366ff',icon:'rocket'});
 expect(readFileSync(join(project.path,'keep.txt'),'utf8')).toBe('preserved');expect(await rpc('thread/list')).toEqual(threadsBefore);expect(await (await api('/api/runtime')).json()).toEqual(before);
 expect((await api('/api/projects','PATCH',{path:project.path,hidden:false})).status).toBe(200);
 expect((await api('/api/projects','PATCH',{path:'/etc',color:'#ffffff'})).status).toBe(400);
 expect((await api('/api/projects','PATCH',{path:project.path,icon:'<img>'})).status).toBe(400);
 for(const method of ['GET','PATCH','DELETE'])expect((await fetch(base+'/api/projects',{method,headers:{host:'public.example','content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify({path:project.path})})})).status).toBe(401);
});


test('projects stay in Zilpio and cannot be moved to the removed El environment',async()=>{
 const folder=join(temp,'home','el','Former-El-project');mkdirSync(folder,{recursive:true});
 expect((await api('/api/projects','PATCH',{path:folder,icon:'star'})).status).toBe(200);
 expect((await api('/api/projects/move','POST',{path:folder,environmentId:'El'})).status).toBe(400);
 expect((await (await api('/api/projects')).json()).projects.find((p:any)=>p.path===folder)).toMatchObject({icon:'star',hidden:false});
});


test('changes the shared default account and can switch back',async()=>{
 const before=await (await api('/api/runtime')).json();const second=before.accounts.find((a:any)=>a.id!==before.accountId);
 const response=await api('/api/runtime/switch','POST',{accountId:second.id,expectedRevision:before.runtimeRevision});expect(response.status).toBe(200);
 const changed=await response.json();expect(changed.accountId).toBe(second.id);expect(changed.environmentId).toBe(before.environmentId);
 const restored=await api('/api/runtime/switch','POST',{accountId:before.accountId,expectedRevision:changed.runtimeRevision});expect(restored.status).toBe(200);
});

test('restarts Codex only when chats are idle and preserves the selected account', async()=>{
 await rpc('thread/start',{cwd:join(temp,'home','zilpio')});
 const before=await (await api('/api/runtime')).json();
 await rpc('turn/start',{threadId:'thread-test',input:[]});
 expect((await api('/api/runtime/restart','POST')).status).toBe(409);
 await rpc('turn/interrupt',{threadId:'thread-test',turnId:'turn-test'});
 const response=await api('/api/runtime/restart','POST');
 expect(response.status).toBe(200);
 const after=await (await api('/api/runtime')).json();
 expect(after.accountId).toBe(before.accountId);
 expect(after.runtimeRevision).not.toBe(before.runtimeRevision);
 expect((await rpc('thread/list')).data.length).toBeGreaterThan(0);
});

test('WebUI restart waits for active chats and shuts down once idle', async()=>{
 await rpc('turn/start',{threadId:'thread-test',input:[]});
 expect((await api('/api/webui/restart','POST')).status).toBe(409);
 await rpc('turn/interrupt',{threadId:'thread-test',turnId:'turn-test'});
 const response=await api('/api/webui/restart','POST');
 expect(response.status).toBe(200);
 const result=await response.json();expect(result.instanceId).toBeTruthy();
 expect(await Promise.race([child.exited,Bun.sleep(7000).then(()=>-1)])).toBe(0);
});
