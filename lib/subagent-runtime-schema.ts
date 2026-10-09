export type RuntimeSettingsScope = "global" | "project";

export interface SubagentRuntimeSettings {
  maxConcurrent: number;
  maxConcurrentForeground: number;
  defaultMaxTurns: number;
  graceTurns: number;
  defaultJoinMode: "async" | "group" | "smart";
  backgroundByDefault: boolean;
  schedulingEnabled: boolean;
  scopeModels: boolean;
  strictAgentFiles: boolean;
  disableDefaultAgents: boolean;
  toolDescriptionMode: "full" | "compact" | "custom";
  rememberAgents: boolean;
  outputTranscript: boolean;
  worktreeIsolation: boolean;
  workflowsEnabled: boolean;
  maxSubagentDepth: number;
  fallbackSubagent: string;
  reportUsage: boolean;
}

export interface SubagentRuntimeSettingsResponse {
  scope: RuntimeSettingsScope;
  filePath: string;
  values: Partial<SubagentRuntimeSettings>;
  effective: SubagentRuntimeSettings;
  global: Partial<SubagentRuntimeSettings>;
  project: Partial<SubagentRuntimeSettings>;
  legacyMaxConcurrent?: number;
}

export interface RuntimeSettingField {
  key: keyof SubagentRuntimeSettings;
  type: "number" | "boolean" | "select" | "text";
  min?: number;
  max?: number;
  options?: readonly string[];
}

/** Shared with the renderer: this module has no backend imports. */
export const RUNTIME_SETTING_FIELDS: readonly RuntimeSettingField[] = [
  { key: "maxConcurrent", type: "number", min: 1, max: 1024 },
  { key: "maxConcurrentForeground", type: "number", min: 0, max: 1024 },
  { key: "defaultMaxTurns", type: "number", min: 0, max: 10000 },
  { key: "graceTurns", type: "number", min: 1, max: 1000 },
  { key: "defaultJoinMode", type: "select", options: ["async", "group", "smart"] },
  { key: "backgroundByDefault", type: "boolean" },
  { key: "schedulingEnabled", type: "boolean" },
  { key: "scopeModels", type: "boolean" },
  { key: "strictAgentFiles", type: "boolean" },
  { key: "disableDefaultAgents", type: "boolean" },
  { key: "toolDescriptionMode", type: "select", options: ["full", "compact", "custom"] },
  { key: "rememberAgents", type: "boolean" },
  { key: "outputTranscript", type: "boolean" },
  { key: "worktreeIsolation", type: "boolean" },
  { key: "workflowsEnabled", type: "boolean" },
  { key: "maxSubagentDepth", type: "number", min: 0, max: 16 },
  { key: "fallbackSubagent", type: "text" },
  { key: "reportUsage", type: "boolean" },
];

export const DEFAULT_SUBAGENT_RUNTIME_SETTINGS: Readonly<SubagentRuntimeSettings> = {
  maxConcurrent: 10,
  maxConcurrentForeground: 0,
  defaultMaxTurns: 0,
  graceTurns: 5,
  defaultJoinMode: "smart",
  backgroundByDefault: true,
  schedulingEnabled: true,
  scopeModels: false,
  strictAgentFiles: false,
  disableDefaultAgents: false,
  toolDescriptionMode: "full",
  rememberAgents: true,
  outputTranscript: true,
  worktreeIsolation: true,
  // Missing on disk means native auto mode; never materialize this default.
  workflowsEnabled: true,
  maxSubagentDepth: 2,
  fallbackSubagent: "work",
  reportUsage: false,
};
