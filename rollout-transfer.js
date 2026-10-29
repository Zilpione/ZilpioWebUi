import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function rolloutHash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
export function installRollout(source, destination, previousHash, {link = linkSync} = {}) {
  const hash = rolloutHash(source);
  if (existsSync(destination)) {
    const a=statSync(source), b=statSync(destination);
    if (a.dev === b.dev && a.ino === b.ino) return hash;
    const existing = rolloutHash(destination);
    if (existing === hash) return hash;
    if (!previousHash || existing !== previousHash) throw new Error('La destinazione contiene una cronologia diversa');
  } else {
    try { link(source, destination); return hash; }
    catch (error) { if (error?.code !== 'EXDEV') throw error; }
  }
  const temp = join(dirname(destination), `.rollout-${randomUUID()}`);
  try {
    copyFileSync(source, temp, 1);
    const file = openSync(temp, 'r'); try { fsyncSync(file); } finally { closeSync(file); }
    if (rolloutHash(temp) !== hash || rolloutHash(source) !== hash) throw new Error('Cronologia cambiata durante il trasferimento');
    renameSync(temp, destination);
    const dir = openSync(dirname(destination), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    return hash;
  } finally { try { unlinkSync(temp); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
}
