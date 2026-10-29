import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { repositoryChanges, repositoryBranch, repositoryDiffs, discardRepositoryChange, commitAndPush } from '../project-repository.js';
import { initProjectChanges } from '../public/project-changes.js';

test('counts each dirty file once, including staged changes, renames, and nested untracked files', async () => {
 const root = mkdtempSync(join(tmpdir(), 'project-changes-'));
 const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
 try {
  git('init', '-q'); git('config', 'user.email', 'test\x40example.com'); git('config', 'user.name', 'Test');
  for (const name of ['modified', 'deleted', 'renamed', '.gitignore']) writeFileSync(join(root, name), name === '.gitignore' ? 'ignored\n' : 'initial');
  git('add', '.'); git('commit', '-qm', 'initial');
  expect(await repositoryChanges(root)).toEqual({ modified: 0, added: 0, deleted: 0, untracked: 0, total: 0 });
  writeFileSync(join(root, 'modified'), 'staged'); git('add', 'modified'); writeFileSync(join(root, 'modified'), 'unstaged');
  unlinkSync(join(root, 'deleted')); git('mv', 'renamed', 'renamed\nwith newline');
  writeFileSync(join(root, 'added'), 'new'); git('add', 'added');
  mkdirSync(join(root, 'nested')); writeFileSync(join(root, 'nested', 'one'), '1'); writeFileSync(join(root, 'nested', 'two'), '2');
  writeFileSync(join(root, 'ignored'), 'hidden');
  expect(await repositoryChanges(root)).toEqual({ modified: 2, added: 1, deleted: 1, untracked: 2, total: 6 });
  expect(await repositoryChanges(join(root, 'nested'))).toEqual({ modified: 0, added: 0, deleted: 0, untracked: 2, total: 2 });
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('non-repositories return no badges', async () => {
 const root = mkdtempSync(join(tmpdir(), 'project-changes-'));
 try { expect(await repositoryChanges(root)).toBeNull(); }
 finally { rmSync(root, { recursive: true, force: true }); }
});

test('badges survive sidebar redraws, hide clean projects and skip task groups', async () => {
 const dom = new JSDOM('<div id="list"></div>', { pretendToBeVisual: true });
 const doc = dom.window.document, list = doc.querySelector('#list')!;
 const markup = (path: string) => `<section class="sidebar-project-group" data-project="${path}"><div class="sidebar-project-heading"><button class="sidebar-project-row"><span>Folder</span><span>Project</span><span class="sidebar-project-chevron"></span></button><button class="project-new-chat">+</button><button class="project-settings-button">⋯</button></div></section>`;
 list.innerHTML = markup('/project') + markup('/clean') + markup('__tasks__');
 const calls: string[] = [];
 const controller = initProjectChanges({ list, document: doc, window: dom.window, fetch: async (url: string) => {
  calls.push(url);
  return Response.json({ changes: url.includes('%2Fclean') ? { total: 0 } : { modified: 2, untracked: 1, total: 3 } });
 } });
 try {
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(list.querySelector('.project-changes')!.textContent).toBe('M2?1');
  expect(list.querySelector('.project-changes')!.nextElementSibling?.className).toBe('project-new-chat');
  expect(list.querySelector('.project-changes')!.getAttribute('aria-label')).toBe('3 file non committati');
  expect((list.querySelector('[data-project="/clean"] .project-changes') as HTMLElement).hidden).toBe(true);
  expect(calls).toHaveLength(2);
  list.innerHTML = markup('/project');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(list.querySelector('.project-changes')!.textContent).toBe('M2?1');
  expect(calls).toHaveLength(2);
 } finally { controller.destroy(); dom.window.close(); }
});


test('shows and selectively discards tracked, renamed, staged new and untracked files', async () => {
 const root = mkdtempSync(join(tmpdir(), 'project-diffs-'));
 const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
 try {
  git('init', '-q'); git('config', 'user.email', 'test\x40example.com'); git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'tracked'), 'before\n'); writeFileSync(join(root, 'old'), 'rename\n'); git('add', '.'); git('commit', '-qm', 'initial');
  writeFileSync(join(root, 'tracked'), 'after\n'); git('mv', 'old', 'new');
  writeFileSync(join(root, 'added'), 'added\n'); git('add', 'added'); writeFileSync(join(root, 'untracked'), 'new\n');
  expect(await repositoryBranch(root)).toBe(git('branch', '--show-current').toString().trim());
  const files = await repositoryDiffs(root);
  expect(files.find(f => f.name === 'tracked')?.diff).toContain('+after');
  expect(files.find(f => f.name === 'untracked')?.diff).toContain('+new');
  await discardRepositoryChange(root, 'new'); await discardRepositoryChange(root, 'added'); await discardRepositoryChange(root, 'untracked');
  expect((await repositoryChanges(root))?.total).toBe(1);
  expect((await repositoryDiffs(root))[0].name).toBe('tracked');
  await discardRepositoryChange(root, 'tracked'); expect((await repositoryChanges(root))?.total).toBe(0);
  await expect(discardRepositoryChange(root, '../outside')).rejects.toThrow();
  await expect(commitAndPush(root, ' ')).rejects.toThrow();
 } finally { rmSync(root, { recursive: true, force: true }); }
});
