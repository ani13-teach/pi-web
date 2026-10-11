import type { BackupRoot } from "./types.ts";

const EXECUTABLE_KINDS = new Set(["skill", "skills", "extension", "extensions", "agent", "agents", "prompt", "prompts", "workflow", "workflows", "instruction", "instructions", "custom", "project", "package"]);

/** Shared by discovery and archive verification; never executes configuration. */
export function executableConfig(v: unknown): boolean {
  if (typeof v === "string") return v.trimStart().startsWith("!");
  if (Array.isArray(v)) return v.some(executableConfig);
  return !!v && typeof v === "object" && Object.entries(v).some(([k, value]) =>
    /^(command|mcpServers|permissions|autoMode|automode)$/.test(k) ||
    ["extensions", "packages"].includes(k) && Array.isArray(value) && value.length > 0 ||
    executableConfig(value));
}

export function securityConfig(v: unknown): boolean {
  return !!v && typeof v === "object" && (Array.isArray(v) ? v.some(securityConfig) :
    Object.entries(v).some(([k, value]) => /^(permissions|automode|autoMode)$/.test(k) || securityConfig(value)));
}

export function requiresExecutable(root: BackupRoot, relative: string, kind: string): boolean {
  return root.kind === "external" || EXECUTABLE_KINDS.has(kind) ||
    /^(?:(?:\.pi|\.agents)\/)?(?:skills|extensions|agents|desktop-agents|workflows|prompts)(?:\/|$)/.test(relative) ||
    /(?:^|\/)(?:AGENTS(?:\.override)?|CLAUDE|SYSTEM|APPEND_SYSTEM|agent-tool-description)\.md$/.test(relative);
}
