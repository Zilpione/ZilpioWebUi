import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export function resolveBrowsePath(input = "~", allowedRoots = [homedir()], home = homedir()) {
  const expanded = input === "~" ? home : input.startsWith("~/") ? resolve(home, input.slice(2)) : resolve(input);
  const roots = allowedRoots.map((root) => resolve(root));
  if (!roots.some((root) => inside(expanded, root))) throw new Error("outside allowed roots");
  try {
    const canonical = realpathSync(expanded);
    const canonicalRoots = roots.map((root) => realpathSync(root));
    if (!canonicalRoots.some((root) => inside(canonical, root))) throw new Error("outside allowed roots");
  } catch (error) {
    if (error instanceof Error && error.message === "outside allowed roots") throw error;
    // Non-existent paths are handled by the caller's directory check.
  }
  return expanded;
}

export function listFolders(input, allowedRoots = [resolve(input)]) {
  const path = resolveBrowsePath(input, allowedRoots);
  const roots = allowedRoots.map((root) => resolve(root));
  const folders = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: resolve(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const candidate = resolve(path, "..");
  const parent = candidate !== path && roots.some((root) => inside(candidate, root)) ? candidate : null;
  return { path, parent, folders };
}

export function defaultBrowseRoots(home = homedir()) {
  return [resolve(home)];
}

export function createProjectFolder(parent, name, allowedRoots) {
  if (typeof parent !== 'string' || typeof name !== 'string') throw new Error('Cartella o nome progetto non valido');
  const cleaned = name.trim();
  if (!cleaned || cleaned.length > 100 || cleaned.startsWith('.') || /[/\\\x00-\x1f\x7f]/.test(cleaned)) {
    throw new Error('Usa un nome di massimo 100 caratteri, senza punti iniziali o separatori di cartella');
  }
  const directory = realpathSync(resolveBrowsePath(parent, allowedRoots));
  if (!isDirectory(directory)) throw new Error('La cartella di destinazione non esiste');
  const path = resolve(directory, cleaned);
  try { mkdirSync(path); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('Un progetto con questo nome esiste già'), { status: 409 });
    throw new Error('Impossibile creare il progetto nella cartella selezionata');
  }
  return { name: cleaned, path };
}

export function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
