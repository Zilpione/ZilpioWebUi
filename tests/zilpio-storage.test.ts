import {expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';
import {migrateZilpioStorage} from '../public/zilpio-storage.js';
const config = {environmentId: 'zilpio', environments: [{id: 'zilpio'}]};

test('preserves El project selection and unsent chat and new-task drafts once', () => {
  const window = new JSDOM('', {url: 'https://example.test'}).window, local = window.localStorage, session = window.sessionStorage;
  local.setItem('codex-webui-project:El', '/home/codex/el/project');
  session.setItem('codex-webui-draft:El:account:chat', 'chat draft');
  session.setItem('codex-webui-draft-new:El:account:secondary:project', 'new draft');
  migrateZilpioStorage(config, local, session);
  expect(local.getItem('codex-webui-project:zilpio')).toBe('/home/codex/el/project');
  expect(session.getItem('codex-webui-draft:zilpio:account:chat')).toBe('chat draft');
  expect(session.getItem('codex-webui-draft-new:zilpio:account:secondary:project')).toBe('new draft');
  session.removeItem('codex-webui-draft:zilpio:account:chat');
  migrateZilpioStorage(config, local, session);
  expect(session.getItem('codex-webui-draft:zilpio:account:chat')).toBeNull();
  window.close();
});
test('keeps existing Zilpio browser preferences and drafts', () => {
  const window = new JSDOM('', {url: 'https://example.test'}).window, local = window.localStorage, session = window.sessionStorage;
  local.setItem('codex-webui-project:El', 'old'); local.setItem('codex-webui-project:zilpio', 'current');
  session.setItem('codex-webui-draft:El:account:chat', 'old'); session.setItem('codex-webui-draft:zilpio:account:chat', 'current');
  migrateZilpioStorage(config, local, session);
  expect(local.getItem('codex-webui-project:zilpio')).toBe('current'); expect(session.getItem('codex-webui-draft:zilpio:account:chat')).toBe('current');
  window.close();
});
