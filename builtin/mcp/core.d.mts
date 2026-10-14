import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { McpRuntimeSnapshot } from "../../lib/mcp-types";
export type CoreSnapshot = Omit<McpRuntimeSnapshot, "generation">;
export interface CoreController {
  check(timeoutMs?: number): Promise<CoreSnapshot>;
  retry(name: string): Promise<CoreSnapshot>;
  dispose(): Promise<void>;
}
export interface CoreConfigApi {
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): {
    servers: Array<{ name: string; source: string; scope?: "global" | "project" | "extension"; config: Record<string, unknown> }>;
    errors: string[]; autoEnableCodemode?: boolean; projectConfig?: string;
  };
  validateMcpServerConfig(name: string, value: unknown): Record<string, unknown> | string;
}
export function createObservedMcpExtension(options?: {
  logPath?: string;
  loadConfig?: (ctx: ExtensionContext) => ReturnType<CoreConfigApi["loadMcpConfig"]>;
  onSnapshot?: (snapshot: CoreSnapshot) => void;
  onController?: (controller: CoreController) => void;
}): ExtensionFactory;
