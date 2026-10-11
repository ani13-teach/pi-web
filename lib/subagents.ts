import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dump as stringifyYaml } from "js-yaml";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { builtinAgentDirectory, builtinDeletionPath, loadBuiltinAgents } from "../builtin/pi-subagents/src/builtin-agents";
import { loadCustomAgents, parseAgentFrontmatter, readAgentConfigFile } from "../builtin/pi-subagents/src/custom-agents";
import { BUILTIN_TOOL_NAMES, buildAgentRegistry, resolveEnabledTypeIn } from "../builtin/pi-subagents/src/agent-types";
import { loadSettings } from "../builtin/pi-subagents/src/settings";
import type { AgentConfig } from "../builtin/pi-subagents/src/types";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isExistingPathWithinRoots } from "./path-security";
import { sessionPathKey } from "./session-path";
import type { SessionEntry, SubagentSessionStatus } from "./types";

export const SUBAGENT_META_TYPE = "pi-web:subagent";
export const SUBAGENT_STATUS_TYPE = "pi-web:subagent-status";
export const SUBAGENT_RESULT_TYPE = "pi-web:subagent-result";
export const SUBAGENT_CONTROL_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent", "subagent_tasks"] as const;

export type SubagentStatus = SubagentSessionStatus;
export type SubagentScope = "builtin" | "global" | "workspace" | "project";
export type SubagentWritableScope = Extract<SubagentScope, "builtin" | "global" | "project">;

export interface SubagentProfile {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  extensionTools?: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  model?: string;
  fallbackModel?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  promptMode: "replace" | "append";
  color?: string;
  isolation?: "worktree" | "off";
  persistSession?: boolean;
  enabled: boolean;
  scope: SubagentScope;
  filePath?: string;
  /** Whether this source wins runtime resolution (disabled winners still veto lower sources). */
  effective?: boolean;
}

export interface SubagentMetadata {
  version: 1;
  parentSessionId: string;
  parentSessionPath: string;
  parentToolCallId: string;
  profile: string;
  description: string;
  task: string;
  runInBackground: boolean;
  createdAt: string;
  resourceSnapshot: SubagentResourceSnapshot;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface SubagentResourceSnapshot {
  version: 1;
  appendSystemPrompt: string[];
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  exactSystemPrompt?: string;
}

export interface SubagentSessionResources {
  appendSystemPrompt: string[];
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  exactSystemPrompt?: string;
}

export interface SubagentResultMetadata {
  version: 1;
  status: Exclude<SubagentStatus, "starting" | "running" | "queued" | "interrupted">;
  completedAt: string;
  result?: string;
  error?: string;
  worktreeCleanupError?: string;
}

export interface SubagentStatusMetadata {
  version: 1;
  status: Extract<SubagentStatus, "queued" | "running">;
}

export interface SubagentRunInfo {
  sessionId: string;
  sessionPath: string;
  parentSessionId: string;
  parentToolCallId: string;
  profile: string;
  description: string;
  task: string;
  runInBackground: boolean;
  status: SubagentStatus;
  createdAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCleanupError?: string;
}

const DEFAULT_TOOLS = BUILTIN_TOOL_NAMES;
const BUILTIN_TOOLS = new Set(DEFAULT_TOOLS);
const SUBAGENT_CONTROL_TOOLS = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Frontmatter keys the web UI owns. Everything else in a profile file belongs to
 * whichever runtime reads it (pi-subagents and friends), so a save from this app must
 * carry those keys through untouched. Dropping them silently changed behaviour:
 * `allowed_subagents` was lost and an orchestrator could no longer spawn anything,
 * `exclude_extensions` was lost and an opt-out became an opt-in.
 */
const MANAGED_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "display_name",
  "tools",
  "load_skills",
  "load_extensions",
  "enabled",
  "inherit_context",
  "run_in_background",
  "model",
  "fallback_model",
  "thinking",
  "max_turns",
  "prompt_mode",
  "color",
  "isolation",
  "persist_session",
]);

const FRONTMATTER_OPEN_RE = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\n|\r)/;

/**
 * The UI exposes two booleans (`load_skills` / `load_extensions`); pi-subagents reads
 * the aliases `skills` / `extensions`, which also accept a whitelist. Aliases are
 * carried through by `unmanagedFrontmatter` and only rewritten once we own them.
 */
const OWNED_ALIAS_VALUES = new Set(["none", "all", "true", "false"]);

/** UI projection only: parsing and defaults belong to the native runtime. */
function profileFromConfig(config: AgentConfig, scope: SubagentScope, defaultRunInBackground = true): SubagentProfile {
  const denied = new Set(config.disallowedTools ?? []);
  return {
    name: config.name,
    displayName: config.displayName ?? config.name,
    description: config.description,
    systemPrompt: config.systemPrompt,
    tools: [...(config.builtinToolNames ?? DEFAULT_TOOLS)].filter((tool) => !denied.has(tool)),
    ...(config.extSelectors ? { extensionTools: [...config.extSelectors] } : {}),
    loadSkills: config.skills !== false,
    loadExtensions: config.extensions !== false,
    model: config.model,
    fallbackModel: config.fallbackModel,
    thinking: config.thinking,
    maxTurns: config.maxTurns,
    inheritContext: config.inheritContext ?? false,
    runInBackground: config.runInBackground ?? defaultRunInBackground,
    promptMode: config.promptMode,
    color: config.color,
    isolation: config.isolation,
    persistSession: config.persistSession,
    enabled: config.enabled !== false,
    scope,
    ...(config.sourcePath ? { filePath: config.sourcePath } : {}),
  };
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return values.map((item) => String(item).trim()).filter(Boolean);
}

/** Read existing frontmatter without allowing malformed metadata to be overwritten. */
function readStoredFrontmatter(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const source = readFileSync(filePath, "utf8");
  try {
    const { frontmatter } = parseAgentFrontmatter<Record<string, unknown>>(source);
    if (!isRecord(frontmatter)) throw new Error("Expected a frontmatter object");
    // The native parser tolerates an unclosed fence as body. Do not overwrite it.
    if (FRONTMATTER_OPEN_RE.test(source) && !source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").includes("\n---")) {
      throw new Error("Unclosed frontmatter");
    }
    return frontmatter;
  } catch {
    throw new Error("Cannot save agent profile: existing frontmatter is invalid");
  }
}

/** Keys another runtime owns, in file order, so a save round-trips them. */
function unmanagedFrontmatter(stored: Record<string, unknown>): Record<string, unknown> {
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!MANAGED_FRONTMATTER_KEYS.has(key)) preserved[key] = value;
  }
  return preserved;
}

/**
 * pi-web filters `tools` down to the built-ins it can dispatch, which would drop
 * another runtime's `ext:<name>` selectors on every save — carry them through.
 */
function composeToolsField(tools: string[], storedTools: unknown): string {
  const selectors = stringList(storedTools).filter((tool) => tool.startsWith("ext:"));
  const combined = [...tools, ...selectors.filter((selector) => !tools.includes(selector))];
  return combined.length > 0 ? combined.join(", ") : "none";
}

/**
 * Keep the alias in step with the boolean the UI owns. A boolean (or a "none" /
 * "all" spelling) is ours to rewrite; a whitelist such as `extensions:
 * pi-advisor-flow` expresses scoping the UI cannot show, so it stays as authored.
 */
function syncFlagAlias(
  frontmatter: Record<string, unknown>,
  alias: string,
  storedValue: unknown,
  flag: boolean,
): void {
  const owned = storedValue === undefined
    || typeof storedValue === "boolean"
    || (typeof storedValue === "string" && OWNED_ALIAS_VALUES.has(storedValue.trim().toLowerCase()));
  if (owned) frontmatter[alias] = flag;
}

function isProjectProfilePathAllowed(cwd: string, target: string): boolean {
  return isExistingPathWithinRoots(target, new Set([cwd]));
}

function readProfileDirectory(dir: string, scope: SubagentScope, cwd: string, defaultRunInBackground = true): SubagentProfile[] {
  if (!existsSync(dir)) return [];
  if (scope !== "global" && scope !== "builtin" && !isProjectProfilePathAllowed(cwd, dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .flatMap((entry) => {
      const filePath = join(dir, entry.name);
      if (scope !== "global" && scope !== "builtin" && !isProjectProfilePathAllowed(cwd, filePath)) return [];
      const config = readAgentConfigFile(filePath, scope === "global" ? "global" : "project");
      return config ? [profileFromConfig(config, scope, defaultRunInBackground)] : [];
    });
}

function profileDirectories(cwd: string): Array<[string, Exclude<SubagentScope, "builtin">]> {
  return [
    [join(getAgentDir(), "agents"), "global"],
    [join(resolve(cwd), ".agents", "agents"), "workspace"],
    [join(resolve(cwd), ".pi", "agents"), "project"],
  ];
}

/** Every configured source, including profiles shadowed by a higher-precedence scope. */
export function listSubagentProfileSources(cwd: string): SubagentProfile[] {
  const settings = loadSettings(cwd);
  const defaultBackground = settings.backgroundByDefault ?? true;
  // Share the actual runtime merger, not a second UI-only last-source-wins rule.
  const registry = buildAgentRegistry(loadCustomAgents(cwd), {
    disableDefaults: settings.disableDefaultAgents === true,
  });
  const profiles: SubagentProfile[] = [];
  for (const [dir, scope] of profileDirectories(cwd)) {
    profiles.push(...readProfileDirectory(dir, scope, cwd, defaultBackground));
  }
  // Keep suppressed factory presets available for editing, but mark them inactive.
  profiles.push(...[...loadBuiltinAgents().values()].map((config) => profileFromConfig(config, "builtin", defaultBackground)));
  return profiles.map((profile) => {
    const winner = registry.get(profile.name);
    return {
      ...profile,
      effective: !!winner && winner.sourcePath === profile.filePath
        && (winner.source === "default") === (profile.scope === "builtin"),
    };
  });
}

export function listSubagentProfiles(cwd: string): SubagentProfile[] {
  return listSubagentProfileSources(cwd).filter((profile) => profile.effective)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function resolveSubagentProfile(cwd: string, name: string): SubagentProfile | undefined {
  const profiles = listSubagentProfiles(cwd);
  // Only identity/enabled fields matter to the native pure resolver.
  const registry = new Map(profiles.map((profile) => [profile.name, {
    name: profile.name, enabled: profile.enabled,
  } as AgentConfig]));
  const key = resolveEnabledTypeIn(registry, name);
  return key === undefined ? undefined : profiles.find((profile) => profile.name === key);
}

function assertProfileName(name: string): string {
  const normalized = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    throw new Error("Agent name may contain only ASCII letters, numbers, dots, underscores, and hyphens, starting with a letter or number");
  }
  return normalized;
}

function writableProfileDirectory(cwd: string, scope: SubagentWritableScope): string {
  if (scope === "builtin") return builtinAgentDirectory();
  if (scope === "global") return join(getAgentDir(), "agents");
  if (scope === "project") return join(resolve(cwd), ".pi", "agents");
  throw new Error("Agent scope must be builtin, global or project");
}

function assertWritableProfileDirectory(cwd: string, scope: SubagentWritableScope): string {
  const dir = writableProfileDirectory(cwd, scope);
  if (scope !== "project") return dir;

  let existingAncestor = dir;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error("Agent profile directory is outside the project root");
    existingAncestor = parent;
  }
  if (!isProjectProfilePathAllowed(cwd, existingAncestor)) {
    throw new Error("Agent profile directory is outside the project root");
  }
  return dir;
}

/** Resolve declared identities back to their files without inventing a second file. */
function writableProfilePath(cwd: string, scope: SubagentWritableScope, name: string, filePath?: string): string {
  const dir = assertWritableProfileDirectory(cwd, scope);
  const matches = readProfileDirectory(dir, scope, cwd).filter((profile) => profile.name === name);
  if (!filePath && matches.length > 1) throw new Error("Agent name has multiple source files; select a source file to save");
  const target = filePath ? resolve(filePath) : matches[0]?.filePath ?? join(dir, `${name}.md`);
  if (resolve(dirname(target)) !== resolve(dir)) throw new Error("Agent profile path is outside its scope directory");
  if (filePath && !matches.some((profile) => resolve(profile.filePath!) === target)) {
    throw new Error("Agent profile source does not match its declared name");
  }
  if (scope === "project" && existsSync(target) && !isProjectProfilePathAllowed(cwd, target)) {
    throw new Error("Agent profile path is outside the project root");
  }
  return target;
}

export function saveSubagentProfile(
  cwd: string,
  scope: SubagentWritableScope,
  profile: Omit<SubagentProfile, "scope">,
  options: { originalName?: string; createOnly?: boolean } = {},
): SubagentProfile {
  const name = assertProfileName(profile.name);
  const originalName = options.originalName === undefined ? name : assertProfileName(options.originalName);
  const renaming = originalName !== name;
  const sources = listSubagentProfileSources(cwd).filter((source) => source.scope === scope);
  if (options.originalName !== undefined && !sources.some((source) => source.name === originalName)) {
    throw new Error("Agent profile not found");
  }
  if ((renaming || options.createOnly) && sources.some((source) => source.name === name)) {
    throw new Error("Agent ID already exists in this scope");
  }
  const tools = [...new Set(profile.tools.filter((tool) => BUILTIN_TOOLS.has(tool)))];
  if (profile.extensionTools !== undefined && (!Array.isArray(profile.extensionTools) || profile.extensionTools.some((tool) => typeof tool !== "string"))) {
    throw new Error("Extension tools must be an array of selectors");
  }
  const extensionTools = [...new Set((profile.extensionTools ?? []).map((tool) => tool.trim()).filter(Boolean))];
  if (extensionTools.some((tool) => !/^ext:[^\s,/]+(?:\/[^\s,]+)?$/.test(tool))) {
    throw new Error("Extension tool selectors require ext:<extension> or ext:<extension>/<tool>, with no empty names, spaces or commas");
  }
  if (profile.isolation !== undefined && profile.isolation !== "off" && profile.isolation !== "worktree") {
    throw new Error("Isolation must be off or worktree");
  }
  if (profile.persistSession !== undefined && typeof profile.persistSession !== "boolean") {
    throw new Error("Persist session must be a boolean");
  }
  if (profile.promptMode !== undefined && profile.promptMode !== "append" && profile.promptMode !== "replace") {
    throw new Error("Prompt mode must be append or replace");
  }
  if (profile.thinking && !THINKING_LEVELS.has(profile.thinking)) {
    throw new Error(`Invalid thinking level: ${profile.thinking}`);
  }
  if (profile.maxTurns !== undefined && (!Number.isFinite(profile.maxTurns) || profile.maxTurns < 0)) {
    throw new Error("Max turns must be a non-negative number");
  }
  const maxTurns = profile.maxTurns !== undefined ? Math.floor(profile.maxTurns) : undefined;
  const displayName = profile.displayName.trim() || name;
  const description = profile.description.trim() || name;
  const systemPrompt = profile.systemPrompt.trim();
  const model = profile.model?.trim() || undefined;
  if (profile.fallbackModel !== undefined && typeof profile.fallbackModel !== "string") {
    throw new Error("Fallback model must be a string");
  }
  const fallbackModel = profile.fallbackModel?.trim() || undefined;
  const loadSkills = profile.loadSkills === true;
  const loadExtensions = profile.loadExtensions === true;
  const promptMode = profile.promptMode === "append" ? "append" : "replace";
  const sourcePath = writableProfilePath(cwd, scope, originalName, profile.filePath);
  const filePath = renaming ? join(assertWritableProfileDirectory(cwd, scope), `${name}.md`) : sourcePath;
  const sameFile = process.platform === "win32"
    ? resolve(filePath).toLowerCase() === resolve(sourcePath).toLowerCase()
    : resolve(filePath) === resolve(sourcePath);
  if ((renaming && !sameFile || options.createOnly) && existsSync(filePath)) {
    throw new Error("Agent ID destination file already exists");
  }
  const dir = assertWritableProfileDirectory(cwd, scope);
  mkdirSync(dir, { recursive: true });
  if (scope === "project" && !isProjectProfilePathAllowed(cwd, dir)) {
    throw new Error("Agent profile directory is outside the project root");
  }
  const stored = readStoredFrontmatter(sourcePath);
  const managed: Record<string, unknown> = {
    name,
    description,
    display_name: displayName,
    tools: composeToolsField([...tools, ...extensionTools], profile.extensionTools === undefined ? stored.tools : undefined),
    load_skills: loadSkills,
    load_extensions: loadExtensions,
    enabled: profile.enabled,
    inherit_context: profile.inheritContext,
    run_in_background: profile.runInBackground,
    prompt_mode: promptMode,
  };
  syncFlagAlias(managed, "skills", stored.skills, loadSkills);
  syncFlagAlias(managed, "extensions", stored.extensions, loadExtensions);
  if (model) managed.model = model;
  // Older clients omit the field; only an explicit empty value clears it.
  if (profile.fallbackModel === undefined && "fallback_model" in stored) {
    managed.fallback_model = stored.fallback_model;
  } else if (fallbackModel) {
    managed.fallback_model = fallbackModel;
  }
  if (profile.thinking) managed.thinking = profile.thinking;
  if (maxTurns !== undefined) managed.max_turns = maxTurns;
  if (profile.color?.trim()) managed.color = profile.color.trim();
  if (profile.isolation) managed.isolation = profile.isolation;
  if (profile.persistSession !== undefined) managed.persist_session = profile.persistSession;
  // Managed keys win; keys this app does not own follow in their original order.
  const frontmatter: Record<string, unknown> = { ...managed };
  for (const [key, value] of Object.entries(unmanagedFrontmatter(stored))) {
    if (!(key in frontmatter)) frontmatter[key] = value;
  }
  const yaml = stringifyYaml(frontmatter, { noRefs: true, lineWidth: 1000 }).trimEnd();
  writePrivateFileAtomicSync(filePath, `---\n${yaml}\n---\n\n${systemPrompt}\n`);
  if (renaming && scope === "builtin") markBuiltinDeleted(originalName);
  if (renaming && !sameFile && existsSync(sourcePath)) unlinkSync(sourcePath);
  if (scope === "builtin" && existsSync(builtinDeletionPath(name))) unlinkSync(builtinDeletionPath(name));
  // Return what the runtime reads, including preserved extension/skill whitelists.
  const config = readAgentConfigFile(filePath, scope === "project" ? "project" : "global", true);
  if (!config) throw new Error("Saved agent profile could not be read");
  return profileFromConfig(config, scope, loadSettings(cwd).backgroundByDefault ?? true);
}

function markBuiltinDeleted(name: string): void {
  const marker = builtinDeletionPath(name);
  mkdirSync(dirname(marker), { recursive: true });
  writePrivateFileAtomicSync(marker, "deleted\n");
}

export function deleteSubagentProfile(cwd: string, scope: SubagentWritableScope, name: string, sourcePath?: string): void {
  const safeName = assertProfileName(name);
  const filePath = writableProfilePath(cwd, scope, safeName, sourcePath);
  if (scope === "builtin") {
    if (!loadBuiltinAgents().has(safeName)) throw new Error("Agent profile not found");
    markBuiltinDeleted(safeName);
  }
  if (existsSync(filePath)) unlinkSync(filePath);
}

export function saveProjectSubagentProfile(cwd: string, profile: Omit<SubagentProfile, "scope" | "filePath">): SubagentProfile {
  return saveSubagentProfile(cwd, "project", profile);
}

export function deleteProjectSubagentProfile(cwd: string, name: string): void {
  deleteSubagentProfile(cwd, "project", name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ValidSubagentMetadataData = Record<string, unknown> & {
  version: 1;
  parentSessionId: string;
  parentSessionPath: string;
};

function subagentMetadataData(entries: readonly SessionEntry[]): ValidSubagentMetadataData | null {
  const metaEntry = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
  if (!metaEntry || metaEntry.type !== "custom" || !isRecord(metaEntry.data)) return null;
  const data = metaEntry.data;
  if (data.version !== 1 || typeof data.parentSessionId !== "string" || typeof data.parentSessionPath !== "string") return null;
  return data as ValidSubagentMetadataData;
}

/** Restore the isolated prompt and tool scope used by a persisted subagent session. */
export function readSubagentSessionResources(
  entries: readonly SessionEntry[],
): SubagentSessionResources | null {
  const data = subagentMetadataData(entries);
  if (!data) return null;
  const snapshot = data.resourceSnapshot;
  const loadSkills = isRecord(snapshot) && snapshot.loadSkills === true;
  const loadExtensions = isRecord(snapshot) && snapshot.loadExtensions === true;
  if (
    isRecord(snapshot)
    && snapshot.version === 1
    && Array.isArray(snapshot.appendSystemPrompt)
    && snapshot.appendSystemPrompt.every((item) => typeof item === "string")
    && Array.isArray(snapshot.tools)
    && snapshot.tools.every((item) =>
      typeof item === "string"
      && item.length > 0
      && !SUBAGENT_CONTROL_TOOLS.has(item)
      && (BUILTIN_TOOLS.has(item) || loadExtensions)
    )
  ) {
    return {
      appendSystemPrompt: [...snapshot.appendSystemPrompt],
      tools: [...new Set(snapshot.tools)],
      loadSkills,
      loadExtensions,
      ...(typeof snapshot.exactSystemPrompt === "string" ? { exactSystemPrompt: snapshot.exactSystemPrompt } : {}),
    };
  }
  return null;
}

export function withSubagentExtensionTools(
  profileTools: readonly string[],
  extensionToolNames: Iterable<string>,
): string[] {
  return [...new Set([
    ...profileTools,
    ...[...extensionToolNames].filter((name) => !SUBAGENT_CONTROL_TOOLS.has(name)),
  ])];
}

export function selectSubagentExtensionTools(
  extensions: Iterable<{ path: string; sourceInfo?: { source?: string }; tools: Map<string, unknown> }>,
  selectors: readonly string[],
): string[] {
  const wanted = selectors.map((selector) => selector.slice(4).toLowerCase());
  return [...extensions].flatMap((extension) => {
    const pathName = extension.path.replaceAll("\\", "/").split("/").at(-2) ?? extension.path;
    const sourceName = (extension.sourceInfo?.source ?? "").replace(/^npm:/, "");
    const extensionNames = new Set([pathName.toLowerCase(), sourceName.toLowerCase()]);
    const selected = wanted.some((selector) => {
      if (selector === "*") return true;
      const [extensionName, toolName] = selector.split("/", 2);
      return extensionNames.has(extensionName) && (!toolName || extension.tools.has(toolName));
    });
    if (!selected) return [];
    return [...extension.tools.keys()].filter((toolName) => wanted.some((selector) => {
      if (selector === "*" || selector.endsWith("/*")) return selector === "*" || extensionNames.has(selector.slice(0, -2));
      const [extensionName, selectedTool] = selector.split("/", 2);
      return extensionNames.has(extensionName) && (!selectedTool || selectedTool === toolName);
    }));
  });
}

export function readSubagentRun(entries: readonly SessionEntry[], sessionId: string, sessionPath: string, parentSessionPath?: string): SubagentRunInfo | null {
  const data = subagentMetadataData(entries);
  if (!data) return null;
  // Forks copy custom entries from their source branch. That inherited marker
  // is not evidence that the new conversation belongs to the same spawner.
  if (parentSessionPath !== undefined && (!parentSessionPath || sessionPathKey(data.parentSessionPath) !== sessionPathKey(parentSessionPath))) return null;
  const lifecycleEntry = [...entries].reverse().find((entry) => {
    if (entry.type !== "custom" || !isRecord(entry.data) || entry.data.version !== 1) return false;
    const status = entry.data.status;
    return entry.customType === SUBAGENT_STATUS_TYPE
      ? status === "queued" || status === "running"
      : entry.customType === SUBAGENT_RESULT_TYPE && (status === "completed" || status === "failed" || status === "aborted");
  });
  const resultEntry = lifecycleEntry?.type === "custom" && lifecycleEntry.customType === SUBAGENT_RESULT_TYPE
    ? lifecycleEntry
    : undefined;
  const result = resultEntry?.type === "custom" && isRecord(resultEntry.data) ? resultEntry.data : undefined;
  const statusEntry = lifecycleEntry?.type === "custom" && lifecycleEntry.customType === SUBAGENT_STATUS_TYPE
    ? lifecycleEntry
    : undefined;
  const statusData = statusEntry?.type === "custom" && isRecord(statusEntry.data) ? statusEntry.data : undefined;
  const persistedStatus = result && (result.status === "completed" || result.status === "failed" || result.status === "aborted")
    ? result.status
    : statusData?.version === 1 && (statusData.status === "queued" || statusData.status === "running")
      ? statusData.status
      : "interrupted";
  return {
    sessionId,
    sessionPath,
    parentSessionId: data.parentSessionId,
    parentToolCallId: typeof data.parentToolCallId === "string" ? data.parentToolCallId : "",
    profile: typeof data.profile === "string" ? data.profile : "general-purpose",
    description: typeof data.description === "string" ? data.description : "Subagent",
    task: typeof data.task === "string" ? data.task : "",
    runInBackground: data.runInBackground === true,
    status: persistedStatus,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    ...(result && typeof result.completedAt === "string" ? { completedAt: result.completedAt } : {}),
    ...(result && typeof result.result === "string" ? { result: result.result } : {}),
    ...(result && typeof result.error === "string" ? { error: result.error } : {}),
    ...(typeof data.worktreePath === "string" ? { worktreePath: data.worktreePath } : {}),
    ...(typeof data.worktreeBranch === "string" ? { worktreeBranch: data.worktreeBranch } : {}),
    ...(result && typeof result.worktreeCleanupError === "string" ? { worktreeCleanupError: result.worktreeCleanupError } : {}),
  };
}
