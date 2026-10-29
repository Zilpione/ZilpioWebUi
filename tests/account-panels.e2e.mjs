import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { AccountStore } from '../account-store.ts';
import { launchOptions } from './browser-runtime.mjs';

const root = new URL('..', import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), 'webui-account-panels-'));
const home = join(temp, 'home'), bin = join(temp, 'bin'), codexHome = join(home, '.codex'), project = join(home, 'legacy', 'project'), log = join(temp, 'calls.jsonl');
for (const path of [bin, codexHome, project]) mkdirSync(path, { recursive: true });
const auth = id => ({ tokens: { account_id: id, access_token: id + '-access', refresh_token: id + '-refresh', id_token: 'x.' + Buffer.from(JSON.stringify({ email: id + '@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: id, chatgpt_plan_type: 'plus' } })).toString('base64url') + '.x' } });
writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(auth('initial')));
writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-a"\n');
const store = new AccountStore({ defaultHome: codexHome, loginsDir: join(home, '.codex-logins'), stateDir: join(home, '.webui'), workspaces: [{ id: 'legacy', label: 'legacy', path: join(home, 'legacy'), codexHome: join(home, '.legacy') }, { id: 'workspace', label: 'workspace', path: join(home, 'workspace'), codexHome: join(home, '.workspace') }] });
store.prepare(); store.addAuth(auth('second'), 'Second account');
// Seed a former legacy chat and project before starting the upgraded server.
const legacyHome=join(home,'.legacy');mkdirSync(join(legacyHome,'sessions'),{recursive:true});
writeFileSync(join(legacyHome,'sessions','rollout-legacy-history.jsonl'),JSON.stringify({id:'legacy-history',name:'Chat migrata da legacy',cwd:project,turns:[],canAcceptDirectInput:true}));
writeFileSync(join(home,'.webui','projects.json.legacy'),JSON.stringify([{path:project,color:'#ff0000',icon:'star',hidden:false}]));
writeFileSync(join(bin, 'codex'), String.raw`#!/usr/bin/env bun
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
const account=JSON.parse(readFileSync(join(process.env.CODEX_HOME,'auth.json'),'utf8')).tokens.account_id;
const sessions=join(process.env.CODEX_HOME,'sessions'); mkdirSync(sessions,{recursive:true});
const threads=()=>readdirSync(sessions).filter(f=>f.endsWith('.jsonl')).map(f=>({...JSON.parse(readFileSync(join(sessions,f),'utf8')),path:join(sessions,f)}));
const save=t=>writeFileSync(t.path,JSON.stringify(t));
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);if(m.id===undefined||!m.method)continue;const p=m.params||{};let result={};
 if(m.method==='initialize')result={codexHome:process.env.CODEX_HOME};
 if(m.method==='account/read')result={account:{type:'chatgpt',email:account+'@example.invalid',planType:'plus'}};
 if(m.method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:account==='initial'?20:45,windowDurationMins:300},secondary:{usedPercent:10,windowDurationMins:10080}}};
 if(m.method==='model/list')result={data:[{id:'gpt-a',model:'gpt-a',displayName:'GPT-A',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]},{id:'gpt-b',model:'gpt-b',displayName:'GPT-B',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]};
 if(m.method==='thread/list')result={data:threads(),nextCursor:null};
 if(m.method==='thread/start'){const thread={id:'thread-'+account,name:'Chat '+account,cwd:p.cwd,path:join(sessions,'rollout-thread-'+account+'.jsonl'),turns:[],canAcceptDirectInput:true};save(thread);result={thread};}
 if(m.method==='thread/read'||m.method==='thread/resume')result={thread:{...threads().find(t=>t.id===p.threadId),historyLoaded:true}};
 if(m.method==='thread/turns/list'||m.method==='permissionProfile/list')result={data:[]};
 if(m.method==='turn/start'){
  appendFileSync(process.env.TEST_LOG,JSON.stringify({account,method:m.method,params:p})+'\n');
  const thread=threads().find(t=>t.id===p.threadId); const turnId='turn-'+account+'-'+thread.turns.length,itemId='item-'+account+'-'+thread.turns.length;
  const user={id:'user-'+turnId,type:'userMessage',content:[{type:'text',text:p.input[0].text}]}, agent={id:itemId,type:'agentMessage',text:'Response from '+account};
  const turn={id:turnId,status:'completed',items:[user,agent]};thread.turns.push(turn);save(thread);
  send({method:'turn/started',params:{threadId:p.threadId,turn:{id:turnId,status:'inProgress'}}});
  send({method:'item/started',params:{threadId:p.threadId,turnId,item:{id:itemId,type:'agentMessage',text:''}}});
  send({method:'item/agentMessage/delta',params:{turnId,itemId,delta:'Response from '+account}});
  send({method:'item/completed',params:{threadId:p.threadId,turnId,item:agent}});
  send({method:'turn/completed',params:{threadId:p.threadId,turn}});
  result={turn:{id:turnId,status:'completed'}};
 }
 send({id:m.id,result});
}
`, { mode: 0o755 });
const port = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = 'http://127.0.0.1:' + port;
let serverErrors = '';
const startServer = () => { const child = Bun.spawn(['bun', 'run', 'server.ts'], { cwd: root, env: { ...process.env, PATH: bin + ':' + process.env.PATH, HOME: home, CODEX_HOME: codexHome, CODEX_WEBUI_MANAGED_ACCOUNTS: 'true', CODEX_WEBUI_WORKSPACE_BASE: home, CODEX_WEBUI_PROJECTLESS: 'false', CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', HOST: '127.0.0.1', PORT: String(port), TEST_DIR: temp, TEST_LOG: log }, stdout: 'ignore', stderr: 'pipe' });
 (async () => { const reader = child.stderr.getReader(), decoder = new TextDecoder(); for (;;) { const chunk = await reader.read(); if (chunk.done) break; serverErrors += decoder.decode(chunk.value, {stream:true}); } })();
 return child; };
let server = startServer(), browser, stage = 'server startup'; const errors = [], consoleErrors = [];
try {
 for (let i = 0; i < 200; i++) { try { if ((await (await fetch(base + '/api/health')).json()).codex) break; } catch {} if (i === 199) throw new Error('Server did not become ready'); await Bun.sleep(50); }
 const runtime = await (await fetch(base + '/api/runtime')).json(), secondId = runtime.accounts.find(a => a.id !== 'default').id;
 if(JSON.stringify(runtime.environments)!==JSON.stringify([{id:'workspace',label:'Workspace'}]))throw new Error('Unexpected environments: '+JSON.stringify(runtime.environments));
 browser = await chromium.launch(launchOptions());
 const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
 const page = await context.newPage(); page.setDefaultTimeout(8000); const captureErrors = (p, name) => { p.on('pageerror', error => errors.push(name + ': ' + error.message)); p.on('console', message => { if (message.type() === 'error') consoleErrors.push(name + ' console: ' + message.text()); }); }; captureErrors(page, 'first tab');
 stage = 'selecting accounts and models before creating chats';
 await page.goto(base, { waitUntil: 'domcontentloaded' });
 await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && document.querySelector('#composerAccount')?.options.length === 2);
 await page.waitForSelector('.thread-item[data-id="legacy-history"]');
 if(await page.locator('.environment-control').isVisible())throw new Error('Environment selector should be hidden');
 const migratedGroup=page.locator('.sidebar-project-group').filter({has:page.locator('.thread-item[data-id="legacy-history"]')});
 if(await migratedGroup.locator('.sidebar-project-row').getAttribute('aria-expanded')==='false')await migratedGroup.locator('.sidebar-project-row').click();
 await page.locator('.thread-item[data-id="legacy-history"] .thread-name').click();
 await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.active?.id==='legacy-history');
 await migratedGroup.locator('.project-settings-button').click();
 if(await migratedGroup.getByText('Sposta workspace',{exact:true}).count())throw new Error('Move environment command should be absent');
 await page.locator('#newTask').click();
 await page.locator('#splitChatButton').click();
 await page.waitForFunction(() => document.querySelector('#secondaryChatFrame')?.contentWindow?.__codexWebuiDebug?.state.connected && document.querySelector('#secondaryChatFrame')?.contentDocument?.querySelector('#composerAccount')?.options.length === 2);
 const secondary = page.frameLocator('#secondaryChatFrame');
 await page.locator('#composerAccountButton').click();await page.locator('#composerAccountMenu [role="option"]').filter({hasText:'initial\x40example.invalid'}).click();
 await secondary.locator('#composerAccountButton').click();await secondary.locator('#composerAccountMenu [role="option"]').filter({hasText:'Second account'}).click();
 await page.locator('#usageBars').getByText('80% residuo').waitFor();
 await secondary.locator('#usageBars').getByText('55% residuo').waitFor();
 await secondary.locator('#modelButton').click(); await secondary.locator('#modelSubmenuButton').click(); await secondary.locator('.model-option[data-model="gpt-b"]').click();
 await page.locator('#prompt').fill('Question initial'); await secondary.locator('#prompt').fill('Question second');
 stage = 'submitting and isolating streams';
 await Promise.all([page.locator('#sendButton').click(), secondary.locator('#sendButton').click()]);
 await page.locator('#conversation').getByText('Response from initial').waitFor(); await secondary.locator('#conversation').getByText('Response from second').waitFor();
 if ((await page.locator('#conversation').textContent()).includes('Response from second') || (await secondary.locator('#conversation').textContent()).includes('Response from initial')) throw new Error('A stream appeared in the other account panel');

 await page.waitForFunction(() => !document.querySelector('#composerAccount').disabled);
 const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
 for (const [account, model, text] of [['initial', 'gpt-a', 'Question initial'], ['second', 'gpt-b', 'Question second']]) {
  const call = calls.find(c => c.account === account);
  if (!call || call.params.threadId !== 'thread-' + account || call.params.model !== model || call.params.input?.[0]?.text !== text) throw new Error('Wrong account, thread or model: ' + JSON.stringify(call));
 }
 stage = 'switching the same chat across accounts and browser tabs';
 const otherPage = await context.newPage(); otherPage.setDefaultTimeout(8000); captureErrors(otherPage, 'second tab');
 await otherPage.goto(base,{waitUntil:'domcontentloaded'}); await otherPage.waitForSelector('.thread-item[data-id="thread-initial"]');
 await otherPage.locator('.thread-item[data-id="thread-initial"] .thread-name').click();
 await otherPage.locator('#conversation').getByText('Response from initial').waitFor();
 await page.locator('#composerAccountButton').click();
 await page.locator('#composerAccountMenu [role="option"]').filter({hasText:'Second account'}).click();
 stage = 'switching account in first tab';
 await page.waitForFunction(id=>globalThis.__codexWebuiDebug?.state.active?.id==='thread-initial' && globalThis.__codexWebuiDebug.state.selectedAccountId===id,secondId);
 stage = 'receiving account switch in second tab';
 await otherPage.waitForFunction(id=>globalThis.__codexWebuiDebug?.state.active?.id==='thread-initial' && globalThis.__codexWebuiDebug.state.selectedAccountId===id,secondId);
 await page.locator('#conversation').getByText('Response from initial').waitFor();
 await otherPage.locator('#conversation').getByText('Response from initial').waitFor();
 await page.locator('#prompt').fill('Continue on second account'); await page.locator('#sendButton').click();
 await page.locator('#conversation').getByText('Response from second').waitFor();
 const continued=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).find(c=>c.params.input?.[0]?.text==='Continue on second account');
 if(continued?.account!=='second'||continued.params.threadId!=='thread-initial') throw new Error('Continuation used the wrong account or thread: '+JSON.stringify(continued));
 await page.reload({waitUntil:'domcontentloaded'}); await page.waitForSelector('.thread-item[data-id="thread-initial"]');
 await page.locator('.thread-item[data-id="thread-initial"] .thread-name').click();
 await page.waitForFunction(id=>globalThis.__codexWebuiDebug?.state.active?.id==='thread-initial' && globalThis.__codexWebuiDebug.state.selectedAccountId===id,secondId);
 await page.locator('#conversation').getByText('Response from initial').waitFor(); await page.locator('#conversation').getByText('Response from second').waitFor();
 await otherPage.close();
 stage = 'reopening persisted account histories after server restart';
 server.kill(); await server.exited; server = startServer();
 for (let i = 0; i < 200; i++) { try { if ((await (await fetch(base + '/api/health')).json()).codex) break; } catch {} if (i === 199) throw new Error('Server did not restart'); await Bun.sleep(50); }
 await page.reload({ waitUntil: 'domcontentloaded' });
 await page.waitForSelector('.thread-item[data-id="thread-initial"]');
 await page.waitForSelector('.thread-item[data-id="thread-second"]');
 await page.locator('.thread-item[data-id="thread-initial"] .thread-name').click();
 await page.waitForFunction(id => globalThis.__codexWebuiDebug?.state.active?.id === 'thread-initial' && globalThis.__codexWebuiDebug.state.selectedAccountId === id, secondId);
 await page.locator('#conversation').getByText('Response from initial').waitFor();
 await page.locator('#conversation').getByText('Response from second').waitFor();
 stage = 'switching the same chat back to its original account';
 await page.locator('#composerAccountButton').click();
 await page.locator('#composerAccountMenu [role="option"]').filter({hasText:'initial\x40example.invalid'}).click();
 await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.active?.id==='thread-initial' && globalThis.__codexWebuiDebug.state.selectedAccountId==='default');
 await page.locator('#conversation').getByText('Response from second').waitFor();
 await page.locator('#prompt').fill('Continue back on initial'); await page.locator('#sendButton').click();
 await page.waitForFunction(() => !document.querySelector('#composerAccount').disabled);
 const back=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).find(c=>c.params.input?.[0]?.text==='Continue back on initial');
 if(back?.account!=='initial'||back.params.threadId!=='thread-initial') throw new Error('Return continuation used the wrong account or thread: '+JSON.stringify(back));
 if (errors.length) throw new Error('Browser errors: ' + errors.join('; '));
 console.log('Chat accounts switch across tabs and restarts while preserving history and routing continuations.');
} catch (error) { console.error('Account panels test failed during: ' + stage); if (serverErrors) console.error('Server stderr:\n' + serverErrors); if (errors.length || consoleErrors.length) console.error('Browser errors:\n' + [...errors, ...consoleErrors].join('\n')); throw error; }
finally { await browser?.close(); server.kill(); await server.exited; rmSync(temp, { recursive: true, force: true }); }
