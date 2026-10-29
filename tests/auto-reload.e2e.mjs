import { chromium } from 'playwright';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { launchOptions } from './browser-runtime.mjs';

const root = new URL('..', import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), 'webui-autoreload-test-'));
const home = join(temp, 'home'), bin = join(temp, 'bin'), project = join(home, 'project');
const quotaFile = join(temp, 'quota.json'), rpcLog = join(temp, 'rpc.jsonl'), telegramLog = join(temp, 'telegram.jsonl'), historyFile = join(temp, 'history.json');
for (const path of [home, bin, project, join(home, '.codex'), join(home, '.webui')]) mkdirSync(path, { recursive: true });
writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { account_id: 'auto-reload-test-account', id_token: `x.${Buffer.from(JSON.stringify({ email: 'test@example.invalid' })).toString('base64url')}.x` } }));
writeFileSync(join(home, '.webui', 'telegram.json'), JSON.stringify({ token: '123456:fake-token', chatId: '12345', enabled: true }));
writeFileSync(join(temp, 'preload.mjs'), String.raw`
import { appendFileSync } from 'node:fs';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://api.telegram.org/')) {
    appendFileSync(process.env.TEST_TELEGRAM_LOG, JSON.stringify(JSON.parse(options.body)) + '\n');
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return originalFetch(url, options);
};
`);
writeFileSync(join(bin, 'codex'), String.raw`#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const threads = ['a', 'b'].map(id => ({ id: 'thread-' + id, name: 'Chat ' + id.toUpperCase(), cwd: process.env.TEST_PROJECT, turns: [], status: { type: 'idle' }, canAcceptDirectInput: true }));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined || !request.method) continue;
  const { method, params = {}, id } = request;
  let result = {};
  if (method === 'initialize') result = { codexHome: process.env.CODEX_HOME };
  if (method === 'model/list') result = { data: [{ id: 'test', model: 'test', displayName: 'Test', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] };
  if (method === 'account/read') result = { account: { type: 'apiKey' } };
  if (method === 'account/rateLimits/read') {
    const quota = existsSync(process.env.TEST_QUOTA_FILE) ? JSON.parse(readFileSync(process.env.TEST_QUOTA_FILE, 'utf8')) : null;
    const blocked = quota && Date.now() < quota.readyAt;
    result = { ordinaryUsageAllowed: !blocked, rateLimits: { primary: { windowDurationMins: 300, usedPercent: blocked ? 100 : 1, resetsAt: blocked ? quota.resetAt : Math.floor(Date.now() / 1000) + 18000 }, secondary: { windowDurationMins: 10080, usedPercent: 20, resetsAt: Math.floor(Date.now() / 1000) + 604800 } } };
  }
  if (method === 'thread/list') result = { data: threads, nextCursor: null };
  if (method === 'thread/read' || method === 'thread/resume') result = { thread: threads.find(thread => thread.id === params.threadId) };
  if (method === 'thread/turns/list') {
    const history = existsSync(process.env.TEST_HISTORY_FILE) ? JSON.parse(readFileSync(process.env.TEST_HISTORY_FILE, 'utf8')) : null;
    result = { data: history?.threadId === params.threadId ? [{ itemsView: 'full', items: [{ type: 'userMessage', clientId: history.clientId, content: [{ type: 'text', text: 'riparti' }] }] }] : [], nextCursor: null };
  }
  if (method === 'permissionProfile/list') result = { data: [] };
  if (method === 'turn/start') {
    const threadId = params.threadId, text = params.input[0].text, turnId = threadId + '-' + text;
    appendFileSync(process.env.TEST_RPC_LOG, JSON.stringify({ method, params, time: Date.now() }) + '\n');
    if (text === 'quota-test') {
      const resetAt = Math.floor((Date.now() - 50_000) / 1000);
      writeFileSync(process.env.TEST_QUOTA_FILE, JSON.stringify({ resetAt, readyAt: resetAt * 1000 + 60_000 }));
    }
    if (text === 'riparti' && !existsSync(process.env.TEST_HISTORY_FILE)) {
      writeFileSync(process.env.TEST_HISTORY_FILE, JSON.stringify({ threadId, clientId: params.clientUserMessageId }));
      continue;
    }
    if (text === 'delayed-manual') {
      setTimeout(() => {
        const events = [
          { id, result: { turn: { id: turnId, status: 'inProgress' } } },
          { method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } },
          { method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], status: 'completed', error: null } } },
        ];
        process.stdout.write(events.map(event => JSON.stringify(event)).join('\n') + '\n');
      }, 2500);
      continue;
    }
    send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
    setTimeout(() => {
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
      const error = text === 'quota-test' ? { message: 'Usage limit reached', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } : null;
      if (error) send({ method: 'error', params: { threadId, turnId, error, willRetry: false } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], status: error ? 'failed' : 'completed', error } } });
    }, 50);
    continue;
  }
  send({ id, result });
}
`, { mode: 0o755 });

const port = await new Promise(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, CODEX_HOME: join(home, '.codex'), CODEX_AUTH_PATH: '', OPENAI_API_KEY: '', CODEX_WEBUI_CWD: project, CODEX_WEBUI_WORKSPACE_BASE: home, CODEX_WEBUI_MANAGED_ACCOUNTS: 'false', CODEX_WEBUI_PROJECTLESS: 'false', CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', HOST: '127.0.0.1', PORT: String(port), TEST_PROJECT: project, TEST_QUOTA_FILE: quotaFile, TEST_RPC_LOG: rpcLog, TEST_TELEGRAM_LOG: telegramLog, TEST_HISTORY_FILE: historyFile };
let server, browser;
function startServer() { server = Bun.spawn(['bun', 'run', '--preload', join(temp, 'preload.mjs'), 'server.ts'], { cwd: root, env, stdout: 'ignore', stderr: 'inherit' }); }
async function waitFor(check, label, timeout = 15_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { if (await check()) return; } catch {} await Bun.sleep(50); } throw new Error(`Timed out waiting for ${label}`); }
const readLines = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
try {
  startServer();
  await waitFor(async () => (await (await fetch(`${base}/api/health`)).json()).codex, 'initial server');
  browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(5000);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const row = page.locator('.thread-item[data-id="thread-a"]'), toggle = row.locator('.thread-auto-reload');
  await toggle.waitFor();
  await page.waitForFunction(() => !document.querySelector('.thread-item[data-id="thread-a"] .thread-auto-reload')?.disabled);
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('.thread-item[data-id="thread-a"] .thread-auto-reload')?.getAttribute('aria-checked') === 'true');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.thread-item[data-id="thread-a"] .thread-auto-reload')?.getAttribute('aria-checked') === 'true');
  await row.locator('.thread-name').click(); await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.active?.id === 'thread-a');
  await page.locator('#prompt').fill('quota-test'); await page.locator('#sendButton').click();
  await row.locator('.thread-notifier.exhausted').waitFor();
  await page.waitForFunction(() => document.querySelector('.thread-item[data-id="thread-a"] .thread-notifier.exhausted')?.title.includes('reset'));
  await page.locator('#prompt').fill('manual'); await page.locator('#sendButton').click();
  await page.waitForTimeout(200);
  if (!(await row.locator('.thread-notifier.exhausted').count())) throw new Error('Manual retry cleared the red indicator before reset');
  if (await page.locator('.thread-item[data-id="thread-b"] .thread-notifier.exhausted').count()) throw new Error('An unrelated chat became blocked');
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  if (process.env.AUTO_RELOAD_SCREENSHOT) await page.screenshot({ path: process.env.AUTO_RELOAD_SCREENSHOT });
  await browser.close(); browser = null;
  const quota = JSON.parse(readFileSync(quotaFile, 'utf8'));
  server.kill(); await server.exited; startServer();
  await waitFor(async () => (await (await fetch(`${base}/api/health`)).json()).codex, 'restarted server');
  const waitUntilManual = quota.readyAt - Date.now() - 1200;
  if (waitUntilManual > 0) await Bun.sleep(waitUntilManual);
  const manual = fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 900, method: 'turn/start', params: { threadId: 'thread-a', input: [{ type: 'text', text: 'delayed-manual' }] } }) });
  await waitFor(() => readLines(rpcLog).some(entry => entry.params?.input?.[0]?.text === 'delayed-manual'), 'manual send');
  await Bun.sleep(Math.max(100, quota.readyAt - Date.now() + 300));
  if (readLines(rpcLog).some(entry => entry.params?.input?.[0]?.text === 'riparti')) throw new Error('AutoReload overlapped a manual send');
  await manual;
  await waitFor(() => readLines(rpcLog).some(entry => entry.params?.input?.[0]?.text === 'riparti'), 'automatic restart');
  await waitFor(() => existsSync(historyFile), 'saved message');
  server.kill(); await server.exited; startServer();
  await waitFor(async () => (await (await fetch(`${base}/api/health`)).json()).codex, 'server after lost response');
  await waitFor(() => readLines(telegramLog).some(entry => entry.text?.startsWith('AutoReload:')), 'Telegram notification');
  const retries = readLines(rpcLog).filter(entry => entry.params?.input?.[0]?.text === 'riparti');
  const notifications = readLines(telegramLog).filter(entry => entry.text?.startsWith('AutoReload:'));
  if (retries.length !== 1 || retries[0].params.threadId !== 'thread-a' || retries[0].time < quota.readyAt || !retries[0].params.clientUserMessageId) throw new Error('AutoReload sent the wrong request or did not wait for reset + one minute');
  if (notifications.length !== 1 || !notifications[0].text.includes('Chat A') || !notifications[0].text.includes('riparti')) throw new Error('The Telegram notification did not describe the restarted chat');
  const state = await (await fetch(`${base}/api/auto-reload`)).json();
  if (!state.threads['thread-a']?.enabled || state.threads['thread-a']?.blocked || state.threads['thread-a']?.pending) throw new Error('The restarted chat did not finish its AutoReload state');
  console.log('AutoReload resumed the correct chat and sent Telegram after reset + one minute, with the browser closed and the server restarted.');
} finally {
  await browser?.close();
  if (server) { server.kill(); await server.exited; }
  rmSync(temp, { recursive: true, force: true });
}
