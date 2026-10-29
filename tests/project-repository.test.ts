import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detachRepository } from '../project-repository.js';

test('detach removes only the project git directory', () => {
 const root=mkdtempSync(join(tmpdir(),'project-repo-'));
 try { mkdirSync(join(root,'.git')); writeFileSync(join(root,'.git','config'),'data'); writeFileSync(join(root,'file'),'keep');
  detachRepository(root); expect(existsSync(join(root,'.git'))).toBe(false); expect(readFileSync(join(root,'file'),'utf8')).toBe('keep');
 } finally { rmSync(root,{recursive:true,force:true}); }
});

test('refuses a nonempty remote for a populated folder without changing files', async () => {
 const { execFileSync } = await import('node:child_process');
 const { chmodSync } = await import('node:fs');
 const { assignRepository } = await import('../project-repository.js');
 const root=mkdtempSync(join(tmpdir(),'project-repo-'));
 try {
  const remote=join(root,'remote'), project=join(root,'project'), gh=join(root,'gh'); mkdirSync(remote);mkdirSync(project);
  execFileSync('git',['init','-q',remote]);execFileSync('git',['-C',remote,'config','user.email','test\x40example.com']);execFileSync('git',['-C',remote,'config','user.name','Test']);
  writeFileSync(join(remote,'remote.txt'),'remote');execFileSync('git',['-C',remote,'add','.']);execFileSync('git',['-C',remote,'commit','-qm','initial']);
  writeFileSync(join(project,'local.txt'),'local');
  writeFileSync(gh,`#!/bin/sh\nif [ "$1" = api ]; then case "$4" in *starred*) printf '[[]]';; *) printf '[[{"full_name":"a/b"}]]';; esac; else git clone -q '${remote}' "$4"; fi\n`);chmodSync(gh,0o755);
  await expect(assignRepository(project,'a/b',gh)).rejects.toThrow('contengono già file');
  expect(readFileSync(join(project,'local.txt'),'utf8')).toBe('local');expect(existsSync(join(project,'.git'))).toBe(false);
 } finally { rmSync(root,{recursive:true,force:true}); }
});

test('connects an empty remote to existing files without changing them', async () => {
 const { execFileSync } = await import('node:child_process');
 const { chmodSync } = await import('node:fs');
 const { assignRepository, repositoryStatus } = await import('../project-repository.js');
 const root=mkdtempSync(join(tmpdir(),'project-repo-'));
 try {
  const remote=join(root,'remote'),project=join(root,'project'),gh=join(root,'gh');mkdirSync(remote);mkdirSync(project);execFileSync('git',['init','-q','--bare',remote]);writeFileSync(join(project,'local.txt'),'local');
  writeFileSync(gh,`#!/bin/sh\nif [ "$1" = api ]; then case "$4" in *starred*) printf '[[]]';; *) printf '[[{"full_name":"a/b"}]]';; esac; else git clone -q '${remote}' "$4"; fi\n`);chmodSync(gh,0o755);
  expect(await assignRepository(project,'a/b',gh)).toEqual({populated:true,emptyRemote:true});
  expect((await repositoryStatus(project)).assigned).toBe(true);expect(readFileSync(join(project,'local.txt'),'utf8')).toBe('local');
 } finally { rmSync(root,{recursive:true,force:true}); }
});
