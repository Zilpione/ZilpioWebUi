import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export class GlobalIntegrations {
  constructor(dir) {
    this.dir = dir;
    this.keyPath = join(dir, 'git-identity');
    this.telegramPath = join(dir, 'telegram.json');
  }
  ensureDir() { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); }
  writePrivate(path, contents) {
    this.ensureDir();
    const temp = join(this.dir, `.integration-${randomUUID()}`);
    try { writeFileSync(temp, contents, { mode: 0o600, flag: 'wx' }); chmodSync(temp, 0o600); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  }
  saveKey(key) {
    if (typeof key !== 'string' || key.length > 50000 || !key.trim()) throw new Error('Chiave SSH non valida');
    this.ensureDir();
    const temp = join(this.dir, `.key-${randomUUID()}`);
    try {
      writeFileSync(temp, key.trim() + '\n', { mode: 0o600, flag: 'wx' });
      const result = spawnSync('ssh-keygen', ['-y', '-P', '', '-f', temp], { encoding: 'utf8', timeout: 5000 });
      if (result.status !== 0 || !result.stdout.trim()) throw new Error('Chiave SSH non valida o protetta da passphrase');
      renameSync(temp, this.keyPath);
      return result.stdout.trim();
    } finally { rmSync(temp, { force: true }); }
  }
  removeKey() { rmSync(this.keyPath, { force: true }); }
  telegram() {
    try { const data = JSON.parse(readFileSync(this.telegramPath, 'utf8')); return { token: data.token || '', chatId: data.chatId || '', enabled: data.enabled === true }; }
    catch (error) { if (error.code === 'ENOENT') return { token: '', chatId: '', enabled: false }; throw error; }
  }
  saveTelegram({ token, chatId, enabled }) {
    if (typeof token !== 'string' || typeof chatId !== 'string' || typeof enabled !== 'boolean') throw new Error('Configurazione Telegram non valida');
    token = token.trim(); chatId = chatId.trim();
    if ((token && !/^\d+:[A-Za-z0-9_-]{1,200}$/.test(token)) || (chatId && !/^-?\d{1,20}$/.test(chatId))) throw new Error('Token o chat ID Telegram non valido');
    if (enabled && (!token || !chatId)) throw new Error('Inserisci token e chat ID Telegram');
    this.writePrivate(this.telegramPath, JSON.stringify({ token, chatId, enabled }));
  }
  publicState() {
    const telegram = this.telegram();
    let publicKey = '';
    if (existsSync(this.keyPath)) {
      const result = spawnSync('ssh-keygen', ['-y', '-P', '', '-f', this.keyPath], { encoding: 'utf8', timeout: 5000 });
      if (result.status === 0) publicKey = result.stdout.trim();
    }
    return { sshConfigured: existsSync(this.keyPath), publicKey, telegramConfigured: !!(telegram.token && telegram.chatId), telegramTokenConfigured: !!telegram.token, telegramChatId: telegram.chatId, telegramEnabled: telegram.enabled };
  }
  async send(text, fetcher = fetch) {
    const { token, chatId } = this.telegram();
    if (!token || !chatId) throw new Error('Configura prima Telegram');
    try {
      const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }), signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error('Telegram ha rifiutato il messaggio; controlla token, chat ID e avvio del bot');
    } catch { throw new Error('Invio Telegram non riuscito: controlla token, chat ID, avvio del bot e connessione'); }
  }
  async notify(params, fetcher = fetch) {
    if (!this.telegram().enabled) return;
    const status = ['completed', 'failed', 'interrupted'].includes(params?.turn?.status) ? params.turn.status : 'completed';
    const thread = typeof params?.threadId === 'string' ? ` (${params.threadId.slice(0, 8)})` : '';
    const chatName = typeof params?.chatName === 'string' && params.chatName.trim() ? `\nChat: ${params.chatName.trim()}` : '';
    await this.send(`Job Codex ${status}${thread}${chatName}`, fetcher);
  }
  async notifyLogin(fetcher = fetch) {
    if (!this.telegram().enabled) return;
    await this.send('NUOVO LOGIN SU CODEX ZILPIOWEB RILEVATO!', fetcher);
  }
}
