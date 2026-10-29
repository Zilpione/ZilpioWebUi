import {expect,test} from 'bun:test';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {initProjectCreator} from '../public/project-create.js';
function setup(request:any,onCreated:any=()=>{}){
 const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'));const doc=dom.window.document;
 const creator=initProjectCreator({document:doc,fetch:request,getParent:()=>'/home/codex/el',onCreated});
 (doc.querySelector('#addProject') as HTMLButtonElement).disabled=false;
 return {doc,creator};
}
test('creates the named folder in the browsed location and selects only after success',async()=>{
 let submitted:any,resolveRequest:any;const selected:any[]=[];
 const {doc}=setup(async(path:any,options:any)=>{submitted={path,...JSON.parse(options.body)};return new Promise(resolve=>resolveRequest=resolve)},(p:any)=>selected.push(p));
 (doc.querySelector('#addProject') as HTMLButtonElement).click();(doc.querySelector('#newProjectName') as HTMLInputElement).value='New project';
 (doc.querySelector('#createProject') as HTMLButtonElement).click();expect(submitted).toEqual({path:'/api/projects',parent:'/home/codex/el',name:'New project'});expect(selected).toEqual([]);
 resolveRequest(new Response(JSON.stringify({name:'New project',path:'/home/codex/el/New project'}),{status:201}));await new Promise(r=>setTimeout(r,0));expect(selected).toHaveLength(1);
});
test('duplicate creation shows error and preserves name without changing project',async()=>{
 const selected:any[]=[];const {doc}=setup(async()=>new Response(JSON.stringify({error:'Esiste già'}),{status:409}),(p:any)=>selected.push(p));
 (doc.querySelector('#addProject') as HTMLButtonElement).click();(doc.querySelector('#newProjectName') as HTMLInputElement).value='Existing';
 (doc.querySelector('#createProject') as HTMLButtonElement).click();await new Promise(r=>setTimeout(r,0));expect(doc.querySelector('#createProjectError')!.textContent).toBe('Esiste già');expect(selected).toEqual([]);expect((doc.querySelector('#newProjectName') as HTMLInputElement).value).toBe('Existing');
});
test('cancel clears the draft without sending a request',()=>{
 let requests=0;const {doc}=setup(()=>{requests++;throw new Error()});
 (doc.querySelector('#addProject') as HTMLButtonElement).click();(doc.querySelector('#newProjectName') as HTMLInputElement).value='Draft';(doc.querySelector('#cancelCreateProject') as HTMLButtonElement).click();
 expect((doc.querySelector('#createProjectPanel') as HTMLElement).hidden).toBe(true);expect(requests).toBe(0);
});

test('navigating or reopening the picker invalidates pending creation selection',async()=>{
 let complete:any;const selected:any[]=[];const {doc,creator}=setup(async()=>new Promise(resolve=>complete=resolve),(p:any)=>selected.push(p));
 (doc.querySelector('#addProject') as HTMLButtonElement).click();(doc.querySelector('#newProjectName') as HTMLInputElement).value='Old folder';(doc.querySelector('#createProject') as HTMLButtonElement).click();
 creator.reset();complete(new Response(JSON.stringify({name:'Old folder',path:'/home/codex/el/Old folder'}),{status:201}));await new Promise(r=>setTimeout(r,0));expect(selected).toEqual([]);
});
