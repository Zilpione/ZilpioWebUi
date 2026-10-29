import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SAFETY_MS = 60_000;
const RETRY_MS = 60_000;

function quotaState(response) {
  const limits = response?.rateLimits ?? response?.rateLimitsByLimitId?.codex;
  const windows = [limits?.primary, limits?.secondary].filter(window => [300, 10080].includes(window?.windowDurationMins) && typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent));
  const fiveHour = windows.find(window => window.windowDurationMins === 300);
  if (!fiveHour) return null;
  const exhausted = windows.filter(window => window.usedPercent >= 100);
  const relevant = exhausted.length ? exhausted : [fiveHour];
  const allowed = response?.ordinaryUsageAllowed === true;
  const previousResets = windows.filter(window => typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt > 0).map(window => window.resetsAt * 1000 - window.windowDurationMins * 60_000);
  if (relevant.some(window => typeof window.resetsAt !== 'number' || !Number.isFinite(window.resetsAt) || window.resetsAt <= 0)) return { exhausted: exhausted.length > 0, resetAt: null, allowed, previousResets };
  return { exhausted: exhausted.length > 0, resetAt: Math.max(...relevant.map(window => window.resetsAt * 1000)), allowed, previousResets };
}

function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value); }

export function localAutoReloadScope({ auth, apiKey } = {}) {
  let account = typeof auth?.tokens?.account_id === 'string' ? auth.tokens.account_id : '';
  let user = '';
  if (typeof auth?.tokens?.id_token === 'string') {
    try {
      const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
      account ||= typeof claims?.['https://api.openai.com/auth']?.chatgpt_account_id === 'string' ? claims['https://api.openai.com/auth'].chatgpt_account_id : '';
      user = typeof claims?.sub === 'string' && claims.sub ? claims.sub : typeof claims?.email === 'string' ? claims.email : '';
    } catch {}
  }
  const key = typeof apiKey === 'string' && apiKey ? apiKey : typeof auth?.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY : '';
  const identity = key ? `api:${key}` : user ? `account:${JSON.stringify([account, user])}` : '';
  return identity ? `local:${createHash('sha256').update(identity).digest('hex')}` : null;
}

export async function findAutoReloadMessage(request, threadId, messageId) {
  let cursor = null;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const response = await request('thread/turns/list', { threadId, limit: 50, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(response?.data)) throw new Error('Cronologia della chat non disponibile');
    for (const turn of response.data) {
      if (turn?.itemsView !== 'full' || !Array.isArray(turn.items)) throw new Error('Cronologia della chat incompleta');
      if (turn.items.some(item => item?.type === 'userMessage' && item.clientId === messageId)) return true;
    }
    if (response.nextCursor === null) return false;
    if (typeof response.nextCursor !== 'string' || !response.nextCursor || seen.has(response.nextCursor)) throw new Error('Cronologia della chat incompleta');
    cursor = response.nextCursor; seen.add(cursor);
  }
  throw new Error('Cronologia della chat troppo lunga');
}

export class AutoReloadService {
  constructor({ file, scope, available, busy, readUsage, start, notify, onChange = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { file, scope, available, busy, readUsage, start, notify, onChange, now, setTimer, clearTimer });
    this.records = new Map(); this.instanceId = randomUUID(); this.revision = 0; this.timer = null; this.inFlight = false; this.stopped = false;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      for (const record of Array.isArray(saved?.records) ? saved.records : []) {
        if (validId(record?.threadId) && typeof record.scope === 'string') this.records.set(this.key(record.scope, record.threadId), record);
      }
    } catch (error) { if (error.code !== 'ENOENT') console.error('AutoReload: impossibile leggere lo stato salvato'); }
  }
  key(scope, threadId) { return JSON.stringify([scope, threadId]); }
  current(threadId) { return this.records.get(this.key(this.scope(), threadId)); }
  snapshot() {
    const threads = {};
    for (const record of this.records.values()) if (record.scope === this.scope()) {
      threads[record.threadId] = { enabled: record.enabled === true, blocked: record.blocked === true, resetAt: record.resetAt ?? null, readyAt: record.readyAt ?? null, pending: Boolean(record.pendingId), error: record.error || null };
    }
    return { instanceId: this.instanceId, revision: this.revision, threads };
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = join(dirname(this.file), `.auto-reload-${randomUUID()}`);
    try { writeFileSync(temp, JSON.stringify({ records: [...this.records.values()] }), { mode: 0o600, flag: 'wx' }); renameSync(temp, this.file); }
    finally { rmSync(temp, { force: true }); }
    this.revision++; this.onChange(this.snapshot());
  }
  setEnabled(threadId, enabled) {
    if (!validId(threadId) || typeof enabled !== 'boolean') throw new Error('Impostazione AutoReload non valida');
    const scope = this.scope(), key = this.key(scope, threadId);
    const record = this.records.get(key) || { scope, threadId, blocked: false, resetAt: null, readyAt: null };
    record.enabled = enabled;
    if (!enabled) { if (!record.dispatching) record.pendingId = null; record.error = null; }
    this.records.set(key, record); this.save(); this.kick();
    return this.snapshot();
  }
  fail(threadId, turnId = null, legacy = false) {
    if (!validId(threadId)) return;
    const scope = this.scope(), key = this.key(scope, threadId);
    const record = this.records.get(key) || { scope, threadId, enabled: false };
    if (record.blocked && (!turnId || record.failureTurnId === turnId)) return;
    Object.assign(record, { blocked: true, resetAt: null, readyAt: null, pendingId: null, dispatching: false, error: null, failureTurnId: turnId || null, failureId: randomUUID(), failedAt: this.now(), legacy });
    this.records.set(key, record); this.save(); this.kick();
  }
  remove(threadId) { if (this.records.delete(this.key(this.scope(), threadId))) { this.save(); this.kick(); } }
  kick(delay = 0) {
    if (this.stopped) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; void this.process(); }, delay);
    this.timer?.unref?.();
  }
  schedule() {
    const records = [...this.records.values()].filter(record => record.notifications?.length || (record.scope === this.scope() && (record.blocked || record.pendingId)));
    if (!records.length) return;
    const future = records.map(record => {
      const resetDelay = record.scope === this.scope() && record.blocked && Number.isFinite(record.readyAt) && record.readyAt > this.now() ? record.readyAt - this.now() : RETRY_MS;
      return record.notifications?.length ? Math.min(RETRY_MS, resetDelay) : resetDelay;
    });
    this.kick(Math.min(...future, 2_147_483_647));
  }
  async deliverNotifications(record, scope) {
    while (this.records.get(this.key(scope, record.threadId)) === record && record.notifications?.length && !this.stopped) {
      const notification = record.notifications[0];
      try {
        await this.notify(record.threadId, { name: notification.name });
        if (record.notifications?.[0]?.id === notification.id) { record.notifications.shift(); record.error = null; this.save(); }
      } catch { record.error = 'Notifica Telegram non riuscita; nuovo tentativo previsto'; this.save(); break; }
    }
  }
  async process() {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      const attemptedNotifications = new Set();
      for (const record of [...this.records.values()]) if (record.notifications?.length) {
        attemptedNotifications.add(record);
        await this.deliverNotifications(record, record.scope);
      }
      if (!this.available()) return;
      const scope = this.scope();
      for (const record of [...this.records.values()]) {
        if (record.scope !== scope || this.scope() !== scope || !this.available()) continue;
        if (record.blocked && (record.readyAt == null || record.readyAt <= this.now())) {
          const failureId = record.failureId;
          let quota;
          try { quota = quotaState(await this.readUsage()); } catch { continue; }
          if (this.scope() !== scope || !this.available() || this.records.get(this.key(scope, record.threadId)) !== record || record.failureId !== failureId || !record.blocked || !quota) continue;
          const candidates = !quota.exhausted && quota.allowed && Number.isFinite(record.failedAt) ? quota.previousResets.filter(reset => reset >= record.failedAt && reset <= this.now()) : [];
          const inferredReset = candidates.length ? Math.max(...candidates) : null;
          const missedReset = inferredReset !== null && inferredReset + SAFETY_MS <= this.now();
          if (record.readyAt == null && !(record.legacy && !quota.exhausted && quota.allowed) && !missedReset) {
            record.resetAt = inferredReset ?? quota.resetAt; record.readyAt = record.resetAt == null ? null : record.resetAt + SAFETY_MS;
            record.legacy = false; this.save();
          } else if (quota.exhausted) {
            if (quota.resetAt != null) { record.resetAt = quota.resetAt; record.readyAt = quota.resetAt + SAFETY_MS; }
            this.save();
          } else if (quota.allowed) {
            record.blocked = false; record.resetAt = null; record.readyAt = null; record.legacy = false;
            if (record.enabled && !record.pendingId) record.pendingId = randomUUID();
            this.save();
          }
        }
        if (this.records.get(this.key(scope, record.threadId)) === record && !record.blocked && record.pendingId && (record.enabled || record.dispatching) && !this.busy(record.threadId) && this.available() && this.scope() === scope) {
          const pendingId = record.pendingId;
          try {
            const canStart = () => this.records.get(this.key(scope, record.threadId)) === record && record.pendingId === pendingId && record.enabled && !record.blocked && this.available() && this.scope() === scope;
            const markDispatch = () => { if (!canStart()) throw new Error('AutoReload disattivato'); record.dispatching = true; this.save(); };
            const thread = await this.start(record.threadId, pendingId, scope, canStart, markDispatch, record.dispatching === true);
            if (record.pendingId === pendingId) { record.pendingId = null; record.dispatching = false; }
            if (!thread?.autoReloadCanceled) {
              record.notifications = [...(record.notifications || []), { id: pendingId, name: typeof thread?.name === 'string' ? thread.name.slice(0, 120) : '' }];
            }
            record.error = null; this.save();
          } catch {
            if (record.pendingId === pendingId) { record.error = 'Invio automatico non riuscito; nuovo tentativo previsto'; this.save(); }
          }
        }
        if (!attemptedNotifications.has(record) && record.notifications?.length) await this.deliverNotifications(record, scope);
      }
    } finally { this.inFlight = false; this.schedule(); }
  }
  stop() { this.stopped = true; if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
}
