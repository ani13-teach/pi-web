import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type DecipherGCM } from "node:crypto";
import { constants, createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type BackupOptions = { agentDir: string; outputPath: string; password: string; includePrivate: boolean;
  includeSessions?: boolean; includeCustomizations?: boolean; projectDir?: string };
export type ScanOptions = Omit<BackupOptions, "outputPath" | "password">;
type Entry = { path: string; size: number; kind: string; source?: string; data?: Buffer;
  mtimeMs?: number; ctimeMs?: number };
const MAGIC = Buffer.from("PIDESK01");
const MAX_FILE = 8 * 1024 ** 3, MAX_TOTAL = 16 * 1024 ** 3, MAX_ENTRIES = 10000, MAX_META = 4096;
const INVALID = "Invalid backup or password";
const DIRS = ["extensions", "skills", "agents", "prompts", "themes"];
const FILES = ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"];
const fold = (s: string) => s.normalize("NFC").toLowerCase();
const validPath = (s: string) => !!s && s.length <= 1024 && !/[\\\u0000-\u001f:<>"|?*]/.test(s) &&
  s.split("/").every((p) => !!p && p !== "." && p !== ".." && !/[. ]$/.test(p) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));

async function root(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  const stat = await fs.lstat(abs);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid backup directory");
  return abs;
}
async function source(base: string, rel: string): Promise<string | null> {
  let current = base;
  try {
    for (const part of rel.split("/")) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink()) return null;
    }
    return current;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
async function json(file: string): Promise<Record<string, unknown>> {
  const handle = await checkedOpen(file);
  let value: unknown;
  try {
    if ((await handle.stat()).size > 16 * 1024 ** 2) throw new Error("Configuration exceeds limit");
    value = JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration");
  return value as Record<string, unknown>;
}
async function checkedOpen(file: string) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const [name, opened] = await Promise.all([fs.lstat(file), handle.stat()]);
    if (!name.isFile() || !opened.isFile() || name.dev !== opened.dev || name.ino !== opened.ino)
      throw new Error("Source changed during backup");
    return handle;
  } catch (e) { await handle.close(); throw e; }
}
function redacted(settings: Record<string, unknown>): Buffer {
  const clean: Record<string, string> = {};
  if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(settings.defaultThinkingLevel as string))
    clean.defaultThinkingLevel = settings.defaultThinkingLevel as string;
  if (["light", "dark", "auto"].includes(settings.theme as string)) clean.theme = settings.theme as string;
  if (["on", "off"].includes(settings.enabledModelsSync as string)) clean.enabledModelsSync = settings.enabledModelsSync as string;
  return Buffer.from(JSON.stringify(clean));
}
async function collect(o: ScanOptions): Promise<{ entries: Entry[]; warnings: string[] }> {
  const base = await root(o.agentDir), entries: Entry[] = [], warnings: string[] = [], seen = new Set<string>();
  let total = 0;
  async function add(dir: string, rel: string, dest: string, kind: string, data?: Buffer) {
    const file = await source(dir, rel);
    if (!file) return;
    if (!(await fs.lstat(file)).isFile()) { warnings.push(`Skipped unsupported resource: ${dest}`); return; }
    const stat = await fs.stat(file);
    const size = data?.length ?? stat.size;
    if (!validPath(dest) || size > MAX_FILE || (total += size) > MAX_TOTAL || entries.length >= MAX_ENTRIES || seen.has(fold(dest)))
      throw new Error("Backup path or size limit exceeded");
    seen.add(fold(dest)); entries.push({ path: dest, size, kind, source: file, data,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
  }
  async function walk(dir: string, rel: string, dest: string, kind: string,
    accept: (name: string, isDirectory: boolean) => boolean = () => true) {
    const folder = await source(dir, rel);
    if (!folder) return;
    if (!(await fs.lstat(folder)).isDirectory()) { warnings.push(`Skipped unsupported resource: ${dest}`); return; }
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const from = `${rel}/${item.name}`, to = `${dest}/${item.name}`;
      if (!accept(item.name, item.isDirectory()) || (kind !== "session" &&
        (/^(?:\.git|node_modules|cache|logs?|tmp)$/i.test(item.name) ||
          /\.(?:log|tmp|cache|lock|sqlite|db)$/i.test(item.name))) || item.isSymbolicLink()) {
        warnings.push(`Skipped link or unsupported resource: ${to}`); continue;
      }
      if (item.isDirectory()) await walk(dir, from, to, kind, accept);
      else if (item.isFile()) await add(dir, from, to, kind);
      else warnings.push(`Skipped unsupported resource: ${to}`);
    }
  }
  const settings = await source(base, "settings.json");
  if (settings && (await fs.lstat(settings)).isFile())
    await add(base, "settings.json", "agent/settings.json", "settings", o.includePrivate ? undefined : redacted(await json(settings)));
  if (!o.includePrivate) {
    if (!entries.length || entries.every((entry) => entry.data?.equals(Buffer.from("{}"))))
      warnings.push("No eligible non-private settings were found; this archive contains no user data");
    return { entries, warnings };
  }
  await add(base, "models.json", "agent/models.json", "models");
  const auth = await source(base, "auth.json");
  if (!auth) warnings.push("No saved auth.json credentials found; some providers may require sign-in after restore");
  if (auth && (await fs.lstat(auth)).isFile()) {
    const credentials = await json(auth);
    await add(base, "auth.json", "agent/auth.json", "auth", Buffer.from(JSON.stringify(credentials)));
    if (Object.keys(credentials).length)
      warnings.push("Private backup includes all stored authentication credentials, including providers not in models.json");
  }
  if (o.includeSessions !== false) await walk(base, "sessions", "agent/sessions", "session",
    (name, isDirectory) => isDirectory || name.endsWith(".jsonl"));
  if (o.includeCustomizations) {
    for (const dir of DIRS) await walk(base, dir, `agent/${dir}`, "custom");
    for (const file of FILES) await add(base, file, `agent/${file}`, "custom");
  }
  if (o.projectDir) {
    const project = await root(o.projectDir);
    for (const file of ["settings.json", "models.json", ...FILES]) await add(project, `.pi/${file}`, `project/.pi/${file}`, "project");
    for (const dir of DIRS) await walk(project, `.pi/${dir}`, `project/.pi/${dir}`, "project");
    await walk(project, ".agents/skills", "project/.agents/skills", "project");
    await add(project, "AGENTS.md", "project/AGENTS.md", "project");
    const pi = await source(project, ".pi");
    if (pi && (await fs.lstat(pi)).isDirectory())
      for (const item of await fs.readdir(pi)) if (![...DIRS, ...FILES, "settings.json", "models.json"].includes(item))
        warnings.push(`Skipped unsupported project resource: .pi/${item}`);
  }
  return { entries, warnings };
}

export async function scanBackup(o: ScanOptions): Promise<{ entries: number; bytes: number;
  kinds: Record<string, number>; warnings: string[] }> {
  const { entries, warnings } = await collect(o);
  const kinds: Record<string, number> = {};
  for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  return { entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0), kinds, warnings };
}

const derive = (password: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) =>
  scryptCb(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
    (error, result) => error ? reject(error) : resolve(result as Buffer)));
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_META) throw new Error("Backup metadata exceeds limit");
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
export async function createBackup(o: BackupOptions): Promise<{ entries: number; bytes: number; warnings: string[] }> {
  if (!o.password) throw new Error("A password is required");
  const output = path.resolve(o.outputPath), agent = await root(o.agentDir);
  const actualOutput = path.join(await fs.realpath(path.dirname(output)), path.basename(output));
  if ([agent, ...(o.projectDir ? [await root(o.projectDir)] : [])].some((dir) =>
    fold(actualOutput).startsWith(fold(dir + path.sep)))) throw new Error("Destination must be outside source directories");
  const { entries, warnings } = await collect(o);
  const header = Buffer.concat([MAGIC, randomBytes(16), randomBytes(12)]);
  const cipher = createCipheriv("aes-256-gcm", await derive(o.password, header.subarray(8, 24)), header.subarray(24));
  cipher.setAAD(header);
  const temp = path.join(path.dirname(output), `.${path.basename(output)}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const file = await fs.open(temp, "wx", 0o600);
    try { await file.writeFile(header); } finally { await file.close(); }
    async function* records() {
      yield frame({ version: 1, includePrivate: o.includePrivate, count: entries.length });
      for (const item of entries) {
        yield frame({ path: item.path, size: item.size, kind: item.kind });
        if (item.data) yield item.data;
        else if (item.source) {
          const handle = await checkedOpen(item.source);
          let read = 0;
          try {
            const initial = await handle.stat();
            if (initial.size !== item.size || initial.mtimeMs !== item.mtimeMs || initial.ctimeMs !== item.ctimeMs)
              throw new Error("Source changed during backup");
            for await (const chunk of handle.createReadStream({ highWaterMark: 65536, autoClose: false })) {
              read += chunk.length;
              if (read > item.size) throw new Error("Source changed during backup");
              yield chunk;
            }
            const final = await handle.stat();
            if (final.size !== item.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs)
              throw new Error("Source changed during backup");
          } finally {
            await handle.close();
          }
          if (read !== item.size) throw new Error("Source changed during backup");
        }
      }
    }
    await pipeline(Readable.from(records()), cipher, createWriteStream(temp, { flags: "a" }));
    await fs.appendFile(temp, cipher.getAuthTag());
    await parse(temp, o.password);
    try { await fs.link(temp, output); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new Error("Backup destination already exists");
      if (!["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EXDEV"].includes(code ?? "")) throw e;
      // FAT/exFAT may not support hard links. Exclusive creation protects any
      // existing backup; a crash during copying can only leave an invalid new
      // archive, never overwrite an old one. Validate before reporting success.
      let target: Awaited<ReturnType<typeof fs.open>>;
      try { target = await fs.open(output, "wx", 0o600); }
      catch (openError) {
        if ((openError as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Backup destination already exists");
        throw openError;
      }
      const identity = await target.stat();
      try {
        let position = 0;
        for await (const chunk of createReadStream(temp)) {
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset, position);
            if (!bytesWritten) throw new Error("Backup copy stopped unexpectedly");
            offset += bytesWritten; position += bytesWritten;
          }
        }
        await target.sync();
        await target.close();
        await parse(output, o.password);
      } catch (copyError) {
        await target.close().catch(() => {});
        const current = await fs.lstat(output).catch(() => null);
        if (current?.isFile() && current.dev === identity.dev && current.ino === identity.ino)
          await fs.unlink(output).catch(() => {});
        throw copyError;
      }
      warnings.push("This drive does not support atomic backup publishing; interrupted export may leave an invalid incomplete file");
    }
    return { entries: entries.length, bytes: (await fs.stat(output)).size, warnings };
  } finally { await fs.rm(temp, { force: true }); }
}

class Reader {
  private iterator: AsyncIterator<Buffer>;
  private current = Buffer.alloc(0);
  constructor(input: AsyncIterable<Buffer>) { this.iterator = input[Symbol.asyncIterator](); }
  async take(length: number, consume: (part: Buffer) => Promise<void>): Promise<void> {
    while (length) {
      if (!this.current.length) {
        const item = await this.iterator.next();
        if (item.done) throw new Error(INVALID);
        this.current = Buffer.from(item.value);
      }
      const count = Math.min(length, this.current.length);
      await consume(this.current.subarray(0, count));
      this.current = this.current.subarray(count); length -= count;
    }
  }
  async json(): Promise<unknown> {
    const prefix = Buffer.alloc(4);
    let offset = 0;
    await this.take(4, async (part) => { part.copy(prefix, offset); offset += part.length; });
    const size = prefix.readUInt32BE();
    if (size < 2 || size > MAX_META) throw new Error(INVALID);
    const body = Buffer.alloc(size); offset = 0;
    await this.take(size, async (part) => { part.copy(body, offset); offset += part.length; });
    return JSON.parse(body.toString("utf8"));
  }
  async end(): Promise<void> {
    if (this.current.length || !(await this.iterator.next()).done) throw new Error(INVALID);
  }
}
function validEntry(value: unknown, privateMode: boolean): value is Entry {
  if (!value || typeof value !== "object") return false;
  const e = value as Entry;
  if (typeof e.path !== "string" || !validPath(e.path) || !Number.isSafeInteger(e.size) || e.size < 0 || e.size > MAX_FILE) return false;
  if (!privateMode) return e.path === "agent/settings.json" && e.kind === "settings" && e.size <= MAX_META;
  if (e.path === "agent/settings.json") return e.kind === "settings";
  if (e.path === "agent/models.json") return e.kind === "models";
  if (e.path === "agent/auth.json") return e.kind === "auth";
  if (e.path.startsWith("agent/sessions/")) return e.kind === "session" && e.path.endsWith(".jsonl");
  if (e.path.startsWith("project/")) return e.kind === "project" && (e.path === "project/AGENTS.md" ||
    /^project\/(?:\.pi\/(?:settings\.json|models\.json|AGENTS\.md|SYSTEM\.md|APPEND_SYSTEM\.md|(?:extensions|skills|agents|prompts|themes)\/.+)|\.agents\/skills\/.+)$/.test(e.path));
  return e.kind === "custom" && (FILES.some((name) => e.path === `agent/${name}`) ||
    DIRS.some((dir) => e.path.startsWith(`agent/${dir}/`)));
}
async function parse(archive: string, password: string, stage?: string): Promise<{ includePrivate: boolean; entries: Entry[]; batch: string }> {
  if (!password) throw new Error("A password is required");
  const file = await fs.open(archive, "r");
  let input: ReturnType<typeof createReadStream> | undefined;
  let decipher: DecipherGCM | undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 52 || stat.size > MAX_TOTAL + MAX_ENTRIES * MAX_META + 1024) throw new Error(INVALID);
    const header = Buffer.alloc(36), tag = Buffer.alloc(16);
    if ((await file.read(header, 0, 36, 0)).bytesRead !== 36 ||
      (await file.read(tag, 0, 16, stat.size - 16)).bytesRead !== 16 || !header.subarray(0, 8).equals(MAGIC)) throw new Error(INVALID);
    decipher = createDecipheriv("aes-256-gcm", await derive(password, header.subarray(8, 24)), header.subarray(24));
    decipher.setAAD(header); decipher.setAuthTag(tag);
    input = createReadStream(archive, { start: 36, end: stat.size - 17, highWaterMark: 65536 });
    const reader = new Reader(input.pipe(decipher));
    const meta = await reader.json() as { version?: unknown; includePrivate?: unknown; count?: unknown };
    if (meta.version !== 1 || typeof meta.includePrivate !== "boolean" || !Number.isSafeInteger(meta.count) ||
      (meta.count as number) < 0 || (meta.count as number) > MAX_ENTRIES) throw new Error(INVALID);
    const entries: Entry[] = [], seen = new Set<string>();
    let total = 0;
    for (let i = 0; i < (meta.count as number); i++) {
      const item = await reader.json();
      if (!validEntry(item, meta.includePrivate) || seen.has(fold(item.path)) || (total += item.size) > MAX_TOTAL) throw new Error(INVALID);
      seen.add(fold(item.path)); entries.push({ path: item.path, size: item.size, kind: item.kind });
      if (stage) {
        const out = await fs.open(path.join(stage, String(i)), "wx", 0o600);
        const publicChunks: Buffer[] = [];
        try { await reader.take(item.size, async (part) => {
          if (!meta.includePrivate) publicChunks.push(Buffer.from(part));
          await out.writeFile(part);
        }); }
        finally { await out.close(); }
        if (!meta.includePrivate) checkPublic(Buffer.concat(publicChunks));
      } else {
        const publicChunks: Buffer[] = [];
        await reader.take(item.size, async (part) => { if (!meta.includePrivate) publicChunks.push(Buffer.from(part)); });
        if (!meta.includePrivate) checkPublic(Buffer.concat(publicChunks));
      }
    }
    await reader.end();
    return { includePrivate: meta.includePrivate, entries, batch: header.subarray(8, 24).toString("hex") };
  } catch { throw new Error(INVALID); }
  finally {
    const inputClosed = input && !input.closed ? new Promise<void>((resolve) => input!.once("close", resolve)) : Promise.resolve();
    const decipherClosed = decipher && !decipher.closed ? new Promise<void>((resolve) => decipher!.once("close", resolve)) : Promise.resolve();
    decipher?.destroy();
    input?.destroy();
    await Promise.all([inputClosed, decipherClosed]);
    await file.close();
  }
}
function checkPublic(data: Buffer): void {
  const value: unknown = JSON.parse(data.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID);
  const allowed = redacted(value as Record<string, unknown>);
  if (Object.keys(value).length !== Object.keys(JSON.parse(allowed.toString()) as object).length)
    throw new Error(INVALID);
}
export async function inspectBackup(o: { archivePath: string; password: string }): Promise<{
  includePrivate: boolean; entries: { path: string; size: number; kind: string }[]; warnings: string[] }> {
  return { ...await parse(o.archivePath, o.password), warnings: [] };
}

async function destination(base: string, relative: string, created: string[]): Promise<string> {
  let current = base;
  for (const part of relative.split("/").slice(0, -1)) {
    if ((await fs.readdir(current)).some((name) => fold(name) === fold(part) && name !== part))
      throw new Error("Ambiguous restore destination");
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe restore destination");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await fs.mkdir(current, { mode: 0o700 }); created.push(current);
    }
  }
  const leaf = relative.split("/").at(-1)!;
  if ((await fs.readdir(current)).some((name) => fold(name) === fold(leaf) && name !== leaf))
    throw new Error("Ambiguous restore destination");
  return path.join(current, leaf);
}
function target(e: Entry, privateMode: boolean, batch: string): string {
  const rel = e.path.slice(e.path.indexOf("/") + 1);
  const isolated = e.path.startsWith("project/") || (privateMode &&
    (["agent/settings.json", "agent/models.json", "agent/auth.json"].includes(e.path))) ||
    e.kind === "custom" || /^(?:extensions|skills|agents|prompts|themes)\//.test(rel) ||
    rel.startsWith(".agents/skills/") || /^(?:AGENTS|SYSTEM|APPEND_SYSTEM)\.md$/.test(rel) ||
    /^\.pi\/(?:extensions|skills|agents|prompts|themes)\//.test(rel);
  return isolated ? `backup-imports/${batch}/${e.path}` : rel;
}
export async function restoreBackup(o: { agentDir: string; archivePath: string; password: string;
  overwrite?: boolean; projectDir?: string }): Promise<{ restored: number; skipped: number; warnings: string[] }> {
  if (o.overwrite) throw new Error("Backup restore does not support overwrite");
  const agent = await root(o.agentDir);
  const inspected = await inspectBackup({ archivePath: o.archivePath, password: o.password });
  const stage = await fs.mkdtemp(path.join(agent, ".backup-restore-"));
  await fs.chmod(stage, 0o700);
  const warnings: string[] = [], created: string[] = [], applied: { dest: string; dev: number; ino: number }[] = [];
  let preserveStage = false;
  let skipped = 0;
  try {
    const parsed = await parse(o.archivePath, o.password, stage);
    if (JSON.stringify(parsed.entries) !== JSON.stringify(inspected.entries) || parsed.includePrivate !== inspected.includePrivate)
      throw new Error(INVALID);
    const reviewDir = `backup-imports/${parsed.batch}`;
    if (parsed.entries.some((entry) => entry.path.startsWith("project/")))
      warnings.push(`Project resources isolated in ${reviewDir}/project; review and migrate manually`);
    if (parsed.includePrivate && parsed.entries.some((entry) => entry.path === "agent/models.json"))
      warnings.push(`Provider configuration isolated in ${reviewDir}/agent/models.json; review command-type values before activating`);
    if (parsed.includePrivate && parsed.entries.some((entry) => entry.path === "agent/auth.json"))
      warnings.push(`Credentials isolated in ${reviewDir}/agent/auth.json; review command-type values before activating`);
    for (const [i, entry] of parsed.entries.entries()) {
      const dest = await destination(agent, target(entry, parsed.includePrivate, parsed.batch), created);
      const stat = await fs.lstat(path.join(stage, String(i)));
      try {
        await fs.link(path.join(stage, String(i)), dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          skipped++;
          warnings.push(`Existing ${entry.kind} skipped: ${entry.path}`);
          continue;
        }
        throw e;
      }
      applied.push({ dest, dev: stat.dev, ino: stat.ino });
    }
    return { restored: applied.length, skipped, warnings };
  } catch (e) {
    const failures: unknown[] = [];
    for (const { dest, dev, ino } of applied.reverse()) {
      try {
        const stat = await fs.lstat(dest);
        if (!stat.isFile() || stat.dev !== dev || stat.ino !== ino)
          throw new Error(`Restore target changed during rollback: ${dest}`);
        await fs.unlink(dest);
      } catch (rollbackError) { failures.push(rollbackError); }
    }
    if (failures.length) {
      preserveStage = true;
      throw new AggregateError([e, ...failures], `Restore failed and rollback was incomplete; staged files retained in ${stage}`);
    }
    throw e;
  } finally {
    for (const dir of created.reverse()) await fs.rmdir(dir).catch(() => {});
    if (!preserveStage) await fs.rm(stage, { recursive: true, force: true });
  }
}
