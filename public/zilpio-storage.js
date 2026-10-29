// Preserve the selected project and unsent drafts when El is retired. Each
// storage area migrates once, so clearing a Zilpio draft cannot resurrect it.
export function migrateZilpioStorage(config, persistent, session) {
  if (config.environmentId !== 'zilpio' || config.environments?.length !== 1) return;
  const marker = 'codex-webui-zilpio-storage-migrated';
  try {
    if (persistent.getItem(marker) !== 'true') {
      const project = persistent.getItem('codex-webui-project:El');
      if (project !== null && persistent.getItem('codex-webui-project:zilpio') === null) persistent.setItem('codex-webui-project:zilpio', project);
      persistent.setItem(marker, 'true');
    }
  } catch { /* Storage can be unavailable in private browser contexts. */ }
  try {
    if (session.getItem(marker) === 'true') return;
    const keys = Array.from({length: session.length}, (_, i) => session.key(i));
    for (const key of keys) {
      if (!key || !/^codex-webui-draft(?:-new)?:El:/.test(key)) continue;
      const destination = key.replace(':El:', ':zilpio:');
      if (session.getItem(destination) === null) session.setItem(destination, session.getItem(key));
    }
    session.setItem(marker, 'true');
  } catch { /* Draft restoration remains available when storage recovers. */ }
}
