import { test, expect } from 'bun:test';
import { createNotifier } from '../public/codex-notifier.js';
function storage() { const data = new Map(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) }; }
test('shows active and completed states until explicitly acknowledged, including after reload', () => {
  const saved = storage(); const n = createNotifier({ storage: saved });
  n.started('one'); expect(n.status('one')).toBe('running');
  n.completed('one', 'turn-1'); expect(n.status('one')).toBe('unread');
  n.started('one'); expect(n.status('one')).toBe('running');
  n.completed('one', 'turn-2');
  const restored = createNotifier({ storage: saved }); expect(restored.status('one')).toBe('unread');
  restored.acknowledge('one'); expect(restored.status('one')).toBe('');
  expect(createNotifier({ storage: saved }).status('one')).toBe('');
});
test('plays once per finished turn and respects the saved sound preference', () => {
  const saved = storage(); let sounds = 0;
  const n = createNotifier({ storage: saved, play: () => sounds++ });
  n.completed('one','turn-1'); n.completed('one','turn-1'); expect(sounds).toBe(1);
  n.setSoundEnabled(false); n.completed('one','turn-2'); expect(sounds).toBe(1);
  expect(createNotifier({ storage: saved }).soundEnabled()).toBe(false);
});
test('uses live thread summaries to restore the running indicator', () => {
  const n = createNotifier({ storage: storage() });
  expect(n.status('one', { type: 'active' })).toBe('running');
  expect(n.status('one', { type: 'idle' })).toBe('');
  n.started('one'); n.completed('one', 'turn-1');
  expect(n.status('one', { type: 'active' })).toBe('unread');
});
test('opening a chat cannot clear a completion that arrives after the click', () => {
  const n = createNotifier({ storage: storage() });
  n.completed('one','turn-1');
  const beforeOpen = n.unreadVersion('one');
  n.completed('one','turn-2');
  n.acknowledge('one', beforeOpen);
  expect(n.status('one')).toBe('unread');
  n.acknowledge('one', n.unreadVersion('one'));
  expect(n.status('one')).toBe('');
});

test('quota failures stay attached to the affected chat until it is retried', () => {
  const saved = storage(); const n = createNotifier({ storage: saved });
  n.started('blocked');
  n.failed('blocked', { message: 'Usage limit reached', codexErrorInfo: 'usageLimitExceeded' });
  n.completed('blocked', 'failed-turn');
  expect(n.status('blocked', { type: 'active' })).toBe('exhausted');
  expect(n.status('other', { type: 'idle' })).toBe('');
  n.acknowledge('blocked');
  expect(n.status('blocked')).toBe('exhausted');
  const restored = createNotifier({ storage: saved });
  expect(restored.status('blocked')).toBe('exhausted');
  restored.started('blocked');
  expect(restored.status('blocked')).toBe('running');
  expect(createNotifier({ storage: saved }).status('blocked')).toBe('');
});

test('ordinary failures do not appear as exhausted credits', () => {
  const n = createNotifier({ storage: storage() });
  for (const error of [
    { message: 'Server overloaded', codexErrorInfo: 'serverOverloaded' },
    { message: 'Too many requests', codexErrorInfo: 'rateLimitExceeded' },
    { message: 'Context window exceeded', codexErrorInfo: 'contextWindowExceeded' },
    { message: 'Something went wrong', codexErrorInfo: null },
  ]) n.failed('other', error);
  expect(n.status('other')).toBe('');
});

test('quota indicators from separate browser views preserve each other', () => {
  const saved = storage(); const first = createNotifier({ storage: saved }), second = createNotifier({ storage: saved });
  first.failed('one', { codexErrorInfo: 'usageLimitExceeded' });
  second.failed('two', { message: 'You have exceeded your current quota' });
  first.reload();
  expect(first.status('one')).toBe('exhausted');
  expect(first.status('two')).toBe('exhausted');
  first.started('one');
  second.reload();
  expect(second.status('one')).toBe('');
  expect(second.status('two')).toBe('exhausted');
});

test('sidebar renders working and unread markers and clears unread only after the chat opens', async () => {
  const { JSDOM } = await import('jsdom');
  const { readFileSync } = await import('node:fs');
  const doc = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')).window.document;
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const grouping = source.slice(source.indexOf('function sidebarProjectKey('), source.indexOf('async function deleteThread('));
  const rendering = source.slice(source.indexOf('function sidebarThreadStatus('), source.indexOf('async function openThread('));
  const n = createNotifier({ storage: storage() });
  const state = { threads: [{ id: 'thread-1', name: 'Test chat', cwd: '/work', status: { type: 'idle' } }], active: { id: 'thread-1', cwd: '/work' }, config: { home: '/work' }, workspaceContext: { cwd: '/work' } };
  let opens = 0;
  const render = new Function('document', 'state', 'projectSettings', 'PROJECT_ICONS', 'notifier', 'openThread', `const $=s=>document.querySelector(s),t=s=>s,shortPath=s=>s,titleOf=t=>t.name||'',codexIcon=()=>'',escapeHtml=s=>s,formatAge=()=>'',sidebarProjectExpansion={},sidebarMoreChats=new Set(),splitChats=null,mobileSidebarEnabled=()=>false;${grouping}${rendering}return renderThreads;`)(doc, state, {getProjects:()=>[],open:()=>{}}, {folder:'📁'}, n, async () => { opens++; return true; });
  const style = doc.createElement('style'); style.textContent = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8'); doc.head.append(style);
  n.started('thread-1'); render(); const marker = doc.querySelector('[data-id="thread-1"] .thread-notifier.running')!; expect(marker).not.toBeNull(); expect(doc.defaultView!.getComputedStyle(marker.parentElement!).display).not.toBe('none');
  n.completed('thread-1', 'turn-1'); render(); const unread = doc.querySelector('[data-id="thread-1"] .thread-notifier.unread')!; expect(unread).not.toBeNull(); expect(doc.defaultView!.getComputedStyle(unread.parentElement!).display).not.toBe('none');
  doc.querySelector<HTMLElement>('[data-id="thread-1"]')!.click(); await Promise.resolve(); await Promise.resolve();
  expect(opens).toBe(1); expect(doc.querySelector('[data-id="thread-1"] .thread-notifier')).toBeNull();
  state.threads = Array.from({length: 7}, (_, i) => ({id: `chat-${i}`, name: `Chat ${i}`, cwd: '/work', status: {type: 'idle'}, recencyAt: i + 1}));
  n.completed('chat-0', 'completed'); n.started('chat-1'); render();
  const ids = () => Array.from(doc.querySelectorAll<HTMLElement>('.thread-item')).map(row => row.dataset.id);
  expect(ids()).toEqual(['chat-1', 'chat-0', 'chat-6', 'chat-5', 'chat-4']);
  doc.querySelector<HTMLButtonElement>('.sidebar-show-more')!.click();
  expect(ids()).toEqual(['chat-1', 'chat-0', 'chat-6', 'chat-5', 'chat-4', 'chat-3', 'chat-2']);
  doc.querySelector<HTMLButtonElement>('.sidebar-show-more')!.click(); expect(ids()).toHaveLength(5);
  (doc.querySelector('#threadSearch') as HTMLInputElement).value = 'Chat'; render(); expect(ids()).toHaveLength(7);
});
