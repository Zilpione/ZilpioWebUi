import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { artifact, launchOptions } from './browser-runtime.mjs';

const root=new URL('..',import.meta.url).pathname;
async function freePort(){return await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const address=probe.address();if(!address||typeof address==='string')return reject(new Error('Could not allocate composer test port'));probe.close(error=>error?reject(error):resolve(address.port))})})}
async function waitFor(check,timeout=20_000){const started=Date.now();while(Date.now()-started<timeout){try{if(await check())return}catch{}await Bun.sleep(50)}throw new Error('Timed out waiting for composer test server')}

const port=await freePort(),base=`http://127.0.0.1:${port}`;
const server=Bun.spawn(['bun','run','server.ts'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_MANAGED_ACCOUNTS:'false'},stdout:'ignore',stderr:'ignore'});
let browser;
try{
  await waitFor(async()=>(await fetch(`${base}/api/health`)).ok);
  browser=await chromium.launch(launchOptions());
  const context=await browser.newContext({viewport:{width:1018,height:760},colorScheme:'dark'});
  await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en')});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.syncTurnSnapshot);
  await page.waitForTimeout(1500);
  await page.evaluate(()=>{
    const api=globalThis.__codexWebuiDebug;
    api.state.active={id:'composer-thread',name:'Composer thread',cwd:api.state.config.defaultCwd,turns:[]};
    api.syncTurnSnapshot({id:'composer-turn',status:'inProgress',itemsView:'full',items:[]});
    api.notify('turn/started',{threadId:'other-thread',turn:{id:'other-turn'}});
    window.__composerRpcCalls=[];
    window.__composerOriginalFetch=window.fetch;
    window.__composerOriginalTransport=api.state.transport;
    api.state.transport='sse';
    api.state.selectedAccountId='account-test';
    api.state.accounts=[{id:'account-test',label:'First'},{id:'other',label:'Other'}];
    const selector=document.querySelector('#composerAccount');selector.innerHTML='<option value="account-test">First</option><option value="other">Other</option>';selector.value='other';selector.dispatchEvent(new Event('change'));window.__lockedAccount=api.state.selectedAccountId;
    window.fetch=async(resource,options={})=>{
      const url=new URL(typeof resource==='string'?resource:resource.url,location.href);
      if(url.pathname==='/api/rpc'){
        const payload=JSON.parse(options.body||'{}');
        window.__composerRpcCalls.push(payload);
        if(window.__composerConflictMode&&payload.method==='thread/resume')return new Response(JSON.stringify({type:'rpc/error',id:payload.id,error:'thread external-thread already has an active writer',code:'thread_active_writer'}),{status:200,headers:{'content-type':'application/json'}});
        return new Response(JSON.stringify({type:'rpc/result',result:{turnId:payload.params?.expectedTurnId||payload.params?.turnId||'ok'}}),{status:200,headers:{'content-type':'application/json'}});
      }
      return window.__composerOriginalFetch(resource,options);
    };
  });
  await page.evaluate(()=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array([137,80,78,71])],'paste.png',{type:'image/png'}));document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))});
  await page.waitForFunction(()=>document.querySelector('#composerContextTray')?.textContent.includes('paste.png'),null,{timeout:3000});
  await page.click('#sendButton');
  await page.waitForFunction(()=>window.__composerRpcCalls.some(call=>call.method==='turn/steer'));
  const call=await page.evaluate(()=>window.__composerRpcCalls.find(call=>call.method==='turn/steer'));
  if(!call.params.input.some(item=>item.type==='image'&&item.url?.startsWith('data:image/png;base64,')))throw new Error('Pasted image missing from turn input');
  await page.evaluate(()=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array([137,80,78,71])],'drop.png',{type:'image/png'}));document.querySelector('#composer').dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}))});
  await page.waitForFunction(()=>document.querySelector('#composerContextTray')?.textContent.includes('drop.png'),null,{timeout:3000});
  const chooserPromise=page.waitForEvent('filechooser',{timeout:3000});
  await page.click('[data-composer-control="add"]');
  const chooser=await chooserPromise;
  await chooser.setFiles({name:'report.txt',mimeType:'text/plain',buffer:Buffer.from('attachment proof')});
  await page.waitForFunction(()=>document.querySelector('#composerContextTray')?.textContent.includes('report.txt'),null,{timeout:5000});
  await page.fill('#prompt','Analyze this');
  await page.click('#sendButton');
  await page.waitForFunction(()=>window.__composerRpcCalls.filter(call=>call.method==='turn/steer').length===2);
  const fileCall=await page.evaluate(()=>window.__composerRpcCalls.filter(call=>call.method==='turn/steer').at(-1));
  const text=fileCall.params.input.find(item=>item.type==='text')?.text||'';
  const path=text.match(/\/tmp\/codex-upload-[^\s]+\/[^\s]+/)?.[0];
  if(!path||readFileSync(path,'utf8')!=='attachment proof')throw new Error('Uploaded file missing from turn');
  if(errors.length)throw new Error(errors.join('\n'));

}finally{
  await browser?.close();
  server.kill();
  await server.exited;
}
