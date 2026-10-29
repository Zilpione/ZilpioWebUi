import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GlobalIntegrations } from '../global-integrations.js';

test('stores a validated SSH key privately, persists and removes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'integrations-'));
  try {
    const generated = join(dir, 'source');
    expect(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', generated]).status).toBe(0);
    const store = new GlobalIntegrations(join(dir, 'state'));
    expect(() => store.saveKey('invalid')).toThrow();
    const key = readFileSync(generated, 'utf8');
    store.saveKey(key);
    expect(statSync(store.keyPath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(store.publicState())).not.toContain(key);
    expect(new GlobalIntegrations(join(dir, 'state')).publicState().sshConfigured).toBe(true);
    store.removeKey();
    expect(store.publicState().sshConfigured).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Telegram settings persist privately and notifications include the turn outcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'integrations-'));
  try {
    const store = new GlobalIntegrations(dir);
    store.saveTelegram({ token: '123456:token-value', chatId: '-100123', enabled: true });
    expect(statSync(join(dir, 'telegram.json')).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(store.publicState())).not.toContain('token-value');
    const reloaded = new GlobalIntegrations(dir);
    let request: any;
    await reloaded.notify({ turn: { status: 'failed' }, threadId: 'abc123456' }, async (url: string, options: any) => { request = { url, options }; return { ok: true, json: async () => ({ ok: true }) }; });
    expect(JSON.parse(request.options.body)).toMatchObject({ chat_id: '-100123', text: expect.stringContaining('failed') });
    await reloaded.notifyLogin(async (url: string, options: any) => { request = { url, options }; return { ok: true, json: async () => ({ ok: true }) }; });
    expect(JSON.parse(request.options.body)).toEqual({ chat_id: '-100123', text: 'NUOVO LOGIN SU CODEX ZILPIOWEB RILEVATO!' });
    reloaded.saveTelegram({ token: '', chatId: '', enabled: false });
    expect(reloaded.publicState().telegramConfigured).toBe(false);
    await reloaded.notifyLogin(() => { throw new Error('Disabled notifications must not send'); });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('Git SSH wrapper uses shared identity when present and falls back after removal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-ssh-wrapper-'));
  try {
    const ssh = join(dir, 'ssh'); const log = join(dir, 'args'); const key = join(dir, 'identity');
    writeFileSync(ssh, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_ARGS"\n', { mode: 0o755 });
    writeFileSync(key, 'example');
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_ARGS: log, CODEX_WEBUI_GIT_IDENTITY: key, CODEX_WEBUI_KNOWN_HOSTS: join(dir, 'hosts') };
    expect(spawnSync(new URL('../git-ssh-wrapper.sh', import.meta.url).pathname, ['-T', 'git@example.org'], { env }).status).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain(`-i\n${key}\n`);
    rmSync(key);
    expect(spawnSync(new URL('../git-ssh-wrapper.sh', import.meta.url).pathname, ['-T', 'git@example.org'], { env }).status).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('-T\ngit@example.org\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
