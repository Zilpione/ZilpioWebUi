import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

test('a failed delete offers to hide the chat and removes it only after confirmation', async () => {
 const source=readFileSync('public/app.js','utf8');
 const fn=source.slice(source.indexOf('async function deleteThread('),source.indexOf('async function renameThread('));
 const calls:string[]=[], confirmations:string[]=[], state={threads:[{id:'one',name:'Allora'}],active:null};
 const remove=new Function('state','rpc','confirm','refreshThreadList','renderThreads','startNewTask','toast',`const titleOf=t=>t.name,t=s=>s,threadAccount=()=> 'a';${fn}return deleteThread;`)(state,async (method:string)=>{calls.push(method);if(method==='thread/delete')throw new Error('broken');},(message:string)=>{confirmations.push(message);return true;},async()=>{},()=>{},()=>{},()=>{});
 await remove(state.threads[0]);
 expect(calls).toEqual(['thread/delete','host/thread/hide']);
 expect(confirmations).toHaveLength(2);
 expect(confirmations[1]).toContain('cronologia');
 expect(state.threads).toEqual([]);
});

test('cancelling the fallback leaves the chat visible', async () => {
 const source=readFileSync('public/app.js','utf8');
 const fn=source.slice(source.indexOf('async function deleteThread('),source.indexOf('async function renameThread('));
 const calls:string[]=[], state={threads:[{id:'one',name:'Allora'}],active:null}; let count=0;
 const remove=new Function('state','rpc','confirm','refreshThreadList','renderThreads','startNewTask','toast',`const titleOf=t=>t.name,t=s=>s,threadAccount=()=> 'a';${fn}return deleteThread;`)(state,async (method:string)=>{calls.push(method);throw new Error('broken');},()=>++count===1,async()=>{},()=>{},()=>{},()=>{});
 await remove(state.threads[0]);
 expect(calls).toEqual(['thread/delete']);
 expect(state.threads).toHaveLength(1);
});
