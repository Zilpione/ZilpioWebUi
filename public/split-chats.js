const THREAD_DRAG_TYPE = 'application/x-codex-webui-thread';
export function setChatDragData(event, id) {
  if (!event.dataTransfer || !id) return false;
  event.dataTransfer.setData(THREAD_DRAG_TYPE, id);
  event.dataTransfer.effectAllowed = 'copy';
  return true;
}

// The embedded conversation has its own app state and transport. Only navigation
// and focus are exchanged with the host; messages are accepted from this frame.
export function initSplitChats({ openThread, startNewTask, getActiveThreadId, getDefaultProject, document: doc = document, window: win = window }) {
  const workspace = doc.querySelector('#chatWorkspace');
  const primary = doc.querySelector('#primaryChatPane');
  const secondary = doc.querySelector('#secondaryChatPane');
  const separator = doc.querySelector('#chatPaneSeparator');
  const overlay = doc.querySelector('#chatDropOverlay');
  let frame = null, ready = false, pendingAction = null, secondaryThread = null, focus = 'primary';
  const stacked = () => win.matchMedia('(max-width:720px)').matches || workspace.classList.contains('chat-split-vertical');
  const updateOrientation = () => separator.setAttribute('aria-orientation', stacked() ? 'horizontal' : 'vertical');
  updateOrientation();
  win.addEventListener('resize', updateOrientation);

  function post(type, value) {
    if (frame?.contentWindow) frame.contentWindow.postMessage({ source: 'codex-webui-chat-host', type, ...value }, win.location.origin);
  }
  function openSecondary(id = null, before) {
    if (id && id === getActiveThreadId()) { focus = 'primary'; primary.querySelector('#prompt')?.focus(); return; }
    if (before !== undefined) workspace.classList.toggle('secondary-first', before);
    if (!frame) {
      frame = doc.createElement('iframe');
      frame.id = 'secondaryChatFrame';
      frame.title = 'Seconda chat';
      const url = new URL('/', win.location.href);
      url.searchParams.set('chat-panel', 'secondary');
      const project = getDefaultProject();
      if (project) url.searchParams.set('project', project);
      if (id) url.searchParams.set('thread', id);
      frame.src = url.href;
      secondary.prepend(frame);
      secondary.hidden = false;
      separator.hidden = false;
      workspace.classList.add('split-open');
      doc.querySelector('#swapChatPanels').hidden = false;
      ready = false;
      pendingAction = null;
    } else if (id) {
      if (ready) post('open-thread', { id });
      else pendingAction = { type: 'open-thread', id };
    }
    focus = 'secondary';
  }
  function closeSecondary() {
    frame?.remove(); frame = null; ready = false; pendingAction = null; secondaryThread = null;
    secondary.hidden = true; separator.hidden = true; workspace.classList.remove('split-open', 'secondary-first', 'chat-split-vertical');
    doc.querySelector('#swapChatPanels').hidden = true;
    updateOrientation();
    focus = 'primary';
  }
  function openInPrimary(id) {
    if (id && id === secondaryThread) { focus = 'secondary'; frame?.contentWindow?.focus(); return true; }
    focus = 'primary'; return openThread(id);
  }
  function openSelected(id) {
    if (frame && focus === 'secondary') {
      if (id === getActiveThreadId()) { focus = 'primary'; primary.querySelector('#prompt')?.focus(); return true; }
      if (ready) post('open-thread', { id }); else pendingAction = { type: 'open-thread', id };
      return true;
    }
    return openInPrimary(id);
  }
  function newTask(project) {
    if (frame && focus === 'secondary') {
      if (ready) post('new-task', { project }); else pendingAction = { type: 'new-task', project };
      return;
    }
    startNewTask(project);
  }
  function dragStart(event, id) {
    if (!setChatDragData(event, id)) { event.preventDefault(); return; }
    overlay.hidden = false;
    workspace.classList.add('dragging-thread');
  }
  function dragEnd() { overlay.hidden = true; workspace.classList.remove('dragging-thread'); }
  for (const zone of overlay.querySelectorAll('[data-chat-drop]')) {
    zone.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes(THREAD_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
    zone.addEventListener('drop', event => {
      const id = event.dataTransfer?.getData(THREAD_DRAG_TYPE);
      if (!id) return;
      event.preventDefault();
      const position = zone.dataset.chatDrop;
      const vertical = position === 'top' || position === 'bottom';
      workspace.classList.toggle('chat-split-vertical', vertical);
      updateOrientation();
      const left = position === 'left' || position === 'top';
      if (!frame && id === getActiveThreadId()) openSecondary(null, !left);
      else if (!frame) openSecondary(id, left);
      else if (id === getActiveThreadId()) { workspace.classList.toggle('secondary-first', !left); focus = 'primary'; }
      else if (id === secondaryThread) { workspace.classList.toggle('secondary-first', left); focus = 'secondary'; }
      else if (left === workspace.classList.contains('secondary-first')) openSecondary(id, left);
      else openInPrimary(id);
      dragEnd();
    });
  }
  const setSize = value => { const size = Math.max(20, Math.min(80, value)); workspace.style.setProperty('--primary-pane-size', `${size}%`); separator.setAttribute('aria-valuenow', String(Math.round(size))); };
  separator.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); separator.setPointerCapture(event.pointerId); workspace.classList.add('resizing-chats');
  });
  separator.addEventListener('pointermove', event => {
    if (!separator.hasPointerCapture(event.pointerId)) return;
    const rect = workspace.getBoundingClientRect();
    let value = stacked() ? (event.clientY - rect.top) / rect.height * 100 : (event.clientX - rect.left) / rect.width * 100;
    if (workspace.classList.contains('secondary-first')) value = 100 - value;
    setSize(value);
  });
  const stopResize = () => workspace.classList.remove('resizing-chats');
  separator.addEventListener('pointerup', stopResize); separator.addEventListener('pointercancel', stopResize); separator.addEventListener('lostpointercapture', stopResize);
  separator.addEventListener('keydown', event => {
    const keys = stacked() ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const direction = (event.key === keys[1] ? 1 : -1) * (workspace.classList.contains('secondary-first') ? -1 : 1);
    setSize(Number(separator.getAttribute('aria-valuenow') || 50) + direction * 5);
  });
  doc.querySelector('#splitChatButton').addEventListener('click', () => openSecondary());
  doc.querySelector('#closeSecondaryChat').addEventListener('click', closeSecondary);
  doc.querySelector('#swapChatPanels').addEventListener('click', () => workspace.classList.toggle('secondary-first'));
  primary.addEventListener('pointerdown', () => { focus = 'primary'; });
  primary.addEventListener('focusin', () => { focus = 'primary'; });
  for (const heading of [doc.querySelector('#primaryPanelTitle'), doc.querySelector('.topbar .thread-heading')]) {
    heading.draggable = true;
    heading.addEventListener('dragstart', event => dragStart(event, getActiveThreadId()));
    heading.addEventListener('dragend', dragEnd);
  }
  win.addEventListener('message', event => {
    if (event.origin !== win.location.origin || event.source !== frame?.contentWindow || event.data?.source !== 'codex-webui-chat-panel') return;
    if (event.data.type === 'ready') { ready = true; if (pendingAction) { const {type,...value} = pendingAction; post(type,value); pendingAction = null; } }
    if (event.data.type === 'focus') focus = 'secondary';
    if (event.data.type === 'drag-start') { overlay.hidden = false; workspace.classList.add('dragging-thread'); }
    if (event.data.type === 'drag-end') dragEnd();
    if (event.data.type === 'thread-changed') secondaryThread = typeof event.data.id === 'string' ? event.data.id : null;
  });
  return { openSecondary, openSelected, newTask, dragStart, dragEnd };
}
