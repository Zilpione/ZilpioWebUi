import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, linkSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { AccountStore } from '../account-store.ts';
import { ThreadOwnership } from '../thread-ownership.js';

const root = new URL('..', import.meta.url).pathname;
let temp: string, base: string, child: any, revision: string, secondId: string, launch: () => any;
const headers = { authorization: 'Bearer routing-secret', 'content-type': 'application/json' };
const api = (path: string, method = 'GET', data?: any) => fetch(base + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
async function rpc(accountId: string, method: string, params: any = {}) {
  return (await api('/api/rpc', 'POST', { id: 42, accountId, method, params, runtimeRevision: revision })).json();
}
const auth = (id: string) => ({ tokens: { account_id: id, access_token: id + '-access', refresh_token: id + '-refresh', id_token: 'x.' + Buffer.from(JSON.stringify({ email: id + '@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: id, chatgpt_plan_type: 'plus' } })).toString('base64url') + '.x' } });

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'webui-account-routing-'));
  const home = join(temp, 'home'), codexHome = join(home, '.codex'), bin = join(temp, 'bin');
  mkdirSync(codexHome, { recursive: true }); mkdirSync(bin);
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(auth('initial')));
  writeFileSync(join(codexHome, 'config.toml'), 'model = "test"\n');
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env bun
import {createInterface} from 'node:readline';
import {readFileSync,appendFileSync,mkdirSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
const account=JSON.parse(readFileSync(join(process.env.CODEX_HOME,'auth.json'),'utf8')).tokens.account_id;
appendFileSync(process.env.TEST_PID_FILE,String(process.pid)+'\\n');
const threads=[];
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.method==='initialized')continue;
 if(!m.method){if(m.id===7)send({method:'test/approvalReceived',params:{account,decision:m.result?.decision}});continue;}
 let result={};
 if(m.method==='initialize')result={codexHome:process.env.CODEX_HOME};
 if(m.method==='account/read')result={account:{type:'chatgpt',email:account+'@example.invalid',planType:'plus'}};
 if(m.method==='thread/start'){const id=m.params.testId||'thread-'+account;const path=join(process.env.CODEX_HOME,'sessions',id+'.jsonl');mkdirSync(join(process.env.CODEX_HOME,'sessions'),{recursive:true});writeFileSync(path,JSON.stringify({id})+'\\n');const thread={id,path,cwd:m.params.cwd};threads.push(thread);result={thread};}
 if(m.method==='thread/read'||m.method==='thread/resume'){const id=m.params.threadId,path=join(process.env.CODEX_HOME,'sessions',id+'.jsonl'),namePath=path+'.name';if(!existsSync(path)){send({id:m.id,error:{message:'missing thread'}});continue;}result={thread:{id,path,name:existsSync(namePath)?readFileSync(namePath,'utf8'):null}};}
 if(m.method==='thread/name/set')writeFileSync(join(process.env.CODEX_HOME,'sessions',m.params.threadId+'.jsonl.name'),m.params.name);
 if(m.method==='thread/list')result={data:threads,nextCursor:null};
 if(m.method==='thread/delete' && m.params.threadId==='crash')process.exit(1);
 if(m.method==='thread/delete' && m.params.threadId!=='crash') {
  const path=join(process.env.CODEX_HOME,'sessions',m.params.threadId+'.jsonl'), fail=process.env.TEST_PID_FILE+'.delete-fail';
  if(account==='second' && existsSync(fail)){unlinkSync(fail);send({id:m.id,error:{message:'injected failure'}});continue;}
  if(!existsSync(path)){send({id:m.id,error:{message:'no rollout'}});continue;}
  unlinkSync(path);const index=threads.findIndex(t=>t.id===m.params.threadId);if(index>=0)threads.splice(index,1);
 }

 if(m.method==='turn/start'){
  const threadId=m.params.threadId,turn={id:'turn-'+account,status:'inProgress'};
  send({method:'turn/started',params:{threadId,turn}});
  send({id:7,method:'item/commandExecution/requestApproval',params:{threadId,turnId:turn.id,itemId:'item-'+account}});
  result={turn};
 }
 send({id:m.id,result});
}
`, { mode: 0o755 });
  const store = new AccountStore({ defaultHome: codexHome, loginsDir: join(home, '.codex-logins'), stateDir: join(home, '.webui'), workspaces: [{ id: 'El', label: 'El', path: join(home, 'el'), codexHome: join(home, '.El') }, { id: 'zilpio', label: 'zilpio', path: join(home, 'zilpio'), codexHome: join(home, '.zilpio') }] });
  store.prepare(); store.addAuth(auth('second'), 'Second account');
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
  base = 'http://127.0.0.1:' + port;
  launch = () => Bun.spawn(['bun', 'run', 'server.ts'], { cwd: root, env: { ...process.env, PATH: bin + ':' + process.env.PATH, HOME: home, CODEX_HOME: codexHome, CODEX_WEBUI_MANAGED_ACCOUNTS: 'true', HOST: '127.0.0.1', PORT: String(port), CODEX_WEBUI_ACCESS_TOKEN: 'routing-secret', CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_PROJECTLESS: 'false', CODEX_WEBUI_WORKSPACE_BASE: home, TEST_PID_FILE: join(temp, 'pids') }, stdout: 'ignore', stderr: 'ignore' });
  child = launch();
  for (let i = 0; i < 150; i++) { try { if ((await (await api('/api/health')).json()).codex) break; } catch {} await Bun.sleep(30); }
  const state = await (await api('/api/runtime')).json();
  revision = state.runtimeRevision; secondId = state.accounts.find((a: any) => a.id !== 'default').id;
}, 15000);
afterAll(async () => {
  child?.kill();
  const exit = child && await Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
  if (!exit) child?.kill('SIGKILL');
  const pids = readFileSync(join(temp, 'pids'), 'utf8').trim().split('\n').map(Number);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 100 && pids.some(alive); i++) await Bun.sleep(20);
  const leaked = pids.filter(alive);
  rmSync(temp, { recursive: true, force: true });
  expect(exit).toBe(true); expect(leaked).toEqual([]);
}, 10000);

test('hands off a persisted rollout and rejects stale account requests', async () => {
  const threadId = 'handoff-thread';
  expect((await rpc('default', 'thread/start', { cwd: join(temp, 'home', 'el'), testId: threadId })).type).toBe('rpc/result');
  await rpc('default', 'thread/name/set', {threadId, name: 'Original title'});
  const switched = await rpc('default', 'host/thread/switchAccount', { threadId, targetAccountId: secondId });
  expect(switched.type).toBe('rpc/result');
  expect(switched.result.accountId).toBe(secondId);
  expect(switched.result.thread.name).toBe('Original title');
  expect((await rpc('default', 'thread/read', { threadId })).type).toBe('rpc/error');
  expect((await rpc(secondId, 'thread/read', { threadId })).result.thread.id).toBe(threadId);
  await rpc(secondId, 'thread/name/set', {threadId, name: 'New title'});
  const switchedBack = await rpc(secondId, 'host/thread/switchAccount', { threadId, targetAccountId: 'default' });
  expect(switchedBack.type).toBe('rpc/result');
  expect(switchedBack.result.thread.name).toBe('New title');
  expect((await rpc(secondId, 'thread/read', { threadId })).type).toBe('rpc/error');
  writeFileSync(join(temp, 'pids.delete-fail'), 'once');
  expect((await rpc('default', 'thread/delete', {threadId})).type).toBe('rpc/error');
  const journal = new ThreadOwnership(join(temp, 'home', '.webui', 'thread-ownership.json'));
  expect(journal.isDeleted('zilpio',threadId)).toBe(true);
  expect(journal.deletion('zilpio',threadId).completed).toEqual(['default']);
  expect((await rpc('default', 'thread/read', {threadId})).type).toBe('rpc/error');
  child.kill(); await child.exited; child = launch();
  let ready = false;
  for (let i = 0; i < 150; i++) { try { if ((await (await api('/api/health')).json()).codex) { ready = true; break; } } catch {} await Bun.sleep(30); }
  expect(ready).toBe(true);
  revision = (await (await api('/api/runtime')).json()).runtimeRevision;
  expect((await rpc('default', 'thread/read', {threadId})).type).toBe('rpc/error');
  let completed = false;
  for (let i=0;i<100;i++) { const saved=new ThreadOwnership(join(temp,'home','.webui','thread-ownership.json')).deletion('zilpio',threadId); if(saved.completed.length===2) {completed=true;break;} await Bun.sleep(100); }
  expect(completed).toBe(true);
  expect((await rpc('default', 'thread/delete', {threadId})).type).toBe('rpc/result');
  expect((await rpc('default', 'thread/list')).result.data.some((t:any)=>t.id===threadId)).toBe(false);
  expect((await rpc(secondId, 'thread/list')).result.data.some((t:any)=>t.id===threadId)).toBe(false);
  expect(existsSync(join(temp,'home','.zilpio','sessions',threadId+'.jsonl'))).toBe(false);
  expect(existsSync(join(temp,'home','.webui','runtime-homes',secondId,'zilpio','sessions',threadId+'.jsonl'))).toBe(false);
}, 15000);

test('resumes deletion after a crash between native deletion and checkpoint', async () => {
  const threadId='delete-checkpoint-crash';
  expect((await rpc('default','thread/start',{cwd:join(temp,'home','el'),testId:threadId})).type).toBe('rpc/result');
  expect((await rpc('default','host/thread/switchAccount',{threadId,targetAccountId:secondId})).type).toBe('rpc/result');
  child.kill(); await child.exited;
  const state=new ThreadOwnership(join(temp,'home','.webui','thread-ownership.json'));
  state.beginDeletion('zilpio',threadId,secondId); state.startDeletionAccount('zilpio',threadId,'default');
  unlinkSync(join(temp,'home','.zilpio','sessions',threadId+'.jsonl'));
  child=launch(); let ready=false;
  for(let i=0;i<150;i++){try{if((await (await api('/api/health')).json()).codex){ready=true;break;}}catch{}await Bun.sleep(30);}expect(ready).toBe(true);
  revision=(await (await api('/api/runtime')).json()).runtimeRevision;
  expect((await rpc(secondId,'thread/delete',{threadId})).type).toBe('rpc/result');
  const restored=new ThreadOwnership(join(temp,'home','.webui','thread-ownership.json'));
  expect(restored.deletion('zilpio',threadId).completed).toEqual(['default',secondId]);
  expect(existsSync(join(temp,'home','.webui','runtime-homes',secondId,'zilpio','sessions',threadId+'.jsonl'))).toBe(false);
},15000);

test('restart reconciles an interrupted handoff in Zilpio', async () => {
  const threadId='environment-intent', source=join(temp,'home','.zilpio','sessions',threadId+'.jsonl');
  expect((await rpc('default','thread/start',{cwd:join(temp,'home','el'),testId:threadId})).type).toBe('rpc/result');
  expect((await api('/api/runtime/switch','POST',{environmentId:'zilpio',expectedRevision:revision})).status).toBe(200);
  child.kill();await child.exited;
  const state=new ThreadOwnership(join(temp,'home','.webui','thread-ownership.json'));
  state.registerLink('zilpio',threadId,'default',secondId,threadId+'.jsonl',(await import('../rollout-transfer.js')).rolloutHash(source));
  child=launch();let ready=false;for(let i=0;i<150;i++){try{if((await (await api('/api/health')).json()).codex){ready=true;break;}}catch{}await Bun.sleep(30);}expect(ready).toBe(true);
  revision=(await (await api('/api/runtime')).json()).runtimeRevision;
  expect((await api('/api/runtime/switch','POST',{environmentId:'zilpio',expectedRevision:revision})).status).toBe(200);
  revision=(await (await api('/api/runtime')).json()).runtimeRevision;
  expect((await rpc('default','thread/read',{threadId})).type).toBe('rpc/result');
},15000);

test('startup reconciles interrupted copy intent and rejects divergent histories', async () => {
  const threadId='intent-thread', source=join(temp,'home','.zilpio','sessions',threadId+'.jsonl');
  const dest=join(temp,'home','.webui','runtime-homes',secondId,'zilpio','sessions',threadId+'.jsonl');
  const file=join(temp,'home','.webui','thread-ownership.json');
  expect((await rpc('default','thread/start',{cwd:join(temp,'home','el'),testId:threadId})).type).toBe('rpc/result');
  const stop = async () => {child.kill();await child.exited;};
  const start = async () => {child=launch();let ready=false;for(let i=0;i<150;i++){try{if((await (await api('/api/health')).json()).codex){ready=true;break;}}catch{}await Bun.sleep(30);}expect(ready).toBe(true);revision=(await (await api('/api/runtime')).json()).runtimeRevision;};
  const hash=(await import('../rollout-transfer.js')).rolloutHash;
  await stop();
  let state=new ThreadOwnership(file);state.registerLink('zilpio',threadId,'default',secondId,threadId+'.jsonl',hash(source));
  await start();expect((await rpc('default','thread/read',{threadId})).type).toBe('rpc/result');
  await stop();state=new ThreadOwnership(file);state.registerLink('zilpio',threadId,'default',secondId,threadId+'.jsonl',hash(source));copyFileSync(source,dest);
  await start();expect((await rpc('default','thread/read',{threadId})).type).toBe('rpc/result');
  await stop();state=new ThreadOwnership(file);state.registerLink('zilpio',threadId,'default',secondId,threadId+'.jsonl',hash(source));writeFileSync(dest,'divergent');
  await start();expect((await rpc('default','thread/read',{threadId})).type).toBe('rpc/error');
  expect(readFileSync(source,'utf8')).not.toBe('divergent');expect(readFileSync(dest,'utf8')).toBe('divergent');
},15000);

test('recovers appended rollout entries after interrupted copy and hard-link handoffs', async () => {
  for (const [threadId, mode] of [['intent-copy-append','copy'], ['intent-link-append','link'], ['intent-truncated','truncated'], ['intent-malformed','malformed']]) {
    const source=join(temp,'home','.zilpio','sessions',threadId+'.jsonl'), dest=join(temp,'home','.webui','runtime-homes',secondId,'zilpio','sessions',threadId+'.jsonl');
    expect((await rpc('default','thread/start',{cwd:join(temp,'home','el'),testId:threadId})).type).toBe('rpc/result');
    child.kill();await child.exited;
    const state=new ThreadOwnership(join(temp,'home','.webui','thread-ownership.json'));
    state.registerLink('zilpio',threadId,'default',secondId,threadId+'.jsonl',(await import('../rollout-transfer.js')).rolloutHash(source),statSync(source).size,'Recovered title');
    if(mode==='link')linkSync(source,dest);else copyFileSync(source,dest);
    appendFileSync(dest,mode==='truncated'?'bad-partial':mode==='malformed'?'bad-json\n':JSON.stringify({type:'session_meta',payload:{id:threadId}})+'\n');
    child=launch();let ready=false;for(let i=0;i<150;i++){try{if((await (await api('/api/health')).json()).codex){ready=true;break;}}catch{}await Bun.sleep(30);}expect(ready).toBe(true);
    revision=(await (await api('/api/runtime')).json()).runtimeRevision;
    expect((await rpc('default','thread/read',{threadId})).type).toBe('rpc/error');
    const recovered=await rpc(secondId,'thread/read',{threadId});
    expect(recovered.type).toBe(['truncated','malformed'].includes(mode)?'rpc/error':'rpc/result');
    if (recovered.type==='rpc/result') expect(recovered.result.thread.name).toBe('Recovered title');
  }
},15000);

test('a conflicting destination preserves the source owner and restarts its runtime', async () => {
  const threadId = 'conflicting-thread';
  expect((await rpc('default', 'thread/start', { cwd: join(temp, 'home', 'el'), testId: threadId })).type).toBe('rpc/result');
  const destination = join(temp, 'home', '.webui', 'runtime-homes', secondId, 'zilpio', 'sessions', threadId + '.jsonl');
  mkdirSync(join(destination, '..'), { recursive: true });
  writeFileSync(destination, 'different history');
  expect((await rpc('default', 'host/thread/switchAccount', { threadId, targetAccountId: secondId })).type).toBe('rpc/error');
  expect((await rpc('default', 'thread/read', { threadId })).result.thread.id).toBe(threadId);
  expect((await rpc(secondId, 'thread/read', { threadId })).type).toBe('rpc/error');
  expect((await rpc('default', 'thread/delete', {threadId})).type).toBe('rpc/result');
  expect(readFileSync(destination, 'utf8')).toBe('different history');
}, 15000);

test('routes simultaneous chats, histories and colliding approval IDs to their own accounts', async () => {
  const response = await api('/api/events');
  const reader = response.body!.getReader();
  const events: any[] = [];
  let stopped = false;
  const pump = (async () => { let buffer = ''; while (!stopped) { const chunk = await reader.read(); if (chunk.done) break; buffer += new TextDecoder().decode(chunk.value, { stream: true }); let pos; while ((pos = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, pos); buffer = buffer.slice(pos + 2); for (const line of block.split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); } } })();
  try {
    const invalid = await rpc('unknown-account', 'thread/list');
    expect(invalid.type).toBe('rpc/error');
    const invalidApproval = await api('/api/codex/respond', 'POST', { accountId: 'unknown-account', requestId: 7, result: { decision: 'accept' }, runtimeRevision: revision });
    expect(invalidApproval.ok ? (await invalidApproval.json()).type : 'rejected').toMatch(/rpc\/error|rejected/);
    const cwd = join(temp, 'home', 'el');
    const [a, b] = await Promise.all([rpc('default', 'thread/start', { cwd }), rpc(secondId, 'thread/start', { cwd })]);
    expect(a.result.thread.id).toBe('thread-initial');
    expect(b.result.thread.id).toBe('thread-second');
    const [listA, listB] = await Promise.all([rpc('default', 'thread/list'), rpc(secondId, 'thread/list')]);
    expect(listA.result.data.map((t: any) => t.id)).toEqual(['thread-initial']);
    expect(listB.result.data.map((t: any) => t.id)).toEqual(['thread-second']);
    const turnB = await rpc(secondId, 'turn/start', { threadId: 'thread-second', input: [] });
    expect(turnB.result.turn.id).toBe('turn-second');
    const blocked = await api('/api/runtime/switch', 'POST', { environmentId: 'zilpio', expectedRevision: revision });
    expect(blocked.status).toBe(200);
    const state = await (await api('/api/runtime')).json();
    expect(state.accountId).toBe('default'); expect(state.runtimeRevision).toBe(revision);
    const pendingB = await rpc(secondId, 'host/approvals/list', { threadId: 'thread-second' });
    expect(pendingB.result.requests).toHaveLength(1);
    const secondApprovalId = pendingB.result.requests[0].id;
    expect(typeof secondApprovalId).toBe('string');
    expect(secondApprovalId).not.toBe('7');
    const [stillA, stillB] = await Promise.all([rpc('default', 'thread/list'), rpc(secondId, 'thread/list')]);
    expect(stillA.result.data.map((t: any) => t.id)).toEqual(['thread-initial']);
    expect(stillB.result.data.map((t: any) => t.id)).toEqual(['thread-second']);
    const turnA = await rpc('default', 'turn/start', { threadId: 'thread-initial', input: [] });
    expect(turnA.result.turn.id).toBe('turn-initial');
    const blockedAgain = await api('/api/runtime/switch', 'POST', { environmentId: 'zilpio', expectedRevision: revision });
    expect(blockedAgain.status).toBe(200);
    const [pendingA, pendingBAgain] = await Promise.all([rpc('default', 'host/approvals/list', { threadId: 'thread-initial' }), rpc(secondId, 'host/approvals/list', { threadId: 'thread-second' })]);
    expect(pendingA.result.requests.map((request: any) => request.id)).toEqual([7]);
    expect(pendingBAgain.result.requests.map((request: any) => request.id)).toEqual([secondApprovalId]);
    for (let i = 0; i < 100 && events.filter(e => e.type === 'codex/request').length < 2; i++) await Bun.sleep(20);
    expect(events.filter(e => e.type === 'codex/request').map(e => [e.accountId, e.payload.params.threadId]).sort()).toEqual([['default', 'thread-initial'], [secondId, 'thread-second']].sort());
    const secondEvent = events.find(e => e.type === 'codex/request' && e.accountId === secondId);
    expect(secondEvent.payload.id).toBe(secondApprovalId);
    const [replyA, replyB] = await Promise.all([
      api('/api/codex/respond', 'POST', { accountId: 'default', requestId: 7, result: { decision: 'accept' }, runtimeRevision: revision }),
      api('/api/codex/respond', 'POST', { accountId: secondId, requestId: secondApprovalId, result: { decision: 'decline' }, runtimeRevision: revision }),
    ]);
    expect(replyA.status).toBe(200); expect(replyB.status).toBe(200);
    for (let i = 0; i < 100 && events.filter(e => e.payload?.method === 'test/approvalReceived').length < 2; i++) await Bun.sleep(20);
    expect(events.filter(e => e.payload?.method === 'test/approvalReceived').map(e => [e.accountId, e.payload.params.account, e.payload.params.decision]).sort()).toEqual([['default', 'initial', 'accept'], [secondId, 'second', 'decline']].sort());
  } finally { stopped = true; await reader.cancel(); await pump; }
}, 15000);


test('a crashed account process invalidates old approval tokens after restarting', async () => {
  const first = await rpc(secondId, 'turn/start', { threadId: 'thread-second', input: [] });
  expect(first.type).toBe('rpc/result');
  const before = await rpc(secondId, 'host/approvals/list', { threadId: 'thread-second' });
  expect(before.result.requests).toHaveLength(1);
  const oldToken = before.result.requests[0].id;
  const crash = await rpc(secondId, 'thread/delete', { threadId: 'crash' });
  expect(crash.type).toBe('rpc/error');
  let restarted = false;
  for (let i = 0; i < 150; i++) {
    const probe = await rpc(secondId, 'thread/list');
    if (probe.type === 'rpc/result') { restarted = true; break; }
    await Bun.sleep(30);
  }
  expect(restarted).toBe(true);
  const cleared = await rpc(secondId, 'host/approvals/list', { threadId: 'thread-second' });
  expect(cleared.result.requests).toEqual([]);
  expect((await rpc(secondId, 'turn/start', { threadId: 'thread-second', input: [] })).type).toBe('rpc/result');
  const after = await rpc(secondId, 'host/approvals/list', { threadId: 'thread-second' });
  expect(after.result.requests).toHaveLength(1);
  const newToken = after.result.requests[0].id;
  expect(newToken).not.toBe(oldToken);
  const stale = await api('/api/codex/respond', 'POST', { accountId: secondId, requestId: oldToken, result: { decision: 'accept' }, runtimeRevision: revision });
  expect(stale.ok ? (await stale.json()).type : 'rejected').toMatch(/rpc\/error|rejected/);
  const stillPending = await rpc(secondId, 'host/approvals/list', { threadId: 'thread-second' });
  expect(stillPending.result.requests.map((request: any) => request.id)).toEqual([newToken]);
  const accepted = await api('/api/codex/respond', 'POST', { accountId: secondId, requestId: newToken, result: { decision: 'decline' }, runtimeRevision: revision });
  expect((await accepted.json()).type).toBe('ack');
  expect((await rpc(secondId, 'host/approvals/list', { threadId: 'thread-second' })).result.requests).toEqual([]);
}, 15000);
