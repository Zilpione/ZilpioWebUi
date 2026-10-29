import {normalizeUsage} from './usage-bars.js';

export function createSidebarUsage({host,readUsage,consumeReset,now=()=>Date.now()}) {
  let accounts=[],generation=0;
  const snapshots=new Map();
  let tooltip=null;
  function hideTooltip(){tooltip?.remove();tooltip=null}
  function showTooltip(dot){hideTooltip();const doc=host.ownerDocument;tooltip=doc.createElement('div');tooltip.className='sidebar-usage-tooltip';tooltip.textContent=dot.dataset.tooltip;doc.body.append(tooltip);const rect=dot.getBoundingClientRect(),view=doc.defaultView;const width=tooltip.offsetWidth,height=tooltip.offsetHeight;tooltip.style.left=`${Math.max(8,Math.min(rect.right+14,view.innerWidth-width-8))}px`;tooltip.style.top=`${Math.max(8,Math.min(rect.top-(height-rect.height)/2,view.innerHeight-height-8))}px`}
  const element=(tag,className,text)=>{const node=host.ownerDocument.createElement(tag);node.className=className;if(text!=null)node.textContent=text;return node};
  const doc=host.ownerDocument,listDialog=element('dialog','reset-list-dialog'),confirmDialog=element('dialog','reset-confirm-dialog');doc.body.append(listDialog,confirmDialog);
  function calendarDay(timestamp){const date=new Date(timestamp);return Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())/86400000}
  function expiryText(credit){if(!credit)return 'Scadenza non disponibile';if(credit.expiresAt===null)return 'Senza scadenza';const date=new Date(credit.expiresAt*1000);return Number.isFinite(date.getTime())?`Scade: ${date.toLocaleString('it-IT',{weekday:'long',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}`:'Scadenza non disponibile'}
  function button(label,className,handler){const node=element('button',className,label);node.type='button';node.onclick=handler;return node}
  function openResets(account,credits,count){
    hideTooltip();listDialog.replaceChildren();listDialog.append(element('h2','',`Reset disponibili · ${account.label||account.email||'Account'}`));
    const list=element('div','reset-list');for(let i=0;i<count;i++){const credit=credits[i],row=element('div','reset-row');row.append(element('span','',expiryText(credit)),button('Usa ora','reset-use',()=>confirmReset(account,credit)));list.append(row)}
    listDialog.append(list,button('Chiudi','reset-close',()=>listDialog.close()));listDialog.showModal();
  }
  function confirmReset(account,credit){
    confirmDialog.replaceChildren();confirmDialog.append(element('h2','','Confermi l’utilizzo del reset?'),element('p','',`Account: ${account.label||account.email||'Account'} · ${expiryText(credit)}`),element('p','','Il reset verrà utilizzato per ripristinare i limiti disponibili.'));
    const error=element('p','reset-error');error.setAttribute('role','alert');const cancel=button('Annulla','reset-cancel',()=>confirmDialog.close());
    const confirm=button('Conferma','reset-confirm',async()=>{confirm.disabled=true;cancel.disabled=true;error.textContent='';try{if(!consumeReset)throw new Error('Operazione non disponibile');const result=await consumeReset(account.id,credit?.id);if(result?.outcome!=='reset')throw new Error(({nothingToReset:'Nessun limite da ripristinare.',noCredit:'Nessun reset disponibile.',alreadyRedeemed:'Reset già utilizzato.'})[result?.outcome]||'Reset non completato.');confirmDialog.close();listDialog.close();await refresh()}catch(e){error.textContent=e.message||'Impossibile utilizzare il reset.'}finally{confirm.disabled=false;cancel.disabled=false}});confirmDialog.append(error,cancel,confirm);confirmDialog.showModal();
  }
  function render(){
    hideTooltip();host.replaceChildren();host.hidden=!accounts.length;
    for(const account of accounts){
      const snapshot=snapshots.get(account.id),usage=normalizeUsage(snapshot?.data),card=element('article','sidebar-usage-card');
      const header=element('div','sidebar-usage-header'),identity=element('div','sidebar-usage-identity');identity.append(element('strong','sidebar-usage-name',account.label||account.email||'Account'));
      const resets=snapshot?.data?.rateLimitResetCredits,count=Number(resets?.availableCount),credits=Array.isArray(resets?.credits)?resets.credits.filter(credit=>credit.status==='available'):[];
      if(Number.isSafeInteger(count)&&count>0){for(let index=0;index<count;index++){const credit=credits[index],expiry=credit?.expiresAt,validExpiry=typeof expiry==='number'&&Number.isFinite(new Date(expiry*1000).getTime());const description=validExpiry?`Reset disponibile · Scade: ${new Date(expiry*1000).toLocaleString('it-IT',{weekday:'long',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}`:credit&&expiry===null?'Reset disponibile · Senza scadenza':'Reset disponibile · Scadenza non disponibile';const dot=element('button','sidebar-usage-reset-dot');dot.type='button';const days=validExpiry?Math.max(0,calendarDay(expiry*1000)-calendarDay(now())):null;if(days!==null)dot.dataset.expiryDay=String(days);dot.dataset.expiryLevel=days===null?'unknown':days<=1?'low':days<=3?'medium':'high';dot.onclick=()=>openResets(account,credits,count);dot.dataset.tooltip=description;dot.setAttribute('aria-label',description);dot.tabIndex=0;dot.addEventListener('mouseenter',()=>showTooltip(dot));dot.addEventListener('mouseleave',hideTooltip);dot.addEventListener('focus',()=>showTooltip(dot));dot.addEventListener('blur',hideTooltip);identity.append(dot)}}
      header.append(identity,element('span','sidebar-usage-clock',usage.fiveHour?.resetsAt?new Date(usage.fiveHour.resetsAt).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'}):'--:--'));card.append(header);
      for(const [key,label] of [['fiveHour','5 ore'],['weekly','Sett']]){
        const quota=usage[key],section=element('div','sidebar-usage-window'),heading=element('div','sidebar-usage-window-heading');
        let remaining='Reset non disponibile';
        if(quota?.resetsAt){const minutes=Math.max(0,Math.ceil((quota.resetsAt-now())/60000));remaining=`${Math.floor(minutes/60)}h e ${minutes%60} m`}
        const title=element('strong','',label);if(quota)title.append(element('span','sidebar-usage-inline-percent',` ${Math.round(quota.remainingPercent)}%`));const resetLabel=key==='weekly'?(quota?.resetsAt?`Reset ${new Date(quota.resetsAt).toLocaleString('it-IT',{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}`:'Reset non disponibile'):remaining;heading.append(title,element('span','',resetLabel));section.append(heading);
        const track=element('div','sidebar-usage-track');
        if(quota){track.setAttribute('role','progressbar');track.setAttribute('aria-label',`${label}: quota disponibile`);track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(quota.remainingPercent));track.dataset.level=quota.remainingPercent<=20?'low':quota.remainingPercent<=40?'medium':'high';const fill=element('span','');fill.style.width=`${quota.remainingPercent}%`;track.append(fill)}
        const detail=element('div','sidebar-usage-detail');if(!quota)detail.append(element('span','',quota?`${Math.round(quota.remainingPercent)}%`:'Non disponibile'));
        section.append(track);if(detail.childElementCount)section.append(detail);
        card.append(section);
      }
      host.append(card);
    }
    if(accounts.length){const times=accounts.map(account=>snapshots.get(account.id)?.updatedAt).filter(value=>value!=null),oldest=times.length?Math.min(...times):null;host.append(element('div','sidebar-usage-updated',oldest!=null?`Aggiornato alle ${new Date(oldest).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}`:'Aggiornamento non disponibile'))}
  }
  async function refresh(){const current=++generation;await Promise.all(accounts.map(async account=>{try{const data=await readUsage(account.id);if(current===generation)snapshots.set(account.id,{data,updatedAt:now()})}catch{if(current===generation&&!snapshots.has(account.id))snapshots.delete(account.id)}}));if(current===generation)render()}
  function setAccounts(next){accounts=next.filter(account=>account.id);const ids=new Set(accounts.map(account=>account.id));for(const id of snapshots.keys())if(!ids.has(id))snapshots.delete(id);render();return refresh()}
  const timer=setInterval(()=>void refresh(),120000);
  return {setAccounts,refresh,dispose(){clearInterval(timer);generation++;hideTooltip();listDialog.remove();confirmDialog.remove()}};
}
