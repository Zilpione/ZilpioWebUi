import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type PublicLoginStatus = {
  status: 'idle' | 'pending' | 'completed' | 'failed';
  userCode?: string;
  verificationUrl?: string;
  error?: string;
};
type Request = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Run = {
  home?: string;
  child?: ChildProcessWithoutNullStreams;
  requests: Map<number, Request>;
  nextId: number;
  loginId?: string;
  completion?: any;
  finishing?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  cleanup?: Promise<void>;
  starting?: Promise<PublicLoginStatus>;
};

/** A disposable login process. It never touches the active runtime's home. */
export class DeviceLogin {
  private readonly onAuth: (auth: object) => void | Promise<void>;
  private readonly codexBin: string;
  private status: PublicLoginStatus = { status: 'idle' };
  private run?: Run;
  private disposed = false;

  constructor(options: { onAuth: (auth: object) => void | Promise<void>; codexBin?: string }) {
    this.onAuth = options.onAuth;
    this.codexBin = options.codexBin ?? 'codex';
  }

  getStatus(): PublicLoginStatus { return { ...this.status }; }

  async start(): Promise<PublicLoginStatus> {
    if (this.disposed) throw new Error('Login service is disposed');
    if (this.run) return this.run.starting ?? this.getStatus();
    const run: Run = { requests: new Map(), nextId: 1 };
    this.run = run;
    this.status = { status: 'pending' };
    run.starting = this.begin(run);
    return run.starting;
  }

  private active(run: Run): boolean { return this.run === run && !this.disposed; }

  private async begin(run: Run): Promise<PublicLoginStatus> {
    try {
      run.home = await mkdtemp(join(tmpdir(), 'codex-device-login-'));
      await chmod(run.home, 0o700);
      if (!this.active(run)) { await rm(run.home, {recursive: true, force: true}); return this.getStatus(); }
      const env = { ...process.env, CODEX_HOME: run.home };
      // Authentication-related overrides must not bypass the device flow or redirect it.
      for (const key of Object.keys(env)) {
        if (/^(OPENAI_|AZURE_OPENAI_|CODEX_AUTH|CODEX_API|CODEX_ACCESS|CODEX_REFRESH|CHATGPT_)/i.test(key)) delete env[key];
      }
      run.child = spawn(this.codexBin, ['app-server', '--stdio', '-c', 'cli_auth_credentials_store="file"'], { env, stdio: ['pipe','pipe','pipe'] });
      run.child.stderr.resume(); // Drain stderr without storing or exposing secrets.
      run.child.stdin.on('error', () => { void this.fail(run); });
      run.child.on('error', () => { void this.fail(run); });
      run.child.on('exit', () => { if (!run.finishing) void this.fail(run); });
      const lines = createInterface({input: run.child.stdout});
      lines.on('line', line => this.receive(run, line));
      run.timer = setTimeout(() => { void this.fail(run, 'Device login timed out.'); }, 15 * 60_000);
      await this.request(run, 'initialize', { clientInfo: {name: 'codex-webui-device-login', version: '1.0.0'}, capabilities: {} });
      if (!this.active(run)) return this.getStatus();
      this.send(run, {method: 'initialized', params: {}});
      const response = await this.request(run, 'account/login/start', {type: 'chatgptDeviceCode'});
      if (!this.active(run)) return this.getStatus();
      if (!response || typeof response.loginId !== 'string' || !response.loginId || typeof response.userCode !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(response.userCode) || !this.validUrl(response.verificationUrl)) throw new Error('Invalid login response');
      run.loginId = response.loginId;
      this.status = {status: 'pending', userCode: response.userCode, verificationUrl: response.verificationUrl};
      if (run.completion) void this.complete(run, run.completion);
      return this.getStatus();
    } catch {
      await this.fail(run);
      return this.getStatus();
    }
  }

  private validUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ['openai.com','chatgpt.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host));
    } catch { return false; }
  }

  private send(run: Run, message: object) {
    if (!this.active(run) || !run.child || run.child.stdin.destroyed) throw new Error('Login process stopped');
    run.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private request(run: Run, method: string, params: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = run.nextId++;
      const timer = setTimeout(() => {
        run.requests.delete(id);
        reject(new Error('Login request timed out'));
      }, 30_000);
      run.requests.set(id, {resolve, reject, timer});
      try { this.send(run, {id, method, params}); }
      catch (error) { clearTimeout(timer); run.requests.delete(id); reject(error); }
    });
  }

  private receive(run: Run, line: string) {
    if (!this.active(run)) return;
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;
    const request = run.requests.get(message.id);
    if (request) {
      run.requests.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error('Login request failed'));
      else request.resolve(message.result);
    } else if (message.method === 'account/login/completed') {
      run.completion = message.params;
      if (run.loginId) void this.complete(run, message.params);
    }
  }

  private async complete(run: Run, completion: any) {
    if (!this.active(run) || run.finishing || completion?.loginId !== run.loginId) return;
    if (completion.success !== true) { await this.fail(run); return; }
    run.finishing = true;
    try {
      let contents: string | undefined;
      for (let attempt = 0; attempt < 100 && this.active(run); attempt++) {
        try { contents = await readFile(join(run.home!, 'auth.json'), 'utf8'); break; }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!this.active(run)) return;
      if (!contents || contents.length > 1024 * 1024) throw new Error('Missing authentication');
      const auth = JSON.parse(contents);
      if (!auth || typeof auth !== 'object' || Array.isArray(auth) || Object.keys(auth).length === 0) throw new Error('Invalid authentication');
      if (!this.active(run)) return;
      await this.onAuth(auth);
      if (!this.active(run)) return;
      this.status = {status: 'completed'};
      this.run = undefined;
      await this.cleanup(run);
    } catch { await this.fail(run); }
  }

  private async fail(run: Run, error = 'Device login failed. Please try again.') {
    if (!this.active(run)) return;
    this.status = {status: 'failed', error};
    this.run = undefined;
    await this.cleanup(run);
  }

  private cleanup(run: Run): Promise<void> {
    return run.cleanup ??= (async () => {
      clearTimeout(run.timer);
      for (const request of run.requests.values()) { clearTimeout(request.timer); request.reject(new Error('Login stopped')); }
      run.requests.clear();
      const child = run.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); }, 500);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
          child.once('error', () => { clearTimeout(timer); resolve(); });
          child.kill('SIGTERM');
        });
      }
      if (run.home) await rm(run.home, {recursive: true, force: true});
    })();
  }

  async cancel(): Promise<void> {
    const run = this.run;
    this.run = undefined;
    this.status = {status: 'idle'};
    if (run) { await this.cleanup(run); await run.starting; }
  }

  async dispose(): Promise<void> { this.disposed = true; await this.cancel(); }
}
