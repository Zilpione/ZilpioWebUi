import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutoReloadService, findAutoReloadMessage, localAutoReloadScope } from '../auto-reload.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-reload-')); dirs.push(dir);
  let now = 1_800_000_000_000, scope = 'account-a', connected = true, busy = false;
  let usage: any = { ordinaryUsageAllowed: false, rateLimits: { primary: { windowDurationMins: 300, usedPercent: 100, resetsAt: now / 1000 + 120 }, secondary: { windowDurationMins: 10080, usedPercent: 20, resetsAt: now / 1000 + 100000 } } };
  const sent: any[] = [], notifications: any[] = [];
  const options = { file: join(dir, 'state.json'), now: () => now, scope: () => scope, available: () => connected, busy: () => busy,
    readUsage: async () => usage, start: async (...args: any[]) => { sent.push(args); return { name: 'Chat A' }; }, notify: async (...args: any[]) => { notifications.push(args); },
    setTimer: () => 0, clearTimer: () => {} };
  return { options, service: new AutoReloadService(options), sent, notifications,
    setNow: (value: number) => { now = value; }, now: () => now, setUsage: (value: any) => { usage = Object.hasOwn(value, 'ordinaryUsageAllowed') ? value : { ordinaryUsageAllowed: true, ...value }; },
    setScope: (value: string) => { scope = value; }, setConnected: (value: boolean) => { connected = value; }, setBusy: (value: boolean) => { busy = value; } };
}

test('a quota failure stays red until the five-hour reset plus one minute', async () => {
  const f = fixture(), start = f.now();
  f.service.fail('chat-a', 'turn-a'); await f.service.process();
  expect(f.service.snapshot().threads['chat-a']).toMatchObject({ blocked: true, resetAt: start + 120_000, readyAt: start + 180_000, enabled: false });
  f.setNow(start + 179_999); await f.service.process();
  expect(f.service.snapshot().threads['chat-a'].blocked).toBe(true);
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 2, resetsAt: (start + 18_000_000) / 1000 }, secondary: { windowDurationMins: 10080, usedPercent: 20, resetsAt: (start + 100_000_000) / 1000 } } });
  f.setNow(start + 180_000); await f.service.process();
  expect(f.service.snapshot().threads['chat-a'].blocked).toBe(false);
  expect(f.sent).toHaveLength(0);
});

test('AutoReload sends riparti and one Telegram notification after reset, even after a restart', async () => {
  const f = fixture(), start = f.now();
  f.service.setEnabled('chat-a', true); f.service.fail('chat-a', 'turn-a'); await f.service.process();
  const restored = new AutoReloadService(f.options);
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 } } });
  f.setNow(start + 180_000); await restored.process(); await restored.process();
  expect(restored.snapshot().threads['chat-a']).toMatchObject({ enabled: true, blocked: false });
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0][0]).toBe('chat-a');
  expect(typeof f.sent[0][1]).toBe('string');
  expect(f.notifications).toHaveLength(1);
  expect(f.notifications[0][0]).toBe('chat-a');
});

test('does not restart while another quota window is exhausted, the chat is running, or the account changed', async () => {
  const f = fixture(), start = f.now();
  f.service.setEnabled('chat-a', true); f.service.fail('chat-a', 'turn-a'); await f.service.process();
  f.setScope('account-b'); f.setNow(start + 180_000); await f.service.process(); expect(f.sent).toHaveLength(0);
  f.setScope('account-a');
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 }, secondary: { windowDurationMins: 10080, usedPercent: 100, resetsAt: (start + 300_000) / 1000 } } });
  await f.service.process(); expect(f.service.snapshot().threads['chat-a']).toMatchObject({ blocked: true, readyAt: start + 360_000 });
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 }, secondary: { windowDurationMins: 10080, usedPercent: 20, resetsAt: (start + 100_000_000) / 1000 } } });
  f.setNow(start + 360_000); f.setBusy(true); await f.service.process(); expect(f.sent).toHaveLength(0);
  f.setBusy(false); await f.service.process(); expect(f.sent).toHaveLength(1);
});

test('a missing reset time does not schedule a guessed restart', async () => {
  const f = fixture(); f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 100, resetsAt: null } } });
  f.service.setEnabled('chat-a', true); f.service.fail('chat-a', 'turn-a'); await f.service.process();
  expect(f.service.snapshot().threads['chat-a']).toMatchObject({ blocked: true, readyAt: null });
  f.setNow(f.now() + 100_000_000); await f.service.process(); expect(f.sent).toHaveLength(0);
});

test('waits for refreshed usage data when the reset time has passed but quota is still exhausted', async () => {
  const f = fixture(), start = f.now();
  f.service.setEnabled('chat-a', true); f.service.fail('chat-a', 'turn-a'); await f.service.process();
  f.setNow(start + 180_000); await f.service.process();
  expect(f.service.snapshot().threads['chat-a'].blocked).toBe(true); expect(f.sent).toHaveLength(0);
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 1, resetsAt: (start + 18_000_000) / 1000 } } });
  f.setNow(start + 240_000); await f.service.process(); expect(f.sent).toHaveLength(1);
});

test('disabling AutoReload prevents an already scheduled send', async () => {
  const f = fixture(), start = f.now();
  f.service.setEnabled('chat-a', true); f.service.fail('chat-a', 'turn-a'); await f.service.process();
  f.service.setEnabled('chat-a', false);
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 } } });
  f.setNow(start + 180_000); await f.service.process();
  expect(f.service.snapshot().threads['chat-a'].blocked).toBe(false);
  expect(f.sent).toHaveLength(0); expect(f.notifications).toHaveLength(0);
});

test('retries a failed automatic send with the same message id and notifies only after success', async () => {
  const f = fixture(), start = f.now(), attempts: string[] = [];
  f.options.start = async (threadId: string, messageId: string) => { attempts.push(messageId); if (attempts.length === 1) throw new Error('temporary failure'); return { name: threadId }; };
  const service = new AutoReloadService(f.options);
  service.setEnabled('chat-a', true); service.fail('chat-a', 'turn-a'); await service.process();
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 } } });
  f.setNow(start + 180_000); await service.process();
  expect(service.snapshot().threads['chat-a'].pending).toBe(true); expect(f.notifications).toHaveLength(0);
  await service.process(); expect(attempts).toHaveLength(2); expect(attempts[0]).toBe(attempts[1]); expect(f.notifications).toHaveLength(1);
});

test('does not infer recovery when the usage response denies or cannot confirm access', async () => {
  for (const permission of [false, null, undefined]) {
    const f = fixture(), start = f.now();
    f.service.setEnabled('chat-a', true); f.service.fail('chat-a', 'turn-a'); await f.service.process();
    f.setUsage({ ordinaryUsageAllowed: permission, rateLimits: { primary: { windowDurationMins: 300, usedPercent: 1, resetsAt: (start + 18_000_000) / 1000 } } });
    f.setNow(start + 180_000); await f.service.process();
    expect(f.service.snapshot().threads['chat-a'].blocked).toBe(true); expect(f.sent).toHaveLength(0);
    f.setUsage({ ordinaryUsageAllowed: true, rateLimits: { primary: { windowDurationMins: 300, usedPercent: 1, resetsAt: (start + 18_000_000) / 1000 } } });
    f.setNow(start + 240_000); await f.service.process();
    expect(f.service.snapshot().threads['chat-a'].blocked).toBe(false); expect(f.sent).toHaveLength(1);
  }
});

test('disabling AutoReload while the chat is being resumed prevents the send', async () => {
  const f = fixture(), start = f.now(); let resume!: () => void, entered!: () => void, hasGuard = false;
  const waiting = new Promise<void>(resolve => { resume = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.options.start = async (threadId: string, messageId: string, scope: string, canStart: () => boolean) => {
    hasGuard = typeof canStart === 'function'; entered(); await waiting;
    if (hasGuard && !canStart()) throw new Error('AutoReload disabled');
    f.sent.push([threadId, messageId, scope]); return { name: 'Chat A' };
  };
  const service = new AutoReloadService(f.options);
  service.setEnabled('chat-a', true); service.fail('chat-a', 'turn-a'); await service.process();
  f.setUsage({ ordinaryUsageAllowed: true, rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 } } });
  f.setNow(start + 180_000); const processing = service.process(); await started;
  service.setEnabled('chat-a', false); resume(); await processing;
  expect(hasGuard).toBe(true); expect(f.sent).toHaveLength(0); expect(f.notifications).toHaveLength(0);
});

test('disabling AutoReload after a message was sent still delivers its notification', async () => {
  const f = fixture(), start = f.now(); let complete!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { complete = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.options.start = async (threadId: string, messageId: string, scope: string, canStart: () => boolean) => {
    if (typeof canStart === 'function' && !canStart()) throw new Error('AutoReload disabled');
    f.sent.push([threadId, messageId, scope]); entered(); await waiting; return { name: 'Chat A' };
  };
  const service = new AutoReloadService(f.options);
  service.setEnabled('chat-a', true); service.fail('chat-a', 'turn-a'); await service.process();
  f.setUsage({ ordinaryUsageAllowed: true, rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 } } });
  f.setNow(start + 180_000); const processing = service.process(); await started;
  service.setEnabled('chat-a', false); complete(); await processing;
  expect(f.sent).toHaveLength(1); expect(f.notifications).toHaveLength(1);
});

test('recovers an interrupted send without sending riparti twice', async () => {
  const f = fixture(), start = f.now(), delivered = new Set<string>();
  f.options.start = async (threadId: string, id: string, scope: string, canStart: () => boolean, markDispatch: () => void, recovering: boolean) => {
    if (recovering && delivered.has(id)) return { name: 'Chat A' };
    if (!canStart()) throw new Error('Canceled');
    markDispatch(); delivered.add(id); f.sent.push([threadId, id, scope]);
    throw new Error('Lost response after delivery');
  };
  const service = new AutoReloadService(f.options);
  service.setEnabled('chat-a', true); service.fail('chat-a', 'turn-a'); await service.process();
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 } } });
  f.setNow(start + 180_000); await service.process();
  expect(f.sent).toHaveLength(1);
  const restored = new AutoReloadService(f.options); await restored.process();
  expect(f.sent).toHaveLength(1); expect(f.notifications).toHaveLength(1);
  expect(restored.snapshot().threads['chat-a'].pending).toBe(false);
});

test('retries a failed Telegram notification after a restart without resending the chat message', async () => {
  const f = fixture(), start = f.now(); let attempts = 0;
  f.options.notify = async (...args: any[]) => { if (++attempts === 1) throw new Error('Telegram offline'); f.notifications.push(args); };
  const service = new AutoReloadService(f.options);
  service.setEnabled('chat-a', true); service.fail('chat-a', 'turn-a'); await service.process();
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 } } });
  f.setNow(start + 180_000); await service.process();
  expect(f.sent).toHaveLength(1); expect(f.notifications).toHaveLength(0);
  const restored = new AutoReloadService(f.options); await restored.process();
  expect(f.sent).toHaveLength(1); expect(f.notifications).toHaveLength(1); expect(attempts).toBe(2);
});

test('a first usage read after the reset does not wait for the next five-hour window', async () => {
  const f = fixture(), start = f.now(), resetAt = start + 120_000;
  f.service.setEnabled('chat-a', true); f.service.fail('chat-a', 'turn-a');
  f.setNow(resetAt + 60_000);
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 1, resetsAt: (resetAt + 18_000_000) / 1000 } } });
  await f.service.process();
  expect(f.service.snapshot().threads['chat-a'].blocked).toBe(false); expect(f.sent).toHaveLength(1);
});

test('reconciles an uncertain send by checking complete, paginated thread history', async () => {
  const seen: any[] = [];
  const request = async (_method: string, params: any) => {
    seen.push(params);
    if (!params.cursor) return { data: [{ itemsView: 'full', items: [{ type: 'userMessage', clientId: 'other' }] }], nextCursor: 'next' };
    return { data: [{ itemsView: 'full', items: [{ type: 'userMessage', clientId: 'saved-message-id' }] }], nextCursor: null };
  };
  expect(await findAutoReloadMessage(request, 'chat-a', 'saved-message-id')).toBe(true);
  expect(seen.map(params => params.cursor ?? null)).toEqual([null, 'next']);
  expect(await findAutoReloadMessage(async () => ({ data: [{ itemsView: 'full', items: [] }], nextCursor: null }), 'chat-a', 'missing')).toBe(false);
  await expect(findAutoReloadMessage(async () => ({ data: [{ itemsView: 'summary', items: [] }], nextCursor: null }), 'chat-a', 'missing')).rejects.toThrow();
  await expect(findAutoReloadMessage(async () => ({ data: [], nextCursor: 'repeated' }), 'chat-a', 'missing')).rejects.toThrow();
});

test('local schedules are isolated by account identity without exposing credentials', () => {
  const token = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.x`;
  const first = localAutoReloadScope({ auth: { tokens: { account_id: 'account-one', id_token: token('one\x40example.com'), access_token: 'secret-access' } } });
  const refreshed = localAutoReloadScope({ auth: { tokens: { account_id: 'account-one', id_token: token('one\x40example.com'), access_token: 'other-token' } } });
  const second = localAutoReloadScope({ auth: { tokens: { account_id: 'account-two', id_token: token('one\x40example.com'), access_token: 'secret-access' } } });
  expect(first).toBe(refreshed); expect(second).not.toBe(first);
  const anotherUser = localAutoReloadScope({ auth: { tokens: { account_id: 'account-one', id_token: token('two\x40example.com') } } });
  expect(anotherUser).not.toBe(first);
  expect(localAutoReloadScope({ auth: { tokens: { account_id: 'account-one' } } })).toBeNull();
  expect(first).not.toContain('account-one'); expect(first).not.toContain('secret-access');
  expect(localAutoReloadScope({ apiKey: 'secret-api-key' })).not.toContain('secret-api-key');
  expect(localAutoReloadScope({ auth: {} })).toBeNull();
});

test('a first usage read immediately after reset waits only the remaining safety minute', async () => {
  const f = fixture(), start = f.now(), resetAt = start + 120_000;
  f.service.setEnabled('chat-a', true); f.service.fail('chat-a', 'turn-a');
  f.setNow(resetAt + 30_000);
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 1, resetsAt: (resetAt + 18_000_000) / 1000 } } });
  await f.service.process();
  expect(f.service.snapshot().threads['chat-a']).toMatchObject({ blocked: true, resetAt, readyAt: resetAt + 60_000 });
  f.setNow(resetAt + 60_000); await f.service.process();
  expect(f.service.snapshot().threads['chat-a'].blocked).toBe(false); expect(f.sent).toHaveLength(1);
});

test('a first usage read after a weekly reset recognizes the previous weekly window', async () => {
  const f = fixture(), start = f.now(), resetAt = start + 120_000;
  f.service.setEnabled('chat-a', true); f.service.fail('chat-a', 'turn-a');
  f.setNow(resetAt + 60_000);
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 1, resetsAt: (start + 10_000_000) / 1000 }, secondary: { windowDurationMins: 10080, usedPercent: 1, resetsAt: (resetAt + 604_800_000) / 1000 } } });
  await f.service.process();
  expect(f.service.snapshot().threads['chat-a'].blocked).toBe(false); expect(f.sent).toHaveLength(1);
});

test('a failed Telegram notification is retried promptly even if the chat becomes blocked again', async () => {
  const f = fixture(), start = f.now(), delays: number[] = [];
  f.options.setTimer = (_callback: () => void, delay: number) => { delays.push(delay); return 0; };
  f.options.notify = async () => { throw new Error('Telegram offline'); };
  const service = new AutoReloadService(f.options);
  service.setEnabled('chat-a', true); service.fail('chat-a', 'turn-a'); await service.process();
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 } } });
  f.setNow(start + 180_000); await service.process();
  service.fail('chat-a', 'turn-b');
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 100, resetsAt: (start + 600_000) / 1000 } } });
  await service.process();
  expect(delays.at(-1)).toBe(60_000);
});

test('a queued Telegram notification is delivered even when the quota service is unavailable', async () => {
  const f = fixture(), start = f.now(); let available = false;
  f.options.notify = async (...args: any[]) => { if (!available) throw new Error('Telegram offline'); f.notifications.push(args); };
  const service = new AutoReloadService(f.options);
  service.setEnabled('chat-a', true); service.fail('chat-a', 'turn-a'); await service.process();
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 } } });
  f.setNow(start + 180_000); await service.process();
  service.fail('chat-a', 'turn-b'); available = true;
  f.options.readUsage = async () => { throw new Error('Quota service offline'); };
  const restored = new AutoReloadService(f.options); await restored.process();
  expect(f.notifications).toHaveLength(1);
});

test('a queued Telegram notification is retried after switching account', async () => {
  const f = fixture(), start = f.now(); let available = false;
  f.options.notify = async (...args: any[]) => { if (!available) throw new Error('Telegram offline'); f.notifications.push(args); };
  const service = new AutoReloadService(f.options);
  service.setEnabled('chat-a', true); service.fail('chat-a', 'turn-a'); await service.process();
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 } } });
  f.setNow(start + 180_000); await service.process();
  f.setScope('account-b'); available = true; await service.process();
  expect(f.notifications).toHaveLength(1); expect(f.sent).toHaveLength(1);
});

test('a pending notification does not delay a quota reset due in less than one minute', async () => {
  const f = fixture(), start = f.now(), delays: number[] = [];
  f.options.setTimer = (_callback: () => void, delay: number) => { delays.push(delay); return 0; };
  f.options.notify = async () => { throw new Error('Telegram offline'); };
  const service = new AutoReloadService(f.options);
  service.setEnabled('chat-a', true); service.fail('chat-a', 'turn-a'); await service.process();
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: (start + 18_000_000) / 1000 } } });
  f.setNow(start + 180_000); await service.process();
  service.fail('chat-a', 'turn-b');
  f.setUsage({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 100, resetsAt: (f.now() - 30_000) / 1000 } } });
  await service.process();
  expect(delays.at(-1)).toBe(30_000);
});
