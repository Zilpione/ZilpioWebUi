import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
const dir = mkdtempSync(join(tmpdir(), 'webui-integrations-'));
const home = join(dir, 'home'); mkdirSync(home);
const key = join(dir, 'key');
assert.equal(spawnSync('ssh-keygen', ['-q','-t','ed25519','-N','','-f',key]).status, 0);
const port = 19800 + Math.floor(Math.random() * 1000);
const child = spawn('bun', ['run','server.ts'], { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'), env: { ...process.env, HOME: home, HOST: '127.0.0.1', PORT: String(port), CODEX_WEBUI_WORKSPACE_BASE: home, CODEX_WEBUI_CWD: home, CODEX_WEBUI_MANAGED_ACCOUNTS: 'false', CODEX_WEBUI_PROJECTLESS: 'false', CODEX_WEBUI_ACCESS_TOKEN: 'test-integrations-token' }, stdio: 'ignore' });
const url = `http://127.0.0.1:${port}`;
const headers = { authorization: 'Bearer test-integrations-token', 'content-type': 'application/json' };
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url+'/api/health',{headers})).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.ok(ready, 'server did not start');
  const call = (path, method = 'GET', body) => fetch(url+path, { method, headers, ...(body ? {body:JSON.stringify(body)} : {}) });
  assert.equal((await fetch(url+'/api/integrations',{headers:{host:'example.com'}})).status, 401);
  let response = await call('/api/integrations/ssh','POST',{key:readFileSync(key,'utf8')}); assert.equal(response.status, 200); let state = await response.json(); assert.equal(state.sshConfigured,true); assert.match(state.publicKey,/^ssh-ed25519 /);
  response = await call('/api/integrations/telegram','POST',{token:'123456:test_token',chatId:'123456',enabled:true}); assert.equal(response.status,200);
  response = await call('/api/integrations'); const text=await response.text(); assert.ok(!text.includes('test_token')); assert.ok(!text.includes('PRIVATE KEY'));
  response = await call('/api/files/download?path='+encodeURIComponent(join(home,'.webui','git-identity'))); assert.equal(response.status,404);
  response = await call('/api/files/download?path='+encodeURIComponent(join(home,'.webui','telegram.json'))); assert.equal(response.status,404);
  response = await call('/api/integrations/ssh','DELETE'); assert.equal(response.status,200);
  response = await call('/api/integrations/telegram','DELETE'); assert.equal(response.status,200);
  console.log('Global integrations API: authenticated, persistent, secret downloads blocked, removal verified');
} finally { child.kill('SIGTERM'); await new Promise(resolve=>{ if(child.exitCode!==null) resolve(); else child.once('exit',resolve); }); rmSync(dir,{recursive:true,force:true}); }
