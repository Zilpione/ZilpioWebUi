import {expect,test} from 'bun:test';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {initProjectSettings} from '../public/project-settings.js';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){
 const doc=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8')).window.document;
 const dialog=doc.querySelector('#projectSettingsDialog') as any;
 if(dialog){dialog.showModal=()=>dialog.open=true;dialog.close=()=>dialog.open=false;}
 let projects=[{path:'/work/One',name:'One',color:null,icon:'folder',hidden:false}],failure=false;const calls:any[]=[];
 const fetch=async(url:any,options:any={})=>{calls.push({url,method:options.method||'GET',body:options.body&&JSON.parse(options.body)});if(failure)return new Response(JSON.stringify({error:'Accesso negato'}),{status:403});if(options.method){const data=JSON.parse(options.body);projects=projects.map(p=>p.path===data.path?{...p,...data,...(options.method==='DELETE'?{hidden:true}:{})}:p);return Response.json(projects[0]);}return Response.json({projects});};
 let changes=0;const settings=initProjectSettings({document:doc,fetch,onChange:()=>changes++});
 return {doc,settings,calls,fetch,get projects(){return projects;},fail:()=>failure=true,get changes(){return changes;}};
}
test('saves appearance and reads shared persisted values in a fresh controller',async()=>{
 const f=fixture();await f.settings.ready;await f.settings.open('/work/One');
 (f.doc.querySelector('#projectColor') as HTMLSelectElement).value='#3b82f6';(f.doc.querySelector('#projectIcon') as HTMLSelectElement).value='rocket';
 (f.doc.querySelector('#saveProjectSettings') as HTMLButtonElement).click();await tick();
 expect(f.projects[0]).toMatchObject({color:'#3b82f6',icon:'rocket',hidden:false});
 const freshDoc=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8')).window.document;const fresh=initProjectSettings({document:freshDoc,fetch:f.fetch});await fresh.ready;expect(fresh.getProjects()[0]).toMatchObject({icon:'rocket',color:'#3b82f6'});expect(f.changes).toBeGreaterThan(1);
});
test('remove only hides metadata and manager restores without deleting data',async()=>{
 const f=fixture();await f.settings.ready;await f.settings.open('/work/One');
 expect(f.doc.querySelector('#projectRemovalNotice')!.textContent).toContain('file e le chat');
 (f.doc.querySelector('#removeProject') as HTMLButtonElement).click();await tick();
 expect(f.calls.filter(c=>c.method==='DELETE')).toEqual([{url:'/api/projects',method:'DELETE',body:{path:'/work/One'}}]);expect(f.settings.getProjects()[0].hidden).toBe(true);
 await f.settings.open();expect(f.doc.querySelector('#projectSettingsPath')!.textContent).toContain('rimosso');
 (f.doc.querySelector('#restoreProject') as HTMLButtonElement).click();await tick();expect(f.settings.getProjects()[0].hidden).toBe(false);
 expect(f.calls.every(c=>c.url==='/api/projects')).toBe(true);
});
test('failed save preserves draft and shows error without changing project',async()=>{
 const f=fixture();await f.settings.ready;await f.settings.open('/work/One');f.fail();
 (f.doc.querySelector('#projectIcon') as HTMLSelectElement).value='code';(f.doc.querySelector('#saveProjectSettings') as HTMLButtonElement).click();await tick();
 expect(f.doc.querySelector('#projectSettingsError')!.textContent).toBe('Accesso negato');expect(f.settings.getProjects()[0].icon).toBe('folder');expect((f.doc.querySelector('#projectIcon') as HTMLSelectElement).value).toBe('code');
});
test('explicit register restores hidden folder and refresh handles remote changes',async()=>{
 const f=fixture();await f.settings.ready;await f.settings.open('/work/One');(f.doc.querySelector('#removeProject') as HTMLButtonElement).click();await tick();
 await f.settings.register('/work/One');expect(f.calls.some(c=>c.method==='PATCH'&&c.body.hidden===false)).toBe(true);expect(f.settings.getProjects()[0].hidden).toBe(false);
});

test('hidden project chats remain in Altre chat; empty registered projects and safe appearance render',()=>{
 const doc=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8')).window.document;
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const grouping=source.slice(source.indexOf('function sidebarProjectKey('),source.indexOf('async function deleteThread('));
 const rendering=source.slice(source.indexOf('function renderThreads('),source.indexOf('async function openThread('));
 const projects=[{path:'/work/Hidden',hidden:true,icon:'folder',color:null},{path:'/work/Empty',hidden:false,icon:'rocket',color:'#3b82f6'},{path:'/work/<img onerror=alert(1)>',hidden:false,icon:'<script>',color:'red;display:none'}];
 const state={threads:[{id:'t1',cwd:'/work/Hidden',name:'Retained chat'}],active:{id:'t1',cwd:'/work/Hidden'},config:{home:'/home'},workspaceContext:{cwd:'/work/Hidden'}};
 new Function('document','state','projectSettings','PROJECT_ICONS','projectRepository',`const $=s=>document.querySelector(s),t=s=>s,shortPath=s=>s,titleOf=t=>t.name||'',codexIcon=()=>'<span class="icon-slot"></span>',escapeHtml=s=>s,formatAge=()=>'',sidebarProjectExpansion={},sidebarMoreChats=new Set(),splitChats=null,mobileSidebarEnabled=()=>false,openThread=()=>{},sidebarThreadStatus=()=>'',notifier={status:()=>'',unreadVersion:()=>0,acknowledge:()=>{}};${grouping}${rendering}renderThreads();`)(doc,state,{getProjects:()=>projects,open:()=>{}},{folder:'📁',rocket:'🚀'},{status:async()=>({assigned:false}),open:()=>{}});
 expect(Boolean(doc.querySelector('[data-project="/work/Hidden"]'))).toBe(false);expect(doc.querySelector('[data-project="__unassigned__"]')!.textContent).toContain('Altre chat');
 expect(doc.querySelector('#threadList')!.lastElementChild?.getAttribute('data-project')).toBe('__unassigned__');
 expect(doc.querySelector('[data-id="t1"]')!.textContent).toContain('Retained chat');expect(state.threads[0].cwd).toBe('/work/Hidden');
 const empty=doc.querySelector('[data-project="/work/Empty"]')!;expect(empty.textContent).toContain('🚀');expect(empty.querySelector('.project-settings-button')).not.toBeNull();expect(empty.querySelector('.project-new-chat')).not.toBeNull();(empty.querySelector('.project-settings-button') as HTMLButtonElement).click();expect(empty.querySelector('.project-menu')!.textContent).toContain('Modifica');expect(empty.querySelector('.project-menu')!.textContent).not.toContain('Sposta workspace');expect(empty.querySelector('button button')).toBeNull();
 expect(doc.querySelector('#threadList img')).toBeNull();expect(doc.querySelector('#threadList script')).toBeNull();
});

test('metadata event refreshes without reloading and failed registration preserves workspace',async()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const handler=source.slice(source.indexOf('function handle(message){'),source.indexOf('function setStatus('));
 let refreshes=0;new Function('projectSettings','toast',`${handler};handle({type:'projects/changed'});`)({refresh:async()=>{refreshes++;}},()=>{});expect(refreshes).toBe(1);
 const select=source.slice(source.indexOf('async function useSelectedFolder(){'),source.indexOf('function useProjectless('));
 const workspaces:string[]=[],errors:string[]=[];let closed=false;
 await new Function('folderBrowse','projectSettings','setWorkspace','$','startNewTask','toast',`${select};return useSelectedFolder();`)({selected:'/work/Hidden'},{register:async()=>{throw new Error('Accesso negato');}},(path:string)=>workspaces.push(path),()=>({close:()=>closed=true}),()=>{},(message:string)=>errors.push(message));
 expect(workspaces).toEqual([]);expect(closed).toBe(false);expect(errors).toEqual(['Accesso negato']);
});

test('background refresh preserves appearance draft and successful save accepts later remote values',async()=>{
 const f=fixture();await f.settings.ready;await f.settings.open('/work/One');
 const color=f.doc.querySelector('#projectColor') as HTMLSelectElement,icon=f.doc.querySelector('#projectIcon') as HTMLSelectElement;
 color.value='#3b82f6';icon.value='rocket';
 await f.settings.refresh();expect(color.value).toBe('#3b82f6');expect(icon.value).toBe('rocket');
 f.projects.push({path:'/work/Other',name:'Other',color:null,icon:'star',hidden:false});
 await f.settings.refresh();expect(color.value).toBe('#3b82f6');expect(icon.value).toBe('rocket');
 (f.doc.querySelector('#saveProjectSettings') as HTMLButtonElement).click();await tick();expect(f.projects[0]).toMatchObject({color:'#3b82f6',icon:'rocket'});
 f.projects[0].icon='book';f.projects[0].color='#22c55e' as any;await f.settings.open('/work/One');
 expect(color.value).toBe('#22c55e');expect(icon.value).toBe('book');
});

test('slow initial dialog refresh preserves edits and explicit project selection clears draft',async()=>{
 const doc=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8')).window.document;const dialog=doc.querySelector('#projectSettingsDialog') as any;dialog.showModal=()=>dialog.open=true;
 const projects=[{path:'/work/One',color:null,icon:'folder',hidden:false},{path:'/work/Other',color:'#22c55e',icon:'book',hidden:false}];
 let calls=0,complete:any;const settings=initProjectSettings({document:doc,fetch:async()=>++calls===1?Response.json({projects}):new Promise(resolve=>complete=resolve)});await settings.ready;
 const opened=settings.open('/work/One');const color=doc.querySelector('#projectColor') as HTMLSelectElement,icon=doc.querySelector('#projectIcon') as HTMLSelectElement;color.value='#3b82f6';icon.value='rocket';
 complete(Response.json({projects}));await opened;expect(color.value).toBe('#3b82f6');expect(icon.value).toBe('rocket');
 const picker=doc.querySelector('#projectSettingsPath') as HTMLSelectElement;picker.value='/work/Other';picker.dispatchEvent(new doc.defaultView!.Event('change'));expect(color.value).toBe('#22c55e');expect(icon.value).toBe('book');
});

test('saves custom instructions and preserves the draft during refresh',async()=>{
 const f=fixture();await f.settings.ready;await f.settings.open('/work/One');
 const input=f.doc.querySelector('#projectInstructions') as HTMLTextAreaElement;
 input.value='Rispondi in italiano\nUsa test';await f.settings.refresh();expect(input.value).toBe('Rispondi in italiano\nUsa test');
 (f.doc.querySelector('#saveProjectSettings') as HTMLButtonElement).click();await tick();
 expect((f.projects[0] as any).instructions).toBe('Rispondi in italiano\nUsa test');
 await f.settings.open('/work/One');expect(input.value).toBe('Rispondi in italiano\nUsa test');
});

test('closes the project dialog after a successful save and keeps it open on error',async()=>{
 const f=fixture();await f.settings.ready;await f.settings.open('/work/One');
 const dialog=f.doc.querySelector('#projectSettingsDialog') as HTMLDialogElement;
 (f.doc.querySelector('#saveProjectSettings') as HTMLButtonElement).click();await tick();expect(dialog.open).toBe(false);
 await f.settings.open('/work/One');f.fail();(f.doc.querySelector('#saveProjectSettings') as HTMLButtonElement).click();await tick();expect(dialog.open).toBe(true);
});
