import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { chromium } from 'playwright';
import { launchOptions } from './browser-runtime.mjs';

const dir = mkdtempSync(join(tmpdir(), 'github-panel-'));
const home = join(dir, 'home'), ghDir = join(home, '.config', 'gh');
mkdirSync(ghDir, { recursive: true });
const state = join(dir, 'state.json'), complete = join(dir, 'complete');
writeFileSync(state, JSON.stringify({ accounts: [{ login:'FirstUser', active:true }] }));
writeFileSync(join(ghDir, 'hosts.yml'), 'fake-secret');
const port = 19000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
const token = 'github-panel-test-token';
const child = spawn('bun', ['run','server.ts'], {
  cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  env: { ...process.env, HOME:home, CODEX_HOME:join(home,'.codex'), GH_CONFIG_DIR:ghDir, GH_TOKEN:'', GITHUB_TOKEN:'', CODEX_WEBUI_GH_BIN:resolve('tests/fixtures/fake-gh.cjs'), FAKE_GH_STATE:state, FAKE_GH_COMPLETE:complete, HOST:'127.0.0.1', PORT:String(port), CODEX_WEBUI_WORKSPACE_BASE:home, CODEX_WEBUI_CWD:home, CODEX_WEBUI_MANAGED_ACCOUNTS:'false', CODEX_WEBUI_PROJECTLESS:'false', CODEX_WEBUI_ACCESS_TOKEN:token },
  stdio:'ignore',
});
let browser;
try {
  let ready = false;
  for (let i=0;i<100;i++) { try { if ((await fetch(base+'/api/health',{headers:{authorization:`Bearer ${token}`}})).ok) { ready=true; break; } } catch {} await new Promise(resolve=>setTimeout(resolve,100)); }
  assert.ok(ready, 'test server did not start');
  assert.equal((await fetch(base+'/api/integrations/github',{headers:{host:'example.com'}})).status,401);
  const protectedFile = await fetch(base+'/api/files/download?path='+encodeURIComponent(join(ghDir,'hosts.yml')), {headers:{authorization:`Bearer ${token}`}});
  assert.equal(protectedFile.status,404, 'GitHub credentials must not be downloadable');
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({viewport:{width:1100,height:800},extraHTTPHeaders:{authorization:`Bearer ${token}`}});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base+'/settings/git-settings', {waitUntil:'domcontentloaded'});
  const first = page.locator('[data-github-account="FirstUser"]');
  await first.waitFor({state:'visible',timeout:10000});
  assert.match(await first.innerText(), /FirstUser.*Autorizzato.*Attivo/s);
  await first.getByRole('button',{name:'Rinomina'}).click();
  await first.getByRole('textbox',{name:'Nickname per FirstUser'}).fill('Personale');
  await first.getByRole('button',{name:'Salva'}).click();
  await page.waitForFunction(()=>document.querySelector('[data-github-account="FirstUser"] strong')?.textContent==='Personale');

  await page.click('#githubAddAccount');
  await page.waitForFunction(()=>document.querySelector('#githubDeviceCode')?.textContent==='ABCD-1234');
  assert.equal(await page.locator('#githubDeviceLink').getAttribute('href'),'https://github.com/login/device');
  await page.click('[data-settings-page="telegram-settings"]');
  await page.click('[data-settings-page="git-settings"]');
  await page.waitForFunction(()=>document.querySelector('#githubDeviceCode')?.textContent==='ABCD-1234' && !document.querySelector('#githubDeviceLogin')?.hidden);
  await page.click('#githubCancelLogin');
  await page.waitForFunction(()=>document.querySelector('#githubDeviceLogin')?.hidden);
  assert.equal(await page.locator('[data-github-account]').count(),1);

  await page.click('#githubAddAccount');
  await page.waitForFunction(()=>document.querySelector('#githubDeviceCode')?.textContent==='ABCD-1234');
  writeFileSync(complete,'ok');
  const second = page.locator('[data-github-account="SecondUser"]');
  await second.waitFor({state:'visible',timeout:10000});
  assert.match(await second.innerText(),/Attivo/);
  await first.getByRole('button',{name:'Usa'}).click();
  await page.waitForFunction(()=>document.querySelector('[data-github-account="FirstUser"] small')?.textContent.includes('Attivo'));
  await second.getByRole('button',{name:'Rimuovi'}).click();
  await second.getByRole('button',{name:'Conferma rimozione'}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-github-account="SecondUser"]'));
  assert.match(await first.innerText(),/Personale/);

  const mobileContext = await browser.newContext({viewport:{width:375,height:780},extraHTTPHeaders:{authorization:`Bearer ${token}`}});
  const mobile = await mobileContext.newPage();
  await mobile.goto(base+'/settings/git-settings', {waitUntil:'domcontentloaded'});
  await mobile.locator('[data-github-account="FirstUser"]').waitFor({state:'visible',timeout:10000});
  assert.match(await mobile.locator('[data-github-account="FirstUser"]').innerText(),/Personale.*Attivo/s);
  const overflow = await mobile.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth);
  assert.equal(overflow,false,'page overflows on mobile');
  await mobileContext.close();
  assert.deepEqual(errors,[]);
  console.log('GitHub panel: authorization, nickname, account switch, removal, protected credentials and mobile layout verified');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  await new Promise(resolve=>{if(child.exitCode!==null) resolve(); else child.once('exit',resolve)});
  rmSync(dir,{recursive:true,force:true});
}
