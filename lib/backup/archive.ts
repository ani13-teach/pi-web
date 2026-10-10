import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, type DecipherGCM } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { BackupEntry, BackupInspection, BackupManifest, BackupResource, BackupRoot, Collection, OperationOptions, SourceEntry } from "./types.ts";
import { checkLegacyPublic, readLegacyV1 } from "./legacy-v1.ts";
import { checkParents, renameNoReplace, syncDirectory, verifyParents } from "./platform.ts";
import { BACKUP_PREFERENCE_KEYS, BACKUP_UI_RESOURCE_ID, validateBackupUiState } from "../../shared/backup-preferences.ts";

// Fixed, bounded v2 header: magic[8], N/r/p uint32 BE, salt[16], nonce[12].
// One GCM stream: count frame, (entry frame + body)*, manifest frame, tag[16].
export const ARCHIVE_LIMITS = Object.freeze({ file: 8 * 1024 ** 3, total: 16 * 1024 ** 3, entries: 100000, meta: 16384, manifest: 32 * 1024 ** 2, path: 1024, depth: 64 });
const MAGIC = Buffer.from("PIDESK02"), LEGACY_MAGIC = Buffer.from("PIDESK01"), INVALID = "Invalid backup or password";
const fold = (s: string) => s.normalize("NFC").toLowerCase();
function fail(): never { throw new Error(INVALID); }
const abort = (o: OperationOptions) => { if (o.signal?.aborted) throw new Error("Backup operation cancelled"); };
function progress(o: OperationOptions, phase: "export" | "verify" | "stage", completed: number, total: number) {
  o.progress?.({ operationId: o.operationId ?? "", phase, completed, total }); abort(o);
}
export function validArchivePath(s: unknown): s is string {
  return typeof s === "string" && !!s && s.length <= ARCHIVE_LIMITS.path && s.split("/").length <= ARCHIVE_LIMITS.depth && !/[\\\u0000-\u001f\u007f:<>"|?*]/.test(s) &&
    s.split("/").every((p) => !!p && p !== "." && p !== ".." && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p));
}
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function fields(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, unknown> {
  if (!object(v) || required.some((k) => !Object.hasOwn(v, k)) || Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))) fail();
}
const text = (v: unknown, max = 4096) => typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v) && validArchivePath(v);
const SHA = /^[0-9a-f]{64}$/;
const KINDS = new Set(["settings", "models", "auth", "credentials", "configuration", "config", "session", "sessions", "skill", "skills", "extension", "extensions", "agent", "agents", "prompt", "prompts", "theme", "themes", "workflow", "workflows", "memory", "instructions", "instruction", "policy", "security-policy", "lock", "skill-lock", "ui", "custom", "project", "package"]);
const AGENT_FILES = new Set(["settings.json", "models.json", "auth.json", "web-push.json", "subagents.json", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md", "agent-tool-description.md", "automode.json", "automode.local.json", "automode.settings.json"]);
const TOOL_DIRS = ["skills", "extensions", "agents", "prompts", "themes", "workflows", "agent-memory", "sessions", "desktop-agents"];
const PROJECT_FILES = new Set(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "skills-lock.json", ...["settings.json", "models.json", "auth.json", "web-push.json", "subagents.json", "automode.local.json", "automode.json", "automode.settings.json", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md", "agent-tool-description.md"].map((p) => `.pi/${p}`)]);
const HOME_FILES = new Set([".agents/.skill-lock.json", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md"]);
const HOME_DIRS = [".agents/skills", ".agents/agents", ".agents/workflows", ".pi/agent-memory"];
const PROJECT_DIRS = ["skills", "extensions", "agents", "prompts", "themes", "workflows", "agent-memory", "agent-memory-local"].map((p) => `.pi/${p}`).concat([".agents/skills", ".agents/agents", ".agents/workflows"]);
const EXECUTABLE_KINDS = new Set(["skill", "skills", "extension", "extensions", "agent", "agents", "prompt", "prompts", "workflow", "workflows", "instruction", "instructions", "custom", "project", "package"]);
function executableConfig(v: unknown): boolean {
  if (typeof v === "string") return v.trimStart().startsWith("!");
  if (Array.isArray(v)) return v.some(executableConfig);
  return object(v) && Object.entries(v).some(([k, value]) => /^(command|mcpServers|permissions|autoMode|automode)$/.test(k) || ["extensions", "packages"].includes(k) && Array.isArray(value) && value.length > 0 || executableConfig(value));
}
function securityConfig(v: unknown): boolean {
  return !!v && typeof v === "object" && (Array.isArray(v) ? v.some(securityConfig) : Object.entries(v).some(([k,value])=>/^(permissions|automode|autoMode)$/.test(k) || securityConfig(value)));
}
function intrinsicallyExecutable(root: BackupRoot, relative: string) {
  if (root.kind === "external") return false;
  return /^(?:(?:\.pi|\.agents)\/)?(?:skills|extensions|agents|desktop-agents|workflows|prompts)(?:\/|$)/.test(relative) ||
    /(?:^|\/)(?:AGENTS(?:\.override)?|CLAUDE|SYSTEM|APPEND_SYSTEM|agent-tool-description)\.md$/.test(relative);
}
function allowedResource(root: BackupRoot, relative: string): boolean {
  if (root.kind === "external") return validArchivePath(relative); // Exactly one catalog resource per external root; no target follows originalPath.
  if (root.kind === "ui") return false; // UI is schema-controlled manifest.uiState, never filesystem records.
  const files = root.kind === "agent" ? AGENT_FILES : root.kind === "project" ? PROJECT_FILES : HOME_FILES;
  const dirs = root.kind === "agent" ? TOOL_DIRS : root.kind === "project" ? PROJECT_DIRS : HOME_DIRS;
  return files.has(relative) || dirs.some((d) => relative === d || relative.startsWith(`${d}/`));
}
// This list is intentionally not a generic localStorage/profile export. Unknown keys fail closed.
export const ARCHIVE_UI_KEYS = new Set<string>(BACKUP_PREFERENCE_KEYS);
function entry(value: unknown): asserts value is BackupEntry {
  fields(value, ["path", "rootId", "resourceId", "relativePath", "size", "sha256", "kind"]);
  if (!validArchivePath(value.path) || !validArchivePath(value.relativePath) || !id(value.rootId) || !id(value.resourceId) ||
    !Number.isSafeInteger(value.size) || (value.size as number) < 0 || (value.size as number) > ARCHIVE_LIMITS.file || typeof value.sha256 !== "string" || !SHA.test(value.sha256) ||
    typeof value.kind !== "string" || !KINDS.has(value.kind)) fail();
}
/** Paths are logical descriptors, never an authorization to read or restore originalPath. */
export function validateManifest(value: unknown, legacy = false): asserts value is BackupManifest {
  fields(value, ["formatVersion", "archiveId", "appVersion", "sdkVersion", "createdAt", "roots", "resources", "entries", "warnings"], ["uiState"]);
  if (value.formatVersion !== 2 || !id(value.archiveId) || !text(value.appVersion, 128) || !text(value.sdkVersion, 128) || typeof value.createdAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.roots) || value.roots.length > ARCHIVE_LIMITS.entries || !Array.isArray(value.resources) || value.resources.length > ARCHIVE_LIMITS.entries ||
    !Array.isArray(value.entries) || value.entries.length > ARCHIVE_LIMITS.entries || !Array.isArray(value.warnings) || value.warnings.length > 10000 || value.warnings.some((s) => !text(s))) fail();
  if (new Date(value.createdAt).toISOString() !== value.createdAt || Buffer.byteLength(JSON.stringify(value)) > ARCHIVE_LIMITS.manifest) fail();
  const roots = new Map<string, BackupRoot>(), resources = new Map<string, BackupResource>();
  for (const r of value.roots) {
    fields(r, ["id", "kind", "label", "originalPath"]);
    if (!id(r.id) || r.id === BACKUP_UI_RESOURCE_ID || roots.has(fold(r.id)) || !["agent", "home", "project", "external", "ui"].includes(r.kind as string) || !text(r.label) || !text(r.originalPath, 32768)) fail();
    roots.set(fold(r.id), r as BackupRoot);
  }
  if (["agent", "home", "ui"].some((kind) => [...roots.values()].filter((r) => r.kind === kind).length > 1)) fail();
  const resourcePaths = new Set<string>(), externalCounts = new Map<string, number>();
  for (const r of value.resources) {
    fields(r, ["id", "rootId", "relativePath", "label", "kind", "executable", "sensitive", "availability"], ["securityPolicy", "source", "version", "requiredRootIds"]);
    const root = typeof r.rootId === "string" && roots.get(fold(r.rootId));
    if (!id(r.id) || r.id === BACKUP_UI_RESOURCE_ID || resources.has(fold(r.id)) || !root || root.id !== r.rootId || !validArchivePath(r.relativePath) || !allowedResource(root, r.relativePath) ||
      !text(r.label) || typeof r.kind !== "string" || !KINDS.has(r.kind) || typeof r.executable !== "boolean" || typeof r.sensitive !== "boolean" ||
      !["offlineReady", "requiresReinstall", "unresolved"].includes(r.availability as string) ||
      (Object.hasOwn(r, "securityPolicy") && typeof r.securityPolicy !== "boolean") || (Object.hasOwn(r, "source") && !text(r.source)) || (Object.hasOwn(r, "version") && !text(r.version, 256))) fail();
    if (Object.hasOwn(r,"requiredRootIds") && (!Array.isArray(r.requiredRootIds) || r.requiredRootIds.length > 10000 || new Set(r.requiredRootIds).size!==r.requiredRootIds.length || r.requiredRootIds.some(id=>typeof id!=="string" || roots.get(fold(id))?.id!==id || roots.get(fold(id))?.kind!=="project"))) fail();
    const configKind = /(?:^|\/)auth\.json$|(?:^|\/)web-push\.json$/.test(r.relativePath) ? "auth" : /(?:^|\/)models\.json$/.test(r.relativePath) ? "models" : /(?:^|\/)(?:settings|subagents|automode(?:\.(?:local|settings))?)\.json$/.test(r.relativePath) ? "settings" : undefined;
    if (configKind && (r.kind !== configKind || !r.sensitive)) fail();
    if ((root.kind === "external" || EXECUTABLE_KINDS.has(r.kind as string) || intrinsicallyExecutable(root, r.relativePath)) && r.executable !== true) fail();
    if (/(?:^|\/)(?:automode(?:\.(?:local|settings))?\.json|trust\.json)$/.test(r.relativePath) && r.securityPolicy !== true) fail();
    const resourcePath = `${fold(root.id)}/${fold(r.relativePath)}`;
    if (resourcePaths.has(resourcePath)) fail(); resourcePaths.add(resourcePath);
    if (root.kind === "external") externalCounts.set(root.id, (externalCounts.get(root.id) ?? 0) + 1);
    resources.set(fold(r.id), r as BackupResource);
  }
  if (value.roots.some((r) => r.kind === "external" && externalCounts.get(r.id) !== 1)) fail();
  for (const p of resourcePaths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) if (resourcePaths.has(parts.slice(0, i).join("/"))) fail();
  }
  const seen = new Set<string>(), targetPaths = new Set<string>(); let total = 0;
  for (const e of value.entries) {
    entry(e);
    if (e.kind === "package") fail(); // Dependency descriptors never represent installed runtime/program files.
    const r = resources.get(fold(e.resourceId));
    if (!r || r.id !== e.resourceId || r.rootId !== e.rootId || r.kind !== e.kind ||
      !(e.relativePath === r.relativePath || e.relativePath.startsWith(`${r.relativePath}/`)) ||
      e.path !== `${e.rootId}/${e.relativePath}` || seen.has(fold(e.path)) || (total += e.size) > ARCHIVE_LIMITS.total) fail();
    const root = roots.get(fold(e.rootId));
    if (!root || !allowedResource(root, e.relativePath)) fail();
    // Known singleton files may not be turned into attacker-controlled directory trees.
    const singletons = root.kind === "agent" ? AGENT_FILES : root.kind === "project" ? PROJECT_FILES : HOME_FILES;
    if ([...singletons].some((p) => e.relativePath.startsWith(`${p}/`))) fail();
    const target = `${fold(e.rootId)}/${fold(e.relativePath)}`;
    if (targetPaths.has(target)) fail(); targetPaths.add(target); seen.add(fold(e.path));
  }
  // Reject case aliases in ANY path component, not only equal complete filenames, and file/dir conflicts.
  const components = new Map<string, string>();
  for (const p of targetPaths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) if (targetPaths.has(parts.slice(0, i).join("/"))) fail();
  }
  for (const r of [...value.resources, ...value.entries]) {
    const p = `${r.rootId}/${r.relativePath}`, parts = p.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/"), old = components.get(fold(prefix));
      if (old !== undefined && old !== prefix) fail(); components.set(fold(prefix), prefix);
    }
  }
  if (Object.hasOwn(value, "uiState")) {
    validateBackupUiState(value.uiState);
  }
  // Legacy converter uses historical roots/paths, but it must still satisfy the same whitelist.
  void legacy;
}
const derive = (password: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) =>
  scryptCb(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result as Buffer)));
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function checkedOpen(file: string) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const [named, opened] = await Promise.all([fs.lstat(file), handle.stat()]);
    if (!named.isFile() || !opened.isFile() || !same(named, opened)) throw new Error("Source changed during backup");
    return handle;
  } catch (e) { await handle.close(); throw e; }
}
async function stable(file: string, handle: Awaited<ReturnType<typeof fs.open>>, before: Stats) {
  const [after, named] = await Promise.all([handle.stat(), fs.lstat(file)]);
  if (!named.isFile() || !same(before, after) || !same(after, named)) throw new Error("Source changed during backup");
}
class Reader {
  private iterator: AsyncIterator<Buffer>; private current: Buffer = Buffer.alloc(0);
  constructor(input: AsyncIterable<Buffer>) { this.iterator = input[Symbol.asyncIterator](); }
  async take(length: number, consume: (part: Buffer) => Promise<void>) {
    while (length) {
      if (!this.current.length) { const next = await this.iterator.next(); if (next.done) fail(); this.current = next.value; }
      const n = Math.min(length, this.current.length); await consume(this.current.subarray(0, n)); this.current = this.current.subarray(n); length -= n;
    }
  }
  async json(limit: number = ARCHIVE_LIMITS.meta): Promise<unknown> {
    const prefix = Buffer.alloc(4); let offset = 0;
    await this.take(4, async (p) => { p.copy(prefix, offset); offset += p.length; });
    const size = prefix.readUInt32BE(); if (size < 2 || size > limit) fail();
    const body = Buffer.alloc(size); offset = 0;
    await this.take(size, async (p) => { p.copy(body, offset); offset += p.length; });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  }
  async end() { if (this.current.length || !(await this.iterator.next()).done) fail(); }
  async close() { await this.iterator.return?.(); this.current = Buffer.alloc(0); }
}
function frame(v: unknown, limit: number = ARCHIVE_LIMITS.meta) {
  const body = Buffer.from(JSON.stringify(v)); if (body.length > limit) throw new Error("Backup metadata exceeds limit");
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); return Buffer.concat([prefix, body]);
}
async function readAt(handle: Awaited<ReturnType<typeof fs.open>>, position: number, length: number) {
  const buf = Buffer.alloc(length); let offset = 0;
  while (offset < length) { const { bytesRead } = await handle.read(buf, offset, length - offset, position + offset); if (!bytesRead) fail(); offset += bytesRead; }
  return buf;
}
async function safeStage(dir: string) {
  const absolute = path.resolve(dir); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const s = await fs.lstat(current); if (!s.isDirectory() || s.isSymbolicLink()) fail();
  }
  const stat = await fs.lstat(absolute); return { path: absolute, stat };
}
/** Full-stream authenticated inspection; never restores effective data or executes resources.
 * stageDir must be a caller-protected, operation-private staging directory (ACLs belong to platform/transaction).
 * Successful numeric stage files belong to the caller; failures remove only files created by this invocation.
 * The returned key is an operation-lifetime copy. The controller must zero it and bind reuse to archiveHash.
 */
export async function readArchive(o: { archivePath: string; password?: string; key?: Buffer; stageDir?: string } & OperationOptions): Promise<BackupInspection & { key: Buffer }> {
  abort(o);
  if (o.key !== undefined ? !Buffer.isBuffer(o.key) || o.key.length !== 32 : typeof o.password !== "string" || !o.password) throw new Error("A password or 32-byte derived key is required");
  const file = await checkedOpen(o.archivePath), made: { path: string; dev: number; ino: number }[] = [];
  let reader: Reader | undefined, decipher: DecipherGCM | undefined, key: Buffer | undefined, success = false;
  try {
    const initial = await file.stat();
    if (initial.size < 54 || initial.size > ARCHIVE_LIMITS.total + ARCHIVE_LIMITS.entries * (ARCHIVE_LIMITS.meta + 4) + ARCHIVE_LIMITS.manifest + 1024) fail();
    const magic = await readAt(file, 0, 8), legacy = magic.equals(LEGACY_MAGIC); if (!legacy && !magic.equals(MAGIC)) fail();
    const headerSize = legacy ? 36 : 48, header = await readAt(file, 0, headerSize), tag = await readAt(file, initial.size - 16, 16);
    if (!legacy && (header.readUInt32BE(8) !== 16384 || header.readUInt32BE(12) !== 8 || header.readUInt32BE(16) !== 1)) fail();
    const salt = header.subarray(legacy ? 8 : 20, legacy ? 24 : 36), nonce = header.subarray(legacy ? 24 : 36);
    key = o.key ? Buffer.from(o.key) : await derive(o.password!, salt); abort(o);
    decipher = createDecipheriv("aes-256-gcm", key, nonce); decipher.setAAD(header); decipher.setAuthTag(tag);
    const decryptor = decipher;
    const archiveHash = createHash("sha256"); archiveHash.update(header);
    async function* plaintext() {
      for (let offset = headerSize; offset < initial.size - 16;) {
        abort(o); const raw = await readAt(file, offset, Math.min(65536, initial.size - 16 - offset)); offset += raw.length;
        archiveHash.update(raw); const plain = decryptor.update(raw); if (plain.length) yield plain;
      }
      archiveHash.update(tag); abort(o); const final = decryptor.final(); if (final.length) yield final;
    }
    reader = new Reader(plaintext());
    const stage = o.stageDir ? await safeStage(o.stageDir) : undefined;
    const sessionHeaders = new Map<number,string>();
    const riskyConfigs = new Set<number>(), policyConfigs = new Set<number>();
    async function consume(e: { size: number; kind?: string; relativePath?: string }, i: number, publicMode = false) {
      abort(o); const digest = createHash("sha256"), publicChunks: Buffer[] = [];
      const checkConfig = e.relativePath?.endsWith(".json") && ["auth", "models", "settings"].includes(e.kind ?? "");
      if (checkConfig && e.size > 16 * 1024 ** 2) fail();
      const configChunks: Buffer[] = [], sessionChunks:Buffer[]=[]; let sessionBytes=0;
      let out: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        if (stage) {
          const now = (await safeStage(stage.path)).stat;
          if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== stage.stat.dev || now.ino !== stage.stat.ino) fail();
          const dest = path.join(stage.path, String(i)); out = await fs.open(dest, "wx", 0o600);
          const identity = await out.stat(); made.push({ path: dest, dev: identity.dev, ino: identity.ino });
        }
        await reader!.take(e.size, async (p) => { abort(o); digest.update(p); if (publicMode) publicChunks.push(Buffer.from(p)); if (checkConfig) configChunks.push(Buffer.from(p)); if(e.kind==="session" && sessionBytes<65536){const prefix=p.subarray(0,65536-sessionBytes);sessionChunks.push(Buffer.from(prefix));sessionBytes+=prefix.length;} if (out) await out.writeFile(p); });
        if (publicMode) checkLegacyPublic(Buffer.concat(publicChunks));
        if (checkConfig) {
          const config = JSON.parse(Buffer.concat(configChunks).toString("utf8"));
          if (executableConfig(config)) riskyConfigs.add(i);
          if (securityConfig(config)) policyConfigs.add(i);
        }
        if (sessionBytes) { try { const header=JSON.parse(Buffer.concat(sessionChunks).toString("utf8").split("\n")[0]); if(header.type==="session" && typeof header.cwd==="string" && path.isAbsolute(header.cwd))sessionHeaders.set(i,path.resolve(header.cwd)); } catch { /* Raw damaged history is retained, never executed. */ } }
        if (out) await out.sync();
      } finally { await out?.close(); }
      return digest.digest("hex");
    }
    let manifest: BackupManifest;
    if (legacy) manifest = await readLegacyV1(reader, `legacy-${salt.toString("hex")}`, async (e, i, pub) => {
      const hash = await consume({...e,relativePath:e.path.slice(e.path.indexOf("/")+1),kind:/(?:^|\/)settings\.json$/.test(e.path)?"settings":e.kind}, i, pub); progress(o, stage ? "stage" : "verify", i + 1, 0); return hash;
    });
    else {
      const start = await reader.json(); fields(start, ["formatVersion", "count"]);
      if (start.formatVersion !== 2 || !Number.isSafeInteger(start.count) || (start.count as number) < 0 || (start.count as number) > ARCHIVE_LIMITS.entries) fail();
      const actual: BackupEntry[] = []; const seen = new Set<string>(); let bytes = 0, metadataBytes = 0;
      for (let i = 0; i < (start.count as number); i++) {
        const e = await reader.json(); entry(e);
        if (seen.has(fold(e.path)) || (bytes += e.size) > ARCHIVE_LIMITS.total ||
          (metadataBytes += Buffer.byteLength(JSON.stringify(e))) > ARCHIVE_LIMITS.manifest) fail(); seen.add(fold(e.path));
        if (await consume(e, i) !== e.sha256) fail(); actual.push(e); progress(o, stage ? "stage" : "verify", i + 1, start.count as number);
      }
      const tail = await reader.json(ARCHIVE_LIMITS.manifest); await reader.end(); // Forces full GCM authentication before trusted validation/return.
      validateManifest(tail); manifest = tail;
      if (manifest.entries.length !== actual.length || actual.some((e, i) => !equalEntry(e, manifest.entries[i]))) fail();
    }
    const resourcesById=new Map(manifest.resources.map(resource=>[resource.id,resource]));
    const workspaceRoots=new Map(manifest.roots.filter(root=>root.kind==="project" && root.originalPath).map(root=>[fold(path.resolve(root.originalPath)),root]));
    for (const [index,cwd] of sessionHeaders) {
      const resource=resourcesById.get(manifest.entries[index].resourceId)!;
      let root=workspaceRoots.get(fold(cwd));
      if (legacy && !root) { root={id:"legacy-workspace-"+createHash("sha256").update(cwd).digest("hex").slice(0,20),kind:"project",label:"Historical session workspace: "+cwd,originalPath:cwd};manifest.roots.push(root);workspaceRoots.set(fold(cwd),root); }
      if(!root)fail();
      if(legacy)resource.requiredRootIds=[...new Set([...(resource.requiredRootIds??[]),root.id])];
      else if(!resource.requiredRootIds?.includes(root.id))fail();
    }
    if(legacy)for(const index of policyConfigs)resourcesById.get(manifest.entries[index].resourceId)!.securityPolicy=true;
    validateManifest(manifest, legacy);
    for (const i of riskyConfigs) if (!manifest.resources.find(r => r.id === manifest.entries[i].resourceId)?.executable) fail();
    for (const i of policyConfigs) if (!manifest.resources.find(r => r.id === manifest.entries[i].resourceId)?.securityPolicy) fail();
    await stable(o.archivePath, file, initial); abort(o);
    if (stage) {
      const current = await safeStage(stage.path);
      if (current.stat.dev !== stage.stat.dev || current.stat.ino !== stage.stat.ino) fail();
      for (const item of made) {
        const named = await fs.lstat(item.path);
        if (!named.isFile() || named.isSymbolicLink() || named.dev !== item.dev || named.ino !== item.ino) fail();
      }
    }
    const hash = archiveHash.digest("hex"); success = true;
    return { manifest, archiveHash: hash, legacy, warnings: [...manifest.warnings], key };
  } catch {
    if (o.signal?.aborted) throw new Error("Backup operation cancelled");
    // Never retain parser errors as causes: JSON exceptions can embed decrypted content.
    throw new Error(INVALID);
  } finally {
    const closeErrors: unknown[] = [];
    try { await reader?.close(); } catch (e) { closeErrors.push(e); }
    decipher?.destroy();
    try { await file.close(); } catch (e) { closeErrors.push(e); }
    if (closeErrors.length) success = false;
    if (!success) {
      key?.fill(0); const failures: unknown[] = [];
      for (const item of made.reverse()) {
        try { const s = await fs.lstat(item.path); if (!s.isFile() || s.dev !== item.dev || s.ino !== item.ino) throw new Error("Stage identity changed; cleanup refused"); await fs.unlink(item.path); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") failures.push(e); }
      }
      if (failures.length) throw new AggregateError(failures, "Backup validation failed; stage cleanup incomplete");
    }
    if (closeErrors.length) throw new AggregateError(closeErrors, "Backup file handle cleanup failed");
  }
}
function equalEntry(a: BackupEntry, b: BackupEntry) { return ["path", "rootId", "resourceId", "relativePath", "size", "sha256", "kind"].every((k) => a[k as keyof BackupEntry] === b[k as keyof BackupEntry]); }
/** Encrypt directly to a same-directory temporary file, fsync and authenticate before
 * kernel no-clobber publication. Hardlinks are never required; unsupported native
 * atomic move/permission operations fail closed.
 */
export async function writeArchive(o: { outputPath: string; password: string; collection: Collection } & OperationOptions): Promise<{ entries: number; bytes: number; warnings: string[] }> {
  abort(o); if (typeof o.password !== "string" || !o.password) throw new Error("A password is required");
  // Snapshot the descriptors; caller mutation cannot change the authenticated manifest mid-export.
  const manifest: unknown = JSON.parse(JSON.stringify(o.collection.manifest)); validateManifest(manifest);
  const entries: SourceEntry[] = o.collection.entries.map((e) => ({ ...e, data: e.data ? Buffer.from(e.data) : undefined }));
  if (entries.length !== manifest.entries.length || entries.some((e, i) => !equalEntry(e, manifest.entries[i]))) throw new Error("Scan collection does not match manifest");
  if (o.collection.preview.blockers.length) throw new Error("Backup scan has unresolved blockers");
  const tail = frame(manifest, ARCHIVE_LIMITS.manifest);
  const output = path.resolve(o.outputPath), parent = await fs.realpath(path.dirname(output));
  const destination = path.join(parent, path.basename(output));
  const parentIdentity = await checkParents(parent);
  for (const e of entries) {
    abort(o);
    if (e.source && fold(path.resolve(e.source)) === fold(destination)) throw new Error("Destination is a backup source");
  }
  const temp = path.join(parent, `.pibak-${randomBytes(16).toString("hex")}.tmp`);
  const header = Buffer.alloc(48); MAGIC.copy(header); header.writeUInt32BE(16384, 8); header.writeUInt32BE(8, 12); header.writeUInt32BE(1, 16);
  randomBytes(16).copy(header, 20); randomBytes(12).copy(header, 36);
  const key = await derive(o.password, header.subarray(20, 36));
  let tempIdentity: { dev: number; ino: number } | undefined;
  try {
    abort(o); const out = await fs.open(temp, "wx", 0o600);
    const cipher = createCipheriv("aes-256-gcm", key, header.subarray(36)); cipher.setAAD(header);
    async function put(p: Buffer) { abort(o); const encrypted = cipher.update(p); if (encrypted.length) await out.writeFile(encrypted); }
    try {
      tempIdentity = await out.stat();
      await out.writeFile(header); await put(frame({ formatVersion: 2, count: entries.length }));
      for (const [i, e] of entries.entries()) {
        await put(frame(manifest.entries[i])); const hash = createHash("sha256"); let read = 0;
        if (e.data !== undefined) {
          if (e.data.length !== e.size) throw new Error("Source changed during backup");
          hash.update(e.data); await put(e.data); read = e.data.length;
        } else if (e.source) {
          const source = await checkedOpen(e.source);
          try {
            const before = await source.stat();
            if (before.size !== e.size || (e.dev !== undefined && before.dev !== e.dev) || (e.ino !== undefined && before.ino !== e.ino) ||
              (e.mtimeMs !== undefined && before.mtimeMs !== e.mtimeMs) || (e.ctimeMs !== undefined && before.ctimeMs !== e.ctimeMs)) throw new Error("Source changed during backup");
            while (read < e.size) { const p = await readAt(source, read, Math.min(65536, e.size - read)); read += p.length; hash.update(p); await put(p); }
            await stable(e.source, source, before);
          } finally { await source.close(); }
        } else throw new Error("Backup source is missing");
        if (read !== e.size || hash.digest("hex") !== e.sha256) throw new Error("Source changed during backup");
        progress(o, "export", i + 1, entries.length);
      }
      await put(tail); await out.writeFile(cipher.final()); await out.writeFile(cipher.getAuthTag()); await out.sync();
    } finally { cipher.destroy(); await out.close(); }
    const verified = await readArchive({ archivePath: temp, key, signal: o.signal }); verified.key.fill(0); abort(o);
    const tempStat = await fs.lstat(temp);
    if (!tempStat.isFile() || tempStat.dev !== tempIdentity.dev || tempStat.ino !== tempIdentity.ino) throw new Error("Encrypted temporary archive identity changed");
    const bytes = tempStat.size;
    await verifyParents(parentIdentity);
    try { await renameNoReplace(temp, destination); await syncDirectory(parent); }
    catch (e) {
      if (await fs.lstat(destination).catch(() => null)) throw new Error("Backup destination already exists");
      throw new Error("Safe atomic no-clobber backup publishing is unavailable; choose another destination");
    }
    // Publish is the success boundary. Cancellation arriving afterwards must not misreport a complete archive as absent.
    return { entries: entries.length, bytes, warnings: [...manifest.warnings] };
  } finally {
    key.fill(0);
    if (tempIdentity) {
      const named = await fs.lstat(temp).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
      if (named) {
        if (!named.isFile() || named.dev !== tempIdentity.dev || named.ino !== tempIdentity.ino) throw new Error("Encrypted temporary archive identity changed; cleanup refused");
        await fs.unlink(temp);
      }
    }
  }
}
