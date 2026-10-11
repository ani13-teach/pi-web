import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, type AgentSession, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../builtin/pi-subagents/src/agent-manager";
import type { AgentRecord } from "../builtin/pi-subagents/src/types";
import type { DesktopChildInfo, DesktopHost } from "../builtin/pi-subagents/src/desktop-host";
import { createBuiltinAutomodeExtension, preferBuiltinAutomode } from "./automode-builtin";
import { createBuiltinRpivTodoExtension, preferBuiltinRpivTodo } from "./rpiv-todo-builtin";
import { projectTrustReloadOptions } from "./project-trust";
import { filteredSubagentLoaderOptions } from "./extension-loader-options";
export { filteredSubagentLoaderOptions, isSubagentsSource } from "./extension-loader-options";
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

export interface SubagentHostDependencies {
  getRootSession?(sessionId: string): AgentSession | undefined;
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
  return pathToFileURL(file);
}

export function createSubagentExtension(cwd: string, dependencies: SubagentHostDependencies): InlineExtension {
  return {
    name: HOST_SUBAGENT_EXTENSION_NAME,
    hidden: true,
    async factory(pi) {
      if (!isBuiltInSubagentsEnabled()) return;
      // Stable namespace, collectible per-activation module graph.
      const namespace = await import(/* @vite-ignore */ bundleUrl().href);
      const native = namespace.createSubagentModule();
      const activation: Activation = { closed: false, children: new Map() };
      activations.add(activation);
      let releaseLiveness: (() => void) | undefined;
      const releases: (() => void)[] = [];
      const gateAbort = new AbortController();
      let gateInstalled = false;
      let shutdownPromise: Promise<void> | undefined;
      const cleanup = () => {
        releases.splice(0).forEach(release => release());
        releaseLiveness?.();
        releaseLiveness = undefined;
        activations.delete(activation);
        for (const child of activation.children.values()) child.unsubscribe?.();
        activation.children.clear();
        activation.manager = undefined;
        activation.parentId = undefined;
        native.configureDesktopHost(undefined);
      };
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
        onManager(manager) {
          if (activation.closed) { void manager.dispose().catch(() => {}); return; }
          activation.manager = manager;
        },
        installRequestCoordinator(sessionId, coordinator) {
          if (gateInstalled) return true;
          const root = dependencies.getRootSession?.(sessionId);
          if (activation.closed || !root?.agent) return false;
          const previous = root.agent.prepareRequest;
          let released = false;
          const gate: NonNullable<typeof previous> = async (request, signal) => {
            // Later extensions may retain this inner wrapper across reload.
            // Cancel calls already waiting here, but forward future calls once released.
            if (released) {
              const forwarded = await previous?.(request, signal);
              return forwarded ?? undefined;
            }
            const combined = signal ? AbortSignal.any([signal, gateAbort.signal]) : gateAbort.signal;
            combined.throwIfAborted();
            await coordinator.waitForRequest(combined);
            combined.throwIfAborted();
            // This boundary is after the tool batch, never between a call and its result.
            // Persist before the SDK rebuilds its authoritative request projection.
            for (const delivery of coordinator.deliveries()) {
              root.sessionManager.appendCustomMessageEntry("subagent-notification", delivery.content, false, {
                displayOrigin: "pi-subagents", agentId: delivery.record.id, assignment: { ...delivery.assignment, delivery: "consumed" },
              });
              coordinator.consume(delivery);
            }
            const prepared = await previous?.(request, combined);
            combined.throwIfAborted();
            const state = coordinator.snapshot();
            const context = prepared?.context ?? request.context;
            return {
              ...prepared,
              context: state ? { ...context, messages: [...context.messages, {
                role: "custom" as const, customType: "subagent-task-state", content: state,
                display: false, timestamp: Date.now(),
              }] } : context,
            };
          };
          root.agent.prepareRequest = gate;
          const originalPrompt = root.prompt;
          const originalSteer = root.steer;
          const originalFollowUp = root.followUp;
          const prompt: typeof root.prompt = (text, options) => released ? originalPrompt.call(root, text, options) : originalPrompt.call(root, text, {
            ...options,
            preflightResult(disposition) {
              if (!released && disposition === "queued" && options?.source !== "extension") coordinator.acceptedInput();
              options?.preflightResult?.(disposition);
            },
          });
          const steer: typeof root.steer = async (text, images, options) => {
            const disposition = await originalSteer.call(root, text, images, options);
            if (!released && disposition === "queued" && options?.source !== "extension") coordinator.acceptedInput();
            return disposition;
          };
          const followUp: typeof root.followUp = async (text, images, options) => {
            const disposition = await originalFollowUp.call(root, text, images, options);
            if (!released && disposition === "queued" && options?.source !== "extension") coordinator.acceptedInput();
            return disposition;
          };
          root.prompt = prompt; root.steer = steer; root.followUp = followUp;
          gateInstalled = true;
          releases.push(() => {
            released = true;
            if (root.agent.prepareRequest === gate) root.agent.prepareRequest = previous;
            if (root.prompt === prompt) root.prompt = originalPrompt;
            if (root.steer === steer) root.steer = originalSteer;
            if (root.followUp === followUp) root.followUp = originalFollowUp;
          });
          return true;
        },
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
              const tools = session.getActiveToolNames().filter((name) => !["Agent", "SubagentWorkflow", "get_subagent_result", "steer_subagent", "subagent_tasks"].includes(name));
              const entries = session.sessionManager.getEntries() as unknown as SessionEntry[];
              const meta = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
              if (meta?.type === "custom") session.sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, { ...meta.data as object, resourceSnapshot: { version: 1, appendSystemPrompt: [], tools, loadExtensions: info.loadExtensions, loadSkills: info.loadSkills, exactSystemPrompt: info.systemPrompt } });
            }
            if (event.type === "agent_settled") setImmediate(() => { if (!activation.closed) persistTerminal(); });
          });
          if (info.agentId) activation.children.get(info.agentId)!.unsubscribe = unsubscribe;
          try { await dependencies.bindChild(session, info); }
          catch (error) {
            try { await host.shutdownChild(session); }
            catch (shutdownError) { throw new AggregateError([error, shutdownError], "Child binding and shutdown failed"); }
            throw error;
          }
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
      const shutdown = () => {
        if (shutdownPromise) return shutdownPromise;
        activation.closed = true;
        gateAbort.abort(new Error("Parent subagent activation closed"));
        shutdownPromise = (async () => {
          const failures: unknown[] = [];
          try {
            activation.manager?.abortAll();
            persistTerminal();
          } catch (error) { failures.push(error); }
          try { await native.shutdownSubagentModule(); }
          catch (error) { failures.push(error); }
          try { await activation.manager?.dispose(); }
          catch (error) { failures.push(error); }
          try {
            const results = await Promise.allSettled([...activation.children.values()].map(({ session }) => host.shutdownChild(session)));
            for (const result of results) if (result.status === "rejected") failures.push(result.reason);
          } finally { cleanup(); }
          if (failures.length) throw new AggregateError(failures, "Subagent activation shutdown failed");
        })();
        return shutdownPromise;
      };
      // Own teardown BEFORE native handlers. A failing native shutdown cannot
      // prevent the host's subscriptions, liveness and activation release.
      try {
        pi.on("session_shutdown", shutdown);
        native.configureDesktopHost(host);
        native.default(pi);
        releases.push(pi.events.on("subagents:completed", () => { if (!activation.closed) persistTerminal(); }), pi.events.on("subagents:failed", () => { if (!activation.closed) persistTerminal(); }));
        pi.on("session_start", (_event, ctx) => {
          if (activation.closed) return;
          activation.parentId = ctx.sessionManager.getSessionId();
          releaseLiveness?.();
          releaseLiveness = registerSessionLivenessProvider({ name: "pi-subagents", sessionId: activation.parentId, isActive: () => !activation.closed && native.hasActiveWork() });
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
      } catch (error) {
        try { await shutdown(); }
        catch (shutdownError) { throw new AggregateError([error, shutdownError], "Subagent activation and shutdown failed"); }
        throw error;
      }
    },
  };
}
