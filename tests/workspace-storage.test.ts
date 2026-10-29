import {expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';
import {migrateWorkspaceStorage} from '../public/workspace-storage.js';
const config = {environmentId: 'workspace', environments: [{id: 'workspace'}]};

test('preserves legacy project selection and unsent chat and new-task drafts once', () => {
  const window = new JSDOM('', {url: 'https://example.test'}).window, local = window.localStorage, session = window.sessionStorage;
  local.setItem('codex-webui-project:legacy', '/home/app/legacy/project');
  session.setItem('codex-webui-draft:legacy:account:chat', 'chat draft');
  session.setItem('codex-webui-draft-new:legacy:account:secondary:project', 'new draft');
  migrateWorkspaceStorage(config, local, session);
  expect(local.getItem('codex-webui-project:workspace')).toBe('/home/app/legacy/project');
  expect(session.getItem('codex-webui-draft:workspace:account:chat')).toBe('chat draft');
  expect(session.getItem('codex-webui-draft-new:workspace:account:secondary:project')).toBe('new draft');
  session.removeItem('codex-webui-draft:workspace:account:chat');
  migrateWorkspaceStorage(config, local, session);
  expect(session.getItem('codex-webui-draft:workspace:account:chat')).toBeNull();
  window.close();
});
test('keeps existing Workspace browser preferences and drafts', () => {
  const window = new JSDOM('', {url: 'https://example.test'}).window, local = window.localStorage, session = window.sessionStorage;
  local.setItem('codex-webui-project:legacy', 'old'); local.setItem('codex-webui-project:workspace', 'current');
  session.setItem('codex-webui-draft:legacy:account:chat', 'old'); session.setItem('codex-webui-draft:workspace:account:chat', 'current');
  migrateWorkspaceStorage(config, local, session);
  expect(local.getItem('codex-webui-project:workspace')).toBe('current'); expect(session.getItem('codex-webui-draft:workspace:account:chat')).toBe('current');
  window.close();
});
