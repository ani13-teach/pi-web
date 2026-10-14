/** Renderer-safe MCP contracts. Never include resolved credentials or tool results. */
export type McpScope = "global" | "project";
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
export const MCP_REDACTED = "__PI_DESKTOP_REDACTED__";
export interface McpConfigEntry {
  name: string;
  config: Record<string, unknown>;
  overrideOnly: boolean;
}
export interface McpConfigView {
  scope: McpScope;
  path: string;
  revision: string;
  exists: boolean;
  editable: boolean;
  error?: string;
  servers: McpConfigEntry[];
}
export interface McpServerState {
  name: string;
  source: string;
  scope: "global" | "project" | "extension";
  enabled: boolean;
  exposure: McpExposure;
  state: "starting" | "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed" | "disabled";
  tools: Array<{ name: string; registeredName?: string; callable?: boolean; exposure: McpExposure }>;
  resourceCount: number;
  hasResources: boolean;
  resourcesCallable?: boolean;
  error?: string;
  lastCall?: { at: number; success: boolean };
}
export interface McpRuntimeSnapshot {
  generation: number;
  started: boolean;
  servers: McpServerState[];
  errors: string[];
  autoEnableCodemode: boolean;
}
export interface McpSessionView {
  id: string;
  runtimeActive: boolean;
  busy: boolean;
  provider: "builtin" | "external" | "disabled" | "unloaded";
  providerPath?: string;
  generation: number;
  appliedRevision: string | null;
  pending: boolean;
  applyState: "idle" | "queued" | "applying" | "failed";
  error?: string;
  activeTools: string[];
  snapshot: McpRuntimeSnapshot | null;
}
export interface McpOverview {
  config: { global: McpConfigView; project: McpConfigView | null };
  projectTrusted: boolean;
  configRoot: string | null;
  session: McpSessionView | null;
  affectedSessions: Array<{ id: string; busy: boolean; pending: boolean }>;
}
export interface McpMutation {
  scope: McpScope;
  revision: string;
  name: string;
  operation: "upsert" | "delete";
  config?: Record<string, unknown>;
}
export interface McpAction {
  action: "apply" | "cancel-apply" | "check" | "retry";
  sessionId: string;
  name?: string;
}
