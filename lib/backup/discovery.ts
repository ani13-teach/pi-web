import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BackupResource, BackupRoot, Collection, ScanOptions, SourceEntry } from "./types.ts";
import { BACKUP_SDK_VERSION } from "./runtime.ts";
import { validateBackupUiState } from "../../shared/backup-preferences.ts";
import { relativePath, within } from "./platform.ts";

const MAX_TOTAL = 16 * 1024 ** 3, MAX_FILE = 8 * 1024 ** 3, MAX_ENTRIES = 100000;
const dirs = ["skills", "extensions", "prompts", "themes", "agents", "desktop-agents", "workflows", "agent-memory", "sessions"];
const files = ["settings.json", "models.json", "auth.json", "web-push.json", "subagents.json", "agent-tool-description.md", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md", "automode.json", "automode.local.json", "automode.settings.json"];
const excluded = /^(?:\.git|node_modules|\.cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.turbo|coverage|cache|caches|logs?|tmp|temp|backup-imports|\.backup-transactions|\.backup-restore-.+|\.pi-backup-.+)$/i;
const assetPath = (rel: string) => rel.split("/").some(part=>/^(assets|references|fixtures|examples)$/i.test(part));
const excludeEntry = (name: string, rel: string) => excluded.test(name) && (!assetPath(rel) || /^(?:\.git|node_modules|backup-imports|\.backup-transactions|\.backup-restore-.+|\.pi-backup-.+)$/i.test(name));
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const kindFor = (rel: string) => rel.includes("sessions") ? "session" : rel.includes("agent-memory") ? "memory" : /auth|credentials|web-push/.test(rel) ? "auth" : rel.endsWith("models.json") ? "models" : /settings|subagents|automode/.test(rel) ? "settings" : rel.includes("skill") ? "skills" : rel.includes("workflow") ? "workflows" : rel.includes("agent") ? "agents" : rel.includes("extension") ? "extensions" : rel.includes("theme") ? "themes" : rel.includes("prompt") ? "prompts" : "instructions";
function commands(value: unknown): boolean {
  if (typeof value === "string") return value.trimStart().startsWith("!");
  if (Array.isArray(value)) return value.some(commands);
  if (value && typeof value === "object") return Object.entries(value).some(([key, v]) => /^(command|mcpServers|permissions|automode|autoMode)$/.test(key) || commands(v));
  return false;
}
function securityContent(value: unknown): boolean {
  return !!value && typeof value === "object" && (Array.isArray(value) ? value.some(securityContent) : Object.entries(value).some(([key,v])=>/^(permissions|automode|autoMode)$/.test(key) || securityContent(v)));
}
async function config(p: string): Promise<Record<string, unknown>> {
  const s = await fs.lstat(p);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 16 * 1024 ** 2) throw new Error("Unsafe/oversized configuration");
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(p, "utf8")); } catch { throw new Error("Invalid resource configuration JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration");
  return value as Record<string, unknown>;
}
async function exists(p: string) { try { return await fs.lstat(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } }
/** Reads declarations and cached metadata only. Never imports an extension or resolves a package. */
export async function collectBackup(o: ScanOptions): Promise<Collection> {
  const home = path.resolve(o.homeDir ?? os.homedir()), agent = path.resolve(o.agentDir);
  const roots: BackupRoot[] = [], resources: BackupResource[] = [], entries: SourceEntry[] = [], warnings: string[] = [], blockers: string[] = [];
  const seen = new Set<string>(), realSeen = new Set<string>(); let total = 0;
  const authorized = [agent, path.join(home, ".agents"), path.join(home, ".pi", "agent-memory"), ...(o.projectDirs ?? []).map(p => path.resolve(p)), ...(o.externalRoots ?? []).map(p => path.resolve(p))];
  const rootMap = new Map<string, BackupRoot>();
  function addRoot(kind: BackupRoot["kind"], originalPath: string, label: string) {
    const identity = kind + ":" + originalPath + (kind === "external" ? ":" + label : "");
    const old = rootMap.get(identity); if (old) return old;
    const r: BackupRoot = { id: kind + "-" + digest(identity).slice(0, 16), kind, label, originalPath };
    rootMap.set(identity, r); roots.push(r); return r;
  }
  const agentRoot = addRoot("agent", agent, "Global Pi environment");
  const homeRoot = addRoot("home", home, "Shared user tools");
  const safeTarget = async (p: string) => {
    const actual = await fs.realpath(p);
    if (!authorized.some(r => within(r, actual))) throw new Error("External link target requires explicit authorization: " + p);
    return actual;
  };
  async function addFile(r: BackupRoot, res: BackupResource, p: string, rel: string) {
    o.signal?.throwIfAborted(); relativePath(rel);
    const key = r.id + "/" + rel.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new Error("Duplicate/case-colliding resource: " + rel);
    const h = await fs.open(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await h.stat(), named = await fs.lstat(p);
      if (!before.isFile() || named.isSymbolicLink() || before.dev !== named.dev || before.ino !== named.ino) throw new Error("Resource changed before scan");
      if (before.size > MAX_FILE || total + before.size > MAX_TOTAL || entries.length >= MAX_ENTRIES) throw new Error("Backup resource limit exceeded");
      const hash = createHash("sha256"); for await (const b of h.createReadStream({ autoClose: false })) { o.signal?.throwIfAborted(); hash.update(b); }
      const after = await h.stat(), finalName = await fs.lstat(p);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.dev !== finalName.dev || after.ino !== finalName.ino) throw new Error("Resource changed during scan");
      const e: SourceEntry = { path: r.id + "/" + rel, rootId: r.id, resourceId: res.id, relativePath: rel, size: before.size, sha256: hash.digest("hex"), kind: res.kind, source: p, dev: before.dev, ino: before.ino, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs };
      seen.add(key); entries.push(e); total += before.size;
      if (res.kind === "session" && before.size) {
        const prefix = Buffer.alloc(Math.min(before.size,65536)); await h.read(prefix,0,prefix.length,0);
        try { const header = JSON.parse(prefix.toString("utf8").split("\n")[0]); if (header.type === "session" && typeof header.cwd === "string" && path.isAbsolute(header.cwd)) { const root=addRoot("project",path.resolve(header.cwd),"Session workspace (paths only): " + header.cwd); res.requiredRootIds=[...new Set([...(res.requiredRootIds??[]),root.id])]; } else throw new Error("Invalid session header"); }
        catch { warnings.push("Session header could not provide a structured workspace mapping: " + rel); }
      }
      o.progress?.({ operationId: o.operationId ?? "", phase: "scan", completed: entries.length, total: 0 });
    } finally { await h.close(); }
  }
  async function walk(r: BackupRoot, res: BackupResource, p: string, rel: string, visiting = new Set<string>(), depth = 0) {
    o.signal?.throwIfAborted(); if (depth > 64) throw new Error("Resource nesting limit exceeded");
    const s = await exists(p); if (!s) return;
    const actual = s.isSymbolicLink() ? await safeTarget(p) : await fs.realpath(p);
    if (visiting.has(actual)) throw new Error("Resource link cycle: " + rel);
    const st = await fs.lstat(actual);
    if (st.isFile()) {
      if (res.kind === "session" && !rel.endsWith(".jsonl")) return;
      if (!assetPath(rel) && /\.(?:tmp|log|cache)$/i.test(path.basename(rel))) { warnings.push("Excluded transient file: " + rel); return; }
      await addFile(r, res, actual, rel); return;
    }
    if (!st.isDirectory()) throw new Error("Unsupported resource: " + rel);
    const next = new Set(visiting); next.add(actual);
    const names = (await fs.readdir(actual)).sort();
    if (new Set(names.map(n => n.normalize("NFC").toLowerCase())).size !== names.length) throw new Error("Case-colliding resource directory: " + rel);
    for (const name of names) {
      if (excludeEntry(name,rel + "/" + name)) { warnings.push("Excluded generated directory: " + rel + "/" + name); continue; }
      await walk(r, res, path.join(actual, name), rel ? rel + "/" + name : name, next, depth + 1);
    }
  }
  async function addResource(r: BackupRoot, rel: string, p: string, explicitKind?: string) {
    const originalState = await exists(p); if (!originalState) return;
    const canonical = await fs.realpath(p);
    if (originalState.isSymbolicLink() && !authorized.some(root => within(root, canonical))) {
      if ([home, agent, ...(o.projectDirs ?? []), path.parse(canonical).root, ...(o.applicationDir ? [path.resolve(o.applicationDir)] : [])].some(root => path.resolve(root) === canonical)) { blockers.push("Link points at an entire environment/project: " + rel); return; }
      authorized.push(canonical); warnings.push("Linked tool contents included; confirm target ownership: " + canonical);
    }
    if (realSeen.has(canonical)) return;
    realSeen.add(canonical);
    const kind = explicitKind ?? kindFor(rel), securityPolicy = /automode|auto-mode|trust\.json/.test(rel);
    const res: BackupResource = { id: "resource-" + digest(r.id + ":" + rel).slice(0, 20), rootId: r.id, relativePath: rel, label: rel || path.basename(p), kind, executable: r.kind === "external" || ["skills", "extensions", "agents", "workflows", "prompts", "instructions"].includes(kind), sensitive: ["auth", "settings", "models", "session", "memory"].includes(kind), securityPolicy, availability: "offlineReady" };
    if (/\.(?:json)$/.test(rel) && ["settings", "models", "auth"].includes(kind)) {
      try { const c = await config(p); if (securityContent(c)) res.securityPolicy=true; if (commands(c) || Array.isArray(c.extensions) && c.extensions.length > 0 || Array.isArray(c.packages) && c.packages.length > 0) res.executable = true; }
      catch (e) { blockers.push("Cannot inspect configuration " + rel + ": " + (e as Error).message); return; }
    }
    resources.push(res);
    try {
      await walk(r, res, p, rel);
      if (kind === "agents" && p.endsWith(".md") && (await fs.stat(p)).size < 256 * 1024) {
        const text = await fs.readFile(p,"utf8");
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
        const declared = /^session_dir:\s*["']?([^\r\n"']+)["']?\s*$/m.exec(frontmatter)?.[1]?.trim();
        if (declared) { const base = r.kind === "project" ? r.originalPath : agent; await external(path.resolve(base, declared.startsWith("~/") ? path.join(home,declared.slice(2)) : declared), "session"); }
      }
    } catch (e) { o.signal?.throwIfAborted(); blockers.push((e as Error).message); }
  }
  async function standard(r: BackupRoot, base: string, project = false) {
    for (const f of files) await addResource(r, project ? ".pi/" + f : f, path.join(base, project ? ".pi" : "", f));
    for (const d of dirs.filter(d => !project || !["desktop-agents", "sessions"].includes(d))) {
      const prefix = project ? ".pi/" : "";
      const folder = path.join(base, project ? ".pi" : "", d);
      // Independently selectable tool units and session workspace buckets.
      if (["skills", "extensions", "agents", "desktop-agents", "workflows", "prompts", "themes", "sessions"].includes(d)) {
        const st = await exists(folder); if (!st) continue;
        if (st.isSymbolicLink()) { await addResource(r, prefix + d, folder); continue; }
        for (const item of (await fs.readdir(folder)).sort()) if (!excluded.test(item)) await addResource(r, prefix + d + "/" + item, path.join(folder, item));
      } else await addResource(r, prefix + d, folder);
    }
    if (project) {
      for (const f of ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "skills-lock.json"]) await addResource(r, f, path.join(base, f));
      await addResource(r, ".pi/agent-memory-local", path.join(base, ".pi", "agent-memory-local"));
      for (const d of ["skills", "agents", "workflows"]) {
        const folder = path.join(base, ".agents", d), st = await exists(folder); if (!st) continue;
        for (const name of (await fs.readdir(folder)).sort()) await addResource(r, ".agents/" + d + "/" + name, path.join(folder, name), d);
      }
    }
    await declarations(r, path.join(base, project ? ".pi" : "", "settings.json"), path.join(base, project ? ".pi" : ""));
  }
  async function external(p: string, kind: string) {
    const s = await exists(p); if (!s) { if (kind === "session") warnings.push("No saved sessions at declared root: " + p); else blockers.push("Declared resource unavailable: " + p); return; }
    const actual = await fs.realpath(p);
    if (o.applicationDir && [path.resolve(o.applicationDir),path.resolve(o.applicationDir.replace("app.asar","app.asar.unpacked"))].some(root=>within(root,actual))) { warnings.push("Program-provided resource is not archived: " + path.basename(actual)); return; }
    if (kind === "extensions" && s.isFile()) {
      const normalized=actual.split(path.sep).join("/"), marker="/node_modules/", index=normalized.lastIndexOf(marker);
      if (index>=0) {
        const rest=normalized.slice(index+marker.length).split("/"), count=rest[0]?.startsWith("@")?2:1;
        const packageRoot=path.resolve(normalized.slice(0,index+marker.length)+rest.slice(0,count).join("/"));
        if (await exists(path.join(packageRoot,"package.json"))) { await external(packageRoot,kind); return; }
      }
    }
    if ([...realSeen].some(existing => existing === actual || within(existing, actual))) return;
    // A configured path is not authorization to archive a project/HOME/disk root.
    if ([home, agent, ...(o.projectDirs ?? []), path.parse(actual).root].some(r => path.resolve(r) === actual) && s.isDirectory()) { blockers.push("Tool boundary cannot be an entire environment/project: " + actual); return; }
    // The scan identifies an exact declared/loaded tool boundary. Export requires
    // confirmation of this visible root; restore still needs a new native mapping.
    if (!authorized.some(r => within(r, actual))) { authorized.push(actual); warnings.push("External resource contents included: " + actual); }
    if (realSeen.has(actual)) return;
    const r = addRoot("external", path.dirname(actual), "External " + kind + ": " + path.basename(actual));
    await addResource(r, path.basename(actual), actual, kind);
    if (kind === "extensions" && s.isDirectory() && await exists(path.join(actual,"package.json"))) {
      const pkg=await config(path.join(actual,"package.json")), resource=resources.find(resource=>resource.rootId===r.id);
      if (resource) {
        if (typeof pkg.version === "string") resource.version=pkg.version;
        if (typeof pkg.name === "string" && /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(pkg.name) && resource.version) resource.source="npm:"+pkg.name+"@"+resource.version;
        const deps=Object.keys({...pkg.dependencies as object,...pkg.peerDependencies as object,...pkg.optionalDependencies as object}).filter(name=>!/^@earendil-works\/pi-/.test(name));
        if (deps.length) { resource.availability="requiresReinstall";warnings.push("Runtime dependencies excluded; source and local modifications are preserved: " + resource.label); }
      }
    }
  }
  async function declarations(r: BackupRoot, settingsPath: string, base: string) {
    if (!(await exists(settingsPath))) return;
    let c: Record<string, unknown>; try { c = await config(settingsPath); } catch { return; }
    for (const kind of ["skills", "extensions", "prompts", "themes"]) {
      const values = c[kind]; if (!Array.isArray(values)) continue;
      for (const raw of values) {
        if (typeof raw !== "string") { blockers.push("Unsupported resource declaration in " + settingsPath); continue; }
        const value = raw.replace(/^[!+-]/, "");
        if (/[*?\[\]{}]/.test(value)) { blockers.push("Pattern resource requires an explicitly resolved snapshot: " + kind + " in " + settingsPath); continue; }
        if (/^(?:https?:|npm:|git:)/.test(value)) { warnings.push("Declared remote resource requires explicit installation; no network command is executed."); continue; }
        const p = path.resolve(base, value.startsWith("~/") || value.startsWith("~\\") ? path.join(home, value.slice(2)) : value);
        await external(p, kind);
      }
    }
    if (Array.isArray(c.packages)) for (const entry of c.packages) {
      const source = typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as { source?: unknown }).source : undefined;
      if (typeof source !== "string") { blockers.push("Unsupported package declaration"); continue; }
      if (!/^(?:npm:|git:|https?:|github:|git@)/.test(source)) { await external(path.resolve(base, source), "extensions"); continue; }
      const parsedNpm = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.+))?$/.exec(source);
      const npmMatch=parsedNpm && /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(parsedNpm[1]) ? parsedNpm : null;
      const sourceLabel = npmMatch ? "Npm package: " + npmMatch[1] : "Remote package " + digest(source).slice(0,12);
      let installed = npmMatch ? path.join(base, "npm", "node_modules", npmMatch[1]) : undefined;
      if (!installed && !source.startsWith("npm:")) {
        let gitUrl=source.replace(/^git:/,"");
        if (gitUrl.startsWith("github:")) gitUrl="https://github.com/"+gitUrl.slice(7);
        if (/^git@[^:]+:/.test(gitUrl)) gitUrl=gitUrl.replace(/^git@([^:]+):/,"https://$1/");
        if (!gitUrl.includes("://")) gitUrl="https://"+gitUrl;
        try { const u=new URL(gitUrl); const rel=u.pathname.replace(/^\/+|\/+$/g,"").replace(/\.git$/,""); relativePath(rel); installed=path.join(base,"git",u.hostname,rel); } catch { /* unknown source is metadata-only */ }
      }
      let captured: BackupResource | undefined;
      if (installed && await exists(installed)) {
        await external(installed,"extensions");
        captured = resources.find(r => roots.find(root => root.id === r.rootId)?.originalPath === path.dirname(installed!) && r.relativePath === path.basename(installed!));
        if (captured) {
          captured.source=source;
          const pkgPath=path.join(installed,"package.json"), pkg=await exists(pkgPath)?await config(pkgPath):{};
          captured.version=typeof pkg.version === "string" ? pkg.version : undefined;
          if (!npmMatch) {
            try { let head=(await fs.readFile(path.join(installed,".git","HEAD"),"utf8")).trim(); if (head.startsWith("ref: ")) { const rel=head.slice(5);relativePath(rel);head=(await fs.readFile(path.join(installed,".git",rel),"utf8")).trim(); } if (/^[a-f0-9]{40,64}$/.test(head)) captured.version="git:"+head; } catch { warnings.push("Git commit metadata unavailable: " + sourceLabel); }
          }
          const deps=Object.keys({...pkg.dependencies as object,...pkg.peerDependencies as object,...pkg.optionalDependencies as object}).filter(name=>!/^@earendil-works\/pi-/.test(name));
          captured.availability=deps.length || npmMatch && !(await exists(pkgPath)) ? "requiresReinstall":"offlineReady";
        }
      }
      const res: BackupResource = { id: "package-" + digest(r.id + ":" + source).slice(0, 20), rootId: r.id, relativePath: "packages/" + digest(source).slice(0, 16), label: sourceLabel, kind: "package", executable: true, sensitive: false, availability: captured?.availability ?? "requiresReinstall", source, ...(captured?.version ? {version:captured.version}:{}) };
      // Metadata-only resources never map to a program installation folder.
      const root = addRoot("external", "", "Package dependency: " + sourceLabel + " (" + r.id + ")"); res.rootId = root.id; res.relativePath = "package-" + digest(source).slice(0, 16); resources.push(res);
      warnings.push(captured?.availability === "offlineReady" ? "Managed package source included; confirm mapping and activation: " + sourceLabel : "Package dependency requires review/reinstallation; managed source content is included when found: " + sourceLabel + ". No install command runs during backup or restore.");
    }
    const sessionDir = c.sessionDir;
    if (typeof sessionDir === "string" && sessionDir) await external(path.resolve(base, sessionDir), "session");
  }
  const st = await exists(agent); if (!st?.isDirectory() || st.isSymbolicLink()) throw new Error("Invalid agent directory");
  await standard(agentRoot, agent);
  for (const d of ["skills", "agents", "workflows"]) {
    const folder = path.join(home, ".agents", d); if (!(await exists(folder))) continue;
    for (const name of (await fs.readdir(folder)).sort()) await addResource(homeRoot, ".agents/" + d + "/" + name, path.join(folder, name), d);
  }
  for (const file of ["AGENTS.md","AGENTS.override.md","CLAUDE.md"]) await addResource(homeRoot,file,path.join(home,file),"instructions");
  await addResource(homeRoot, ".agents/.skill-lock.json", path.join(home, ".agents", ".skill-lock.json"), "settings");
  await addResource(homeRoot, ".pi/agent-memory", path.join(home, ".pi", "agent-memory"), "memory");
  for (const project of o.projectDirs ?? []) {
    const p = path.resolve(project); const s = await exists(p); if (!s?.isDirectory() || s.isSymbolicLink()) throw new Error("Invalid selected project");
    await standard(addRoot("project", p, path.basename(p)), p, true);
    let boundary: string | undefined;
    for (let probe=p,depth=0;depth<32;depth++,probe=path.dirname(probe)) {
      if (await exists(path.join(probe,".git"))) { boundary=probe; break; }
      if (probe === path.dirname(probe) || probe === home) break;
    }
    // Never discover ancestor tools all the way to HOME/disk when no Git
    // ownership boundary exists. The owning project can be selected explicitly.
    if (!boundary) warnings.push("No Git boundary: only explicitly selected project tools are included; select an ancestor project if it owns additional tools.");
    if (boundary && boundary !== p) for (let current=path.dirname(p),depth=0; within(boundary,current) && depth<32;depth++,current=path.dirname(current)) {
      for (const name of ["AGENTS.override.md","AGENTS.md","CLAUDE.md"]) if (await exists(path.join(current,name))) await external(path.join(current,name),"instructions");
      const skills = path.join(current,".agents","skills");
      if (await exists(skills)) for (const name of (await fs.readdir(skills)).sort()) await external(path.join(skills,name),"skills");
      if (current === boundary) break;
    }
  }
  for (const resource of o.resourceSnapshot ?? []) await external(resource.kind === "skills" && resource.baseDir ? resource.baseDir : resource.path, resource.kind);
  for (const dir of o.sessionDirs ?? []) if (!within(path.join(agent, "sessions"), dir)) await external(dir, "session");
  warnings.push(...(o.resourceWarnings ?? []));
  if (home === path.resolve(os.homedir()) && process.env.PI_CODING_AGENT_SESSION_DIR) await external(path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR), "session");
  if (home === path.resolve(os.homedir()) && process.env.XDG_STATE_HOME) {
    const lock=path.join(process.env.XDG_STATE_HOME,"skills",".skill-lock.json"); if(await exists(lock)) await external(lock,"settings");
  }
  const uiState = o.uiState ? validateBackupUiState(o.uiState) : undefined;
  const manifest = { formatVersion: 2 as const, archiveId: randomUUID(), appVersion: o.appVersion ?? "unknown", sdkVersion: o.sdkVersion ?? BACKUP_SDK_VERSION, createdAt: new Date().toISOString(), roots, resources, entries: entries.map(({ source: _s, data: _d, dev: _dev, ino: _ino, mtimeMs: _m, ctimeMs: _c, ...e }) => e), warnings, ...(uiState ? { uiState } : {}) };
  const kinds: Record<string, number> = {}; for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  const fingerprint = digest(JSON.stringify({ roots, resources, entries: manifest.entries, uiState, warnings, blockers }));
  return { manifest, entries, preview: { entries: entries.length, bytes: total, kinds, roots, resources:resources.map(({source:_source,...resource})=>resource), warnings, blockers, fingerprint } };
}
export async function scanBackup(o: ScanOptions) { return (await collectBackup(o)).preview; }
