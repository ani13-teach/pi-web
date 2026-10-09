import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadSettings as loadNativeSettings } from "../builtin/pi-subagents/src/settings";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isPathWithinRoots } from "./path-security";
import {
  DEFAULT_SUBAGENT_RUNTIME_SETTINGS,
  RUNTIME_SETTING_FIELDS,
  type RuntimeSettingField,
  type RuntimeSettingsScope,
  type SubagentRuntimeSettings,
  type SubagentRuntimeSettingsResponse,
} from "./subagent-runtime-schema";

export { DEFAULT_SUBAGENT_RUNTIME_SETTINGS, RUNTIME_SETTING_FIELDS } from "./subagent-runtime-schema";
export type { RuntimeSettingsScope, SubagentRuntimeSettings, SubagentRuntimeSettingsResponse } from "./subagent-runtime-schema";

function validateScope(scope: RuntimeSettingsScope): void {
  if (scope !== "global" && scope !== "project") throw new Error("scope must be global or project");
}

function validateCwd(cwd: string): void {
  if (typeof cwd !== "string" || !isAbsolute(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error("Valid absolute cwd directory required");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check each existing component, including dangling links, before reading/writing. */
function validateSettingsPath(filePath: string, root: string): void {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A dangling root link is not a missing directory.
      try { lstatSync(root); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") return;
        throw missing;
      }
    }
    throw error;
  }
  let component = root;
  for (const part of relative(root, filePath).split(sep)) {
    component = join(component, part);
    try {
      lstatSync(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!isPathWithinRoots(realpathSync(component), new Set([realRoot]))) {
      throw new Error("Access denied");
    }
  }
}

function readDocument(filePath: string, root: string): Record<string, unknown> {
  validateSettingsPath(filePath, root);
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid JSON in ${filePath}`);
  }
  if (!isObject(parsed)) throw new Error(`Invalid settings in ${filePath}: expected a JSON object`);
  return parsed;
}

function validateValue(field: RuntimeSettingField, value: unknown): void {
  switch (field.type) {
    case "number":
      if (typeof value !== "number" || !Number.isInteger(value)
        || value < field.min! || value > field.max!) {
        throw new Error(`${field.key} must be an integer between ${field.min} and ${field.max}`);
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${field.key} must be a boolean`);
      break;
    case "select":
      if (typeof value !== "string" || !field.options!.includes(value)) {
        throw new Error(`${field.key} must be one of ${field.options!.join(", ")}`);
      }
      break;
    case "text":
      if (typeof value !== "string" || !value.trim()) throw new Error(`${field.key} must be a non-empty string`);
      break;
  }
}

function readLayer(document: Record<string, unknown>, filePath: string): Partial<SubagentRuntimeSettings> {
  const layer: Record<string, unknown> = {};
  for (const field of RUNTIME_SETTING_FIELDS) {
    if (!Object.hasOwn(document, field.key)) continue;
    // Native accepts false as the strict-dispatch spelling of "none".
    const value = field.key === "fallbackSubagent" && document[field.key] === false
      ? "none" : document[field.key];
    try {
      validateValue(field, value);
    } catch (error) {
      throw new Error(`Invalid settings in ${filePath}: ${(error as Error).message}`);
    }
    layer[field.key] = field.type === "text" ? (value as string).trim() : value;
  }
  return layer as Partial<SubagentRuntimeSettings>;
}

function loadSettings(cwd: string, agentDir: string) {
  validateCwd(cwd);
  const globalPath = join(resolve(agentDir), "subagents.json");
  const projectPath = join(cwd, ".pi", "subagents.json");
  const globalDocument = readDocument(globalPath, resolve(agentDir));
  const projectDocument = readDocument(projectPath, cwd);
  const global = readLayer(globalDocument, globalPath);
  const project = readLayer(projectDocument, projectPath);
  // Only an explicit valid legacy value participates; its old reader's default
  // must not turn an absent key into an override. The legacy file is never written.
  const legacy = readDocument(join(resolve(agentDir), "agents", "settings.json"), resolve(agentDir));
  let legacyMaxConcurrent: number | undefined;
  if (Object.hasOwn(legacy, "maxConcurrent")) {
    try {
      validateValue(RUNTIME_SETTING_FIELDS[0], legacy.maxConcurrent);
      legacyMaxConcurrent = legacy.maxConcurrent as number;
    } catch {
      // Legacy invalid numbers don't contribute to native runtime settings.
    }
  }
  return { globalPath, projectPath, globalDocument, projectDocument, global, project, legacyMaxConcurrent };
}

function responseFor(
  scope: RuntimeSettingsScope,
  settings: ReturnType<typeof loadSettings>,
): SubagentRuntimeSettingsResponse {
  const { global, project, legacyMaxConcurrent } = settings;
  return {
    scope,
    filePath: scope === "global" ? settings.globalPath : settings.projectPath,
    values: { ...(scope === "global" ? global : project) },
    effective: {
      ...DEFAULT_SUBAGENT_RUNTIME_SETTINGS,
      ...(legacyMaxConcurrent === undefined ? {} : { maxConcurrent: legacyMaxConcurrent }),
      ...global,
      ...project,
    },
    global,
    project,
    ...(legacyMaxConcurrent === undefined ? {} : { legacyMaxConcurrent }),
  };
}

// Runtime startup deliberately follows native's tolerant loader. The editor
// remains strict, but a malformed unrelated field must not interrupt session_start.
export function resolveSubagentRuntimeMaxConcurrent(cwd: string): number {
  const native = loadNativeSettings(cwd).maxConcurrent;
  if (native !== undefined) return native;
  try {
    const legacy = readDocument(join(getAgentDir(), "agents", "settings.json"), getAgentDir()).maxConcurrent;
    const field = RUNTIME_SETTING_FIELDS.find((entry) => entry.key === "maxConcurrent")!;
    validateValue(field, legacy);
    return legacy as number;
  } catch {
    return DEFAULT_SUBAGENT_RUNTIME_SETTINGS.maxConcurrent;
  }
}

export function readSubagentRuntimeSettings(
  cwd: string,
  scope: RuntimeSettingsScope = "global",
  agentDir = getAgentDir(),
): SubagentRuntimeSettingsResponse {
  validateScope(scope);
  return responseFor(scope, loadSettings(cwd, agentDir));
}

export function writeSubagentRuntimeSettings(
  cwd: string,
  scope: RuntimeSettingsScope,
  patch: Record<string, unknown>,
  agentDir = getAgentDir(),
): SubagentRuntimeSettingsResponse {
  validateScope(scope);
  if (!isObject(patch)) throw new Error("patch must be a JSON object");
  for (const [key, value] of Object.entries(patch)) {
    const field = RUNTIME_SETTING_FIELDS.find((candidate) => candidate.key === key);
    if (!field) throw new Error(`Unknown runtime setting: ${key}`);
    if (value !== null) validateValue(field, value);
  }

  // Validate both layers before any filesystem mutation, even the inactive one.
  const settings = loadSettings(cwd, agentDir);
  const document = scope === "global" ? settings.globalDocument : settings.projectDocument;
  const filePath = scope === "global" ? settings.globalPath : settings.projectPath;
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      if (Object.hasOwn(document, key)) {
        delete document[key];
        changed = true;
      }
    } else if (!Object.hasOwn(document, key) || document[key] !== value) {
      const normalized = value !== null && typeof value === "string" ? value.trim() : value;
      document[key] = normalized;
      changed = true;
    }
  }
  if (changed) {
    mkdirSync(dirname(filePath), { recursive: true });
    writePrivateFileAtomicSync(filePath, `${JSON.stringify(document, null, 2)}\n`);
  }
  settings[scope] = readLayer(document, filePath);
  return responseFor(scope, settings);
}
