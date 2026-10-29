import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadOwnership } from '../thread-ownership.js';

test('ownership persists per environment and rejects stale owners', () => {
 const dir = mkdtempSync(join(tmpdir(), 'thread-ownership-'));
 try {
  const file = join(dir, 'owners.json');
  const owners = new ThreadOwnership(file);
  owners.remember('legacy', 'thread', 'a');
  owners.change('legacy', 'thread', 'a', 'b');
  expect(new ThreadOwnership(file).owner('legacy', 'thread')).toBe('b');
  expect(new ThreadOwnership(file).owner('workspace', 'thread')).toBeUndefined();
  expect(new ThreadOwnership(file).isTransferred('legacy', 'thread')).toBe(true);
  expect(new ThreadOwnership(file).hasAccount('b')).toBe(true);
  expect(new ThreadOwnership(file).hasAccount('a')).toBe(false);
  expect(() => owners.change('legacy', 'thread', 'a', 'c')).toThrow();
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects a symlinked ownership directory', () => {
 const dir = mkdtempSync(join(tmpdir(), 'thread-ownership-link-'));
 try {
  const real = join(dir, 'real'); mkdirSync(real); symlinkSync(real, join(dir, 'link'));
  expect(() => new ThreadOwnership(join(dir, 'link', 'owners.json')).remember('legacy', 'thread', 'a')).toThrow();
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('records every linked runtime and persists deletion checkpoints', () => {
 const dir = mkdtempSync(join(tmpdir(), 'thread-delete-journal-'));
 try {
  const file = join(dir, 'owners.json'); const owners = new ThreadOwnership(file);
  owners.remember('legacy', 'thread', 'a');
  owners.registerLink('legacy', 'thread', 'a', 'b', '2026/rollout.jsonl');
  owners.change('legacy', 'thread', 'a', 'b');
  owners.registerLink('legacy', 'thread', 'b', 'c', '2026/rollout.jsonl');
  owners.change('legacy', 'thread', 'b', 'c');
  owners.beginDeletion('legacy', 'thread', 'c');
  owners.startDeletionAccount('legacy', 'thread', 'a');
  owners.checkpointDeletion('legacy', 'thread', 'a');
  const restored = new ThreadOwnership(file);
  expect(restored.deletion('legacy', 'thread')).toEqual({path:'2026/rollout.jsonl', accounts:['a','b','c'], completed:['a'], started:['a']});
  expect(restored.isDeleted('legacy', 'thread')).toBe(true);
  expect(restored.pendingNames('legacy', 'c')).toEqual([]);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('deletion clears a recovered title before the thread is removed', () => {
 const dir=mkdtempSync(join(tmpdir(),'thread-delete-title-'));
 try { const owners=new ThreadOwnership(join(dir,'owners.json'));
  owners.remember('legacy','thread','a');owners.registerLink('legacy','thread','a','b','rollout');owners.change('legacy','thread','a','b','Title');
  expect(owners.pendingNames('legacy','b')).toHaveLength(1);
  owners.beginDeletion('legacy','thread','b');expect(owners.pendingNames('legacy','b')).toEqual([]);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('hiding a broken chat persists independently of an unfinished transfer', () => {
 const dir=mkdtempSync(join(tmpdir(),'thread-hide-'));
 try {
  const file=join(dir,'owners.json'), owners=new ThreadOwnership(file);
  owners.remember('workspace','thread','a');
  owners.registerLink('workspace','thread','a','b','rollout');
  owners.hide('workspace','thread');
  const restored=new ThreadOwnership(file);
  expect(restored.isHidden('workspace','thread')).toBe(true);
  expect(restored.isHidden('workspace','other')).toBe(false);
  expect(restored.linkIntent('workspace','thread')).not.toBeNull();
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('project assignment persists separately for each environment', () => {
 const dir=mkdtempSync(join(tmpdir(),'thread-project-'));
 try {
  const file=join(dir,'state.json'), store=new ThreadOwnership(file);
  store.setProject('one','chat','/work/project');
  const restored=new ThreadOwnership(file);
  expect(restored.project('one','chat')).toBe('/work/project');
  expect(restored.project('two','chat')).toBeUndefined();
  restored.setProject('one','chat','/work/other');
  expect(new ThreadOwnership(file).project('one','chat')).toBe('/work/other');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
