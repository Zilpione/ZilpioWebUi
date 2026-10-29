const UNREAD_KEY = 'codex-webui-notifier-unread';
const SOUND_KEY = 'codex-webui-notifier-sound';
const EXHAUSTED_KEY = 'codex-webui-notifier-exhausted';

export function isUsageLimitError(error) {
  if (error?.codexErrorInfo && error.codexErrorInfo !== 'other') return error.codexErrorInfo === 'usageLimitExceeded';
  const message = typeof error === 'string' ? error : `${error?.code || ''} ${error?.message || ''}`;
  return /\b(?:usage_limit_(?:reached|exceeded)|insufficient_quota|quota_exceeded|(?:workspace_\w+_)?credits_depleted|(?:hit|reached|exceeded) (?:your |the )?(?:current )?(?:usage limit|quota)|(?:usage limit|quota) (?:has been |is )?(?:reached|exceeded)|(?:insufficient|no|out of) credits|credits (?:are |have been )?(?:exhausted|depleted)|credit balance is too low)\b/i.test(message);
}

export function createNotifier({ storage, play = () => {} }) {
  let unread = new Set(), exhausted = new Set();
  const activity = new Map(), finished = new Set(), versions = new Map();
  function readSet(key) {
    try { const value = JSON.parse(storage.getItem(key) || '[]'); return new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string') : []); }
    catch { return new Set(); }
  }
  function load() {
    unread = readSet(UNREAD_KEY);
    exhausted = readSet(EXHAUSTED_KEY);
  }
  function persist() { try { storage.setItem(UNREAD_KEY, JSON.stringify([...unread])); } catch {} }
  function persistExhausted() { try { storage.setItem(EXHAUSTED_KEY, JSON.stringify([...exhausted])); } catch {} }
  function soundEnabled() { try { return storage.getItem(SOUND_KEY) !== 'false'; } catch { return true; } }
  load();
  return {
    started(id) {
      if (!id) return;
      activity.set(id, 'running');
      exhausted = readSet(EXHAUSTED_KEY);
      if (exhausted.delete(id)) persistExhausted();
    },
    failed(id, error) {
      if (!id || !isUsageLimitError(error)) return false;
      exhausted = readSet(EXHAUSTED_KEY);
      if (!exhausted.has(id)) { exhausted.add(id); persistExhausted(); }
      return true;
    },
    completed(id, turnId) {
      if (!id) return;
      if (turnId && finished.has(turnId)) return;
      if (turnId) { finished.add(turnId); if (finished.size > 500) finished.delete(finished.values().next().value); }
      activity.set(id, 'completed'); versions.set(id, (versions.get(id) || 0) + 1); unread.add(id); persist();
      if (soundEnabled()) { try { Promise.resolve(play()).catch(() => {}); } catch {} }
    },
    unreadVersion(id) { return versions.get(id) || 0; },
    acknowledge(id, version = versions.get(id) || 0) { if (version === (versions.get(id) || 0) && unread.delete(id)) persist(); },
    status(id, summary, ignoreExhausted = false) {
      if (!ignoreExhausted && exhausted.has(id)) return 'exhausted';
      if (activity.get(id) === 'running') return 'running';
      if (activity.get(id) !== 'completed' && summary?.type === 'active') return 'running';
      return unread.has(id) ? 'unread' : '';
    },
    observeSummary(id, summary) { if (summary && summary.type !== 'active' && activity.get(id) === 'completed') activity.delete(id); },
    soundEnabled,
    setSoundEnabled(enabled) { try { storage.setItem(SOUND_KEY, String(Boolean(enabled))); } catch {} },
    exhaustedIds() { return [...exhausted]; },
    removeExhausted(ids) { exhausted = readSet(EXHAUSTED_KEY); let changed = false; for (const id of ids) changed = exhausted.delete(id) || changed; if (changed) persistExhausted(); },
    reload: load,
  };
}

export function createNotificationSound(windowObject = window) {
  let context;
  const getContext = () => { const Audio = windowObject.AudioContext || windowObject.webkitAudioContext; if (!Audio) return null; return context ||= new Audio(); };
  return {
    async unlock() { const audio = getContext(); if (audio?.state === 'suspended') await audio.resume(); },
    async play() {
      const audio = getContext(); if (!audio) throw new Error('Audio non supportato dal browser');
      if (audio.state === 'suspended') await audio.resume();
      if (audio.state !== 'running') throw new Error('Interagisci con la pagina per attivare il suono');
      const now = audio.currentTime, gain = audio.createGain(), oscillator = audio.createOscillator();
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(660, now); oscillator.frequency.setValueAtTime(880, now + 0.12);
      gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(now); oscillator.stop(now + 0.37);
    },
  };
}
