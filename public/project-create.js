export function initProjectCreator({getParent,onCreated,document:doc=globalThis.document,fetch:request=globalThis.fetch}) {
  const $=selector=>doc.querySelector(selector),panel=$('#createProjectPanel'),input=$('#newProjectName'),error=$('#createProjectError');
  let busy=false,generation=0;
  function reset(){generation++;panel.hidden=true;input.value='';error.textContent=''}
  function open(){if(busy)return;panel.hidden=false;error.textContent='';input.focus()}
  async function create(){
    if(busy)return;
    const name=input.value.trim();if(!name){error.textContent='Inserisci il nome del progetto';input.focus();return}
    const operation=++generation;busy=true;error.textContent='';for(const node of panel.querySelectorAll('input,button'))node.disabled=true;
    try{
      const response=await request('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({parent:getParent(),name})});
      const project=await response.json();if(operation!==generation)return;if(!response.ok)throw new Error(project.error||'Impossibile creare il progetto');
      reset();await onCreated(project);
    }catch(e){if(operation===generation)error.textContent=e.message||'Impossibile creare il progetto'}
    finally{busy=false;for(const node of panel.querySelectorAll('input,button'))node.disabled=false}
  }
  $('#addProject').onclick=open;$('#createProject').onclick=create;$('#cancelCreateProject').onclick=reset;
  input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();create()}};
  return {reset};
}
