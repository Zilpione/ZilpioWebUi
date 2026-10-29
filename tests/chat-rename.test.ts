import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

test('rename button saves a chat name and updates the active heading', async () => {
  const doc = new JSDOM(readFileSync('public/index.html', 'utf8')).window.document;
  const source = readFileSync('public/app.js', 'utf8');
  const grouping = source.slice(source.indexOf('function sidebarProjectKey('), source.indexOf('async function deleteThread('));
  const renaming = source.slice(source.indexOf('async function renameThread('), source.indexOf('function renderThreads('));
  const rendering = source.slice(source.indexOf('function renderThreads('), source.indexOf('async function openThread('));
  const thread = { id: 'one', name: 'Old', cwd: '/work', accountId: 'other-account' };
  const state = { threads: [thread], active: { ...thread }, defaultAccountId: 'default', autoReload: { one: { enabled: true } }, config: { home: '/work' }, workspaceContext: { cwd: '/work' } };
  const calls: any[] = [];
  let heading = '';
  const render = new Function('document', 'state', 'rpc', 'prompt', 'renderHeader', `const $=s=>document.querySelector(s),t=s=>s,shortPath=s=>s,titleOf=t=>t.name||'',threadAccount=(_id,fallback)=>fallback,codexIcon=()=>'',formatAge=()=>'',sidebarProjectExpansion={},sidebarProjectOrder=[],sidebarMoreChats=new Set(),splitChats=null,mobileSidebarEnabled=()=>false,projectSettings={getProjects:()=>[]},PROJECT_ICONS={folder:'📁'},notifier={status:()=>''},toast=()=>{};${grouping}${renaming}${rendering}return renderThreads;`)(doc, state, async (...args: any[]) => calls.push(args), () => ' New name ', () => { heading = state.active.name; });
  render();
  const autoReload = doc.querySelector<HTMLButtonElement>('.thread-auto-reload');
  expect(autoReload?.disabled).toBe(true);
  expect(autoReload?.title).toContain('default account');
  const button = doc.querySelector<HTMLButtonElement>('.thread-rename');
  expect(button).not.toBeNull();
  button!.click();
  const input = doc.querySelector<HTMLInputElement>('.thread-rename-input');
  expect(input).not.toBeNull();
  input!.value = ' New name ';
  input!.dispatchEvent(new doc.defaultView!.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls).toEqual([['thread/name/set', { threadId: 'one', name: 'New name' }, 'other-account']]);
  expect(state.threads[0].name).toBe('New name');
  expect(heading).toBe('New name');
});

test('a refreshed chat name updates the sidebar and active heading', () => {
  const source = readFileSync('public/app.js', 'utf8');
  const summaries = source.slice(source.indexOf('function threadSummarySignature('), source.indexOf('function scheduleThreadListRefresh('));
  const state = { threads: [], active: { id: 'one', name: 'Old', turns: [] } };
  let sidebar = '', heading = '';
  const apply = new Function('state', 'renderThreads', 'renderHeader', `let threadListSignature='';const titleOf=t=>t.name||t.preview||'Untitled task',notifier={observeSummary:()=>{}},scheduleActiveThreadSync=()=>{};${summaries}return applyThreadSummaries;`)(state, () => { sidebar = state.threads[0].name; }, () => { heading = state.active!.name; });
  apply([{ id: 'one', name: 'Old', updatedAt: 1 }]);
  apply([{ id: 'one', name: 'New name', updatedAt: 1 }]);
  expect(sidebar).toBe('New name');
  expect(heading).toBe('New name');
});

test('thread lists replace stale cached owners but cannot overwrite a newer ownership event', async () => {
  const source = readFileSync('public/app.js', 'utf8');
  const accountFunctions = source.slice(source.indexOf('let threadAccountRevision='), source.indexOf('async function selectAccount('));
  const listFunction = source.slice(source.indexOf('async function listAccountThreads()'), source.indexOf('async function loadAccount('));
  const values = new Map([['codex-webui-thread-account:one', 'old']]);
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value) };
  let resolveList: (value: any) => void = () => {};
  const rpc = () => new Promise(resolve => { resolveList = resolve; });
  const state = { accounts: [{ id: 'new' }], defaultAccountId: 'old', selectedAccountId: 'old', threads: [], active: null };
  const api = new Function('state', 'localStorage', 'rpc', `let accountStartPending=false,accountSwitchPending=null,threadNavigationGeneration=0;const syncAccountSelector=()=>{},scheduleActiveThreadSync=()=>{},renderThreads=()=>{},activeTurnId=()=>'',toast=()=>{};${accountFunctions}${listFunction}return {listAccountThreads,applyThreadAccountChange};`)(state, storage, rpc);
  const first = api.listAccountThreads();
  resolveList({ data: [{ id: 'one', accountId: 'new' }] });
  expect((await first).data[0].accountId).toBe('new');
  expect(values.get('codex-webui-thread-account:one')).toBe('new');
  const stale = api.listAccountThreads();
  api.applyThreadAccountChange('one', 'latest');
  resolveList({ data: [{ id: 'one', accountId: 'new' }] });
  expect((await stale).data[0].accountId).toBe('latest');
  expect(values.get('codex-webui-thread-account:one')).toBe('latest');
});
