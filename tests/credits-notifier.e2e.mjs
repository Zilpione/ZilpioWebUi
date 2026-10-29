import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { launchOptions } from './browser-runtime.mjs';

const root = new URL('..', import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), 'webui-credits-test-'));
const home = join(temp, 'home'), bin = join(temp, 'bin'), project = join(home, 'project');
for (const path of [home, bin, project, join(home, '.codex')]) mkdirSync(path, { recursive: true });
writeFileSync(join(bin, 'codex'), String.raw`#!/usr/bin/env bun
import { createInterface } from 'node:readline';
const threads = ['a', 'b', 'c'].map(id => ({ id: 'thread-' + id, name: 'Chat ' + id.toUpperCase(), cwd: process.env.TEST_PROJECT, turns: [], status: { type: 'idle' }, canAcceptDirectInput: true }));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined || !request.method) continue;
  const { method, params = {}, id } = request;
  let result = {};
  if (method === 'initialize') result = { codexHome: process.env.CODEX_HOME };
  if (method === 'model/list') result = { data: [{ id: 'test', model: 'test', displayName: 'Test', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] };
  if (method === 'account/read') result = { account: { type: 'apiKey' } };
  if (method === 'thread/list') result = { data: threads, nextCursor: null };
  if (method === 'thread/read' || method === 'thread/resume') result = { thread: threads.find(thread => thread.id === params.threadId) };
  if (method === 'thread/turns/list' || method === 'permissionProfile/list') result = { data: [] };
  if (method === 'turn/start') {
    const threadId = params.threadId, text = params.input[0].text, turnId = threadId + '-' + text;
    if (text === 'start-rejected') { send({ id, error: { code: -32000, message: 'You have exceeded your current quota' } }); continue; }
    send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
    setTimeout(() => {
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
      const quota = { message: 'Usage limit reached', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null };
      const other = { message: 'Server overloaded', codexErrorInfo: 'serverOverloaded', additionalDetails: null };
      if (text === 'quota-event') send({ method: 'error', params: { threadId, turnId, error: quota, willRetry: false } });
      if (text === 'temporary') send({ method: 'error', params: { threadId, turnId, error: quota, willRetry: true } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], status: ['quota-event', 'quota-completed', 'other-error'].includes(text) ? 'failed' : 'completed', error: text === 'quota-completed' ? quota : text === 'other-error' ? other : null } } });
    }, 50);
    continue;
  }
  send({ id, result });
}
`, { mode: 0o755 });

const port = await new Promise(resolve => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
});
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn(['bun', 'run', 'server.ts'], {
  cwd: root,
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, CODEX_HOME: join(home, '.codex'), CODEX_WEBUI_CWD: project, CODEX_WEBUI_WORKSPACE_BASE: home, CODEX_WEBUI_MANAGED_ACCOUNTS: 'false', CODEX_WEBUI_PROJECTLESS: 'false', CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', HOST: '127.0.0.1', PORT: String(port), TEST_PROJECT: project },
  stdout: 'ignore', stderr: 'ignore',
});
let browser;
try {
  for (let i = 0; i < 200; i++) {
    try { if ((await (await fetch(`${base}/api/health`)).json()).codex) break; } catch {}
    await Bun.sleep(50);
    if (i === 199) throw new Error('Test server did not become ready');
  }
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.thread-item[data-id="thread-a"]');
  await page.locator('#sidebarSearchButton').click();
  await page.locator('#threadSearch').fill('Chat');
  async function send(thread, text) {
    await page.locator(`.thread-item[data-id="thread-${thread}"] .thread-name`).click();
    await page.waitForFunction(id => globalThis.__codexWebuiDebug?.state.active?.id === id, `thread-${thread}`);
    await page.locator('#prompt').fill(text);
    await page.locator('#sendButton').click();
  }
  const red = thread => page.locator(`.thread-item[data-id="thread-${thread}"] .thread-notifier.exhausted`);
  await send('b', 'quota-event');
  await red('b').waitFor();
  if (await red('b').getAttribute('aria-label') !== 'Crediti esauriti') throw new Error('Quota indicator is not accessible');
  if (await red('b').evaluate(marker => getComputedStyle(marker).backgroundColor) !== 'rgb(239, 83, 80)') throw new Error('Quota indicator is not red');
  if (await red('a').count() || await red('c').count()) throw new Error('Quota indicator appeared on an unrelated chat');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await red('b').waitFor();
  await page.locator('.thread-item[data-id="thread-b"] .thread-name').click();
  if (!(await red('b').count())) throw new Error('Opening a chat dismissed the quota indicator');
  await send('a', 'quota-completed');
  await red('a').waitFor();
  await send('c', 'other-error');
  await page.locator('.thread-item[data-id="thread-c"] .thread-notifier.unread').waitFor();
  if (await red('c').count()) throw new Error('An unrelated error appeared as exhausted credits');
  await send('c', 'temporary');
  await page.waitForTimeout(300);
  if (await red('c').count()) throw new Error('An automatically retried error appeared as exhausted credits');
  await send('b', 'retry');
  await page.waitForTimeout(200);
  if (!(await red('b').count()) || !(await red('a').count())) throw new Error('Retry cleared a quota indicator before its reset');
  await send('c', 'start-rejected');
  await red('c').waitFor();
  await page.locator('.thread-item[data-id="thread-b"]').hover();
  await page.locator('.thread-item[data-id="thread-b"] .thread-split').click();
  await page.waitForFunction(() => document.querySelector('#secondaryChatFrame')?.contentWindow?.__codexWebuiDebug?.state.active?.id === 'thread-b');
  const secondary = page.frameLocator('#secondaryChatFrame');
  await secondary.locator('#prompt').fill('start-rejected');
  await secondary.locator('#sendButton').click();
  await red('b').waitFor();
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log('Quota indicators follow the affected chats and stay visible until the quota resets.');
} finally {
  await browser?.close();
  server.kill();
  await server.exited;
  rmSync(temp, { recursive: true, force: true });
}
