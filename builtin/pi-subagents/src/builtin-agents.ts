/** Persistent Desktop built-ins: editable profiles plus deletion markers for presets. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readAgentConfigFile } from "./custom-agents.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AgentConfig } from "./types.js";

export function builtinAgentDirectory(): string {
  return join(getAgentDir(), "desktop-agents");
}

export function builtinDeletionPath(name: string): string {
  // Encode exact identity so Windows cannot conflate work and Work markers.
  return join(builtinAgentDirectory(), ".deleted", Buffer.from(name, "utf8").toString("hex"));
}

/** Disabling factory presets must not discard profiles explicitly saved by the user. */
export function loadBuiltinAgents(strict = false, includePresets = true): Map<string, AgentConfig> {
  const agents = new Map((includePresets ? [...DEFAULT_AGENTS] : []).filter(([name]) => !existsSync(builtinDeletionPath(name))));
  const dir = builtinAgentDirectory();
  if (!existsSync(dir)) return agents;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const config = readAgentConfigFile(join(dir, entry.name), "global", strict);
    if (config && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.name) && !existsSync(builtinDeletionPath(config.name))) {
      agents.set(config.name, { ...config, source: "default", isDefault: true });
    }
  }
  return agents;
}
