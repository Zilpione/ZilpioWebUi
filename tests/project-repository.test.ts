import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detachRepository, repositoryDiffs, repositorySync } from '../project-repository.js';

test('detach removes only the project git directory', () => {
 const root=mkdtempSync(join(tmpdir(),'project-repo-'));
 try { mkdirSync(join(root,'.git')); writeFileSync(join(root,'.git','config'),'data'); writeFileSync(join(root,'file'),'keep');
  detachRepository(root); expect(existsSync(join(root,'.git'))).toBe(false); expect(readFileSync(join(root,'file'),'utf8')).toBe('keep');
 } finally { rmSync(root,{recursive:true,force:true}); }
});

test('fetches nonempty remote, preserves local files and exposes diff', async () => {
 const { execFileSync } = await import('node:child_process');
 const { chmodSync } = await import('node:fs');
 const { assignRepository } = await import('../project-repository.js');
 const root=mkdtempSync(join(tmpdir(),'project-repo-'));
 try {
  const remote=join(root,'remote'), project=join(root,'project'), gh=join(root,'gh'); mkdirSync(remote);mkdirSync(project);
  execFileSync('git',['init','-q',remote]);execFileSync('git',['-C',remote,'config','user.email','test@example.com']);execFileSync('git',['-C',remote,'config','user.name','Test']);
  writeFileSync(join(remote,'remote.txt'),'remote');writeFileSync(join(remote,'shared.txt'),'remote version');execFileSync('git',['-C',remote,'add','.']);execFileSync('git',['-C',remote,'commit','-qm','initial']);
  writeFileSync(join(project,'local.txt'),'local');writeFileSync(join(project,'shared.txt'),'local version');
  writeFileSync(gh,`#!/bin/sh\nif [ "$1" = api ]; then case "$4" in *starred*) printf '[[]]';; *) printf '[[{"full_name":"a/b"}]]';; esac; elif [ "$1" = repo ] && [ "$2" = view ]; then printf '%s' '{"url":"${remote}"}'; else exit 9; fi\n`);chmodSync(gh,0o755);
  expect(await assignRepository(project,'a/b',gh)).toEqual({populated:true,emptyRemote:false});
  expect((await repositoryDiffs(project)).map(f => [f.name, f.status]).sort()).toEqual([['local.txt','??'],['remote.txt',' D'],['shared.txt',' M']]);
  expect((await repositorySync(project)).upstream).toMatch(/^origin\//);
  expect(existsSync(join(project,'remote.txt'))).toBe(false);
  expect((await repositoryDiffs(project)).find(f => f.name === 'shared.txt')?.diff).toContain('+local version');
  await expect(assignRepository(project, 'a/b', gh)).rejects.toThrow('già un repository');
  detachRepository(project);
  expect(existsSync(join(project,'.git'))).toBe(false);
  expect(readFileSync(join(project,'shared.txt'),'utf8')).toBe('local version');
  await assignRepository(project, 'a/b', gh);
  expect((await repositorySync(project)).upstream).toMatch(/^origin\//);
  expect(readFileSync(join(project,'local.txt'),'utf8')).toBe('local');expect(existsSync(join(project,'.git'))).toBe(true);
 } finally { rmSync(root,{recursive:true,force:true}); }
});

test('connects an empty remote to existing files without changing them', async () => {
 const { execFileSync } = await import('node:child_process');
 const { chmodSync } = await import('node:fs');
 const { assignRepository, repositoryStatus } = await import('../project-repository.js');
 const root=mkdtempSync(join(tmpdir(),'project-repo-'));
 try {
  const remote=join(root,'remote'),project=join(root,'project'),gh=join(root,'gh');mkdirSync(remote);mkdirSync(project);execFileSync('git',['init','-q','--bare',remote]);writeFileSync(join(project,'local.txt'),'local');
  writeFileSync(gh,`#!/bin/sh\nif [ "$1" = api ]; then case "$4" in *starred*) printf '[[]]';; *) printf '[[{"full_name":"a/b"}]]';; esac; elif [ "$1" = repo ] && [ "$2" = view ]; then printf '%s' '{"url":"${remote}"}'; else exit 9; fi\n`);chmodSync(gh,0o755);
  expect(await assignRepository(project,'a/b',gh)).toEqual({populated:true,emptyRemote:true});
  expect((await repositoryStatus(project)).assigned).toBe(true);expect(readFileSync(join(project,'local.txt'),'utf8')).toBe('local');
 } finally { rmSync(root,{recursive:true,force:true}); }
});

for (const populated of [false, true]) test(`assigns repo with read-only parent (populated=${populated})`, async () => {
 const { execFileSync } = await import('node:child_process');
 const { chmodSync, readdirSync } = await import('node:fs');
 const { assignRepository } = await import('../project-repository.js');
 const root = mkdtempSync(join(tmpdir(), 'repo-permissions-'));
 try {
  const remote = join(root, 'remote'), project = join(root, 'project'), gh = join(root, 'gh');
  mkdirSync(project);
  execFileSync('git', ['init', '-q', '--bare', remote]);
  if (populated) writeFileSync(join(project, 'local.txt'), 'keep');
  writeFileSync(gh, `#!/bin/sh\nif [ "$1" = api ]; then printf '[[{"full_name":"a/b"}]]'; elif [ "$1" = repo ] && [ "$2" = view ]; then printf '%s' '{"url":"${remote}"}'; else exit 9; fi\n`);
  chmodSync(gh, 0o755);
  chmodSync(root, 0o555);
  expect(await assignRepository(project, 'a/b', gh)).toEqual({ populated, emptyRemote: populated });
  expect(readdirSync(project).sort()).toEqual(populated ? ['.git', 'local.txt'] : ['.git']);
  if (populated) expect(readFileSync(join(project, 'local.txt'), 'utf8')).toBe('keep');
 } finally { chmodSync(root, 0o755); rmSync(root, { recursive: true, force: true }); }
});

test('failed fetch removes newly initialized git metadata and preserves files', async () => {
 const { chmodSync, readdirSync } = await import('node:fs');
 const { assignRepository } = await import('../project-repository.js');
 const root = mkdtempSync(join(tmpdir(), 'repo-failed-'));
 try {
  const project = join(root, 'project'), gh = join(root, 'gh');
  mkdirSync(project); writeFileSync(join(project, 'keep.txt'), 'keep');
  writeFileSync(gh, `#!/bin/sh\nif [ "$1" = api ]; then printf '[[{"full_name":"a/b"}]]'; else printf '%s' '{"url":"${root}/missing"}'; fi\n`);
  chmodSync(gh, 0o755);
  await expect(assignRepository(project, 'a/b', gh)).rejects.toThrow('Operazione Git non riuscita');
  expect(readdirSync(project)).toEqual(['keep.txt']);
  expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('keep');
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('successful assignment closes selector, refreshes project and opens existing diff view', async () => {
 const { JSDOM } = await import('jsdom');
 const { initProjectRepository } = await import('../public/project-repository.js');
 const dom = new JSDOM('<body></body>');
 const doc = dom.window.document;
 dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
 dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
 const assigned: string[] = [], calls: string[] = [];
 let refreshed = 0;
 const controller = initProjectRepository({ document: doc, register: async () => {}, toast: () => {},
  onChange: () => { refreshed++; }, onAssigned: (path: string) => { assigned.push(path); },
  fetch: async (url: string, options: any) => {
   calls.push(options?.method || 'GET');
   return Response.json(options?.method === 'POST' ? { populated: true, emptyRemote: false } : url.endsWith('/repositories') ? { repositories: [{ name: 'a/b' }] } : { assigned: false });
  },
 });
 try {
  await controller.open('/project');
  (doc.querySelector('.repo-list button') as HTMLButtonElement).click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(assigned).toEqual(['/project']); expect(refreshed).toBe(1);
  expect(calls).toEqual(['GET', 'GET', 'POST']);
  expect(doc.querySelector('dialog')!.hasAttribute('open')).toBe(false);
  expect(doc.querySelector('.repo-error')!.textContent).toBe('');
 } finally { dom.window.close(); }
});
