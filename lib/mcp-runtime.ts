import { createRequire as createMcpRuntimeRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, type InlineExtension, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { createObservedMcpExtension, type CoreConfigApi, type CoreController, type CoreSnapshot } from "../builtin/mcp/core.mjs";
import type { McpRuntimeSnapshot } from "./mcp-types";
import { getMcpConfigRevision } from "./mcp-config-store";

export interface DesktopMcpRuntimeController {
  readonly generation: number;
  readonly configRevision: string | null;
  snapshot(): McpRuntimeSnapshot;
  check(timeoutMs?: number): Promise<McpRuntimeSnapshot>;
  retry(name: string): Promise<void>;
  dispose(): Promise<void>;
}

function coreDist(): string {
  try { return dirname(createMcpRuntimeRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent")); }
  catch { return dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))); }
}

let configApi: Promise<CoreConfigApi> | undefined;
export function loadMcpCoreConfigApi(): Promise<CoreConfigApi> {
  return configApi ??= (async () => {
    const dist = coreDist();
    const [config, servers] = await Promise.all([
      import(pathToFileURL(join(dist, "extensions/mcp/config.js")).href),
      import(pathToFileURL(join(dist, "core/mcp-servers.js")).href),
    ]);
    return { loadMcpConfig: config.loadMcpConfig, validateMcpServerConfig: servers.validateMcpServerConfig } as CoreConfigApi;
  })().catch((error: unknown) => { configApi = undefined; throw error; });
}

// Root and collectible subagent bundles must observe the same live session registry.
declare global {
  var __piDesktopMcpRuntimes: Map<string, DesktopMcpRuntimeController> | undefined;
  var __piDesktopMcpGeneration: number | undefined;
}
const runtimes = globalThis.__piDesktopMcpRuntimes ??= new Map<string, DesktopMcpRuntimeController>();
export function getDesktopMcpRuntime(sessionId: string): DesktopMcpRuntimeController | undefined {
  return runtimes.get(sessionId);
}

/** SettingsManager owns the settings root; ctx.cwd only controls server processes. */
export function getMcpSettingsRoots(cwd: string, settingsManager: SettingsManager) {
  const paths = (settingsManager as unknown as { settingsPaths?: { global?: string; project?: string } }).settingsPaths;
  return {
    agentDir: paths?.global ? dirname(paths.global) : getAgentDir(),
    cwd: paths?.project ? dirname(dirname(paths.project)) : cwd,
    projectTrusted: settingsManager.isProjectTrusted(),
  };
}

export function mcpMayEnableCodemode(settingsManager: SettingsManager): boolean {
  const tools = settingsManager.getSettings().defaultTools;
  if (!Array.isArray(tools)) return true;
  if (tools.length === 0 || tools.includes("-codemode")) return false;
  // Mirror core's modifier-list versus explicit allowlist distinction.
  return tools.every((entry) => entry.startsWith("+") || entry.startsWith("-")) || tools.includes("codemode");
}

export function createDesktopMcpExtension(cwd: string, settingsManager: SettingsManager): InlineExtension {
  return { name: "mcp", builtin: true, replaceable: true, factory: async (pi) => {
    const api = await loadMcpCoreConfigApi();
    let sessionId: string | undefined;
    let current: DesktopMcpRuntimeController | undefined;
    let controller: CoreController | undefined;
    let snapshot: McpRuntimeSnapshot = { generation: 0, started: false, servers: [], errors: [], autoEnableCodemode: true };
    let active = false;
    let configRevision: string | null = null;
    const assertActive = (expectedGeneration: number) => {
      if (!active || snapshot.generation !== expectedGeneration || !current || runtimes.get(sessionId!) !== current) throw new Error("MCP runtime is no longer active.");
    };
    const observe = (value: CoreSnapshot) => {
      if (active) snapshot = { ...structuredClone(value), generation: snapshot.generation };
    };
    pi.on("session_start", async (_event, ctx) => {
      await current?.dispose();
      sessionId = ctx.sessionManager.getSessionId();
      await runtimes.get(sessionId)?.dispose();
      active = true;
      controller = undefined;
      snapshot = { ...snapshot, generation: globalThis.__piDesktopMcpGeneration = (globalThis.__piDesktopMcpGeneration ?? 0) + 1, started: false, servers: [], errors: [] };
      const expectedGeneration = snapshot.generation;
      current = {
        get generation() { return expectedGeneration; },
        get configRevision() { return configRevision; },
        snapshot: () => { assertActive(expectedGeneration); return structuredClone(snapshot); },
        check: async (timeoutMs) => {
          assertActive(expectedGeneration);
          if (!controller) throw new Error("MCP runtime is still starting.");
          const value = await controller.check(timeoutMs);
          assertActive(expectedGeneration); observe(value);
          return structuredClone(snapshot);
        },
        retry: async (name) => {
          assertActive(expectedGeneration);
          if (!controller) throw new Error("MCP runtime is still starting.");
          const value = await controller.retry(name);
          assertActive(expectedGeneration); observe(value);
        },
        dispose: async () => {
          if (snapshot.generation !== expectedGeneration) return;
          active = false;
          snapshot = { ...snapshot, started: false, servers: [] };
          if (sessionId && runtimes.get(sessionId) === current) runtimes.delete(sessionId);
          const closing = controller; controller = undefined;
          await closing?.dispose();
        },
      };
      runtimes.set(sessionId, current);
    });
    pi.on("session_shutdown", async () => { await current?.dispose(); });
    // Do not replace or broaden core's API: use its own tool-selection path after
    // removing only a disallowed automatic codemode addition.
    const observedPi = new Proxy(pi, { get(target, property) {
      if (property === "setActiveTools") return (names: string[]) => target.setActiveTools(
        mcpMayEnableCodemode(settingsManager) ? names : names.filter((name) => name !== "codemode"));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await createObservedMcpExtension({
      logPath: join(getMcpSettingsRoots(cwd, settingsManager).agentDir, "mcp.log"),
      loadConfig: () => {
        const roots = getMcpSettingsRoots(cwd, settingsManager);
        const before = getMcpConfigRevision(roots);
        const loaded = api.loadMcpConfig(roots);
        configRevision = getMcpConfigRevision(roots) === before ? before : null;
        return { ...loaded, autoEnableCodemode: loaded.autoEnableCodemode !== false && mcpMayEnableCodemode(settingsManager) };
      },
      onSnapshot: observe,
      onController: (value) => { if (active) controller = value; },
    })(observedPi);
  } };
}
