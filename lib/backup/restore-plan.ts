import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BACKUP_UI_RESOURCE_ID, validateBackupUiState } from "../../shared/backup-preferences.ts";
import { BACKUP_SDK_VERSION } from "./runtime.ts";
import { validateManifest } from "./archive.ts";
import type { BackupManifest, BackupRestorePreview, BackupRoot } from "./types.ts";
import { abort, checkParents, digest, fileState, maybeStat, permissions, relativePath, within, type FileState, type Identity } from "./platform.ts";

export type PlanOptions = { manifest: BackupManifest; agentDir: string; homeDir?: string; mappings?: Record<string, string>; currentUiState?: Record<string,string>; signal?: AbortSignal };
export type PlannedEntry = { index: number; target: string; root: string; state: FileState | null; parents: { path: string; identity: Identity }[] };
export type InternalPlan = { preview: BackupRestorePreview; entries: PlannedEntry[]; roots: Record<string, string>; resourceExists: Record<string, boolean> };
const agentNames = new Set(["settings.json", "models.json", "auth.json", "web-push.json", "provider-credentials.json", "skills-lock.json", "subagents.json", "agent-tool-description.md", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md", "skills", "extensions", "prompts", "themes", "agents", "desktop-agents", "workflows", "agent-memory", "sessions", "auto-mode", "automode", "automode.json", "automode.local.json", "automode.settings.json"]);
const projectDirs = [".pi/skills", ".pi/extensions", ".pi/prompts", ".pi/themes", ".pi/agents", ".pi/workflows", ".pi/agent-memory", ".pi/agent-memory-local", ".agents/skills", ".agents/agents", ".agents/workflows"];
const projectFiles = new Set([".pi/settings.json", ".pi/models.json", ".pi/auth.json", ".pi/web-push.json", ".pi/agent-tool-description.md", ".pi/subagents.json", ".pi/automode.local.json", ".pi/automode.json", ".pi/automode.settings.json", ".pi/AGENTS.md", ".pi/AGENTS.override.md", ".pi/CLAUDE.md", ".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md", "skills-lock.json", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md"]);
const homeDirs = [".agents/skills", ".agents/agents", ".agents/workflows", ".pi/agent-memory"];
function under(rel: string, dir: string) { return rel === dir || rel.startsWith(`${dir}/`); }
export function allowedRelative(root: BackupRoot, rel: string) {
  relativePath(rel);
  if (root.kind === "agent") return agentNames.has(rel.split("/")[0]);
  if (root.kind === "home") return ["AGENTS.md","AGENTS.override.md","CLAUDE.md",".agents/.skill-lock.json"].includes(rel) || homeDirs.some((dir) => under(rel, dir));
  if (root.kind === "project") return projectFiles.has(rel) || projectDirs.some((dir) => under(rel, dir));
  return root.kind === "external";
}
export function validateRestoreManifest(manifest: BackupManifest) {
  validateManifest(manifest);
  if (manifest.formatVersion !== 2 || !Array.isArray(manifest.roots) || !Array.isArray(manifest.resources) || !Array.isArray(manifest.entries) || manifest.entries.length > 100000) throw new Error("Invalid restore manifest");
  const roots = new Map<string, BackupRoot>(); const resources = new Map<string, typeof manifest.resources[number]>();
  for (const root of manifest.roots) {
    if (!root.id || roots.has(root.id) || !["agent", "home", "project", "external", "ui"].includes(root.kind)) throw new Error("Invalid/duplicate restore root");
    roots.set(root.id, root);
  }
  for (const res of manifest.resources) {
    const root = roots.get(res.rootId);
    if (!root || !res.id || resources.has(res.id)) throw new Error("Invalid/duplicate restore resource");
    relativePath(res.relativePath, root.kind === "external" || root.kind === "ui");
    if (root.kind !== "ui" && res.relativePath && !allowedRelative(root, res.relativePath)) throw new Error("Resource outside allowed boundary");
    resources.set(res.id, res);
  }
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    const root = roots.get(entry.rootId), resource = resources.get(entry.resourceId);
    if (!root || root.kind === "ui" || !resource || resource.rootId !== root.id || !allowedRelative(root, entry.relativePath) || (resource.relativePath && !under(entry.relativePath, resource.relativePath))) throw new Error("Entry outside resource/root boundary");
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid entry digest/size");
    const key = `${entry.rootId}/${entry.relativePath}`.toLowerCase();
    if (seen.has(key)) throw new Error("Duplicate/case-colliding entry");
    seen.add(key);
  }
  const boundaries = [...manifest.resources].sort((a,b)=>(a.rootId+"/"+a.relativePath).localeCompare(b.rootId+"/"+b.relativePath));
  for (let i=1;i<boundaries.length;i++) {
    const a=boundaries[i-1], b=boundaries[i];
    if (a.rootId===b.rootId && under(b.relativePath.toLowerCase(),a.relativePath.toLowerCase())) throw new Error("Overlapping restore resource boundaries");
  }
  if (manifest.uiState && Object.entries(manifest.uiState).some(([k, v]) => !k || ["__proto__", "constructor", "prototype"].includes(k) || typeof v !== "string")) throw new Error("Invalid UI state");
}
export async function assertNoCaseCollision(root: string, rel: string) {
  let current = root;
  for (const part of relativePath(rel).split("/")) {
    const s = await maybeStat(current); if (!s) return;
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Non-directory/link target parent");
    const names = await fs.readdir(current);
    if (names.some((name) => name.toLowerCase() === part.toLowerCase() && name !== part)) throw new Error("Target case collision");
    current = path.join(current, part);
  }
}
/** Includes resource extras, file identity, content and permissions; directory mtime is
 * deliberately excluded because creating an unrelated coordination directory changes it. */
async function snapshot(p: string, root: string, signal?: AbortSignal, count = { n: 0 }): Promise<unknown[]> {
  abort(signal);
  if (++count.n > 100000) throw new Error("Restore resource too large");
  const s = await maybeStat(p); if (!s) return [];
  if (s.isSymbolicLink()) throw new Error("Link/reparse target refused");
  if (s.isFile()) return [{ path: path.relative(root, p).split(path.sep).join("/"), type: "file", state: await fileState(p) }];
  if (!s.isDirectory()) throw new Error("Unsupported target resource type");
  await checkParents(p);
  const result: unknown[] = [{ path: path.relative(root, p).split(path.sep).join("/"), type: "directory", dev: s.dev, ino: s.ino, permissions: await permissions(p) }];
  const names = (await fs.readdir(p)).filter((name) => !/^\.pi-backup-|^\.backup-transactions$/i.test(name)).sort();
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new Error("Target case collision");
  for (const name of names) result.push(...await snapshot(path.join(p, name), root, signal, count));
  return result;
}
export async function buildRestorePlan(options: PlanOptions): Promise<InternalPlan> {
  const { manifest, signal } = options;
  abort(signal); validateRestoreManifest(manifest);
  if (manifest.sdkVersion !== "historical" && manifest.sdkVersion !== BACKUP_SDK_VERSION) throw new Error("Backup SDK version is incompatible with this app; use a matching app version before restore");
  const descriptors = new Map(manifest.roots.map(root=>[root.id,root]));
  const roots: Record<string, string> = Object.create(null), entries: PlannedEntry[] = [], resourceExists: Record<string, boolean> = Object.create(null);
  const bindings: unknown[] = []; const rootErrors = new Map<string, string>();
  for (const descriptor of manifest.roots) {
    if (descriptor.kind === "ui") continue;
    const selected = Object.hasOwn(options.mappings ?? {}, descriptor.id) ? options.mappings![descriptor.id] : descriptor.kind === "agent" ? options.agentDir : descriptor.kind === "home" ? (options.homeDir ?? os.homedir()) : undefined;
    if (!selected) { bindings.push({ id: descriptor.id, unmapped: true }); continue; }
    if (!path.isAbsolute(selected)) throw new Error("Mapping must be an authorized absolute directory");
    const root = path.resolve(selected); roots[descriptor.id] = root;
    try {
      const parents = await checkParents(root, true);
      if (!parents.length) throw new Error("Unavailable target root");
      bindings.push({ id: descriptor.id, root, parents, exists: Boolean(await maybeStat(root)) });
    } catch (e) { rootErrors.set(descriptor.id, (e as Error).message); bindings.push({ id: descriptor.id, root, blocked: true }); }
  }
  // Independent logical roots/resources must never alias each other's effective files.
  const effective = manifest.resources.filter(res=>roots[res.rootId]).map(res=>path.resolve(roots[res.rootId],res.relativePath).normalize("NFC").toLowerCase());
  const effectiveSet=new Set(effective);
  if(effectiveSet.size!==effective.length)throw new Error("Overlapping effective restore resources");
  for(const target of effective)for(let parent=path.dirname(target);parent!==path.dirname(parent);parent=path.dirname(parent))if(effectiveSet.has(parent))throw new Error("Overlapping effective restore resources");
  const byResource = new Map<string,{entry: BackupManifest["entries"][number];index:number}[]>();
  manifest.entries.forEach((entry,index)=>{const list=byResource.get(entry.resourceId)??[];list.push({entry,index});byResource.set(entry.resourceId,list);});
  const previews: BackupRestorePreview["resources"] = [];
  for (const resource of manifest.resources) {
    abort(signal);
    const descriptor = descriptors.get(resource.rootId)!;
    const root = roots[resource.rootId], items = byResource.get(resource.id) ?? [];
    const dependenciesMapped=(resource.requiredRootIds??[]).every(id=>Boolean(roots[id])&&!rootErrors.has(id));
    const mapped = (descriptor.kind === "ui" || resource.kind === "package" || Boolean(root)) && dependenciesMapped, warnings: string[] = [];
    let blocked = false, existing = 0, extraFiles: string[] = [];
    if (!dependenciesMapped) warnings.push("Session workspace mapping required before this resource can be restored.");
    if (!mapped) warnings.push("Unmapped root: select a destination; original absolute paths are never restored automatically.");
    if (resource.availability !== "offlineReady") warnings.push(`Resource ${resource.availability}; no installation is performed.`);
    if (root) {
      try {
        if (rootErrors.has(resource.rootId)) throw new Error(rootErrors.get(resource.rootId));
        if (resource.relativePath) await assertNoCaseCollision(root, resource.relativePath);
        const target = path.resolve(root, resource.relativePath);
        if (!within(root, target)) throw new Error("Resource escapes authorized root");
        const states = await snapshot(target, root, signal) as { path: string; type: string }[];
        resourceExists[resource.id] = states.length > 0;
        const archived = new Set(items.map(({ entry }) => entry.relativePath));
        extraFiles = states.filter((s) => s.type === "file" && !archived.has(s.path)).map((s) => s.path);
        bindings.push({ resource: resource.id, states });
        for (const { entry, index } of items) {
          await assertNoCaseCollision(root, entry.relativePath);
          const destination = path.resolve(root, entry.relativePath);
          if (!within(root, destination)) throw new Error("Entry escapes authorized root");
          const parents = await checkParents(path.dirname(destination), true);
          const state = await fileState(destination);
          if (state) existing++;
          entries.push({ index, target: destination, root, state, parents });
          bindings.push({ index, destination, state, parents });
        }
        if (extraFiles.length && (resource.executable || resource.securityPolicy)) {
          blocked = true; warnings.push("Target-only files may mix executable/policy versions; keep this resource or select a new empty directory.");
        }
      } catch (e) { blocked = true; warnings.push((e as Error).message); bindings.push({ resource: resource.id, blocked: true }); }
    }
    previews.push({ ...resource, source:undefined, entries: items.length, existing, extraFiles, mapped, blocked, warnings });
  }
  const currentUiState=options.currentUiState ? validateBackupUiState(options.currentUiState) : {};
  if (manifest.uiState && Object.keys(manifest.uiState).length) {
    const keys=Object.keys(manifest.uiState);
    const existing=keys.filter(key=>currentUiState[key]!==undefined).length;
    resourceExists[BACKUP_UI_RESOURCE_ID]=existing>0;
    previews.push({id:BACKUP_UI_RESOURCE_ID,rootId:BACKUP_UI_RESOURCE_ID,relativePath:"preferences",label:"Application preferences",kind:"ui",executable:false,sensitive:false,securityPolicy:manifest.uiState["pi-tool-preset"]!==undefined,availability:"offlineReady",entries:keys.length,existing,extraFiles:[],mapped:true,blocked:false,warnings:[]});
    bindings.push({ui:currentUiState});
  }
  const fingerprint = digest(JSON.stringify({ manifest, roots, bindings }));
  return { preview: { resources: previews, roots: [...manifest.roots.map((r) => ({ ...r, ...(roots[r.id] ? { originalPath: roots[r.id] } : {}) })), ...(previews.some(resource=>resource.id===BACKUP_UI_RESOURCE_ID) ? [{id:BACKUP_UI_RESOURCE_ID,kind:"ui" as const,label:"Application preferences",originalPath:""}]:[])],warnings: [...manifest.warnings], fingerprint }, entries, roots, resourceExists };
}
export async function planRestore(options: PlanOptions): Promise<BackupRestorePreview> { return (await buildRestorePlan(options)).preview; }
