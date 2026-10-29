import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const host = 'github.com';
const verificationUrl = 'https://github.com/login/device';

// GitHub CLI owns the credentials; the WebUI only persists display names.
export class GitHubAccounts {
  constructor({ dir, gh = 'gh', env = process.env } = {}) {
    this.dir = dir;
    this.gh = gh;
    this.env = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
    this.aliasPath = join(dir, 'github-nicknames.json');
    this.configDir = resolve(env.GH_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(env.HOME || process.cwd(), '.config'), 'gh'));
    this.status = { status: 'idle' };
    this.run = null;
    this.busy = false;
  }

  async command(args, timeout = 15000) {
    try {
      return await execFileAsync(this.gh, args, { env: this.env, timeout, maxBuffer: 1024 * 1024 });
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('GitHub CLI non disponibile nella WebUI.');
      throw new Error('Operazione GitHub non riuscita. Controlla la connessione e riprova.');
    }
  }

  aliases() {
    try {
      const value = JSON.parse(readFileSync(this.aliasPath, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('Impossibile leggere i nickname GitHub.');
    }
  }

  saveAliases(aliases) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = join(this.dir, `.github-nicknames-${randomUUID()}`);
    try {
      writeFileSync(temp, JSON.stringify(aliases), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.aliasPath);
    } finally { rmSync(temp, { force: true }); }
  }

  async list() {
    const { stdout } = await this.command(['auth', 'status', '--hostname', host, '--json', 'hosts']);
    let data;
    try { data = JSON.parse(stdout); } catch { throw new Error('Impossibile leggere lo stato GitHub. Aggiorna GitHub CLI.'); }
    const aliases = this.aliases();
    const entries = Array.isArray(data?.hosts?.[host]) ? data.hosts[host] : [];
    const accounts = entries.filter(a => typeof a?.login === 'string').map(a => {
      const key = a.login.toLowerCase();
      const nickname = Object.hasOwn(aliases, key) && typeof aliases[key] === 'string' ? aliases[key] : a.login;
      return { login: a.login, nickname, active: a.active === true, connected: a.state === 'success', environment: /GH_TOKEN|GITHUB_TOKEN/.test(a.tokenSource || '') };
    });
    return { accounts, login: this.loginStatus() };
  }

  loginStatus() { return { ...this.status }; }

  start() {
    if (this.run) return this.loginStatus();
    if (this.busy) throw new Error('Un’altra operazione GitHub è in corso.');
    if (this.env.GH_TOKEN || this.env.GITHUB_TOKEN) throw new Error('GitHub è configurato tramite una variabile ambiente. Rimuovila per aggiungere account qui.');
    const run = { child: null, buffer: '', timer: null };
    this.run = run;
    this.status = { status: 'pending' };
    const child = spawn(this.gh, ['auth', 'login', '--hostname', host, '--git-protocol', 'https', '--web'], {
      env: { ...this.env, BROWSER: '/bin/true' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    run.child = child;
    const receive = chunk => {
      if (this.run !== run) return;
      run.buffer = (run.buffer + String(chunk)).slice(-8192);
      const match = /First copy your one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(run.buffer);
      if (match) this.status = { status: 'pending', userCode: match[1].toUpperCase(), verificationUrl };
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.on('error', () => this.fail(run, 'GitHub CLI non disponibile nella WebUI.'));
    child.on('close', async code => {
      if (this.run !== run) return;
      if (code !== 0) return this.fail(run, 'Autorizzazione non completata. Riprova.');
      this.status = { status: 'pending', finalizing: true };
      try {
        await this.command(['auth', 'setup-git', '--hostname', host]);
        if (this.run !== run) return;
        clearTimeout(run.timer);
        this.run = null;
        this.status = { status: 'completed' };
      } catch { this.fail(run, 'Account collegato, ma configurazione Git non riuscita.'); }
    });
    run.timer = setTimeout(() => this.fail(run, 'Codice scaduto. Avvia una nuova autorizzazione.'), 15 * 60_000);
    run.timer.unref?.();
    return this.loginStatus();
  }

  fail(run, error) {
    if (this.run !== run) return;
    this.run = null;
    clearTimeout(run.timer);
    run.child?.kill();
    this.status = { status: 'failed', error };
  }

  cancel(force = false) {
    if (this.status.finalizing && !force) throw new Error('Il collegamento GitHub è in fase di completamento.');
    const run = this.run;
    this.run = null;
    if (run) { clearTimeout(run.timer); run.child?.kill(); }
    this.status = { status: 'idle' };
    return this.loginStatus();
  }

  async mutate(login, action) {
    if (this.run || this.busy) throw new Error('Completa o annulla l’operazione GitHub in corso.');
    this.busy = true;
    try {
      const { accounts } = await this.list();
      const account = accounts.find(a => a.login === login);
      if (!account) throw new Error('Account GitHub non trovato.');
      if (account.environment) throw new Error('Questo account è gestito da una variabile ambiente.');
      return await action(account);
    } finally { this.busy = false; }
  }

  async rename(login, nickname) {
    if (typeof nickname !== 'string' || !nickname.trim() || nickname.trim().length > 80 || /[\x00-\x1f\x7f]/.test(nickname)) throw new Error('Inserisci un nickname valido (massimo 80 caratteri).');
    await this.mutate(login, account => {
      const aliases = this.aliases();
      aliases[account.login.toLowerCase()] = nickname.trim();
      this.saveAliases(aliases);
    });
  }

  async switchAccount(login) {
    await this.mutate(login, async account => {
      if (!account.connected) throw new Error('L’account non è autorizzato. Collegalo di nuovo.');
      await this.command(['auth', 'switch', '--hostname', host, '--user', account.login]);
    });
  }

  async remove(login) {
    await this.mutate(login, async account => {
      await this.command(['auth', 'logout', '--hostname', host, '--user', account.login]);
      const aliases = this.aliases();
      delete aliases[account.login.toLowerCase()];
      this.saveAliases(aliases);
    });
  }

  protects(filePath) {
    try {
      if (!existsSync(this.configDir)) return false;
      const root = realpathSync(this.configDir);
      return filePath === root || filePath.startsWith(root + sep);
    } catch { return false; }
  }

  dispose() { this.cancel(true); }
}
