export function initGitHubAccountsPanel({ document: doc = globalThis.document, fetch: request = globalThis.fetch } = {}) {
  const root = doc.querySelector('.github-authorization');
  const $ = selector => root.querySelector(selector);
  const list = $('#githubAccountsList'), status = $('#githubAccountsStatus');
  let accounts = [], login = { status: 'idle' }, busy = false, open = false, generation = 0, timer = null;

  async function api(path = '', method = 'GET', body) {
    const response = await request(`/api/integrations/github${path}`, { method, cache: 'no-store', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Operazione GitHub non riuscita');
    return data;
  }
  const message = value => { status.textContent = value; };
  function controls() {
    const pending = login.status === 'pending';
    $('#githubAddAccount').disabled = busy || pending;
    $('#githubCancelLogin').disabled = busy || Boolean(login.finalizing);
    list.querySelectorAll('button,input').forEach(node => { node.disabled = busy || pending; });
  }
  function button(label, action) {
    const element = doc.createElement('button'); element.type = 'button'; element.textContent = label; element.onclick = action; return element;
  }
  async function action(work) {
    if (busy) return;
    busy = true; controls(); message('');
    try { await work(); } catch (error) { message(error.message || 'Operazione GitHub non riuscita'); }
    finally { busy = false; controls(); }
  }
  function renderAccounts() {
    list.replaceChildren();
    for (const account of accounts) {
      const row = doc.createElement('div'); row.className = 'managed-account'; row.dataset.githubAccount = account.login;
      const copy = doc.createElement('div'); copy.className = 'managed-account-copy';
      const name = doc.createElement('strong'); name.textContent = account.nickname;
      const meta = doc.createElement('small');
      meta.textContent = [`@${account.login}`, account.connected ? 'Autorizzato' : 'Autorizzazione non valida', account.active ? 'Attivo' : null, account.environment ? 'Gestito dall’ambiente' : null].filter(Boolean).join(' · ');
      copy.append(name, meta); row.append(copy);
      const actions = doc.createElement('div'); actions.className = 'managed-account-actions';
      if (!account.environment) {
        if (!account.active && account.connected) actions.append(button('Usa', () => action(async () => { await api('/switch', 'POST', {login:account.login}); await refresh(); message('Account GitHub attivo.'); })));
        actions.append(button('Rinomina', () => {
          const input = doc.createElement('input'); input.value = account.nickname; input.maxLength = 80; input.setAttribute('aria-label', `Nickname per ${account.login}`);
          const save = button('Salva', () => action(async () => { await api('/nickname', 'PATCH', {login:account.login,nickname:input.value}); await refresh(); message('Nickname salvato.'); }));
          const cancel = button('Annulla', renderAccounts);
          input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); save.click(); } else if (event.key === 'Escape') { event.stopPropagation(); renderAccounts(); } });
          actions.replaceChildren(input, save, cancel); input.focus(); input.select();
        }));
        actions.append(button('Rimuovi', () => {
          const confirm = button('Conferma rimozione', () => action(async () => { await api('/account', 'DELETE', {login:account.login}); await refresh(); message('Account rimosso dalla WebUI.'); }));
          const cancel = button('Annulla', renderAccounts);
          actions.replaceChildren(confirm, cancel); confirm.focus();
        }));
      }
      row.append(actions); list.append(row);
    }
    if (!accounts.length) { const empty = doc.createElement('p'); empty.textContent = 'Nessun account GitHub collegato.'; list.append(empty); }
    controls();
  }
  function renderLogin(next) {
    login = next || { status:'idle' };
    const pending = login.status === 'pending';
    $('#githubDeviceLogin').hidden = !pending;
    $('#githubDeviceCode').textContent = login.finalizing ? 'Collegamento in corso…' : login.userCode || 'Preparazione del codice…';
    $('#githubDeviceLink').hidden = !login.userCode || Boolean(login.finalizing);
    controls();
  }
  async function refresh() {
    const expected = generation, data = await api();
    if (!open || expected !== generation) return data;
    accounts = Array.isArray(data.accounts) ? data.accounts : [];
    renderAccounts(); renderLogin(data.login); return data;
  }
  function schedulePoll(expected) {
    clearTimeout(timer);
    if (open && expected === generation) timer = setTimeout(() => poll(expected), 1500);
  }
  async function poll(expected) {
    try {
      const next = await api('/login');
      if (!open || expected !== generation) return;
      renderLogin(next);
      if (next.status === 'pending') schedulePoll(expected);
      else if (next.status === 'completed') { await refresh(); if (open && expected === generation) message('Account GitHub collegato.'); }
      else if (next.status === 'failed') message(next.error || 'Autorizzazione non riuscita.');
    } catch (error) { if (open && expected === generation) { message(error.message); schedulePoll(expected); } }
  }
  $('#githubAddAccount').onclick = () => action(async () => { const expected = ++generation; clearTimeout(timer); const next = await api('/login', 'POST'); if (!open || expected !== generation) return; renderLogin(next); schedulePoll(expected); });
  $('#githubCancelLogin').onclick = () => action(async () => { const expected = ++generation; clearTimeout(timer); let next; try { next = await api('/login', 'DELETE'); } catch (error) { schedulePoll(expected); throw error; } if (!open || expected !== generation) return; renderLogin(next); message('Autorizzazione annullata.'); });
  return {
    async open() {
      if (open) return;
      open = true; const expected = ++generation; message('Caricamento account GitHub…');
      try {
        const data = await api(); if (!open || expected !== generation) return;
        accounts = Array.isArray(data.accounts) ? data.accounts : []; renderAccounts(); renderLogin(data.login); message('');
        if (login.status === 'pending') schedulePoll(expected);
        else if (login.status === 'failed') message(login.error || 'Autorizzazione non riuscita.');
      } catch (error) { if (open && expected === generation) message(error.message); }
    },
    close() { open = false; generation++; clearTimeout(timer); },
  };
}
