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
  owners.remember('El', 'thread', 'a');
  owners.change('El', 'thread', 'a', 'b');
  expect(new ThreadOwnership(file).owner('El', 'thread')).toBe('b');
  expect(new ThreadOwnership(file).owner('zilpio', 'thread')).toBeUndefined();
  expect(new ThreadOwnership(file).isTransferred('El', 'thread')).toBe(true);
  expect(new ThreadOwnership(file).hasAccount('b')).toBe(true);
  expect(new ThreadOwnership(file).hasAccount('a')).toBe(false);
  expect(() => owners.change('El', 'thread', 'a', 'c')).toThrow();
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects a symlinked ownership directory', () => {
 const dir = mkdtempSync(join(tmpdir(), 'thread-ownership-link-'));
 try {
  const real = join(dir, 'real'); mkdirSync(real); symlinkSync(real, join(dir, 'link'));
  expect(() => new ThreadOwnership(join(dir, 'link', 'owners.json')).remember('El', 'thread', 'a')).toThrow();
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('records every linked runtime and persists deletion checkpoints', () => {
 const dir = mkdtempSync(join(tmpdir(), 'thread-delete-journal-'));
 try {
  const file = join(dir, 'owners.json'); const owners = new ThreadOwnership(file);
  owners.remember('El', 'thread', 'a');
  owners.registerLink('El', 'thread', 'a', 'b', '2026/rollout.jsonl');
  owners.change('El', 'thread', 'a', 'b');
  owners.registerLink('El', 'thread', 'b', 'c', '2026/rollout.jsonl');
  owners.change('El', 'thread', 'b', 'c');
  owners.beginDeletion('El', 'thread', 'c');
  owners.startDeletionAccount('El', 'thread', 'a');
  owners.checkpointDeletion('El', 'thread', 'a');
  const restored = new ThreadOwnership(file);
  expect(restored.deletion('El', 'thread')).toEqual({path:'2026/rollout.jsonl', accounts:['a','b','c'], completed:['a'], started:['a']});
  expect(restored.isDeleted('El', 'thread')).toBe(true);
  expect(restored.pendingNames('El', 'c')).toEqual([]);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('deletion clears a recovered title before the thread is removed', () => {
 const dir=mkdtempSync(join(tmpdir(),'thread-delete-title-'));
 try { const owners=new ThreadOwnership(join(dir,'owners.json'));
  owners.remember('El','thread','a');owners.registerLink('El','thread','a','b','rollout');owners.change('El','thread','a','b','Title');
  expect(owners.pendingNames('El','b')).toHaveLength(1);
  owners.beginDeletion('El','thread','b');expect(owners.pendingNames('El','b')).toEqual([]);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('hiding a broken chat persists independently of an unfinished transfer', () => {
 const dir=mkdtempSync(join(tmpdir(),'thread-hide-'));
 try {
  const file=join(dir,'owners.json'), owners=new ThreadOwnership(file);
  owners.remember('zilpio','thread','a');
  owners.registerLink('zilpio','thread','a','b','rollout');
  owners.hide('zilpio','thread');
  const restored=new ThreadOwnership(file);
  expect(restored.isHidden('zilpio','thread')).toBe(true);
  expect(restored.isHidden('zilpio','other')).toBe(false);
  expect(restored.linkIntent('zilpio','thread')).not.toBeNull();
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
