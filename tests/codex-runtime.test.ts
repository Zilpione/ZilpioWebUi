import { test, expect } from 'bun:test';
import { CodexRuntime } from '../codex-runtime.js';

// Each fake process uses the same RPC and approval identifiers deliberately.
const fake = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
 input += chunk;
 while (input.includes('\\n')) {
  const i = input.indexOf('\\n'); const message = JSON.parse(input.slice(0,i)); input = input.slice(i+1);
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({id:message.id,result:{codexHome:process.env.CODEX_HOME}})+'\\n');
  if (message.method === 'echo') {
   process.stdout.write(JSON.stringify({id:1,method:'item/commandExecution/requestApproval',params:{threadId:process.env.RUNTIME_NAME}})+'\\n');
   process.stdout.write(JSON.stringify({id:message.id,result:{runtime:process.env.RUNTIME_NAME,value:message.params.value}})+'\\n');
  }
 }
});`;

test('independent app-server processes keep concurrent requests and approval identifiers separate', async () => {
 const make = (name: string) => new CodexRuntime({ command: process.execPath, args: ['-e', fake], cwd: process.cwd(), env: {...process.env, CODEX_HOME: `/tmp/${name}`, RUNTIME_NAME:name}, restart:false });
 const a = make('alpha'), b = make('beta');
 const eventsA: any[] = [], eventsB: any[] = [];
 a.on('message', (event:any) => eventsA.push(event)); b.on('message', (event:any) => eventsB.push(event));
 try {
  await Promise.all([a.start(), b.start()]);
  const [ra, rb] = await Promise.all([a.request('echo',{value:'A'}),b.request('echo',{value:'B'})]);
  expect(ra).toEqual({runtime:'alpha',value:'A'}); expect(rb).toEqual({runtime:'beta',value:'B'});
  expect(eventsA[0].params.threadId).toBe('alpha'); expect(eventsB[0].params.threadId).toBe('beta');
  expect(a.state.approvalRequests.get(1).params.threadId).toBe('alpha');
  expect(b.state.approvalRequests.get(1).params.threadId).toBe('beta');
  a.respond(1, {decision:'accept'}); expect(a.state.approvalRequests.has(1)).toBe(false); expect(b.state.approvalRequests.has(1)).toBe(true);
 } finally { await Promise.all([a.stop(), b.stop()]); }
});

test('a failed executable rejects initialization promptly', async () => {
 const runtime = new CodexRuntime({ command:'/definitely-missing-codex-runtime', args:[], cwd:process.cwd(), restart:false, timeout:1000 });
 const started = Date.now();
 await expect(runtime.start()).rejects.toThrow();
 expect(Date.now()-started).toBeLessThan(500);
 await runtime.stop();
});
