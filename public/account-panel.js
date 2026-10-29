import {renderUsageBars} from './usage-bars.js';

export function initAccountPanel({onError,readUsage,document:doc=globalThis.document,fetch:request=globalThis.fetch,reload=()=>globalThis.location.reload()}={}) {
  const dialog=doc.querySelector('#accountsDialog'),usage=doc.querySelector('#usageBars');
  let runtime=null,busy=false,usageGeneration=0,loginTimer=null,usageSnapshot=null;
  const $=selector=>dialog.querySelector(selector);
  const message=text=>{$('#accountsStatus').textContent=text};
  async function api(path,method='GET',body) {
    const response=await request(path,{method,cache:'no-store',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Operazione non riuscita');return data;
  }
  function setBusy(value){busy=value;dialog.querySelectorAll('button,input,select').forEach(node=>{if(!node.hasAttribute('data-close-accounts'))node.disabled=value||(node.dataset.useAccount===runtime?.accountId)});doc.querySelectorAll('[data-runtime-control]').forEach(node=>node.disabled=value)}
  async function action(work){if(busy)return;setBusy(true);message('');try{await work()}catch(error){message(error.message);onError?.(error.message)}finally{setBusy(false);const selector=doc.querySelector('#environmentSelect');if(selector&&runtime)selector.value=runtime.environmentId||'';}}
  function clearUsage(){usageGeneration++;usageSnapshot=null;renderUsageBars(usage,null)}
  async function refreshUsage(){const generation=++usageGeneration;try{const data=await (readUsage?readUsage():api('/api/usage')); if(generation===usageGeneration){usageSnapshot=data;renderUsageBars(usage,data)}}catch{if(generation===usageGeneration){usageSnapshot=null;renderUsageBars(usage,null)}}}
  function updateUsage(data){
    const incoming=data?.rateLimits;if(!incoming||(incoming.limitId&&incoming.limitId!=='codex'))return;
    const previous=usageSnapshot?.rateLimits??usageSnapshot?.rateLimitsByLimitId?.codex??{};
    const merge=(oldValue,newValue)=>Object.fromEntries(Object.entries({...oldValue,...Object.fromEntries(Object.entries(newValue||{}).filter(([,value])=>value!=null))}));
    const rateLimits=merge(previous,incoming);
    for(const key of ['primary','secondary'])rateLimits[key]=incoming[key]?merge(previous[key],incoming[key]):previous[key];
    usageGeneration++;usageSnapshot={rateLimits};renderUsageBars(usage,usageSnapshot);
  }
  function renderRuntime(){
    const list=$('#accountsList');list.replaceChildren();
    for(const account of runtime?.accounts||[]) {
      const row=doc.createElement('div');row.className='managed-account';
      const copy=doc.createElement('div');copy.className='managed-account-copy';
      const label=doc.createElement('strong');label.textContent=account.label||account.email||'Account ChatGPT';
      const meta=doc.createElement('small');meta.textContent=[account.email,account.planType,account.active?'Predefinito':null].filter(Boolean).join(' · ');copy.append(label,meta);row.append(copy);
      const controls=doc.createElement('div');controls.className='managed-account-actions';
      const use=doc.createElement('button');use.type='button';use.textContent='Usa';use.dataset.useAccount=account.id;use.textContent=account.active?'Principale':'Usa come principale';use.disabled=account.active;use.onclick=()=>switchRuntime({accountId:account.id});controls.append(use);
      const rename=doc.createElement('button');rename.type='button';rename.textContent='Rinomina';rename.onclick=()=>{
        const input=doc.createElement('input');input.value=account.label||'';input.maxLength=80;input.setAttribute('aria-label','Nome account');
        const save=doc.createElement('button');save.type='button';save.textContent='Salva';save.onclick=()=>{const label=input.value.trim();if(!label){message('Inserisci un nome account');return}action(async()=>{await api(`/api/accounts/${encodeURIComponent(account.id)}`,'PATCH',{label});await refreshRuntime()})};
        const cancel=doc.createElement('button');cancel.type='button';cancel.textContent='Annulla';cancel.onclick=renderRuntime;controls.replaceChildren(input,save,cancel);input.focus();
      };controls.append(rename);
      if(!account.active){const remove=doc.createElement('button');remove.type='button';remove.textContent='Elimina';remove.onclick=()=>action(async()=>{await api(`/api/accounts/${encodeURIComponent(account.id)}`,'DELETE');await refreshRuntime()});controls.append(remove)}
      row.append(controls);list.append(row);
    }
    if(!list.childElementCount){const empty=doc.createElement('p');empty.textContent='Nessun account disponibile. Aggiungi un account ChatGPT.';list.append(empty)}
    const spaces=$('#runtimeWorkspaces');spaces.replaceChildren();spaces.closest('section').hidden=(runtime?.environments?.length||0)<2;
    for(const workspace of runtime?.environments||[]) {const button=doc.createElement('button');button.type='button';button.textContent=workspace.label;button.dataset.runtimeControl='';button.setAttribute('aria-pressed',String(workspace.id===runtime.environmentId));button.onclick=()=>switchRuntime({environmentId:workspace.id});spaces.append(button)}
    const environmentControl=doc.querySelector('.environment-control');if(environmentControl)environmentControl.hidden=(runtime?.environments?.length||0)<2;
    const selector=doc.querySelector('#environmentSelect');if(selector){selector.replaceChildren();for(const environment of runtime?.environments||[]){const option=doc.createElement('option');option.value=environment.id;option.textContent=environment.label;selector.append(option)}selector.value=runtime.environmentId||'';}
    setBusy(busy);
  }
  async function refreshRuntime(){runtime=await api('/api/runtime');renderRuntime();return runtime}
  async function switchRuntime(selection){
    await action(async()=>{clearUsage();message('Cambio condiviso in corso…');const next=await api('/api/runtime/switch','POST',{...selection,expectedRevision:runtime?.runtimeRevision});runtime=next;reload(selection)});
  }
  function renderLogin(login){
    const pending=login.status==='pending';$('#deviceLogin').hidden=!pending;$('#addAccount').hidden=pending;
    if(pending){$('#deviceCode').textContent=login.userCode||'';const link=$('#deviceVerification');let url;try{url=new URL(login.verificationUrl)}catch{}const safe=url?.protocol==='https:';link.hidden=!safe;if(safe)link.href=url.href;clearTimeout(loginTimer);loginTimer=setTimeout(pollLogin,2000)}
    else {clearTimeout(loginTimer);if(login.status==='failed')message(login.error||'Accesso non riuscito');}
  }
  async function pollLogin(){try{const login=await api('/api/accounts/login');renderLogin(login);if(login.status==='completed'){await refreshRuntime();await refreshUsage();message('Account aggiunto. Selezionalo nel compositore della chat.')}}catch(error){message(error.message);clearTimeout(loginTimer);loginTimer=setTimeout(pollLogin,5000)}}
  async function open(){if(!dialog.open)dialog.showModal();message('');try{await refreshRuntime();await pollLogin()}catch(error){message(error.message)}}
  const selector=doc.querySelector('#environmentSelect');if(selector)selector.onchange=()=>switchRuntime({environmentId:selector.value});
  doc.querySelector('#defaultAccountButton').onclick=open;
  doc.querySelector('#manageAccounts').onclick=open;
  doc.querySelector('#usageManageAccounts').onclick=open;
  dialog.querySelector('[data-close-accounts]').onclick=()=>dialog.close();
  $('#addAccount').onclick=()=>action(async()=>renderLogin(await api('/api/accounts/login','POST')));
  $('#cancelDeviceLogin').onclick=()=>action(async()=>renderLogin(await api('/api/accounts/login/cancel','POST')));
  clearUsage();
  const usageTimer=setInterval(refreshUsage,60000);
  const ready=refreshRuntime().catch(error=>message(error.message));refreshUsage();
  return {ready,open,refreshUsage,updateUsage,clearUsage,switchRuntime,dispose(){clearInterval(usageTimer);clearTimeout(loginTimer);usageGeneration++}};
}
