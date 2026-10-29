import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceLogin } from '../codex-login';

const roots: string[] = [];
const logins: DeviceLogin[] = [];
afterEach(async () => {
  await Promise.all(logins.splice(0).map(login => login.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await Bun.sleep(10); }
  throw new Error('Condition did not become true');
}
async function fixture(mode = 'success', url = 'https://auth.openai.com/codex/device') {
  const root = await mkdtemp(join(tmpdir(), 'device-login-test-'));
  roots.push(root);
  const bin = join(root, 'codex');
  await writeFile(bin, `#!/usr/bin/env bun
import {createInterface} from 'node:readline';
import {writeFile, stat} from 'node:fs/promises';
const home = process.env.CODEX_HOME;
await writeFile(${JSON.stringify(join(root, 'child.json'))}, JSON.stringify({home, pid:process.pid, mode:(await stat(home)).mode & 511, args:process.argv.slice(2), env:Object.keys(process.env).filter(k=>/^(CODEX_AUTH_PATH|OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|AZURE_OPENAI_API_KEY)$/.test(k))}));
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
let initialized = false;
for await (const line of createInterface({input:process.stdin})) {
 const msg = JSON.parse(line);
 if (msg.method==='initialize') { emit({id:msg.id,result:{userAgent:'test'}}); }
 else if (msg.method==='initialized') initialized=true;
 else if (msg.method==='account/login/start') {
   if (!initialized || msg.params.type!=='chatgptDeviceCode') process.exit(2);
   emit({id:msg.id,result:{type:'chatgptDeviceCode',loginId:'secret-login-id',userCode:'ABCD-EFGH',verificationUrl:${JSON.stringify(url)}}});
   if (${JSON.stringify(mode)}==='success') setTimeout(async()=>{
     emit({method:'account/login/completed',params:{loginId:'secret-login-id',success:true,error:null}});
     setTimeout(()=>writeFile(home+'/auth.json',JSON.stringify({tokens:{access_token:'secret-token',refresh_token:'secret-refresh'}})),30);
   },40);
   if (${JSON.stringify(mode)}==='failure') setTimeout(()=>{
     process.stderr.write('secret-token arbitrary error');
     emit({method:'account/login/completed',params:{loginId:'secret-login-id',success:false,error:'secret-token arbitrary error'}});
   },40);
   if (${JSON.stringify(mode)}==='invalid-auth') setTimeout(async()=>{
     await writeFile(home+'/auth.json','[]');
     emit({method:'account/login/completed',params:{loginId:'secret-login-id',success:true}});
   },40);
 }
}
`, { mode: 0o700 });
  const auths: object[] = [];
  const login = new DeviceLogin({codexBin:bin,onAuth: auth => { auths.push(auth); }});
  logins.push(login);
  return {root, login, auths, child: async () => JSON.parse(await readFile(join(root,'child.json'),'utf8'))};
}
async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }
async function exited(pid: number) { try { process.kill(pid,0); return false; } catch { return true; } }

test('isolated device login initializes protocol, imports persisted auth and removes child home', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'injected-secret';
  const f = await fixture();
  try {
    const pending = await f.login.start();
    expect(pending).toEqual({status:'pending',userCode:'ABCD-EFGH',verificationUrl:'https://auth.openai.com/codex/device'});
    const child = await f.child();
    expect(child.mode).toBe(0o700);
    expect(child.env).toEqual([]);
    expect(child.args).toEqual(['app-server','--stdio','-c','cli_auth_credentials_store="file"']);
    await until(() => f.login.getStatus().status==='completed');
    expect(f.auths).toEqual([{tokens:{access_token:'secret-token',refresh_token:'secret-refresh'}}]);
    expect(f.login.getStatus()).toEqual({status:'completed'});
    await until(async () => !await exists(child.home) && await exited(child.pid));
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY=previous; }
});

test('failed device login exposes only a fixed safe error and removes temporary files', async () => {
  const f = await fixture('failure');
  await f.login.start();
  const child = await f.child();
  await until(() => f.login.getStatus().status==='failed');
  expect(f.auths).toEqual([]);
  expect(JSON.stringify(f.login.getStatus())).not.toContain('secret');
  await until(async () => !await exists(child.home) && await exited(child.pid));
});

test('cancel suppresses late completion and concurrent start shares the pending login', async () => {
  const f = await fixture('success');
  const [a,b] = await Promise.all([f.login.start(),f.login.start()]);
  expect(a.status).toBe('pending'); expect(b.status).toBe('pending');
  const child = await f.child();
  await f.login.cancel();
  await Bun.sleep(100);
  expect(f.login.getStatus()).toEqual({status:'idle'});
  expect(f.auths).toEqual([]);
  expect(await exists(child.home)).toBe(false);
  expect(await exited(child.pid)).toBe(true);
});

test('dispose terminates a pending child and refuses reuse', async () => {
  const f = await fixture('pending');
  await f.login.start();
  const child = await f.child();
  await f.login.dispose();
  expect(await exited(child.pid)).toBe(true);
  expect(await exists(child.home)).toBe(false);
  await expect(f.login.start()).rejects.toThrow();
  expect(f.auths).toEqual([]);
});

for (const url of ['https://evil.example/device','http://auth.openai.com/codex/device','https://user:pass@auth.openai.com/codex/device','https://openai.com.evil.example/']) {
 test('rejects untrusted verification URL '+url, async () => {
   const f = await fixture('pending',url);
   expect((await f.login.start()).status).toBe('failed');
   expect(f.auths).toEqual([]);
 });
}

test('non-object persisted authentication is rejected without invoking callback', async () => {
  const f = await fixture('invalid-auth');
  await f.login.start();
  await until(() => f.login.getStatus().status==='failed');
  expect(f.auths).toEqual([]);
});

test('a missing executable fails promptly without hanging startup cleanup', async () => {
  const login = new DeviceLogin({codexBin:'/missing/codex-login-test',onAuth:()=>{throw new Error('unexpected auth');}});
  logins.push(login);
  const result = await Promise.race([login.start(), Bun.sleep(750).then(()=>({status:'timeout'}))]);
  expect(result.status).toBe('failed');
});
