export function threadLink(id, location) {
 const url=new URL('/',location.origin);url.searchParams.set('thread',id);return url.href;
}
export function showThreadMenu({document:doc=globalThis.document,x,y,thread,projects,copy,move,onError=()=>{}}) {
 doc.querySelector('.thread-context-menu')?.remove();
 const menu=doc.createElement('div');menu.className='thread-context-menu';menu.setAttribute('role','menu');
 const button=(label,action)=>{const node=doc.createElement('button');node.type='button';node.textContent=label;node.setAttribute('role','menuitem');node.onclick=async event=>{event.stopPropagation();menu.remove();try{await action()}catch(error){onError(error)}};menu.append(node);return node};
 button('Copia link chat',()=>copy(threadLink(thread.id,doc.defaultView.location)));
 const destinations=projects.filter(project=>!project.hidden&&project.path!==thread.cwd);
 const heading=doc.createElement('div');heading.className='thread-menu-heading';heading.textContent='Sposta nel progetto';menu.append(heading);
 for(const project of destinations)button(project.name||project.path.split('/').filter(Boolean).at(-1)||project.path,()=>move(project.path));
 if(!destinations.length){const empty=doc.createElement('div');empty.className='thread-menu-heading';empty.textContent='Nessun altro progetto';menu.append(empty)}
 doc.body.append(menu);menu.style.left=`${Math.max(0,Math.min(x,doc.defaultView.innerWidth-menu.offsetWidth))}px`;menu.style.top=`${Math.max(0,Math.min(y,doc.defaultView.innerHeight-menu.offsetHeight))}px`;
 const close=event=>{if(event.type==='keydown'&&event.key!=='Escape')return;if(event.type==='pointerdown'&&menu.contains(event.target))return;menu.remove();doc.removeEventListener('pointerdown',close);doc.removeEventListener('keydown',close)};
 doc.addEventListener('pointerdown',close);doc.addEventListener('keydown',close);menu.querySelector('button')?.focus();
}
