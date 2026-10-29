import {test,expect} from 'bun:test';
import {JSDOM} from 'jsdom';
import {showThreadMenu,threadLink} from '../public/thread-menu.js';

test('menu copies a direct link and offers other visible projects', async()=>{
 const dom=new JSDOM('<body></body>',{url:'https://example.test/'}),doc=dom.window.document;
 let copied='',moved='';
 showThreadMenu({document:doc,x:20,y:30,thread:{id:'chat-1',cwd:'/a'},projects:[{path:'/a'},{path:'/b'},{path:'/hidden',hidden:true}],copy:async value=>{copied=value},move:async path=>{moved=path}});
 expect([...doc.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['Copia link chat','b']);
 doc.querySelector<HTMLButtonElement>('button')!.click();await Promise.resolve();
 expect(copied).toBe('https://example.test/?thread=chat-1');
 showThreadMenu({document:doc,x:20,y:30,thread:{id:'chat-1',cwd:'/a'},projects:[{path:'/b'}],copy:async()=>{},move:async path=>{moved=path}});
 [...doc.querySelectorAll('button')].find(b=>b.textContent==='b')!.click();await Promise.resolve();
 expect(moved).toBe('/b');
 expect(threadLink('a b',dom.window.location)).toBe('https://example.test/?thread=a+b');
});
