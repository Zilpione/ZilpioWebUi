// Preserve the selected project and unsent drafts when legacy is retired. Each
// storage area migrates once, so clearing a Workspace draft cannot resurrect it.
export function migrateWorkspaceStorage(config, persistent, session) {
  if (config.environmentId !== 'workspace' || config.environments?.length !== 1) return;
  const marker = 'codex-webui-workspace-storage-migrated';
  try {
    if (persistent.getItem(marker) !== 'true') {
      const project = persistent.getItem('codex-webui-project:legacy');
      if (project !== null && persistent.getItem('codex-webui-project:workspace') === null) persistent.setItem('codex-webui-project:workspace', project);
      persistent.setItem(marker, 'true');
    }
  } catch { /* Storage can be unavailable in private browser contexts. */ }
  try {
    if (session.getItem(marker) === 'true') return;
    const keys = Array.from({length: session.length}, (_, i) => session.key(i));
    for (const key of keys) {
      if (!key || !/^codex-webui-draft(?:-new)?:legacy:/.test(key)) continue;
      const destination = key.replace(':legacy:', ':workspace:');
      if (session.getItem(destination) === null) session.setItem(destination, session.getItem(key));
    }
    session.setItem(marker, 'true');
  } catch { /* Draft restoration remains available when storage recovers. */ }
}
