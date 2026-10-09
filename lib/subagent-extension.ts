import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultPackageManager, getAgentDir, type AgentSession, type InlineExtension, type SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../builtin/pi-subagents/src/agent-manager";
import type { AgentRecord } from "../builtin/pi-subagents/src/types";
import type { DesktopChildInfo, DesktopHost, DefaultResourceLoaderOptions } from "../builtin/pi-subagents/src/desktop-host";
import { createBuiltinAutomodeExtension, preferBuiltinAutomode } from "./automode-builtin";
import { createBuiltinRpivTodoExtension, preferBuiltinRpivTodo } from "./rpiv-todo-builtin";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { isBuiltInSubagentsEnabled } from "./subagent-settings";
import { resolveSubagentRuntimeMaxConcurrent } from "./subagent-runtime-settings";
import { registerSessionLivenessProvider } from "./session-liveness";
import { readSubagentRun, SUBAGENT_META_TYPE, SUBAGENT_RESULT_TYPE, SUBAGENT_STATUS_TYPE, type SubagentRunInfo } from "./subagents";
import type { SessionEntry } from "./types";
import { SUBAGENT_DISPLAY_TOOLS, nativeSubagentToolNames } from "./subagent-display";

export const HOST_SUBAGENT_EXTENSION_NAME = "pi-subagents";
export interface SubagentToolDetails {
  kind: "pi-web-subagent" | "pi-subagents";
  sessionId: string;
  agentId?: string;
  profile: string;
  description: string;
  status: SubagentRunInfo["status"];
}

/** Exclude another installation BEFORE its extension factory can execute. */
export function isSubagentsSource(path: string, source = ""): boolean {
  if (/(?:^|[/\\])pi-subagents(?:[/\\]|$)/i.test(path) || /(?:^|[/@])pi-subagents(?:@|$)/i.test(source.replace(/^npm:/, ""))) return true;
  let dir = dirname(path);
  while (dir !== dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        return typeof pkg.name === "string" && pkg.name.split("/").at(-1) === "pi-subagents";
      } catch { return false; }
    }
    dir = dirname(dir);
  }
  return false;
}

/** The SDK's noExtensions mode still loads explicit paths and inline factories.
 * Resolve without importing, filter duplicate packages and untrusted project
 * paths, then hand only the allowed paths to that public SDK mode.
 */
export async function filteredSubagentLoaderOptions(
  options: DefaultResourceLoaderOptions,
  settingsManager: SettingsManager,
): Promise<DefaultResourceLoaderOptions> {
  const manager = new DefaultPackageManager({ cwd: options.cwd, agentDir: options.agentDir, settingsManager });
  const trusted = getProjectTrustStatus(options.cwd, options.agentDir).trusted;
  const discovered = options.noExtensions ? [] : (await manager.resolve(async () => "skip")).extensions;
  const explicit = options.additionalExtensionPaths?.length
    ? (await manager.resolveExtensionSources(options.additionalExtensionPaths, { temporary: true })).extensions
    : [];
  const insideProject = (path: string) => {
    const local = relative(options.cwd, resolve(path));
    return local === "" || (!local.startsWith("..") && !isAbsolute(local));
  };
  // Explicit paths are labelled "temporary" by the SDK, even when the
  // project supplied them. Preserve their original source when gating trust.
  const safeExplicit = trusted ? explicit : explicit.filter((entry) =>
    ![entry.path, entry.metadata.source, entry.metadata.baseDir].some((path) => path && insideProject(path)));
  const paths = [...discovered, ...safeExplicit].filter((entry) => entry.enabled
    && (entry.metadata.scope !== "project" || trusted)
    && !isSubagentsSource(entry.path, entry.metadata.source));
  return { ...options, noExtensions: true, additionalExtensionPaths: [...new Set(paths.map((entry) => entry.path))] };
}

export interface SubagentHostDependencies {
  bindChild(session: AgentSession, info: DesktopChildInfo): Promise<void>;
  shutdownChild(session: AgentSession): Promise<void>;
  invalidate(): void;
}
type Activation = { closed: boolean; manager?: AgentManager; parentId?: string; children: Map<string, { session: AgentSession; info: DesktopChildInfo; unsubscribe?: () => void }> };
const activations = new Set<Activation>();

function mapStatus(status: AgentRecord["status"]): SubagentRunInfo["status"] {
  if (status === "error") return "failed";
  if (status === "stopped" || status === "aborted") return "aborted";
  if (status === "steered") return "completed";
  return status;
}

function findRecord(ref: string): { activation: Activation; record: AgentRecord } | undefined {
  for (const activation of activations) {
    const record = activation.manager?.listAgents().find((entry) => entry.id === ref || entry.session?.sessionId === ref || activation.children.get(entry.id)?.session.sessionId === ref);
    if (record) return { activation, record };
  }
}

function runInfo(activation: Activation, record: AgentRecord): SubagentRunInfo {
  const child = activation.children.get(record.id);
  return {
    sessionId: record.session?.sessionId ?? child?.session.sessionId ?? record.id,
    sessionPath: record.session?.sessionFile ?? child?.session.sessionFile ?? "",
    parentSessionId: child?.info.parentContext.sessionManager.getSessionId() ?? activation.parentId ?? "",
    parentToolCallId: record.toolCallId ?? "",
    profile: record.type,
    description: record.description,
    task: child?.info.task ?? "",
    runInBackground: !record.blocking,
    status: mapStatus(record.status),
    createdAt: new Date(record.startedAt).toISOString(),
    ...(record.completedAt ? { completedAt: new Date(record.completedAt).toISOString() } : {}),
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.worktree ? { worktreePath: record.worktree.path, worktreeBranch: record.worktree.branch } : {}),
  };
}

export function getNativeSubagentRun(ref: string): SubagentRunInfo | null {
  const found = findRecord(ref);
  return found ? runInfo(found.activation, found.record) : null;
}
export function steerNativeSubagent(ref: string, message: string): void {
  const found = findRecord(ref);
  if (!found || !found.activation.manager?.steer(found.record.id, message)) throw new Error(`Running subagent not found: ${ref}`);
}
export function abortNativeSubagent(ref: string): void {
  const found = findRecord(ref);
  if (!found || !found.activation.manager?.abort(found.record.id)) throw new Error(`Running subagent not found: ${ref}`);
}

function bundleUrl(): URL {
  const dir = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(dir, "pi-subagents.mjs"), resolve(dir, "../dist/main/pi-subagents.mjs")];
  const file = candidates.find(existsSync);
  if (!file) throw new Error("Built-in pi-subagents bundle missing. Run npm run build:desktop.");
  const url = pathToFileURL(file);
  url.searchParams.set("activation", randomUUID());
  return url;
}

export function createSubagentExtension(cwd: string, dependencies: SubagentHostDependencies): InlineExtension {
  return {
    name: HOST_SUBAGENT_EXTENSION_NAME,
    hidden: true,
    async factory(pi) {
      if (!isBuiltInSubagentsEnabled()) return;
      // No code splitting: every relative module (and its mutable globals) is
      // inside this file, so the unique URL isolates the ENTIRE extension graph.
      const native = await import(/* @vite-ignore */ bundleUrl().href);
      const activation: Activation = { closed: false, children: new Map() };
      activations.add(activation);
      let releaseLiveness: (() => void) | undefined;
      const childShutdowns = new WeakMap<AgentSession, Promise<void>>();
      const persistTerminal = () => {
        for (const [id, child] of activation.children) {
          const record = activation.manager?.getRecord(id);
          if (!record || record.status === "queued" || record.status === "running") continue;
          const run = runInfo(activation, record);
          const entries = child.session.sessionManager.getEntries() as unknown as SessionEntry[];
          const last = readSubagentRun(entries, run.sessionId, run.sessionPath);
          if (last?.completedAt === run.completedAt && last?.status === run.status && last?.result === run.result && last?.error === run.error) continue;
          child.session.sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, {
            version: 1, status: run.status, completedAt: run.completedAt ?? new Date().toISOString(), result: run.result, error: run.error,
          });
        }
        dependencies.invalidate();
      };
      const host: DesktopHost = {
        cwd,
        get maxConcurrent() { return resolveSubagentRuntimeMaxConcurrent(cwd); },
        onManager(manager) { activation.manager = manager; },
        async resourceLoaderOptions(configCwd, options) {
          const base = await filteredSubagentLoaderOptions(options, options.settingsManager!);
          const policy = options.extensionsOverride;
          return {
            ...base,
            extensionFactories: [createBuiltinAutomodeExtension(), createBuiltinRpivTodoExtension()],
            extensionsOverride: (loaded) => {
              // User extension scoping never removes host safety handlers.
              const guards = loaded.extensions.filter((entry) => entry.path.startsWith("<inline:"));
              const scoped = policy ? policy({ ...loaded, extensions: loaded.extensions.filter((entry) => !guards.includes(entry)) }) : loaded;
              return preferBuiltinRpivTodo(preferBuiltinAutomode({ ...scoped, extensions: [...new Set([...scoped.extensions, ...guards])] }));
            },
          };
        },
        reloadOptions(configCwd) { return projectTrustReloadOptions(configCwd, getAgentDir()) ?? {}; },
        async bindChild(session, info) {
          if (activation.closed) {
            await host.shutdownChild(session);
            throw new Error("Parent subagent activation is closed");
          }
          if (info.agentId) activation.children.set(info.agentId, { session, info });
          const record = info.agentId ? activation.manager?.getRecord(info.agentId) : undefined;
          const parentManager = info.parentContext.sessionManager;
          session.sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, {
            version: 1, parentSessionId: parentManager.getSessionId(), parentSessionPath: parentManager.getSessionFile() ?? "",
            parentToolCallId: record?.toolCallId ?? "", profile: info.profile, description: info.description, task: info.task,
            runInBackground: !record?.blocking, createdAt: new Date(record?.startedAt ?? Date.now()).toISOString(),
            resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: info.tools, loadExtensions: info.loadExtensions, loadSkills: info.loadSkills, exactSystemPrompt: info.systemPrompt },
          });
          session.sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
          const unsubscribe = session.subscribe((event) => {
            if (event.type === "agent_start") {
              session.sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
              // Capture the actual live extension-tool scope AFTER original
              // pi-subagents installed its allow/deny policy.
              const tools = session.getActiveToolNames().filter((name) => !["Agent", "SubagentWorkflow", "get_subagent_result", "steer_subagent"].includes(name));
              const entries = session.sessionManager.getEntries() as unknown as SessionEntry[];
              const meta = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
              if (meta?.type === "custom") session.sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, { ...meta.data as object, resourceSnapshot: { version: 1, appendSystemPrompt: [], tools, loadExtensions: info.loadExtensions, loadSkills: info.loadSkills, exactSystemPrompt: info.systemPrompt } });
            }
            if (event.type === "agent_settled") setImmediate(persistTerminal);
          });
          if (info.agentId) activation.children.get(info.agentId)!.unsubscribe = unsubscribe;
          await dependencies.bindChild(session, info);
          if (activation.closed) {
            await host.shutdownChild(session);
            throw new Error("Parent subagent activation closed while child was binding");
          }
          dependencies.invalidate();
        },
        shutdownChild(session) {
          const existing = childShutdowns.get(session);
          if (existing) return existing;
          const shutdown = (async () => {
            try { await dependencies.shutdownChild(session); }
            finally {
              for (const [id, child] of activation.children) {
                if (child.session !== session) continue;
                child.unsubscribe?.();
                activation.children.delete(id);
              }
            }
          })();
          childShutdowns.set(session, shutdown);
          return shutdown;
        },
      };
      native.configureDesktopHost(host);
      // Own even the children whose session_start has not returned yet. This
      // runs BEFORE native dispose clears records, and writes final stop state.
      pi.on("session_shutdown", async () => {
        activation.closed = true;
        activation.manager?.abortAll();
        persistTerminal();
      });
      // Native handlers initialize and dispose the manager. Host handlers only
      // bridge UI/history; they do not implement agent execution a second time.
      native.default(pi);
      const releases = [pi.events.on("subagents:completed", persistTerminal), pi.events.on("subagents:failed", persistTerminal)];
      pi.on("session_start", (_event, ctx) => {
        activation.parentId = ctx.sessionManager.getSessionId();
        releaseLiveness = registerSessionLivenessProvider({ name: "pi-subagents", sessionId: activation.parentId, isActive: () => activation.manager?.hasRunning() ?? false });
      });
      pi.on("session_shutdown", async () => {
        await Promise.all([...activation.children.values()].map(({ session }) => host.shutdownChild(session)));
        releases.forEach((release) => release());
        releaseLiveness?.();
        activations.delete(activation);
        activation.children.clear();
        native.configureDesktopHost(undefined);
      });
      // Keep upstream result fields unchanged; add only a Desktop session link.
      pi.on("tool_result", (event) => {
        if (!SUBAGENT_DISPLAY_TOOLS.has(event.toolName) || !nativeSubagentToolNames(pi.getAllTools()).includes(event.toolName)) return;
        const details = event.details as { agentId?: string } | undefined;
        const record = details?.agentId ? activation.manager?.getRecord(details.agentId) : undefined;
        if (!record?.session) return { details: { ...event.details as object, kind: "pi-subagents" } };
        persistTerminal();
        return { details: { ...event.details as object, kind: "pi-subagents", sessionId: record.session.sessionId, profile: record.type } };
      });
    },
  };
}
