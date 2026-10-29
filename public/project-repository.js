export function initProjectRepository({ register, toast, document: doc = document, fetch: request = fetch }) {
 const dialog = doc.createElement('dialog');
 dialog.className = 'project-repository-dialog';
 dialog.innerHTML = '<form method="dialog"><h2>Repository del progetto</h2><p class="repo-message"></p><input class="repo-search" type="search" placeholder="Cerca repository" aria-label="Cerca repository"><div class="repo-list"></div><p class="repo-error" role="alert"></p><button value="cancel">Chiudi</button></form>';
 doc.body.append(dialog);
 const message=dialog.querySelector('.repo-message'), search=dialog.querySelector('.repo-search'), list=dialog.querySelector('.repo-list'), error=dialog.querySelector('.repo-error');
 let path='', repos=[];
 async function api(url, options) { const response=await request(url,options), data=await response.json(); if(!response.ok)throw new Error(data.error||'Operazione non riuscita'); return data; }
 const url=()=>`/api/projects/repository?path=${encodeURIComponent(path)}`;
 const action=(method, data={})=>api('/api/projects/repository',{method,headers:{'content-type':'application/json'},body:JSON.stringify({path,...data})});
 function render() {
  list.replaceChildren();
  for(const repo of repos.filter(r=>r.name.toLowerCase().includes(search.value.toLowerCase()))) {
   const button=doc.createElement('button'); button.type='button'; button.textContent=`${repo.starred?'★ ':''}${repo.name}${repo.private?' 🔒':''}`;
   button.onclick=async()=>{button.disabled=true;error.textContent='';try { const result=await action('POST',{name:repo.name}); dialog.close(); toast('Repository collegato'); if(result.emptyRemote && confirm('Il repository è vuoto. Vuoi creare il primo commit e pubblicare i file della cartella?')) { try { await action('PATCH'); toast('File pubblicati nel repository'); } catch(e) { toast(e.message); } } } catch(e){error.textContent=e.message;button.disabled=false;} };
   list.append(button);
  }
 }
 search.oninput=render;
 async function status(project) { return api(`/api/projects/repository?path=${encodeURIComponent(project)}`); }
 async function open(project) {
  path=project; error.textContent=''; search.hidden=true;list.replaceChildren();message.textContent='Caricamento…'; if(!dialog.open)dialog.showModal();
  try {
   await register(project);
   const state=await status(project);
   if(state.assigned) { message.textContent=state.remote ? `Repository collegato: ${state.remote}` : 'Questa cartella contiene un repository Git.'; const button=doc.createElement('button');button.type='button';button.textContent='Scollega repository';button.disabled=!state.removable;button.onclick=async()=>{if(!confirm('Scollegare il repository? Verrà rimossa la cartella .git; i file resteranno nella cartella.'))return;button.disabled=true;try{await action('DELETE');dialog.close();toast('Repository scollegato');}catch(e){error.textContent=e.message;button.disabled=false;}};list.append(button); }
   else { message.textContent='Scegli un repository accessibile:'; const data=await api('/api/projects/repositories');repos=data.repositories||[];search.value='';search.hidden=false;render();if(!repos.length)message.textContent='Nessun repository accessibile. Collega un account GitHub nelle impostazioni.'; }
  } catch(e) { message.textContent='';error.textContent=e.message; }
 }
 return {open,status};
}
