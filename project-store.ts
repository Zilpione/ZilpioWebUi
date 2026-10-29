import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {resolveBrowsePath} from './folder-service.js';
export const PROJECT_ICONS=['folder','code','rocket','star','gamepad','globe','book','briefcase'];
export type Project={path:string;name:string;color:string|null;icon:string;hidden:boolean;instructions?:string};
export class ProjectStore {
 private file:string;private roots:string[];private projects:Project[]=[];
 constructor({file,roots}:{file:string;roots:string[]}){
  this.file=resolve(file);this.roots=roots.map(p=>resolve(p));
  if(existsSync(this.file)||this.isSymlink(this.file)){
   if(!lstatSync(this.file).isFile()||this.isSymlink(this.file))throw new Error('Archivio progetti non valido');
   const data=JSON.parse(readFileSync(this.file,'utf8'));if(!Array.isArray(data))throw new Error('Archivio progetti non valido');
   const seen=new Set();for(const p of data){if(!p||typeof p.path!=='string'||!isAbsolute(p.path)||!this.inside(resolve(p.path))||seen.has(p.path))throw new Error('Archivio progetti non valido');
    const fields=this.fields({color:p.color,icon:p.icon,hidden:p.hidden,...(p.instructions !== undefined ? {instructions:p.instructions} : {})});this.projects.push({path:p.path,name:basename(p.path),color:null,icon:'folder',hidden:false,...fields});seen.add(p.path);}
  }
 }
 private isSymlink(path:string){try{return lstatSync(path).isSymbolicLink()}catch{return false}}
 private inside(path:string){return this.roots.some(root=>path===root||path.startsWith(root+'/'))}
 private fields(changes:any){
  if(!changes||typeof changes!=='object'||Array.isArray(changes)||Object.keys(changes).some(key=>!['color','icon','hidden','instructions'].includes(key)))throw new Error('Personalizzazione non valida');
  const out:Partial<Project>={};
  if('color' in changes){if(changes.color!==null&&(typeof changes.color!=='string'||!/^#[0-9a-f]{6}$/i.test(changes.color)))throw new Error('Colore non valido');out.color=changes.color?.toLowerCase()??null;}
  if('icon' in changes){if(!PROJECT_ICONS.includes(changes.icon))throw new Error('Icona non valida');out.icon=changes.icon;}
  if('hidden' in changes){if(typeof changes.hidden!=='boolean')throw new Error('Visibilità non valida');out.hidden=changes.hidden;}
  if('instructions' in changes){if(typeof changes.instructions!=='string'||changes.instructions.length>16000)throw new Error('Istruzioni non valide');out.instructions=changes.instructions;}
  return out;
 }
 private save(projects:Project[]){
  const dir=dirname(this.file);mkdirSync(dir,{recursive:true,mode:0o700});if(lstatSync(dir).isSymbolicLink()||this.isSymlink(this.file))throw new Error('Archivio progetti non valido');
  const temporary=this.file+'.'+randomUUID()+'.tmp';
  try{writeFileSync(temporary,JSON.stringify(projects),{mode:0o600,flag:'wx'});renameSync(temporary,this.file);this.projects=projects;}finally{if(existsSync(temporary))unlinkSync(temporary);}
 }
 list(){return this.projects.map(p=>({...p}))}
 update(input:string,changes:Partial<Pick<Project,'color'|'icon'|'hidden'|'instructions'>>){
  const fields=this.fields(changes);if(typeof input!=='string'||!isAbsolute(input)||!this.inside(resolve(input)))throw new Error('Cartella progetto non consentita');
  const lexical=resolve(input);let path=lexical;
  if(!existsSync(path)&&!this.isSymlink(path)){
   if(fields.hidden!==true)throw new Error('La cartella progetto non esiste');
   let ancestor=dirname(path);while(!existsSync(ancestor)&&!this.isSymlink(ancestor))ancestor=dirname(ancestor);
   realpathSync(resolveBrowsePath(ancestor,this.roots));
  }else{path=realpathSync(resolveBrowsePath(path,this.roots));if(!statSync(path).isDirectory())throw new Error('Il progetto deve essere una cartella');}
  const previous=this.projects.find(p=>p.path===path);const project={path,name:basename(path),color:null,icon:'folder',hidden:false,...previous,...fields};
  this.save([...this.projects.filter(p=>p.path!==path),project]);return {...project};
 }
 hide(path:string){return this.update(path,{hidden:true})}
}

// Each managed environment has its own project metadata. The old shared file
// is moved once to the environment selected at upgrade, retaining its contents.
export class EnvironmentProjectStores {
 private stores=new Map<string,ProjectStore>();
 constructor({file,roots,environmentIds,initialEnvironment}:{file:string;roots:string[];environmentIds:string[];initialEnvironment:string}){
  if(!environmentIds.includes(initialEnvironment)||environmentIds.some(id=>!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))||new Set(environmentIds).size!==environmentIds.length)throw new Error('Ambiente non valido');
  const legacy=resolve(file),target=(id:string)=>`${legacy}.${id}`;
  if(existsSync(legacy)||lstatIsLink(legacy)){
   new ProjectStore({file:legacy,roots});
   if(!existsSync(target(initialEnvironment))&&!lstatIsLink(target(initialEnvironment)))renameSync(legacy,target(initialEnvironment));
  }
  for(const id of environmentIds)this.stores.set(id,new ProjectStore({file:target(id),roots}));
 }
 get(id:string){const store=this.stores.get(id);if(!store)throw new Error('Ambiente sconosciuto');return store;}
 move(from:string,to:string,path:string){
  if(from===to)throw new Error('Scegli un ambiente diverso');
  const source=this.get(from),destination=this.get(to);
  const project=source.list().find(p=>p.path===path);
  if(project?.hidden)throw new Error('Progetto non disponibile');
  if(destination.list().some(p=>p.path===path&&!p.hidden))throw new Error('Il progetto è già presente nell’ambiente di destinazione');
  const moved=destination.update(path,{color:project?.color??null,icon:project?.icon??'folder',instructions:project?.instructions??'',hidden:false});
  source.hide(path);return moved;
 }
}
function lstatIsLink(path:string){try{return lstatSync(path).isSymbolicLink()}catch{return false}}
