import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire as createMcpConfigRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { MCP_REDACTED, type McpConfigView, type McpMutation, type McpScope } from "./mcp-types.ts";

interface Context { agentDir: string; cwd?: string; projectTrusted: boolean }
type JsonObject = Record<string, unknown>;
type Validator = (name: string, config: unknown) => JsonObject | string;
const mcpRequire = createMcpConfigRequire(import.meta.url);
let validatorPromise: Promise<Validator> | undefined;

/** Client-facing messages deliberately never include parser or validator input. */
export class McpConfigError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "McpConfigError";
    this.status = status;
    this.code = code;
  }
}
function invalid(message = "MCP 配置无效，请检查填写内容。") {
  return new McpConfigError(400, "MCP_CONFIG_INVALID", message);
}
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function paths(context: Context) {
  if (typeof context.agentDir !== "string" || !isAbsolute(context.agentDir) || (context.cwd !== undefined && (typeof context.cwd !== "string" || !isAbsolute(context.cwd)))) {
    throw invalid("配置目录必须是绝对路径。");
  }
  return { global: join(context.agentDir, "mcp.json"), project: context.cwd ? join(context.cwd, ".pi", "mcp.json") : undefined };
}
function targetPath(context: Context, scope: McpScope) {
  if (scope !== "global" && scope !== "project") throw invalid("请选择全局或项目配置。");
  const path = paths(context)[scope];
  if (!path) throw invalid("当前没有可用的项目目录。");
  return path;
}
function trustedProject(context: Context) {
  if (!context.projectTrusted) throw new McpConfigError(403, "MCP_PROJECT_UNTRUSTED", "请先信任此项目，再修改项目 MCP 配置。");
}
function safeFile(path: string): Buffer | undefined {
  try {
    // A project cannot redirect configuration I/O through a .pi or mcp.json symlink.
    if (lstatSync(dirname(path)).isSymbolicLink() || lstatSync(path).isSymbolicLink()) throw invalid("配置路径不能是符号链接。");
    if (!lstatSync(path).isFile()) throw invalid("配置路径不是普通文件。");
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof McpConfigError) throw error;
    throw new McpConfigError(400, "MCP_CONFIG_UNREADABLE", "无法读取 MCP 配置，请检查文件权限。");
  }
}
function snapshot(context: Context) {
  const selected = paths(context);
  const global = safeFile(selected.global);
  // Never open project contents until the route has established project trust.
  const project = selected.project && context.projectTrusted ? safeFile(selected.project) : undefined;
  const hash = createHash("sha256");
  for (const value of ["mcp-config-v1", context.projectTrusted ? "trusted" : "untrusted", selected.global, selected.project ?? "", global, context.projectTrusted ? project : "project-not-read"]) {
    if (value === undefined) hash.update("absent;");
    else { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); hash.update(`present:${bytes.length}:`); hash.update(bytes); }
  }
  return { global, project, revision: hash.digest("hex") };
}
export function getMcpConfigRevision(context: Context): string {
  return snapshot(context).revision;
}
function parse(bytes: Buffer | undefined): JsonObject {
  if (!bytes) return {};
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); }
  catch { throw invalid("MCP 配置文件格式损坏，请先修复文件；原文件没有被修改。"); }
  if (!object(value) || (value.mcpServers !== undefined && !object(value.mcpServers))) throw invalid("MCP 配置必须是对象，mcpServers 必须是服务器列表对象。");
  if (object(value.mcpServers) && Object.values(value.mcpServers).some((entry) => !object(entry))) throw invalid("服务器配置必须是对象；原文件没有被修改。");
  return value;
}
async function coreValidator(): Promise<Validator> {
  validatorPromise ??= (async () => {
    let entry: string;
    try { entry = mcpRequire.resolve("@earendil-works/pi-coding-agent"); }
    catch {
      // 1.1.0 exposes only the ESM import condition, not a require condition.
      entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    }
    const core = await import(/* @vite-ignore */ pathToFileURL(join(dirname(entry), "core", "mcp-servers.js")).href);
    if (typeof core.validateMcpServerConfig !== "function") throw new Error("validator unavailable");
    return core.validateMcpServerConfig as Validator;
  })();
  try { return await validatorPromise; }
  catch { throw new McpConfigError(400, "MCP_VALIDATOR_UNAVAILABLE", "当前安装缺少 MCP 配置校验功能，暂时不能保存。"); }
}
const secretKey = /(?:secret|password|passwd|token|credential|authorization|api[-_]?key|access[-_]?key|private[-_]?key|signature|^sig$|^key$|^code$|^auth$)/i;
function credentialText(value: string): boolean {
  if (/(?:bearer|basic)\s+\S+/i.test(value) || /(?:token|password|passwd|secret|credential|api[-_]?key|access[-_]?key|authorization)(?:["']?\s*[=:]\s*|\s+)\S+/i.test(value) || /(?:^|\s)--(?:user(?:name)?|pass|password|passwd|token|secret|credential|client-secret|api[-_]?key|access[-_]?key)(?:[=\s]|$)/i.test(value)) return true;
  const urls = value.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  return urls.some((text) => {
    try { const url = new URL(text); return !!(url.username || url.password || [...url.searchParams.keys()].some((key) => secretKey.test(key)) || (url.hash && secretKey.test(url.hash))); }
    catch { return true; }
  });
}
function maskValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskValues);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, maskValues(entry)]));
  return MCP_REDACTED;
}
/** Safe for reuse by runtime views. Does not mutate or resolve environment variables. */
export function redactMcpConfig(config: JsonObject): JsonObject {
  function visit(value: unknown, key = ""): unknown {
    if (key === "env" || key === "headers") return maskValues(value);
    if (key !== "auth" && secretKey.test(key)) return MCP_REDACTED;
    if (key === "auth") return object(value) ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, name === "provider" ? visit(entry, name) : maskValues(entry)])) : MCP_REDACTED;
    // Arguments may carry positional credentials with no recognizable flag.
    // Preserve them as a whole placeholder rather than guess which are safe.
    if (key === "args" && (!Array.isArray(value) || value.length > 0)) return MCP_REDACTED;
    if (key === "command" && credentialText(String(value))) return MCP_REDACTED;
    if (typeof value === "string") return credentialText(value) ? MCP_REDACTED : value;
    if (Array.isArray(value)) return value.map((entry) => visit(entry));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, visit(entry, name)]));
    return value;
  }
  return visit(config) as JsonObject;
}
function overrideOnly(config: JsonObject) {
  return !["command", "url", "type"].some((key) => Object.hasOwn(config, key));
}
export async function readMcpConfigView(context: Context & { scope: McpScope }): Promise<McpConfigView> {
  const path = targetPath(context, context.scope);
  const base = { scope: context.scope, path, exists: existsSync(path), editable: context.scope === "global" || context.projectTrusted, servers: [] };
  try {
    const state = snapshot(context);
    if (!base.editable) return { ...base, revision: state.revision };
    const doc = parse(state[context.scope]);
    const servers = Object.entries((doc.mcpServers ?? {}) as JsonObject).map(([name, config]) => {
      if (!object(config)) throw invalid();
      return { name, config: redactMcpConfig(config), overrideOnly: context.scope === "project" && overrideOnly(config) };
    });
    return { ...base, revision: state.revision, servers };
  } catch (error) {
    return { ...base, editable: false, revision: "", error: error instanceof McpConfigError ? error.message : "无法读取 MCP 配置。" };
  }
}
function restore(value: unknown, old: unknown, exists: boolean): unknown {
  if (value === MCP_REDACTED) {
    if (!exists || old === MCP_REDACTED) throw invalid("隐藏值只能保留该服务器原有字段，不能用于新增凭据。");
    return structuredClone(old);
  }
  if (Array.isArray(value)) return value.map((entry, index) => restore(entry, exists && Array.isArray(old) && Object.hasOwn(old, index) ? old[index] : undefined, exists && Array.isArray(old) && Object.hasOwn(old, index)));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restore(entry, exists && object(old) && Object.hasOwn(old, key) ? old[key] : undefined, exists && object(old) && Object.hasOwn(old, key))]));
  return value;
}
function merge(old: JsonObject, incoming: JsonObject): JsonObject {
  // Partial updates retain unknown fields, including nested vendor options.
  return Object.fromEntries([...new Set([...Object.keys(old), ...Object.keys(incoming)])].map((key) => {
    if (!Object.hasOwn(incoming, key)) return [key, old[key]];
    const value = incoming[key];
    return [key, object(old[key]) && object(value) ? merge(old[key] as JsonObject, value) : value];
  }));
}
export async function mutateMcpConfig(context: Context, mutation: McpMutation): Promise<McpConfigView> {
  const path = targetPath(context, mutation.scope);
  if (mutation.scope === "project") trustedProject(context);
  if (typeof mutation.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(mutation.name) || !["upsert", "delete"].includes(mutation.operation)) throw invalid();
  if (mutation.operation === "upsert" && !object(mutation.config)) throw invalid();
  const validate = await coreValidator();
  // Lock a stable directory, not mcp.json's replaceable inode. Both scopes use
  // this same lock so their combined revision is checked in one critical section.
  let release: (() => Promise<void>) | undefined;
  try {
    mkdirSync(context.agentDir, { recursive: true, mode: 0o700 });
    release = await lockfile.lock(context.agentDir, { lockfilePath: join(context.agentDir, ".mcp-config-store.lock"), realpath: true, retries: { retries: 30, minTimeout: 10, maxTimeout: 100 } });
    const before = snapshot(context);
    if (mutation.revision !== before.revision) throw new McpConfigError(409, "MCP_CONFIG_CONFLICT", "配置已被其他操作修改，请刷新后重试。");
    const doc = parse(before[mutation.scope]);
    const servers = { ...((doc.mcpServers ?? {}) as JsonObject) };
    if (mutation.operation === "delete") delete servers[mutation.name];
    else {
      const old = Object.hasOwn(servers, mutation.name) ? servers[mutation.name] : undefined;
      if (old !== undefined && !object(old)) throw invalid();
      const incoming = restore(mutation.config, old, old !== undefined) as JsonObject;
      const candidate = merge(object(old) ? old : {}, incoming);
      const override = mutation.scope === "project" && overrideOnly(candidate);
      if (override && Object.keys(incoming).some((key) => !["enabled", "exposure", "toolExposure"].includes(key))) throw invalid("项目覆盖配置只允许修改启用状态和工具显示方式。");
      const result = validate(mutation.name, override ? { ...candidate, command: "__project_override__" } : candidate);
      if (typeof result === "string" || !object(result)) throw invalid();
      if (override) delete result.command;
      servers[mutation.name] = result;
    }
    const namespaces = new Set<string>();
    for (const name of Object.keys(servers)) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw invalid("服务器名称只能包含英文字母、数字、下划线和连字符。");
      const namespace = name.replace(/-/g, "_");
      if (namespaces.has(namespace)) throw invalid("服务器名称转换后重名，请更换名称。");
      namespaces.add(namespace);
    }
    // Also reject collisions introduced between the effective global/project lists.
    if (context.projectTrusted && context.cwd) {
      const other = parse(before[mutation.scope === "global" ? "project" : "global"]);
      const names = new Set([...Object.keys((other.mcpServers ?? {}) as JsonObject), ...Object.keys(servers)]);
      const normalized = new Set<string>();
      for (const name of names) {
        const namespace = name.replace(/-/g, "_");
        if (normalized.has(namespace)) throw invalid("全局和项目服务器名称转换后重名，请更换名称。");
        normalized.add(namespace);
      }
    }
    // Detect changes by editors that do not participate in our directory lock.
    if (snapshot(context).revision !== before.revision) throw new McpConfigError(409, "MCP_CONFIG_CONFLICT", "配置已被其他操作修改，请刷新后重试。");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(path, `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`);
    return await readMcpConfigView({ ...context, scope: mutation.scope });
  } catch (error) {
    if (error instanceof McpConfigError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new McpConfigError(409, "MCP_CONFIG_CONFLICT", "配置正在保存，请稍后刷新并重试。");
    throw new McpConfigError(400, "MCP_CONFIG_WRITE_FAILED", "无法保存 MCP 配置，请检查目录权限。");
  } finally {
    try { await release?.(); }
    catch { throw new McpConfigError(409, "MCP_CONFIG_LOCK_RELEASE_FAILED", "配置操作已处理，但保存锁释放失败，请稍后检查配置再重试。"); }
  }
}
