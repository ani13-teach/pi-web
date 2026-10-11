import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./agent-manager.js";
import { setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "./agent-runner.js";
import { registerAgents, setDefaultsDisabled, setFallbackSubagent } from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { host, type AgentResourcePolicy } from "./desktop-host.js";
import { setScopeModelsEnabled } from "./model-scope.js";
import { createNestedSubagentTools, setMaxSubagentDepth, type NestedSubagentTools } from "./nested-tools.js";
import { setOutputTranscriptDefault } from "./output-file.js";
import { loadSettings } from "./settings.js";
import { setWorktreeIsolationEnabled } from "./worktree.js";

/**
 * Restore a saved child as an independent owner, never reconnecting its former
 * parent's manager or global task registry. The caller supplies the real saved
 * session id and installs the returned hooks on that session at session_start.
 */
export function createRestoredSubagentTools(
  pi: ExtensionAPI,
  policy: AgentResourcePolicy,
  ownerId: string,
): NestedSubagentTools {
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    throw new Error("Restored subagent tools require the saved session id");
  }

  const settings = loadSettings(policy.configCwd);
  // Apply only exported runner/module settings: root-only UI, scheduling and
  // notification switches have no independent nested surface to configure.
  if (typeof settings.defaultMaxTurns === "number") setDefaultMaxTurns(settings.defaultMaxTurns);
  if (typeof settings.graceTurns === "number") setGraceTurns(settings.graceTurns);
  if (typeof settings.rememberAgents === "boolean") setRememberAgents(settings.rememberAgents);
  if (typeof settings.scopeModels === "boolean") setScopeModelsEnabled(settings.scopeModels);
  if (typeof settings.worktreeIsolation === "boolean") setWorktreeIsolationEnabled(settings.worktreeIsolation);
  if (typeof settings.outputTranscript === "boolean") setOutputTranscriptDefault(settings.outputTranscript);
  if (typeof settings.maxSubagentDepth === "number") setMaxSubagentDepth(settings.maxSubagentDepth);
  if (typeof settings.fallbackSubagent === "string") setFallbackSubagent(settings.fallbackSubagent);
  if (typeof settings.disableDefaultAgents === "boolean") setDefaultsDisabled(settings.disableDefaultAgents);
  registerAgents(loadCustomAgents(policy.configCwd, settings.strictAgentFiles === true));

  const manager = new AgentManager();
  if (typeof settings.maxConcurrent === "number") manager.setMaxConcurrent(settings.maxConcurrent);
  if (typeof settings.maxConcurrentForeground === "number") manager.setMaxConcurrentForeground(settings.maxConcurrentForeground);
  if (host?.maxConcurrent !== undefined) manager.setMaxConcurrent(host.maxConcurrent);
  host?.onManager(manager);

  const nested = createNestedSubagentTools({
    manager,
    pi,
    parentAgentId: `restored:${ownerId}`,
    // Historical depth and delegation scope remain authoritative on restore.
    depth: policy.depth,
    maxSubagentDepth: policy.maxSubagentDepth,
    allowedSubagents: policy.allowedSubagents,
    configCwd: policy.configCwd,
    workflowsEnabled: settings.workflowsEnabled !== false,
  });
  const disallowed = new Set(policy.disallowedTools);
  // Array.filter drops install/dispose. Preserve their original identities and
  // keep the underlying owner alive even when every tool is disallowed.
  const tools: NestedSubagentTools = Object.assign(
    nested.filter(tool => !disallowed.has(tool.name)),
    { install: nested.install, dispose: nested.dispose },
  );
  for (const tool of tools) pi.registerTool(tool);
  const startMaintenance = () => {
    manager.startMaintenance();
    if (host?.maxConcurrent !== undefined) manager.setMaxConcurrent(host.maxConcurrent);
  };
  // This helper is created by the adapter inside session_start, after extension
  // filtering. A newly registered handler misses that event's current dispatch.
  startMaintenance();
  pi.on("session_start", startMaintenance);
  pi.on("session_shutdown", async () => {
    try { nested.dispose(); }
    finally { await manager.dispose(pi); }
  });
  return tools;
}
