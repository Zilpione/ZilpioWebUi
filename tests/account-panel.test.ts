import {describe, expect, test} from 'bun:test';
import {normalizeUsage} from '../public/usage-bars.js';

describe('real account quotas', () => {
  test('calculates remaining quota and converts Unix seconds', () => {
    const usage=normalizeUsage({rateLimits:{primary:{usedPercent:23,windowDurationMins:300,resetsAt:1800000000},secondary:{usedPercent:60,windowDurationMins:10080,resetsAt:1800100000}}});
    expect(usage.fiveHour).toEqual({remainingPercent:77,resetsAt:1800000000000});
    expect(usage.weekly).toEqual({remainingPercent:40,resetsAt:1800100000000});
  });
  test('identifies reversed primary and secondary windows by duration', () => {
    expect(normalizeUsage({rateLimits:{primary:{usedPercent:90,windowDurationMins:10080},secondary:{usedPercent:10,windowDurationMins:300}}})).toEqual({fiveHour:{remainingPercent:90,resetsAt:null},weekly:{remainingPercent:10,resetsAt:null}});
  });
  test('never manufactures full quota for absent or invalid data', () => {
    for(const data of [null,{}, {rateLimits:null}, {rateLimits:{primary:{usedPercent:null,windowDurationMins:300},secondary:{usedPercent:'20',windowDurationMins:10080}}}]) expect(normalizeUsage(data)).toEqual({fiveHour:null,weekly:null});
  });
  test('keeps zero remaining and clamps invalid percentages', () => {
    expect(normalizeUsage({rateLimits:{primary:{usedPercent:110,windowDurationMins:300,resetsAt:null},secondary:{usedPercent:-3,windowDurationMins:10080}}})).toEqual({fiveHour:{remainingPercent:0,resetsAt:null},weekly:{remainingPercent:100,resetsAt:null}});
  });
  test('uses codex limit map when top-level quotas absent; ignores unrelated limits', () => {
    expect(normalizeUsage({rateLimitsByLimitId:{codex:{primary:{usedPercent:35,windowDurationMins:300}}}}).fiveHour?.remainingPercent).toBe(65);
    expect(normalizeUsage({rateLimitsByLimitId:{other:{primary:{usedPercent:0,windowDurationMins:300}}}}).fiveHour).toBeNull();
  });
  test('unknown window duration stays unavailable instead of guessing primary means five hours', () => {
    expect(normalizeUsage({rateLimits:{primary:{usedPercent:0,windowDurationMins:60}}}).fiveHour).toBeNull();
  });
});

import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {initAccountPanel} from '../public/account-panel.js';
import {renderUsageBars} from '../public/usage-bars.js';

function panelFixture() {
  const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'));
  const doc=dom.window.document;
  const dialog=doc.querySelector('#accountsDialog') as any;
  dialog.showModal=()=>{dialog.open=true};dialog.close=()=>{dialog.open=false};
  return {doc,dom};
}
const runtime={accountId:'a',environmentId:'el',accounts:[{id:'a',label:'Primo',email:'a@example.com',active:true},{id:'b',label:'Secondo',active:false}],environments:[{id:'el',label:'El'},{id:'zilpio',label:'zilpio'}]};

test('quota rendering declares unavailable data without accessible fake progress',()=>{
  const {doc}=panelFixture();const host=doc.querySelector('#usageBars')!;
  renderUsageBars(host,null);
  expect(host.textContent).toContain('5 ore');expect(host.textContent).toContain('Settimanale');
  expect(host.querySelector('[role=progressbar]')).toBeNull();
  renderUsageBars(host,{rateLimits:{primary:{usedPercent:100,windowDurationMins:300}}});
  expect(host.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('0');
});

test('account panel lists independent environments and keeps active account undeletable',async()=>{
  const {doc}=panelFixture();
  const panel=initAccountPanel({document:doc,fetch:async(path)=>new Response(JSON.stringify(path==='/api/runtime'?runtime:{}))});
  try{await panel.ready;expect([...doc.querySelectorAll('#runtimeWorkspaces button')].map(node=>node.textContent)).toEqual(['El','zilpio']);
    const rows=doc.querySelectorAll('.managed-account');expect(rows[0].textContent).not.toContain('Elimina');expect(rows[1].textContent).toContain('Elimina');
    await panel.open();expect((doc.querySelector('#accountsDialog') as any).open).toBe(true);
  }finally{panel.dispose()}
});

test('environment switch disables controls and reloads without changing project',async()=>{
  const {doc}=panelFixture();let resolveSwitch:any;const applied:string[]=[];let reloads=0;
  const panel=initAccountPanel({document:doc,reload:()=>{reloads++},onWorkspaceChange:workspace=>{applied.push(workspace.path)},fetch:async(path)=>{
    if(path==='/api/runtime/switch')return new Promise(resolve=>{resolveSwitch=resolve});
    return new Response(JSON.stringify(path==='/api/runtime'?runtime:{rateLimits:{primary:{usedPercent:20,windowDurationMins:300}}}));
  }});
  try{await panel.ready;await panel.refreshUsage();const pending=panel.switchRuntime({environmentId:'zilpio'});
    expect(doc.querySelector('#usageBars [role=progressbar]')).toBeNull();expect((doc.querySelector('#addAccount') as HTMLButtonElement).disabled).toBe(true);expect(applied).toEqual([]);
    resolveSwitch(new Response(JSON.stringify({...runtime,environmentId:'zilpio'})));await pending;
    expect(applied).toEqual([]);expect(reloads).toBe(1);
  }finally{panel.dispose()}
});

test('device login can be started and cancelled without changing active runtime',async()=>{
  const {doc}=panelFixture();const paths:string[]=[];
  const panel=initAccountPanel({document:doc,fetch:async(path,options)=>{
    paths.push(`${options?.method} ${path}`);
    const data=path==='/api/runtime'?runtime:path==='/api/accounts/login'&&options?.method==='POST'?{status:'pending',userCode:'TEST-CODE',verificationUrl:'https://auth.openai.com/codex/device'}:{status:'idle'};
    return new Response(JSON.stringify(data));
  }});
  try{await panel.ready;(doc.querySelector('#addAccount') as HTMLButtonElement).click();await new Promise(resolve=>setTimeout(resolve,0));expect((doc.querySelector('#deviceLogin') as HTMLElement).hidden).toBe(false);expect(doc.querySelector('#deviceCode')?.textContent).toBe('TEST-CODE');
    (doc.querySelector('#cancelDeviceLogin') as HTMLButtonElement).click();await new Promise(resolve=>setTimeout(resolve,0));expect((doc.querySelector('#deviceLogin') as HTMLElement).hidden).toBe(true);expect(paths).toContain('POST /api/accounts/login/cancel');expect(paths).not.toContain('POST /api/runtime/switch');
  }finally{panel.dispose()}
});

test('invalid reset dates remain unavailable instead of crashing quota rendering',()=>{
  const {doc}=panelFixture();const host=doc.querySelector('#usageBars')!;
  expect(()=>renderUsageBars(host,{rateLimits:{primary:{usedPercent:20,windowDurationMins:300,resetsAt:Number.MAX_VALUE}}})).not.toThrow();
  expect(host.querySelector('.usage-quota small')?.textContent).toBe('Reset non disponibile');
});

const appSource=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function appFunction(name:string,next:string,scope:Record<string,any>){expect(appSource).toContain(`function ${name}(`);const start=appSource.indexOf(`function ${name}(`),end=appSource.indexOf(`function ${next}(`);const source=(appSource.slice(start-6,start)==='async '?'async ':'')+appSource.slice(start,end).replace(/async\s*$/,'').trim();return new Function(...Object.keys(scope),`return (${source})`)(...Object.values(scope));}

test('websocket and HTTP fallback RPC pin the runtime revision loaded by the browser',async()=>{
  const sent:any[]=[];const state:any={rpcId:1,transport:'ws',config:{runtimeRevision:'old-runtime'},pending:new Map(),ws:{readyState:1,send:(payload:string)=>sent.push(JSON.parse(payload))}};
  const rpc=appFunction('rpc','respondToCodex',{state,WebSocket:{OPEN:1},postBridge:async(path:string,payload:any)=>{sent.push(payload);return{type:'rpc/result',result:{}}}});
  rpc('thread/start',{cwd:'/home/codex/el'});expect(sent[0].runtimeRevision).toBe('old-runtime');
  state.transport='sse';await rpc('thread/list');expect(sent[1].runtimeRevision).toBe('old-runtime');
});

test('reconnecting stale browser reloads before handling bridge status',()=>{
  let cleared=0,reloaded=0,statusUpdates=0;const removed:string[]=[];const state={config:{runtimeRevision:'old-runtime'},connected:false};
  const handle=appFunction('handle','applyAutoReload',{state,accountPanel:{clearUsage:()=>{cleared++}},localStorage:{removeItem:(key:string)=>removed.push(key)},ACTIVE_THREAD_STORAGE_KEY:'active-thread',location:{reload:()=>{reloaded++}},setStatus:()=>{statusUpdates++}});
  handle({type:'bridge/status',status:'connecting',runtimeRevision:'new-runtime'});
  expect(cleared).toBe(1);expect(reloaded).toBe(1);expect(removed).toEqual(['active-thread']);expect(statusUpdates).toBe(0);
  handle({type:'bridge/status',status:'connecting',runtimeRevision:'old-runtime'});expect(reloaded).toBe(1);expect(statusUpdates).toBe(1);
});

test('runtime switch includes the revision observed by account management',async()=>{
  const {doc}=panelFixture();let submitted:any;
  const panel=initAccountPanel({document:doc,reload:()=>{},fetch:async(path,options)=>{
    if(path==='/api/runtime/switch')submitted=JSON.parse(String(options?.body));
    return new Response(JSON.stringify(path==='/api/usage'?{}:{...runtime,runtimeRevision:'observed-runtime'}));
  }});
  try{await panel.ready;await panel.switchRuntime({environmentId:'zilpio'});expect(submitted).toEqual({environmentId:'zilpio',expectedRevision:'observed-runtime'})}finally{panel.dispose()}
});


test('sidebar environment selector switches history without changing selected project',async()=>{
  const {doc}=panelFixture();const selected:string[]=[];let submitted:any,reloads=0;
  const panel=initAccountPanel({document:doc,onWorkspaceChange:value=>selected.push(value.path),reload:()=>{reloads++},fetch:async(path,options)=>{
    if(path==='/api/runtime/switch')submitted=JSON.parse(String(options?.body));
    return new Response(JSON.stringify(path==='/api/usage'?{}:{...runtime,runtimeRevision:'revision'}));
  }});
  try{await panel.ready;const select=doc.querySelector('#environmentSelect') as HTMLSelectElement;
    expect(select).not.toBeNull();expect([...select.options].map(option=>option.textContent)).toEqual(['El','zilpio']);
    select.value='zilpio';select.dispatchEvent(new doc.defaultView!.Event('change'));await new Promise(resolve=>setTimeout(resolve,0));
    expect(submitted).toEqual({environmentId:'zilpio',expectedRevision:'revision'});expect(selected).toEqual([]);expect(reloads).toBe(1);
  }finally{panel.dispose()}
});

test('project confirmation selects nested folder locally without runtime switch',async()=>{
  const selected:string[]=[];let closed=0,started=0,switched=0;
  const useSelectedFolder=appFunction('useSelectedFolder','useProjectless',{folderBrowse:{selected:'/home/codex/el/app'},projectSettings:{register:async()=>{}},$:()=>({close:()=>{closed++}}),startNewTask:(path:string)=>{selected.push(path);started++},configuredWorkspaces:()=>[{path:'/home/codex/el/app',id:'el'}],accountPanel:{switchRuntime:()=>{switched++}}});
  await useSelectedFolder();expect(selected).toEqual(['/home/codex/el/app']);expect(closed).toBe(1);expect(started).toBe(1);expect(switched).toBe(0);
});

test('saved project survives either environment and rejects hidden or escaped paths',()=>{
  const selectedProjectPath=appFunction('selectedProjectPath','restoreSelectedProject',{});
  const config={home:'/home/codex',defaultCwd:'/home/codex/el',projectRoots:['/home/codex/el','/home/codex/zilpio']};
  for(const environmentId of ['el','zilpio'])expect(selectedProjectPath({...config,environmentId},'~/zilpio/app')).toBe('/home/codex/zilpio/app');
  for(const path of ['/home/codex/.codex','/home/codex/el/../../.codex','/home/codex/el-old','/home/codex/el/.git','~'])expect(selectedProjectPath(config,path)).toBe(config.defaultCwd);
});

test('missing saved project falls back to stable default folder',async()=>{
  const selected:string[]=[];const config={home:'/home/codex',defaultCwd:'/home/codex/el',projectRoots:['/home/codex/el','/home/codex/zilpio']};
  const selectedProjectPath=appFunction('selectedProjectPath','restoreSelectedProject',{});
  const restoreSelectedProject=appFunction('restoreSelectedProject','boot',{state:{config},selectedProjectPath,fetch:async()=>new Response('{}',{status:404}),setWorkspace:(path:string)=>selected.push(path)});
  await restoreSelectedProject('/home/codex/zilpio/deleted');expect(selected).toEqual(['/home/codex/el']);
});

test('managed project picker browses both roots and cannot select home alias',async()=>{
  const {doc}=panelFixture();let folderBrowse:any={path:'~',selected:null};const paths:string[]=[];
  // Evaluate the real browser function with shared mutable browse state.
  const source=appSource.slice(appSource.indexOf('async function loadFolders('),appSource.indexOf('function openFolderPicker(')).trim();
  const load=new Function('doc','fetch','configuredEnvironments',`let folderBrowse={path:'~',selected:null};const document=doc,$=selector=>doc.querySelector(selector),icons={file:''},escapeHtml=value=>value,projectCreator={reset(){}};${source};return async path=>{await loadFolders(path);return folderBrowse}`)(doc,async(path:string)=>{paths.push(path);return new Response(JSON.stringify({path:'/home/codex',parent:null,selectable:false,folders:[{name:'el',path:'/home/codex/el'},{name:'zilpio',path:'/home/codex/zilpio'}]}))},()=>runtime.environments);
  folderBrowse=await load('~');expect(paths).toEqual(['/api/folders?path=~']);expect(folderBrowse.selected).toBeNull();expect((doc.querySelector('#folderConfirm') as HTMLButtonElement).disabled).toBe(true);
  expect([...doc.querySelectorAll('#folderList .folder-item')].map(node=>node.textContent)).toEqual(['el','zilpio']);
  (doc.querySelector('#folderList .folder-item') as HTMLButtonElement).click();expect(folderBrowse.selected).toBe('/home/codex/el');expect((doc.querySelector('#folderConfirm') as HTMLButtonElement).disabled).toBe(false);
});

test('sidebar environment switch failure reports visible error and restores current selection',async()=>{
  const {doc}=panelFixture();const errors:string[]=[];let reloads=0;
  const panel=initAccountPanel({document:doc,reload:()=>{reloads++},onError:message=>errors.push(message),fetch:async(path)=>{
    if(path==='/api/runtime/switch')return new Response(JSON.stringify({error:'Attività in corso: termina prima il turno.'}),{status:409});
    return new Response(JSON.stringify(path==='/api/runtime'?{...runtime,runtimeRevision:'revision'}:{}));
  }});
  try{await panel.ready;const selector=doc.querySelector('#environmentSelect') as HTMLSelectElement;
    selector.value='zilpio';selector.dispatchEvent(new doc.defaultView!.Event('change'));await new Promise(resolve=>setTimeout(resolve,0));
    expect(errors).toEqual(['Attività in corso: termina prima il turno.']);expect(doc.querySelector('#accountsStatus')?.textContent).toBe(errors[0]);
    expect(selector.value).toBe('el');expect(selector.disabled).toBe(false);expect(reloads).toBe(0);expect((doc.querySelector('#accountsDialog') as any).open).toBe(false);
  }finally{panel.dispose()}
});

test('environment selector is shown only when managed environments are available',async()=>{
 const {doc}=panelFixture();const control=doc.querySelector('.environment-control') as HTMLElement;
 expect(control.hidden).toBe(true);
 const panel=initAccountPanel({document:doc,fetch:async(path)=>new Response(JSON.stringify(path==='/api/runtime'?runtime:{}))});
 try{await panel.ready;expect(control.hidden).toBe(false);}finally{panel.dispose();}
});

test('single Zilpio environment hides environment controls and preserves account management',async()=>{
  const {doc}=panelFixture();
  const onlyZilpio={...runtime,environmentId:'zilpio',environments:[{id:'zilpio',label:'Zilpio'}]};
  const panel=initAccountPanel({document:doc,fetch:async(path)=>new Response(JSON.stringify(path==='/api/runtime'?onlyZilpio:{}))});
  try{
    await panel.ready;
    expect((doc.querySelector('.environment-control') as HTMLElement).hidden).toBe(true);
    expect((doc.querySelector('#runtimeWorkspaces')!.closest('section') as HTMLElement).hidden).toBe(true);
    expect(doc.querySelector('#accountsTitle')!.textContent).toBe('Account');
    expect(doc.querySelectorAll('.managed-account')).toHaveLength(2);
  }finally{panel.dispose()}
});


test('sidebar button opens account management and sets the shared default account',async()=>{
  const {doc}=panelFixture();let submitted:any,reloads=0;
  const panel=initAccountPanel({document:doc,reload:()=>{reloads++},fetch:async(path,options)=>{
    if(path==='/api/runtime/switch')submitted=JSON.parse(String(options?.body));
    return new Response(JSON.stringify(path==='/api/usage'?{}:{...runtime,runtimeRevision:'revision'}));
  }});
  try{
    await panel.ready;(doc.querySelector('#defaultAccountButton') as HTMLButtonElement).click();
    await new Promise(resolve=>setTimeout(resolve,0));
    expect((doc.querySelector('#accountsDialog') as any).open).toBe(true);
    expect((doc.querySelector('[data-use-account="a"]') as HTMLButtonElement).disabled).toBe(true);
    (doc.querySelector('[data-use-account="b"]') as HTMLButtonElement).click();
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(submitted).toEqual({accountId:'b',expectedRevision:'revision'});expect(reloads).toBe(1);
  }finally{panel.dispose()}
});


test('usage follows the selected chat account and ignores late responses',async()=>{
  const {doc}=panelFixture();let account='a';const pending:Record<string,(value:any)=>void>={};
  const panel=initAccountPanel({document:doc,readUsage:()=>new Promise(resolve=>{pending[account]=resolve}),fetch:async(path)=>new Response(JSON.stringify(path==='/api/runtime'?runtime:{}))});
  try{
    await panel.ready;account='b';panel.clearUsage();const latest=panel.refreshUsage();
    pending.b({rateLimits:{primary:{usedPercent:30,windowDurationMins:300}}});await latest;
    expect(doc.querySelector('#usageBars')!.textContent).toContain('70%');
    pending.a({rateLimits:{primary:{usedPercent:90,windowDurationMins:300}}});await new Promise(resolve=>setTimeout(resolve,0));
    expect(doc.querySelector('#usageBars')!.textContent).toContain('70%');
  }finally{panel.dispose()}
});

test('rolling usage updates immediately merge with the last snapshot and invalidate older reads',async()=>{
  const {doc}=panelFixture();let resolveRead:(value:any)=>void=()=>{};
  const panel=initAccountPanel({document:doc,readUsage:()=>new Promise(resolve=>{resolveRead=resolve}),fetch:async(path)=>new Response(JSON.stringify(path==='/api/runtime'?runtime:{}))});
  try{
    await panel.ready;
    resolveRead({rateLimits:{primary:{usedPercent:20,windowDurationMins:300},secondary:{usedPercent:40,windowDurationMins:10080}}});
    await new Promise(resolve=>setTimeout(resolve,0));
    const oldRead=panel.refreshUsage();
    panel.updateUsage({rateLimits:{limitId:'codex',primary:{usedPercent:35,windowDurationMins:null},secondary:null}});
    expect(doc.querySelector('#usageBars')!.textContent).toContain('65%');
    expect(doc.querySelector('#usageBars')!.textContent).toContain('60%');
    resolveRead({rateLimits:{primary:{usedPercent:20,windowDurationMins:300}}});await oldRead;
    expect(doc.querySelector('#usageBars')!.textContent).toContain('65%');
    panel.updateUsage({rateLimits:{limitId:'other',primary:{usedPercent:99,windowDurationMins:300}}});
    expect(doc.querySelector('#usageBars')!.textContent).toContain('65%');
  }finally{panel.dispose()}
});
