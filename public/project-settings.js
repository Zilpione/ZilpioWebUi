export const PROJECT_ICONS=Object.freeze({folder:'📁',code:'⌘',rocket:'🚀',star:'★',gamepad:'🎮',globe:'🌐',book:'📖',briefcase:'💼'});
const COLORS=[['','Predefinito'],['#3b82f6','Blu'],['#22c55e','Verde'],['#f59e0b','Ambra'],['#ef4444','Rosso'],['#a855f7','Viola'],['#ec4899','Rosa'],['#06b6d4','Ciano']];
export function initProjectSettings({onChange=()=>{},document:doc=globalThis.document,fetch:request=globalThis.fetch}={}){
 const $=selector=>doc.querySelector(selector),dialog=$('#projectSettingsDialog'),picker=$('#projectSettingsPath'),error=$('#projectSettingsError');
 let projects=[],selected='',busy=false,revision=0,renderedPath='',draftDirty=false,baseline={color:'',icon:'folder',instructions:''};
 const name=path=>path.split('/').filter(Boolean).at(-1)||path;
 function option(value,label){const node=doc.createElement('option');node.value=value;node.textContent=label;return node;}
 for(const [value,label] of COLORS)$('#projectColor').append(option(value,label));
 for(const [value,glyph] of Object.entries(PROJECT_ICONS))$('#projectIcon').append(option(value,`${glyph} ${value}`));
 function render({preserveDraft=false}={}){
  const draft={color:$('#projectColor').value,icon:$('#projectIcon').value,instructions:$('#projectInstructions').value};
  const keepDraft=preserveDraft&&renderedPath===selected&&(draftDirty||draft.color!==baseline.color||draft.icon!==baseline.icon||draft.instructions!==baseline.instructions);
  picker.replaceChildren(...projects.map(p=>option(p.path,`${name(p.path)}${p.hidden?' (rimosso)':''} — ${p.path}`)));
  if(selected&&!projects.some(p=>p.path===selected))picker.append(option(selected,`${name(selected)} — ${selected}`));
  if(!selected)selected=projects[0]?.path||'';picker.value=selected;
  const project=projects.find(p=>p.path===selected);
  $('#projectSettingsLocation').textContent=selected||'Nessun progetto registrato';
  const color=$('#projectColor');for(const extra of color.querySelectorAll('[data-custom-color]'))extra.remove();
  if(project?.color&&!COLORS.some(([value])=>value===project.color)&&/^#[a-f0-9]{6}$/i.test(project.color)){const extra=option(project.color,project.color);extra.dataset.customColor='true';color.append(extra);}
  color.value=project?.color||'';$('#projectIcon').value=Object.hasOwn(PROJECT_ICONS,project?.icon)?project.icon:'folder';
  $('#projectInstructions').value=project?.instructions||'';
  renderedPath=selected;draftDirty=keepDraft;if(!keepDraft)baseline={color:color.value,icon:$('#projectIcon').value,instructions:$('#projectInstructions').value};
  if(keepDraft){if(draft.color&&!Array.from(color.options).some(option=>option.value===draft.color)){const extra=option(draft.color,draft.color);extra.dataset.customColor='true';color.append(extra);}color.value=draft.color;$('#projectIcon').value=draft.icon;$('#projectInstructions').value=draft.instructions;}
  $('#removeProject').hidden=Boolean(project?.hidden);$('#restoreProject').hidden=!project?.hidden;
  for(const button of dialog.querySelectorAll('button[type=button]'))button.disabled=busy||!selected;
 }
 async function refresh(){
  const operation=++revision,response=await request('/api/projects',{cache:'no-store'}),data=await response.json();
  if(!response.ok)throw new Error(data.error||'Impossibile caricare i progetti');
  if(operation!==revision)return projects;
  projects=Array.isArray(data.projects)?data.projects:[];
  if(dialog.open)render({preserveDraft:true});onChange(projects);return projects;
 }
 async function mutate(path,changes,method='PATCH'){
  const response=await request('/api/projects',{method,headers:{'content-type':'application/json'},body:JSON.stringify({path,...changes})}),data=await response.json();
  if(!response.ok)throw new Error(data.error||'Impossibile aggiornare il progetto');
  await refresh();return data;
 }
 async function action(changes,method){
  if(busy||!selected)return;busy=true;error.textContent='';for(const node of dialog.querySelectorAll('input,select,textarea,button'))node.disabled=true;
  try{await mutate(selected,changes,method);render({preserveDraft:!Object.hasOwn(changes,'icon')});if(Object.hasOwn(changes,'icon'))dialog.close();}catch(e){error.textContent=e.message||'Impossibile aggiornare il progetto';}
  finally{busy=false;for(const node of dialog.querySelectorAll('input,select,textarea,button'))node.disabled=false;for(const node of dialog.querySelectorAll('button[type=button]'))node.disabled=!selected;}
 }
 async function open(path){selected=path||'';error.textContent='';render();if(!dialog.open)dialog.showModal();try{await refresh();}catch(e){error.textContent=e.message;}}
 picker.onchange=()=>{selected=picker.value;error.textContent='';render();};
 $('#saveProjectSettings').onclick=()=>action({color:$('#projectColor').value||null,icon:$('#projectIcon').value,instructions:$('#projectInstructions').value});
 $('#removeProject').onclick=()=>action({},'DELETE');$('#restoreProject').onclick=()=>action({hidden:false});
 $('#manageProjects').onclick=()=>open();
 dialog.querySelector('form').addEventListener('submit',event=>{if(busy)event.preventDefault();});
 const ready=refresh().catch(e=>{error.textContent=e.message;return projects;});
 return {ready,getProjects:()=>projects,open,refresh,register:path=>mutate(path,{hidden:false})};
}
