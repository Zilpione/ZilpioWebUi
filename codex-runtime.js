import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createRuntimeState } from './runtime-state.js';

// A process and its protocol state belong to one account/environment pair.
export class CodexRuntime extends EventEmitter {
  constructor({ command = 'codex', args = ['app-server', '--stdio'], cwd, env = process.env, timeout = 30000, restart = true }) {
    super(); this.command = command; this.args = args; this.cwd = cwd; this.env = { ...env };
    this.timeout = timeout; this.restart = restart; this.state = createRuntimeState();
    this.child = null; this.starting = null; this.stopped = false; this.connected = false; this.timer = null;
  }
  async start() {
    if (this.connected) return;
    if (this.starting) return this.starting;
    this.stopped = false;
    this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }
  async launch() {
    const child = spawn(this.command, this.args, { cwd:this.cwd, env:this.env, stdio:['pipe','pipe','pipe'], detached:process.platform !== 'win32' });
    this.child = child; let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0,end).trim(); buffer = buffer.slice(end+1);
        if (!line) continue;
        try { this.receive(JSON.parse(line)); } catch (error) { this.emit('protocolError', error); }
      }
    });
    child.stderr.on('data', data => this.emit('stderr', String(data)));
    child.on('error', error => {
      for (const pending of this.state.pending.values()) pending.reject(error);
      this.state.pending.clear(); this.emit('processError', error);
    });
    child.on('close', (code, signal) => {
      if (this.child !== child) return;
      this.child = null; this.connected = false; this.state.clearActivity();
      for (const pending of this.state.pending.values()) pending.reject(new Error('Codex app-server exited'));
      this.state.pending.clear(); this.emit('exit', {code, signal});
      if (!this.stopped && this.restart) this.timer = setTimeout(() => this.start().catch(error => this.emit('processError', error)), 1000);
    });
    try {
      const result = await this.request('initialize', {clientInfo:{name:'codex-webui',title:'Codex WebUI',version:'0.2.0'},capabilities:{experimentalApi:true}});
      this.send({method:'initialized',params:{}}); this.connected = true; this.emit('ready',result); return result;
    } catch (error) { this.terminate(); throw error; }
  }
  send(message) {
    if (!this.child || this.child.exitCode !== null || !this.child.stdin.writable) throw new Error('Codex app-server unavailable');
    this.child.stdin.write(JSON.stringify(message)+'\n');
  }
  request(method, params = {}) {
    const id = this.state.nextRequestId();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.state.pending.delete(id); reject(new Error(`Codex request timed out: ${method}`)); }, this.timeout);
      this.state.pending.set(id, { resolve: value => {clearTimeout(timer);resolve(value)}, reject: error => {clearTimeout(timer);reject(error)} });
      try { this.send({id,method,params}); } catch (error) { this.state.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  receive(message) {
    if (message.id !== undefined && ('result' in message || 'error' in message) && !message.method) {
      const pending = this.state.pending.get(Number(message.id));
      if (pending) { this.state.pending.delete(Number(message.id)); message.error ? pending.reject(new Error(message.error.message || JSON.stringify(message.error))) : pending.resolve(message.result); return; }
    }
    if (message.method && message.id !== undefined) this.state.approvalRequests.set(message.id,message);
    if (message.method === 'serverRequest/resolved') this.state.approvalRequests.delete(message.params?.requestId);
    this.emit('message',message);
  }
  respond(id, result, error) {
    if (!this.state.approvalRequests.has(id)) throw new Error('Approval is no longer pending');
    this.send(error ? {id,error} : {id,result}); this.state.approvalRequests.delete(id);
  }
  terminate(signal = 'SIGTERM') {
    const child = this.child; if (!child || child.exitCode !== null) return;
    if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid,signal); return; } catch {} }
    child.kill(signal);
  }
  async stop() {
    this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null;
    const child = this.child; if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => this.terminate('SIGKILL'), 4000);
      child.once('close', () => { clearTimeout(timer); resolve(); }); this.terminate();
    });
  }
}
