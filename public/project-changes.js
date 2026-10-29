const kinds = [
 ['modified', 'M', 'File modificati'],
 ['added', '+', 'File aggiunti in staging'],
 ['deleted', '−', 'File eliminati'],
 ['untracked', '?', 'File nuovi non tracciati'],
];

export function initProjectChanges({ list, document: doc = document, fetch: request = fetch, window: win = window }) {
 const cache = new Map(), pending = new Set();
 function paint(path, changes) {
  for (const section of list.querySelectorAll('.sidebar-project-group')) {
   if (section.dataset.project !== path) continue;
   const heading = section.querySelector('.sidebar-project-row');
   let badges = section.querySelector('.project-changes');
   if (!badges) {
    badges = doc.createElement('button');
    badges.type = 'button';
    badges.onclick = event => { event.stopPropagation(); void openChanges(path); };
    badges.className = 'project-changes';
    heading.after(badges);
   }
   badges.replaceChildren();
   badges.hidden = !changes?.total;
   if (!changes?.total) continue;
   badges.setAttribute('aria-label', `${changes.total} file non committati`);
   for (const [kind, symbol, label] of kinds) {
    if (!changes[kind]) continue;
    const badge = doc.createElement('span');
    badge.className = `project-change-badge project-change-${kind}`;
    badge.textContent = `${symbol}${changes[kind]}`;
    badge.title = `${label}: ${changes[kind]}`;
    badge.setAttribute('aria-label', badge.title);
    badges.append(badge);
   }
  }
 }
 async function openChanges(path) {
  const dialog = doc.createElement('dialog');
  dialog.className = 'project-diff-dialog';
  const title = doc.createElement('h2'); title.textContent = 'Modifiche Git';
  const subtitle = doc.createElement('p'); subtitle.textContent = path;
  const close = doc.createElement('button'); close.type = 'button'; close.textContent = 'Chiudi'; close.onclick = () => dialog.close();
  const header = doc.createElement('header'); header.append(title, close);
  const error = doc.createElement('p'); error.className = 'project-diff-error'; error.setAttribute('role', 'alert');
  const files = doc.createElement('div'); files.className = 'project-diff-files';
  const input = doc.createElement('input'); input.placeholder = 'Messaggio del commit'; input.setAttribute('aria-label', 'Messaggio del commit');
  const commit = doc.createElement('button'); commit.type = 'button'; commit.textContent = 'Commit e push';
  const branch = doc.createElement('span'); branch.className = 'project-diff-branch';
  const footer = doc.createElement('footer'); footer.append(input, branch, commit);
  dialog.append(header, subtitle, error, files, footer); doc.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  async function api(method, body) {
   const response = await request(`/api/projects/changes/detail${method === 'GET' ? '?path=' + encodeURIComponent(path) : ''}`, method === 'GET' ? { cache: 'no-store' } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, ...body }) });
   const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Operazione Git non riuscita'); return data;
  }
  async function load() {
   files.textContent = 'Caricamento…'; error.textContent = '';
   try {
    const data = await api('GET'); files.replaceChildren();
    branch.textContent = data.branch === null ? 'HEAD scollegato' : typeof data.branch === 'string' && data.branch ? `Branch: ${data.branch}` : 'Branch non disponibile: riavvia il server';
    branch.title = branch.textContent;
    if (!data.files.length) files.textContent = 'Nessuna modifica.';
    for (const file of data.files) {
     const section = doc.createElement('section'), row = doc.createElement('div'), name = doc.createElement('strong'), discard = doc.createElement('button'), diff = doc.createElement('pre');
     row.className = 'project-diff-file-header'; name.textContent = `${file.status}  ${file.name}`; discard.type = 'button'; discard.textContent = 'Scarta'; discard.setAttribute('aria-label', `Scarta modifiche a ${file.name}`);
     discard.onclick = async () => { if (!win.confirm(`Scartare tutte le modifiche a ${file.name}? L’operazione è irreversibile.`)) return; discard.disabled = true; try { await api('DELETE', { name: file.name }); cache.delete(path); await load(); void refresh(); } catch (e) { error.textContent = e.message; discard.disabled = false; } };
     let inHunk = false;
     for (const line of file.diff.split('\n')) {
      if (line.startsWith('diff --git ') || line === 'Staged:' || line === 'Non staged:') inHunk = false;
      if (line.startsWith('@@')) inHunk = true;
      const text = doc.createElement('span');
      text.className = inHunk && line.startsWith('+') ? 'project-diff-added' : inHunk && line.startsWith('-') ? 'project-diff-deleted' : line.startsWith('@@') ? 'project-diff-hunk' : '';
      text.textContent = line + '\n'; diff.append(text);
     }
     row.append(name, discard); section.append(row, diff); files.append(section);
    }
    commit.disabled = !data.files.length;
   } catch (e) { files.textContent = ''; error.textContent = e.message; commit.disabled = true; }
  }
  commit.onclick = async () => { if (!input.value.trim()) { error.textContent = 'Inserisci un messaggio di commit.'; input.focus(); return; } commit.disabled = true; try { await api('POST', { message: input.value }); cache.delete(path); await load(); void refresh(); input.value = ''; } catch (e) { error.textContent = e.message; cache.delete(path); void refresh(); commit.disabled = false; } };
  dialog.showModal(); await load();
 }
 async function refresh() {
  if (doc.hidden) return;
  const paths = new Set([...list.querySelectorAll('.sidebar-project-group')].map(section => section.dataset.project).filter(path => path && !path.startsWith('__')));
  for (const path of cache.keys()) if (!paths.has(path)) cache.delete(path);
  await Promise.all([...paths].map(async path => {
   const cached = cache.get(path);
   paint(path, cached?.changes);
   if (pending.has(path) || cached && Date.now() - cached.time < 5000) return;
   pending.add(path);
   try {
    const response = await request(`/api/projects/changes?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Stato Git non disponibile');
    const { changes } = await response.json();
    cache.set(path, { changes, time: Date.now() });
    paint(path, changes);
   } catch {
    cache.delete(path);
    paint(path, null);
   } finally { pending.delete(path); }
  }));
 }
 const observer = new win.MutationObserver(() => { void refresh(); });
 observer.observe(list, { childList: true });
 const onFocus = () => { void refresh(); };
 win.addEventListener('focus', onFocus);
 doc.addEventListener('visibilitychange', onFocus);
 const timer = win.setInterval(onFocus, 10000);
 void refresh();
 return { refresh, destroy() { observer.disconnect(); win.clearInterval(timer); win.removeEventListener('focus', onFocus); doc.removeEventListener('visibilitychange', onFocus); } };
}
