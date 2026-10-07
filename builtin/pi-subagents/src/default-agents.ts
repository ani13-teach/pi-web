/** The five Desktop presets. User edits live outside the application bundle. */
import type { AgentConfig } from "./types.js";
import { DESKTOP_AGENT_PRESETS } from "./desktop-agent-presets.js";

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map(
  DESKTOP_AGENT_PRESETS.map((config): [string, AgentConfig] => [config.name, config]),
);
