/**
 * Reads and writes the auto-mode configuration.
 *
 * The values live in the files pi-automode itself reads, so the panel works
 * whether the running copy is the one shipped in this build or a plugin
 * installed under `~/.pi/agent/extensions/pi-automode`:
 *
 * - global:  `~/.pi/agent/extensions/pi-automode/config.json`
 * - project: `<cwd>/.pi/automode.local.json` (read only for a trusted project)
 *
 * Scalar settings use last-one-wins precedence (project, then global, then the
 * built-in default); `deniedPaths` accumulates across both scopes. The
 * effective values and every file that was ignored come back from the
 * vendored loader, so the panel never has to guess.
 */
import { NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { BUILTIN_AUTOMODE_BASED_ON, BUILTIN_AUTOMODE_VERSION } from "@/lib/automode-builtin";
import {
  DEFAULT_ALLOW_INSIDE_WORKING_DIRECTORY,
  DEFAULT_CLASSIFY_READ_ONLY_TOOLS,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  DEFAULT_FAST_CLASSIFIER_MAX_TOKENS,
  DEFAULT_LOG_CONFIG,
  DEFAULT_MAX_TOOL_TRANSCRIPT_TOKENS,
  DEFAULT_MAX_USER_TRANSCRIPT_TOKENS,
  MAX_CLASSIFIER_TIMEOUT_MS,
  PI_GLOBAL_SETTINGS,
  PI_PROJECT_LOCAL_SETTINGS,
} from "@/builtin/automode/extensions/auto-mode/constants.ts";
import {
  loadEffectiveConfigWithDiagnostics,
  validateSettingsFile,
} from "@/builtin/automode/extensions/auto-mode/config.ts";
import { parseModelSpec } from "@/builtin/automode/extensions/auto-mode/model.ts";
import type {
  EffectiveConfig,
  SettingsFile,
} from "@/builtin/automode/extensions/auto-mode/types.ts";

export const dynamic = "force-dynamic";

const MIN_CLASSIFIER_TIMEOUT_MS = 1000;
const MIN_FAST_CLASSIFIER_MAX_TOKENS = 16;
const MIN_TRANSCRIPT_TOKENS = 32;
const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Keys the panel owns. Anything else is rejected instead of silently stored. */
const MANAGED_KEYS = new Set([
  "enabled",
  "classifierModel",
  "classifierFallbackModels",
  "classifierReasoningLevel",
  "classifierTimeoutMs",
  "fastClassifierMaxTokens",
  "maxUserTranscriptTokens",
  "maxToolTranscriptTokens",
  "classifyReadOnlyTools",
  "allowInsideWorkingDirectory",
  "deniedPaths",
  "log",
]);

export const DEFAULTS = {
  classifierTimeoutMs: DEFAULT_CLASSIFIER_TIMEOUT_MS,
  fastClassifierMaxTokens: DEFAULT_FAST_CLASSIFIER_MAX_TOKENS,
  maxUserTranscriptTokens: DEFAULT_MAX_USER_TRANSCRIPT_TOKENS,
  maxToolTranscriptTokens: DEFAULT_MAX_TOOL_TRANSCRIPT_TOKENS,
  classifyReadOnlyTools: DEFAULT_CLASSIFY_READ_ONLY_TOOLS,
  allowInsideWorkingDirectory: DEFAULT_ALLOW_INSIDE_WORKING_DIRECTORY,
  log: DEFAULT_LOG_CONFIG,
  minClassifierTimeoutMs: MIN_CLASSIFIER_TIMEOUT_MS,
  maxClassifierTimeoutMs: MAX_CLASSIFIER_TIMEOUT_MS,
  minFastClassifierMaxTokens: MIN_FAST_CLASSIFIER_MAX_TOKENS,
  minTranscriptTokens: MIN_TRANSCRIPT_TOKENS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJsonObject(path: string): { value: Record<string, unknown> | null; error: string | null } {
  if (!existsSync(path)) return { value: null, error: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return { value: null, error: `${path}: expected a JSON object` };
    return { value: parsed, error: null };
  } catch (error) {
    return { value: null, error: `${path}: ${errorMessage(error)}` };
  }
}

function autoModeOf(file: Record<string, unknown> | null): Record<string, unknown> {
  if (!file) return {};
  return isRecord(file.autoMode) ? file.autoMode : {};
}

/**
 * Which file a value came from. Scalars are last-one-wins, so the answer is the
 * first scope that sets them; lists that accumulate are reported as merged.
 */
function sourceOf(
  key: string,
  project: Record<string, unknown>,
  global: Record<string, unknown>,
): "project" | "global" | "default" | "merged" {
  const inProject = key in project;
  const inGlobal = key in global;
  if (key === "deniedPaths") {
    if (inProject && inGlobal) return "merged";
    if (inProject) return "project";
    if (inGlobal) return "global";
    return "default";
  }
  if (inProject) return "project";
  if (inGlobal) return "global";
  return "default";
}

function effectiveSummary(config: EffectiveConfig) {
  return {
    enabled: config.enabled,
    classifierModel: config.classifierModel ?? null,
    classifierFallbackModels: config.classifierFallbackModels,
    classifierReasoningLevel: config.classifierReasoningLevel ?? null,
    classifierTimeoutMs: config.classifierTimeoutMs,
    fastClassifierMaxTokens: config.fastClassifierMaxTokens,
    maxUserTranscriptTokens: config.maxUserTranscriptTokens,
    maxToolTranscriptTokens: config.maxToolTranscriptTokens,
    classifyReadOnlyTools: config.classifyReadOnlyTools,
    allowInsideWorkingDirectory: config.allowInsideWorkingDirectory,
    deniedPaths: config.deniedPaths,
    log: config.log,
    ruleCounts: {
      environment: config.environment.length,
      allow: config.allow.length,
      protectedPaths: config.protectedPaths.length,
      softDeny: config.softDeny.length,
      hardDeny: config.hardDeny.length,
      permissionDeny: config.permissionDeny.length,
      permissionAsk: config.permissionAsk.length,
      permissionAllow: config.permissionAllow.length,
    },
  };
}

function resolvePaths(cwd: string) {
  const globalPath = PI_GLOBAL_SETTINGS[0]!;
  return {
    globalPath,
    projectPath: join(cwd, PI_PROJECT_LOCAL_SETTINGS[0]!),
  };
}

/** The plugin directory this build replaces, if the user still has it installed. */
function installedPluginPath(): string {
  return join(getAgentDir(), "extensions", "pi-automode");
}

function readState(cwd: string) {
  const { globalPath, projectPath } = resolvePaths(cwd);
  const trusted = getProjectTrustStatus(cwd, getAgentDir()).trusted;
  const globalFile = readJsonObject(globalPath);
  const projectFile = readJsonObject(projectPath);
  const loaded = loadEffectiveConfigWithDiagnostics(cwd, trusted, globalPath);
  return {
    paths: { global: globalPath, project: projectPath },
    trusted,
    global: globalFile,
    project: projectFile,
    effective: loaded.config,
    diagnostics: loaded.diagnostics,
  };
}

export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd") || process.cwd();
    const state = readState(cwd);
    const pluginPath = installedPluginPath();
    const globalValues = autoModeOf(state.global.value);
    const projectValues = autoModeOf(state.project.value);

    return NextResponse.json({
      cwd,
      builtin: {
        version: BUILTIN_AUTOMODE_VERSION,
        basedOn: BUILTIN_AUTOMODE_BASED_ON,
      },
      plugin: { path: pluginPath, installed: existsSync(pluginPath), active: false },
      paths: state.paths,
      trusted: state.trusted,
      global: { values: globalValues, error: state.global.error },
      project: { values: projectValues, error: state.project.error },
      effective: effectiveSummary(state.effective),
      sources: Object.fromEntries(
        [...MANAGED_KEYS].map((key) => [key, sourceOf(key, projectValues, globalValues)]),
      ),
      defaults: DEFAULTS,
      diagnostics: state.diagnostics,
    });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

function validateSpecList(value: unknown, label: string, errors: string[]): string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return undefined;
  }
  const specs: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !parseModelSpec(item.trim())) {
      errors.push(`${label}: "${String(item)}" is not a provider/model value`);
      continue;
    }
    specs.push(item.trim());
  }
  return specs;
}

function validatePatch(value: unknown): { patch: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const patch: Record<string, unknown> = {};
  if (!isRecord(value)) return { patch, errors: ["patch must be an object"] };

  for (const key of Object.keys(value)) {
    if (!MANAGED_KEYS.has(key)) errors.push(`unknown setting: ${key}`);
  }

  const bool = (key: "enabled" | "classifyReadOnlyTools" | "allowInsideWorkingDirectory") => {
    if (!(key in value)) return;
    const raw = value[key];
    if (raw === null) patch[key] = null;
    else if (typeof raw === "boolean") patch[key] = raw;
    else errors.push(`${key} must be true or false`);
  };
  bool("enabled");
  bool("classifyReadOnlyTools");
  bool("allowInsideWorkingDirectory");

  const integer = (key: "classifierTimeoutMs" | "fastClassifierMaxTokens" | "maxUserTranscriptTokens" | "maxToolTranscriptTokens", min: number, max = Infinity) => {
    if (!(key in value)) return;
    const raw = value[key];
    if (raw === null) {
      patch[key] = null;
      return;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
      errors.push(`${key} must be a whole number between ${min} and ${max === Infinity ? "any" : max}`);
      return;
    }
    patch[key] = raw;
  };
  integer("classifierTimeoutMs", MIN_CLASSIFIER_TIMEOUT_MS, MAX_CLASSIFIER_TIMEOUT_MS);
  integer("fastClassifierMaxTokens", MIN_FAST_CLASSIFIER_MAX_TOKENS);
  integer("maxUserTranscriptTokens", MIN_TRANSCRIPT_TOKENS);
  integer("maxToolTranscriptTokens", MIN_TRANSCRIPT_TOKENS);

  if ("classifierModel" in value) {
    const raw = value.classifierModel;
    if (raw === null || raw === "") patch.classifierModel = null;
    else if (typeof raw === "string" && parseModelSpec(raw.trim())) patch.classifierModel = raw.trim();
    else errors.push("classifierModel must be a provider/model value");
  }

  if ("classifierReasoningLevel" in value) {
    const raw = value.classifierReasoningLevel;
    if (raw === null || raw === "") patch.classifierReasoningLevel = null;
    else if (typeof raw === "string" && (REASONING_LEVELS as readonly string[]).includes(raw)) {
      patch.classifierReasoningLevel = raw;
    } else errors.push(`classifierReasoningLevel must be one of ${REASONING_LEVELS.join(", ")}`);
  }

  if ("classifierFallbackModels" in value) {
    const raw = value.classifierFallbackModels;
    if (raw === null) {
      patch.classifierFallbackModels = null;
    } else {
      const specs = validateSpecList(raw, "classifierFallbackModels", errors);
      if (specs) patch.classifierFallbackModels = specs;
    }
  }

  if ("deniedPaths" in value) {
    const raw = value.deniedPaths;
    if (raw === null) {
      patch.deniedPaths = null;
    } else if (!Array.isArray(raw)) {
      errors.push("deniedPaths must be an array");
    } else {
      const paths: string[] = [];
      for (const item of raw) {
        if (typeof item !== "string" || !item.trim()) errors.push(`deniedPaths: "${String(item)}" is not a path pattern`);
        else paths.push(item.trim());
      }
      patch.deniedPaths = paths;
    }
  }

  if ("log" in value) {
    const raw = value.log;
    if (raw === null) {
      patch.log = null;
    } else if (!isRecord(raw)) {
      errors.push("log must be an object");
    } else {
      const log: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(raw)) {
        if (key !== "enabled" && key !== "classifierIo") errors.push(`unknown log setting: ${key}`);
        else if (typeof entry === "boolean") log[key] = entry;
        else errors.push(`log.${key} must be true or false`);
      }
      patch.log = log;
    }
  }

  return { patch, errors };
}

function mergeAutoMode(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const autoMode = { ...autoModeOf(current) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete autoMode[key];
    else if (key === "log" && isRecord(value)) {
      autoMode.log = { ...(isRecord(autoMode.log) ? autoMode.log : {}), ...value };
    } else {
      autoMode[key] = value;
    }
  }
  return { ...current, autoMode };
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { scope?: unknown; cwd?: unknown; patch?: unknown };
    const scope = body.scope === "project" ? "project" : body.scope === "global" ? "global" : null;
    if (!scope) return NextResponse.json({ error: "scope must be global or project" }, { status: 400 });
    const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd();
    const { patch, errors } = validatePatch(body.patch);
    if (errors.length > 0) return NextResponse.json({ error: errors.join("\n"), errors }, { status: 400 });

    const { globalPath, projectPath } = resolvePaths(cwd);
    if (scope === "project" && !getProjectTrustStatus(cwd, getAgentDir()).trusted) {
      return NextResponse.json(
        { error: `${cwd} is not a trusted project, so .pi/automode.local.json would be ignored. Trust the project first.` },
        { status: 409 },
      );
    }
    const targetPath = scope === "global" ? globalPath : projectPath;
    const current = readJsonObject(targetPath);
    if (current.error) {
      return NextResponse.json({ error: `${current.error}. Fix the file before saving from here.` }, { status: 409 });
    }
    const next = mergeAutoMode(current.value ?? {}, patch);
    const diagnostics = validateSettingsFile(next as SettingsFile, targetPath);
    if (diagnostics.length > 0) {
      return NextResponse.json({ error: diagnostics.join("\n"), errors: diagnostics }, { status: 400 });
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

    const state = readState(cwd);
    const globalValues = autoModeOf(state.global.value);
    const projectValues = autoModeOf(state.project.value);
    return NextResponse.json({
      saved: { scope, path: targetPath, keys: Object.keys(patch) },
      global: { values: globalValues, error: state.global.error },
      project: { values: projectValues, error: state.project.error },
      effective: effectiveSummary(state.effective),
      sources: Object.fromEntries(
        [...MANAGED_KEYS].map((key) => [key, sourceOf(key, projectValues, globalValues)]),
      ),
      diagnostics: state.diagnostics,
    });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
