import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BackupResource, BackupRoot, Collection, ScanOptions, SourceEntry } from "./types.ts";
import { BACKUP_SDK_VERSION } from "./runtime.ts";
import { validateBackupUiState } from "../../shared/backup-preferences.ts";
import { relativePath, within } from "./platform.ts";
import { executableConfig, securityConfig, requiresExecutable } from "./resource-safety.ts";

const MAX_TOTAL = 16 * 1024 ** 3, MAX_FILE = 8 * 1024 ** 3, MAX_ENTRIES = 100000;
// New exports contain tool dependencies and settings, never conversation history.
const dirs = ["skills", "extensions", "prompts", "themes", "agents", "desktop-agents", "workflows"];
const projectInstructionFiles = new Set(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md", "agent-tool-description.md"]);
const files = ["settings.json", "models.json", "auth.json", "web-push.json", "subagents.json", "agent-tool-description.md", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md", "automode.json", "automode.local.json", "automode.settings.json"];
const excluded = /^(?:\.git|node_modules|\.cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.turbo|coverage|cache|caches|logs?|tmp|temp|backup-imports|\.backup-transactions|\.backup-restore-.+|\.pi-backup-.+)$/i;
const assetPath = (rel: string) => rel.split("/").some(part=>/^(assets|references|fixtures|examples)$/i.test(part));
const historyDirectory = /^(?:sessions?|session-history|chat-history|agent-memory(?:-local)?)$/i;
const excludeEntry = (name: string, rel: string) => historyDirectory.test(name) || excluded.test(name) && (!assetPath(rel) || /^(?:\.git|node_modules|backup-imports|\.backup-transactions|\.backup-restore-.+|\.pi-backup-.+)$/i.test(name));
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const kindFor = (rel: string) => {
  const name = path.posix.basename(rel);
  if (/^(?:auth|web-push)\.json$/.test(name)) return "auth";
  if (name === "models.json") return "models";
  if (/^(?:settings|subagents|automode(?:\.(?:local|settings))?)\.json$/.test(name)) return "settings";
  const parts = rel.split("/");
  if (parts.includes("skills")) return "skills";
  if (parts.includes("extensions")) return "extensions";
  if (parts.includes("workflows")) return "workflows";
  if (parts.includes("agents") || parts.includes("desktop-agents")) return "agents";
  if (parts.includes("themes")) return "themes";
  if (parts.includes("prompts")) return "prompts";
  return "instructions";
};
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
  const authorized = [agent, path.join(home, ".agents"), ...(o.projectDirs ?? []).map(p => path.resolve(p)), ...(o.externalRoots ?? []).map(p => path.resolve(p))];
  // Exclude known history roots even when a tool declaration or link points into them.
  const historyRoots = new Set<string>();
  async function excludeHistory(p: string) {
    historyRoots.add(path.resolve(p));
    const real = await fs.realpath(p).catch(() => null);
    if (real) historyRoots.add(real);
  }
  for (const p of [path.join(agent, "sessions"), path.join(agent, "agent-memory"),
    path.join(home, ".pi", "agent-memory"), ...(o.sessionDirs ?? []),
    ...(o.projectDirs ?? []).flatMap(p => ["sessions", "agent-memory", "agent-memory-local"].map(d => path.join(p, ".pi", d)))])
    await excludeHistory(p);
  if (home === path.resolve(os.homedir()) && process.env.PI_CODING_AGENT_SESSION_DIR)
    await excludeHistory(process.env.PI_CODING_AGENT_SESSION_DIR);
  for (const base of [agent, ...(o.projectDirs ?? []).map(p => path.join(p, ".pi"))]) {
    try {
      const c = await config(path.join(base, "settings.json"));
      if (typeof c.sessionDir === "string" && c.sessionDir) {
        const value = c.sessionDir;
        await excludeHistory(value.startsWith("~/") || value.startsWith("~\\") ? path.join(home, value.slice(2)) : path.resolve(base, value));
      }
    } catch { /* Standard configuration inspection reports invalid settings later. */ }
  }
  // Discover agent-specific history roots before traversing any tool tree.
  const inspectedAgents = new Set<string>();
  async function inspectAgentSessions(p: string, base: string, depth = 0): Promise<void> {
    if (depth > 64) return;
    const s = await exists(p); if (!s) return;
    const real = await fs.realpath(p);
    if (inspectedAgents.has(real)) return;
    inspectedAgents.add(real);
    const stat = await fs.stat(real);
    if (stat.isDirectory()) {
      if ([home, agent, ...(o.projectDirs ?? []), ...(o.applicationDir ? [o.applicationDir] : [])].some(root => path.resolve(root) === real) || real === path.parse(real).root) return;
      for (const name of await fs.readdir(real))
        if (!excludeEntry(name, name)) await inspectAgentSessions(path.join(real, name), base, depth + 1);
    } else if (stat.isFile() && real.endsWith(".md") && stat.size < 256 * 1024) {
      const content = await fs.readFile(real, "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
      const declared = /^session_dir:\s*["']?([^\r\n"']+)["']?\s*$/m.exec(frontmatter)?.[1]?.trim();
      if (declared) await excludeHistory(declared.startsWith("~/") || declared.startsWith("~\\") ?
        path.join(home, declared.slice(2)) : path.resolve(base, declared));
    }
  }
  for (const p of [path.join(agent, "agents"), path.join(agent, "desktop-agents"), path.join(home, ".agents", "agents")])
    await inspectAgentSessions(p, agent);
  for (const p of o.projectDirs ?? [])
    for (const folder of [".pi/agents", ".agents/agents"]) await inspectAgentSessions(path.join(p, folder), p);
  for (const r of o.resourceSnapshot ?? []) if (r.kind === "agents") await inspectAgentSessions(r.path, agent);
  const isHistory = (p: string) => [...historyRoots].some(root => within(root, p));
  const wholeRoots = [home, agent, ...(o.projectDirs ?? []), ...(o.applicationDir ? [o.applicationDir] : [])];
  const canonicalWholeRoots = new Set<string>();
  for (const p of wholeRoots) {
    canonicalWholeRoots.add(path.resolve(p));
    const real = await fs.realpath(p).catch(() => null); if (real) canonicalWholeRoots.add(real);
  }
  const isWholeRoot = (p: string) => canonicalWholeRoots.has(p) || p === path.parse(p).root;
  // Direct declarations/links can target a child of a history folder, not only its root.
  const isHistoryName = (p: string) => p.split(/[\\/]/).some(part => historyDirectory.test(part));
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
    if (isHistory(actual)) return actual;
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
    if (isHistory(actual) || isHistoryName(actual)) return;
    if (isWholeRoot(actual)) throw new Error("Tool boundary cannot be an entire environment/project");
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
    if (isHistory(canonical) || isHistoryName(canonical) || historyDirectory.test(path.basename(rel))) return;
    if (isWholeRoot(canonical)) { blockers.push("Tool boundary cannot be an entire environment/project: " + rel); return; }
    if (originalState.isSymbolicLink() && !authorized.some(root => within(root, canonical))) {
      if ([home, agent, ...(o.projectDirs ?? []), path.parse(canonical).root, ...(o.applicationDir ? [path.resolve(o.applicationDir)] : [])].some(root => path.resolve(root) === canonical)) { blockers.push("Link points at an entire environment/project: " + rel); return; }
      authorized.push(canonical); warnings.push("Linked tool contents included; confirm target ownership: " + canonical);
    }
    if (realSeen.has(canonical)) return;
    realSeen.add(canonical);
    const canonicalState = await fs.stat(canonical);
    const fileKind = canonicalState.isFile() ? kindFor(rel) : undefined;
    const kind = fileKind && ["settings", "models", "auth"].includes(fileKind) ? fileKind : explicitKind ?? kindFor(rel), securityPolicy = /automode|auto-mode|trust\.json/.test(rel);
    const res: BackupResource = { id: "resource-" + digest(r.id + ":" + rel).slice(0, 20), rootId: r.id, relativePath: rel, label: rel || path.basename(p), kind, executable: requiresExecutable(r, rel, kind), sensitive: ["auth", "settings", "models", "session", "memory"].includes(kind), securityPolicy, availability: "offlineReady" };
    if (/\.(?:json)$/.test(rel) && ["settings", "models", "auth"].includes(kind)) {
      try { const c = await config(p); if (securityConfig(c)) res.securityPolicy=true; if (executableConfig(c)) res.executable = true; }
      catch (e) { blockers.push("Cannot inspect configuration " + rel + ": " + (e as Error).message); return; }
    }
    resources.push(res);
    try {
      await walk(r, res, p, rel);
    } catch (e) { o.signal?.throwIfAborted(); blockers.push((e as Error).message); }
  }
  async function standard(r: BackupRoot, base: string, project = false) {
    for (const f of files.filter(f => !project || !projectInstructionFiles.has(f))) await addResource(r, project ? ".pi/" + f : f, path.join(base, project ? ".pi" : "", f));
    for (const d of dirs.filter(d => !project || d !== "desktop-agents")) {
      const prefix = project ? ".pi/" : "";
      const folder = path.join(base, project ? ".pi" : "", d);
      // Independently selectable tool units; project source is never traversed.
      if (["skills", "extensions", "agents", "desktop-agents", "workflows", "prompts", "themes"].includes(d)) {
        const st = await exists(folder); if (!st) continue;
        if (st.isSymbolicLink()) { await addResource(r, prefix + d, folder); continue; }
        for (const item of (await fs.readdir(folder)).sort()) if (!excludeEntry(item, prefix + d + "/" + item)) await addResource(r, prefix + d + "/" + item, path.join(folder, item));
      } else await addResource(r, prefix + d, folder);
    }
    if (project) {
      await addResource(r, "skills-lock.json", path.join(base, "skills-lock.json"), "settings");
      for (const d of ["skills", "agents", "workflows"]) {
        const folder = path.join(base, ".agents", d), st = await exists(folder); if (!st) continue;
        for (const name of (await fs.readdir(folder)).sort()) await addResource(r, ".agents/" + d + "/" + name, path.join(folder, name), d);
      }
    }
    await declarations(r, path.join(base, project ? ".pi" : "", "settings.json"), path.join(base, project ? ".pi" : ""));
  }
  async function external(p: string, kind: string) {
    if (!["skills", "extensions", "prompts", "themes", "agents", "settings"].includes(kind)) return;
    const s = await exists(p); if (!s) { if (kind === "session") warnings.push("No saved sessions at declared root: " + p); else blockers.push("Declared resource unavailable: " + p); return; }
    const actual = await fs.realpath(p);
    if (isHistory(actual) || isHistoryName(actual) || isHistoryName(p)) return;
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
    // sessionDir is configuration only; its history is intentionally not collected.
  }
  const st = await exists(agent); if (!st?.isDirectory() || st.isSymbolicLink()) throw new Error("Invalid agent directory");
  await standard(agentRoot, agent);
  for (const d of ["skills", "agents", "workflows"]) {
    const folder = path.join(home, ".agents", d); if (!(await exists(folder))) continue;
    for (const name of (await fs.readdir(folder)).sort()) await addResource(homeRoot, ".agents/" + d + "/" + name, path.join(folder, name), d);
  }

  await addResource(homeRoot, ".agents/.skill-lock.json", path.join(home, ".agents", ".skill-lock.json"), "settings");

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

      const skills = path.join(current,".agents","skills");
      if (await exists(skills)) for (const name of (await fs.readdir(skills)).sort()) await external(path.join(skills,name),"skills");
      if (current === boundary) break;
    }
  }
  for (const resource of o.resourceSnapshot ?? []) await external(resource.kind === "skills" && resource.baseDir ? resource.baseDir : resource.path, resource.kind);
  // sessionDirs from the running backend are not backup dependencies.
  warnings.push(...(o.resourceWarnings ?? []));

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
