/**
 * Draft state for the auto-mode settings page.
 *
 * Kept out of the component so the rules can be tested: which file a value
 * belongs to, what "empty" means, and which keys a save actually sends. Only
 * changed fields are sent, so flipping one switch never rewrites a file the
 * user did not touch.
 */

/** Fields the panel owns, in the order the extension validates them. */
export interface EffectiveValues {
  enabled: boolean;
  classifierModel: string | null;
  classifierFallbackModels: string[];
  classifierReasoningLevel: string | null;
  classifierTimeoutMs: number;
  fastClassifierMaxTokens: number;
  maxUserTranscriptTokens: number;
  maxToolTranscriptTokens: number;
  classifyReadOnlyTools: boolean;
  allowInsideWorkingDirectory: boolean;
  deniedPaths: string[];
  log: { enabled: boolean; classifierIo: boolean };
  ruleCounts: Record<string, number>;
}

export interface Draft {
  enabled: boolean;
  classifierModel: string;
  classifierFallbackModels: string[];
  classifierReasoningLevel: string;
  classifierTimeoutMs: string;
  fastClassifierMaxTokens: string;
  maxUserTranscriptTokens: string;
  maxToolTranscriptTokens: string;
  classifyReadOnlyTools: boolean;
  allowInsideWorkingDirectory: boolean;
  logEnabled: boolean;
  logClassifierIo: boolean;
  deniedPaths: string;
}

export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Translate = (key: string, params?: Record<string, string | number>) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

function numberString(value: unknown, fallback: number): string {
  return typeof value === "number" ? String(value) : String(fallback);
}

/**
 * Values from one configuration file, with anything the file does not set
 * falling back to what is in force. Unchanged fields are never written back, so
 * inheriting a value in the editor is safe.
 */
export function draftFrom(values: Record<string, unknown>, effective: EffectiveValues): Draft {
  const log = isRecord(values.log) ? values.log : {};
  return {
    enabled: typeof values.enabled === "boolean" ? values.enabled : effective.enabled,
    classifierModel: typeof values.classifierModel === "string" ? values.classifierModel : effective.classifierModel ?? "",
    classifierFallbackModels: stringList(values.classifierFallbackModels, effective.classifierFallbackModels),
    classifierReasoningLevel: typeof values.classifierReasoningLevel === "string"
      ? values.classifierReasoningLevel
      : effective.classifierReasoningLevel ?? "",
    classifierTimeoutMs: numberString(values.classifierTimeoutMs, effective.classifierTimeoutMs),
    fastClassifierMaxTokens: numberString(values.fastClassifierMaxTokens, effective.fastClassifierMaxTokens),
    maxUserTranscriptTokens: numberString(values.maxUserTranscriptTokens, effective.maxUserTranscriptTokens),
    maxToolTranscriptTokens: numberString(values.maxToolTranscriptTokens, effective.maxToolTranscriptTokens),
    classifyReadOnlyTools: typeof values.classifyReadOnlyTools === "boolean"
      ? values.classifyReadOnlyTools
      : effective.classifyReadOnlyTools,
    allowInsideWorkingDirectory: typeof values.allowInsideWorkingDirectory === "boolean"
      ? values.allowInsideWorkingDirectory
      : effective.allowInsideWorkingDirectory,
    logEnabled: typeof log.enabled === "boolean" ? log.enabled : effective.log.enabled,
    logClassifierIo: typeof log.classifierIo === "boolean" ? log.classifierIo : effective.log.classifierIo,
    deniedPaths: stringList(values.deniedPaths, effective.deniedPaths).join("\n"),
  };
}

export function changedKeys(current: Draft, base: Draft): (keyof Draft)[] {
  return (Object.keys(current) as (keyof Draft)[]).filter(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(base[key]),
  );
}

/**
 * Only the fields that differ from what was loaded. An emptied number or model
 * field becomes `null`, which is how the API says "drop this key here, use the
 * value underneath".
 */
export function buildPatch(current: Draft, base: Draft): Record<string, unknown> {
  const dirty = new Set(changedKeys(current, base));
  const patch: Record<string, unknown> = {};
  if (dirty.has("enabled")) patch.enabled = current.enabled;
  if (dirty.has("classifierModel")) patch.classifierModel = current.classifierModel.trim() || null;
  if (dirty.has("classifierFallbackModels")) {
    patch.classifierFallbackModels = current.classifierFallbackModels.map((spec) => spec.trim()).filter(Boolean);
  }
  if (dirty.has("classifierReasoningLevel")) patch.classifierReasoningLevel = current.classifierReasoningLevel || null;
  if (dirty.has("deniedPaths")) patch.deniedPaths = lineList(current.deniedPaths);
  if (dirty.has("classifyReadOnlyTools")) patch.classifyReadOnlyTools = current.classifyReadOnlyTools;
  if (dirty.has("allowInsideWorkingDirectory")) patch.allowInsideWorkingDirectory = current.allowInsideWorkingDirectory;
  if (dirty.has("logEnabled") || dirty.has("logClassifierIo")) {
    patch.log = { enabled: current.logEnabled, classifierIo: current.logClassifierIo };
  }
  for (const key of ["classifierTimeoutMs", "fastClassifierMaxTokens", "maxUserTranscriptTokens", "maxToolTranscriptTokens"] as const) {
    if (!dirty.has(key)) continue;
    const raw = current[key].trim();
    patch[key] = raw === "" ? null : Number(raw);
  }
  return patch;
}

/** One pattern per line, blanks dropped. */
export function lineList(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** What the session that is actually running reports about auto mode. */
export interface SessionStatus {
  enabled: boolean;
  allowed: number | null;
  blocked: number | null;
  classifierAllowed: number | null;
  classifierDenied: number | null;
}

/**
 * The extension publishes a status line like `AM● a:3 d:0 ca:1 cd:2` (colored
 * variants wrap it in escape codes). Reading it is the only way to tell a file
 * that says "on" from a session someone switched off with `/automode off`,
 * which only overrides the running session.
 *
 * Returns null when there is no such line, so the caller can say "unknown"
 * instead of showing the file's value as if it were the live one.
 */
export function parseSessionStatus(text: string | null | undefined): SessionStatus | null {
  const plain = String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  const enabled = plain.includes("AM●") ? true : plain.includes("AM○") ? false : null;
  if (enabled === null) return null;
  // `\b` keeps `a:` from matching inside `ca:`, and `d:` from inside `cd:`.
  const count = (key: string): number | null => {
    const match = new RegExp(`\\b${key}:(\\d+)`).exec(plain);
    return match ? Number(match[1]) : null;
  };
  return {
    enabled,
    allowed: count("a"),
    blocked: count("d"),
    classifierAllowed: count("ca"),
    classifierDenied: count("cd"),
  };
}

/**
 * One line about the running session: whether it follows the file, was
 * switched off in the chat, or was switched on there, plus how many actions it
 * let through and stopped.
 */
export function sessionLine(
  status: SessionStatus | null,
  fileEnabled: boolean,
  t: Translate,
): string {
  if (!status) return t("automode.sessionUnknown");

  let state: string;
  if (status.enabled === fileEnabled) state = status.enabled ? t("automode.sessionOn") : t("automode.sessionOff");
  else state = status.enabled ? t("automode.sessionForcedOn") : t("automode.sessionForcedOff");

  if (status.allowed === null || status.blocked === null) return state;
  let counts = t("automode.sessionCounts", { allowed: status.allowed, blocked: status.blocked });
  if (status.classifierAllowed !== null && status.classifierDenied !== null
    && status.classifierAllowed + status.classifierDenied > 0) {
    counts += ` (${t("automode.sessionClassifierCounts", {
      allowed: status.classifierAllowed,
      denied: status.classifierDenied,
    })})`;
  }
  return `${state} · ${counts}`;
}

/** Rejects non-numeric text before it reaches the API. */
export function numberErrors(draft: Draft, t: Translate): string[] {
  const errors: string[] = [];
  const fields: [keyof Draft, string][] = [
    ["classifierTimeoutMs", "automode.timeout"],
    ["fastClassifierMaxTokens", "automode.maxTokens"],
    ["maxUserTranscriptTokens", "automode.transcriptUser"],
    ["maxToolTranscriptTokens", "automode.transcriptTool"],
  ];
  for (const [key, label] of fields) {
    const raw = draft[key] as string;
    if (raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) errors.push(t("automode.notAWholeNumber", { field: t(label) }));
  }
  return errors;
}
