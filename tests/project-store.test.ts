import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectStore} from '../project-store.ts';
function setup(){const temp=mkdtempSync(join(tmpdir(),'webui-project-store-')),root=join(temp,'projects'),path=join(root,'Project');mkdirSync(path,{recursive:true});writeFileSync(join(path,'keep.txt'),'preserve');const options={file:join(temp,'state','projects.json'),roots:[root]};return {temp,root,path,options,store:new ProjectStore(options)};}
test('persists project style, hides and restores without removing project data',()=>{
 const f=setup();try{const p=f.store.update(f.path,{color:'#FF8800',icon:'rocket'});expect(p).toEqual({path:f.path,name:'Project',color:'#ff8800',icon:'rocket',hidden:false});
 f.store.hide(f.path);expect(f.store.list()[0].hidden).toBe(true);expect(readFileSync(join(f.path,'keep.txt'),'utf8')).toBe('preserve');
 const reload=new ProjectStore(f.options);expect(reload.list()[0]).toMatchObject({hidden:true,color:'#ff8800',icon:'rocket'});reload.update(f.path,{hidden:false});expect(reload.list()[0].hidden).toBe(false);
 }finally{rmSync(f.temp,{recursive:true,force:true});}
});
test('rejects unsafe paths, icons and colors without persisting modifications',()=>{
 const f=setup();try{for(const changes of [{color:'url(javascript:x)'},{icon:'<script>'},{hidden:'yes'},{color:'#123'},{unknown:'x'}])expect(()=>f.store.update(f.path,changes as any)).toThrow();
 expect(()=>f.store.update('/etc',{})).toThrow();symlinkSync(f.temp,join(f.root,'escape'));expect(()=>f.store.update(join(f.root,'escape'),{})).toThrow();expect(f.store.list()).toEqual([]);expect(existsSync(f.options.file)).toBe(false);
 }finally{rmSync(f.temp,{recursive:true,force:true});}
});
test('supports forgotten missing folders without affecting any files and rejects symlink metadata',()=>{
 const f=setup();try{f.store.update(f.path,{});rmSync(f.path,{recursive:true});f.store.hide(f.path);expect(f.store.list()[0].hidden).toBe(true);expect(()=>f.store.update(f.path,{hidden:false})).toThrow();
 const other=join(f.temp,'other');writeFileSync(other,'[]');rmSync(f.options.file);symlinkSync(other,f.options.file);expect(()=>new ProjectStore(f.options)).toThrow();expect(readFileSync(other,'utf8')).toBe('[]');
 }finally{rmSync(f.temp,{recursive:true,force:true});}
});
test('hides an unregistered historical folder after its directory is gone without recreating it',()=>{
 const f=setup();try{const gone=join(f.root,'old-project');expect(f.store.hide(gone)).toMatchObject({path:gone,hidden:true});expect(existsSync(gone)).toBe(false);expect(()=>f.store.update(gone,{hidden:false})).toThrow();
 symlinkSync(f.temp,join(f.root,'outside-link'));expect(()=>f.store.hide(join(f.root,'outside-link','missing'))).toThrow();
 }finally{rmSync(f.temp,{recursive:true,force:true});}
});

test('isolates projects by environment and migrates the shared list only once',()=>{
 const f=setup();try{
  f.store.update(f.path,{icon:'star'});
  const other=join(f.root,'Other');mkdirSync(other);
  const { EnvironmentProjectStores }=require('../project-store.ts');
  const stores=new EnvironmentProjectStores({file:f.options.file,roots:[f.root],environmentIds:['legacy','workspace'],initialEnvironment:'legacy'});
  expect(stores.get('legacy').list()).toMatchObject([{path:f.path,icon:'star'}]);
  expect(stores.get('workspace').list()).toEqual([]);
  stores.get('workspace').update(other,{});
  expect(stores.get('legacy').list().map((p:any)=>p.path)).toEqual([f.path]);
  const reload=new EnvironmentProjectStores({file:f.options.file,roots:[f.root],environmentIds:['legacy','workspace'],initialEnvironment:'workspace'});
  expect(reload.get('legacy').list().map((p:any)=>p.path)).toEqual([f.path]);
  expect(reload.get('workspace').list().map((p:any)=>p.path)).toEqual([other]);
 }finally{rmSync(f.temp,{recursive:true,force:true});}
});

test('moves a project between environments preserving appearance and leaving files intact',()=>{
 const f=setup();try{
  const {EnvironmentProjectStores}=require('../project-store.ts');
  const stores=new EnvironmentProjectStores({file:f.options.file,roots:[f.root],environmentIds:['one','two'],initialEnvironment:'one'});
  stores.get('one').update(f.path,{icon:'rocket',color:'#123456'});
  stores.move('one','two',f.path);
  expect(stores.get('one').list()[0].hidden).toBe(true);
  expect(stores.get('two').list()[0]).toMatchObject({path:f.path,icon:'rocket',color:'#123456',hidden:false});
  expect(readFileSync(join(f.path,'keep.txt'),'utf8')).toBe('preserve');
  expect(()=>stores.move('one','missing',f.path)).toThrow();
 }finally{rmSync(f.temp,{recursive:true,force:true});}
});

test('persists custom instructions and preserves them when moving projects',()=>{
 const f=setup();try{
  const {EnvironmentProjectStores}=require('../project-store.ts');
  const stores=new EnvironmentProjectStores({file:f.options.file,roots:[f.root],environmentIds:['one','two'],initialEnvironment:'one'});
  stores.get('one').update(f.path,{instructions:'Rispondi in italiano\nUsa test'});
  expect(new ProjectStore({...f.options,file:f.options.file+'.one'}).list()[0].instructions).toBe('Rispondi in italiano\nUsa test');
  stores.move('one','two',f.path);expect(stores.get('two').list()[0].instructions).toBe('Rispondi in italiano\nUsa test');
  expect(()=>stores.get('two').update(f.path,{instructions:42})).toThrow();
 }finally{rmSync(f.temp,{recursive:true,force:true});}
});
