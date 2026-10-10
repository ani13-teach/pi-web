import type { BackupEntry, BackupManifest, BackupResource, BackupRoot } from "./types.ts";

const INVALID = "Invalid backup or password";
const DIRS = ["extensions", "skills", "agents", "prompts", "themes"];
const FILES = ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"];
export type LegacyEntry = { path: string; size: number; kind: string };
export interface LegacyReader {
  json(limit?: number): Promise<unknown>;
  take(length: number, consume: (part: Buffer) => Promise<void>): Promise<void>;
  end(): Promise<void>;
}
const fold = (s: string) => s.normalize("NFC").toLowerCase();
const validPath = (s: string) => !!s && s.length <= 1024 && !/[\\\u0000-\u001f:<>"|?*]/.test(s) &&
  s.split("/").every((p) => !!p && p !== "." && p !== ".." && !/[. ]$/.test(p) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function exact(v: Record<string, unknown>, keys: string[]) { return Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k)); }
function validEntry(value: unknown, privateMode: boolean): value is LegacyEntry {
  if (!object(value) || !exact(value, ["path", "size", "kind"])) return false;
  const e = value;
  if (typeof e.path !== "string" || !validPath(e.path) || !Number.isSafeInteger(e.size) || (e.size as number) < 0 || (e.size as number) > 8 * 1024 ** 3) return false;
  if (!privateMode) return e.path === "agent/settings.json" && e.kind === "settings" && (e.size as number) <= 4096;
  if (e.path === "agent/settings.json") return e.kind === "settings";
  if (e.path === "agent/models.json") return e.kind === "models";
  if (e.path === "agent/auth.json") return e.kind === "auth";
  if (e.path.startsWith("agent/sessions/")) return e.kind === "session" && e.path.endsWith(".jsonl");
  if (e.path.startsWith("project/")) return e.kind === "project" && (e.path === "project/AGENTS.md" ||
    /^project\/(?:\.pi\/(?:settings\.json|models\.json|AGENTS\.md|SYSTEM\.md|APPEND_SYSTEM\.md|(?:extensions|skills|agents|prompts|themes)\/.+)|\.agents\/skills\/.+)$/.test(e.path));
  const entryPath = e.path;
  return e.kind === "custom" && (FILES.some((name) => entryPath === `agent/${name}`) || DIRS.some((dir) => entryPath.startsWith(`agent/${dir}/`)));
}
function checkPublic(data: Buffer): void {
  const value: unknown = JSON.parse(data.toString("utf8"));
  if (!object(value)) throw new Error(INVALID);
  const allowed: Record<string, string[]> = {
    defaultThinkingLevel: ["off", "minimal", "low", "medium", "high", "xhigh"],
    theme: ["light", "dark", "auto"], enabledModelsSync: ["on", "off"],
  };
  if (Object.entries(value).some(([k, v]) => !Object.hasOwn(allowed, k) || typeof v !== "string" || !allowed[k].includes(v))) throw new Error(INVALID);
}
/** Read-only v1 conversion. The caller owns decryption, authentication, hashes and stage cleanup. */
export async function readLegacyV1(reader: LegacyReader, archiveId: string,
  consume: (entry: LegacyEntry, index: number, publicMode: boolean) => Promise<string>): Promise<BackupManifest> {
  const meta = await reader.json(4096);
  if (!object(meta) || !exact(meta, ["version", "includePrivate", "count"]) || meta.version !== 1 || typeof meta.includePrivate !== "boolean" ||
    !Number.isSafeInteger(meta.count) || (meta.count as number) < 0 || (meta.count as number) > 10000 || (!meta.includePrivate && (meta.count as number) > 1)) throw new Error(INVALID);
  const entries: BackupEntry[] = [], roots: BackupRoot[] = [], resources: BackupResource[] = [], seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < (meta.count as number); i++) {
    const item = await reader.json(4096);
    if (!validEntry(item, meta.includePrivate) || seen.has(fold(item.path)) || (total += item.size) > 16 * 1024 ** 3) throw new Error(INVALID);
    seen.add(fold(item.path));
    const rootId = item.path.startsWith("project/") ? "project" : "agent";
    const relativePath = item.path.slice(rootId.length + 1);
    if (!roots.some((r) => r.id === rootId)) roots.push({ id: rootId, kind: rootId, label: `Historical ${rootId} (original path unavailable)`, originalPath: "" });
    // A v1 archive has no resource catalog. Conservatively gate ALL customization/project/configuration content.
    const executable = meta.includePrivate && item.kind !== "session";
    let resourcePath = relativePath;
    for (const prefix of [".pi/", ".agents/", ""]) {
      const parts = relativePath.slice(prefix.length).split("/");
      if (relativePath.startsWith(prefix) && DIRS.includes(parts[0]) && parts.length > 1) {
        resourcePath = `${prefix}${parts[0]}/${parts[1]}`; break;
      }
    }
    const normalizedKind = /(?:^|\/)settings\.json$/.test(relativePath) ? "settings" : /(?:^|\/)models\.json$/.test(relativePath) ? "models" : /(?:^|\/)auth\.json$/.test(relativePath) ? "auth" : item.kind;
    let resource = resources.find((r) => r.rootId === rootId && r.relativePath === resourcePath);
    if (!resource) {
      resource = { id: `legacy-${resources.length}`, rootId, relativePath: resourcePath, label: `Historical ${resourcePath}`,
        kind: normalizedKind, executable, sensitive: ["auth", "session", "models", "settings"].includes(normalizedKind), availability: "offlineReady" };
      resources.push(resource);
    }
    const sha256 = await consume(item, i, !meta.includePrivate);
    entries.push({ path: item.path, rootId, resourceId: resource.id, relativePath, size: item.size, sha256, kind: normalizedKind });
  }
  await reader.end();
  return { formatVersion: 2, archiveId, appVersion: "historical", sdkVersion: "historical", createdAt: "1970-01-01T00:00:00.000Z", roots, resources, entries,
    warnings: [meta.includePrivate ? "Legacy v1 private backup: incomplete historical resource coverage; original paths are unavailable and projects require mapping" :
      "Legacy v1 public backup: contains only the historical defaultThinkingLevel/theme/enabledModelsSync settings, not a complete backup",
    "Legacy content has no original manifest; hashes were computed during authenticated import; configuration and customization activation requires review"] };
}
export { checkPublic as checkLegacyPublic };
