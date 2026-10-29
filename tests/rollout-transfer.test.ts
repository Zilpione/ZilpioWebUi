import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync, linkSync, appendFileSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installRollout, rolloutHash } from '../rollout-transfer.js';

test('copies across mounts, updates a known snapshot, and rejects external changes', () => {
 const dir=mkdtempSync(join(tmpdir(),'rollout-transfer-'));
 try {
  const source=join(dir,'source'), target=join(dir,'target');
  const crossDevice=()=>{throw Object.assign(new Error('cross device'),{code:'EXDEV'});};
  writeFileSync(source,'first'); const first=rolloutHash(source);
  installRollout(source,target,null,{link:crossDevice}); expect(readFileSync(target,'utf8')).toBe('first');
  writeFileSync(source,'second'); installRollout(source,target,first,{link:crossDevice});
  expect(readFileSync(target,'utf8')).toBe('second');
  writeFileSync(target,'external');
  expect(()=>installRollout(source,target,first,{link:crossDevice})).toThrow();
  expect(readFileSync(target,'utf8')).toBe('external');
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('transfers and updates a snapshot across actual filesystem mounts', () => {
 if (!existsSync('/dev/shm') || statSync(tmpdir()).dev === statSync('/dev/shm').dev) return;
 try { accessSync('/dev/shm', constants.W_OK); } catch { return; }
 const sourceDir=mkdtempSync(join(tmpdir(),'rollout-source-'));
 const targetDir=mkdtempSync('/dev/shm/rollout-target-');
 try {
  const source=join(sourceDir,'rollout'), target=join(targetDir,'rollout');
  writeFileSync(source,'original\n');const old=rolloutHash(source);
  expect(()=>linkSync(source,target)).toThrow();
  installRollout(source,target,null);appendFileSync(target,'new context\n');
  installRollout(target,source,old);
  expect(readFileSync(source,'utf8')).toBe('original\nnew context\n');
 } finally {rmSync(sourceDir,{recursive:true,force:true});rmSync(targetDir,{recursive:true,force:true});}
});
