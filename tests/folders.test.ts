import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFolders, resolveBrowsePath, createProjectFolder } from "../folder-service.js";

describe("folder browser", () => {
  test("lists only visible directories in stable order", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-webui-folders-"));
    mkdirSync(join(root, "zeta"));
    mkdirSync(join(root, "Alpha"));
    mkdirSync(join(root, ".secret"));
    writeFileSync(join(root, "file.txt"), "x");
    expect(listFolders(root).folders.map((item) => item.name)).toEqual(["Alpha", "zeta"]);
  });

  test("allows browsing only under configured roots", () => {
    const home = join(tmpdir(), "codex-webui-home");
    expect(resolveBrowsePath("~/projects", [home], home)).toBe(join(home, "projects"));
    expect(() => resolveBrowsePath("/etc", [home], home)).toThrow("outside allowed roots");
  });

  test("returns parent only when parent is still allowed", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-webui-parent-"));
    const child = join(root, "child"); mkdirSync(child);
    expect(listFolders(child, [root]).parent).toBe(root);
    expect(listFolders(root, [root]).parent).toBeNull();
  });

  test("rejects a symbolic link that escapes an allowed root", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-webui-symlink-root-"));
    const outside = mkdtempSync(join(tmpdir(), "codex-webui-symlink-outside-"));
    const link = join(root, "outside");
    symlinkSync(outside, link);
    expect(() => resolveBrowsePath(link, [root], root)).toThrow("outside allowed roots");
    expect(() => listFolders(link, [root])).toThrow("outside allowed roots");
  });
});

import { existsSync, rmSync } from 'node:fs';

describe('create a project folder',()=>{
 test('creates only a new child folder and preserves existing content on duplicate',()=>{
  const root=mkdtempSync(join(tmpdir(),'webui-new-project-'));
  try{const project=createProjectFolder(root,'  Mio progetto  ',[root]);expect(project).toEqual({name:'Mio progetto',path:join(root,'Mio progetto')});expect(existsSync(project.path)).toBe(true);
   writeFileSync(join(project.path,'keep.txt'),'keep');expect(()=>createProjectFolder(root,'Mio progetto',[root])).toThrow('esiste');expect(existsSync(join(project.path,'keep.txt'))).toBe(true);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 test('rejects invalid names and parents outside project storage',()=>{
  const root=mkdtempSync(join(tmpdir(),'webui-project-name-')),outside=mkdtempSync(join(tmpdir(),'webui-project-outside-'));
  try{for(const name of ['', '   ', '.', '..', '../escape', '/absolute', 'a/b', 'a\\b', '.hidden', 'bad\nname', 'x'.repeat(101)])expect(()=>createProjectFolder(root,name,[root])).toThrow();
   symlinkSync(outside,join(root,'outside'));expect(()=>createProjectFolder(join(root,'outside'),'escape',[root])).toThrow();expect(()=>createProjectFolder(outside,'escape',[root])).toThrow();expect(existsSync(join(outside,'escape'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
 });
});
