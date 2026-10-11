import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { AgentManager } from "./agent-manager.js";
import { TaskCoordinator, validateAssignmentInput, type AssignmentInput } from "./task-coordination.js";
import { compiledResultReport, renderAgentResult } from "./result-protocol.js";
import { createWorkflowHost, type WorkflowHostOptions } from "./workflow/host.js";
import { extractMeta } from "./workflow/meta.js";
import { runWorkflow, MAX_SCRIPT_LENGTH, type WorkflowGateResult } from "./workflow/runtime.js";
import { collapse } from "./workflow/progress.js";
import { resolveWorkflowScript } from "./workflow/saved.js";
import { appendJournal, readJournal } from "./workflow/journal.js";
import { createWorkflowTask, completeWorkflowTask, failWorkflowTask, updateWorkflowProgressBatch, workflowRunId, workflowResultText, type WorkflowTask } from "./workflow/task.js";
import { sessionTaskDir } from "./output-file.js";
import {
  type AgentSession,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { abortable } from "./abortable.js";
import {
  buildAgentRegistry,
  getAgentConfigIn,
  getAvailableTypesIn,
  resolveEnabledTypeIn,
  resolveTypeIn,
} from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { isolationParam, resolveAgentInvocationConfig } from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import {
  createOutputFilePath,
  getOutputTranscriptDefault,
  streamToOutputFile,
  writeInitialEntry,
} from "./output-file.js";
import { getForegroundOutcomeNote, getStatusNote, partialOutputSuffix } from "./status-note.js";
import type {
  AgentConfig,
  AgentRecord,
} from "./types.js";
import { addUsage } from "./usage.js";
import { isWorktreeIsolationEnabled } from "./worktree.js";

/**
 * Hard ceiling on nesting for every branch: main session = 0, its subagents = 1,
 * their children = 2. `0`/`1` disables nesting entirely. Set from
 * `subagents.json` (`maxSubagentDepth`). Read when a subagent session is built,
 * so a change applies to sessions started after it.
 */
let maxSubagentDepth = 2;

export function getMaxSubagentDepth(): number { return maxSubagentDepth; }
export function setMaxSubagentDepth(n: number): void { maxSubagentDepth = Math.max(0, Math.floor(n)); }

const NESTED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent", "subagent_tasks", "SubagentWorkflow"] as const;

type NestedSpawnOptions = Parameters<AgentManager["spawn"]>[4];

export interface NestedAgentManager extends Pick<AgentManager,
  "spawn" | "awaitStartup" | "spawnAndWait" | "getRecord" | "resume" | "abort"> {}

export interface NestedToolContext {
  manager: NestedAgentManager;
  pi: ExtensionAPI;
  parentAgentId: string;
  depth: number;
  maxSubagentDepth: number;
  /** false = off; "all" = any enabled agent; string[] = only those types. */
  allowedSubagents: false | "all" | string[];
  /** Workflow feature switch, copied from the root registration policy. */
  workflowsEnabled?: boolean;
  /** Optional host override; otherwise gates use the owner's guarded ctx.executeTool("bash"). */
  executeWorkflowGate?: WorkflowHostOptions["executeGate"];
  /** Root used for agent/config discovery; may differ from the agent's working directory. */
  configCwd: string;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

export async function executeNestedWorkflowGate(
  ctx: ExtensionToolContext,
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<WorkflowGateResult> {
  try {
    signal?.throwIfAborted();
    if (typeof ctx.executeTool !== "function") {
      return { ok: false, output: "Owner context has no guarded executeTool; workflow gate cannot run safely." };
    }
    // Git Bash accepts C:/... and //server/share, not PowerShell syntax.
    // Preserve literal POSIX backslashes unless this is a Windows path.
    const shellCwd = /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\")
      ? cwd.replace(/\\/g, "/") : cwd;
    const quotedCwd = `'${shellCwd.replace(/'/g, "'\\''")}'`;
    const outcome = await ctx.executeTool("bash", {
      command: `cd -- ${quotedCwd} && ${command}`,
      timeout: 600,
    }, { signal });
    const structured = outcome.result.structuredContent;
    const fields = structured !== null && typeof structured === "object" && !Array.isArray(structured)
      ? structured as Record<string, unknown> : undefined;
    const exitCode = fields?.exit_code;
    const text = outcome.result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    const output = [...new Set([text, typeof fields?.output === "string" ? fields.output : ""].filter(Boolean))].join("\n");
    const failed = outcome.isError || outcome.result.isError === true;
    if (exitCode === 0 && !failed) return { ok: true, output };
    const reason = typeof exitCode === "number" && Number.isInteger(exitCode)
      ? `Workflow gate ${failed ? "failed or was denied" : "failed"} (bash exit_code=${exitCode}).`
      : "Workflow gate failed: bash returned no verified numeric exit_code (tool unavailable, denied, or incomplete).";
    return { ok: false, output: [reason, output].filter(Boolean).join("\n") };
  } catch (error) {
    return { ok: false, output: `Workflow gate could not execute safely: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function ownsRecord(record: AgentRecord | undefined, parentAgentId: string): record is AgentRecord {
  return record?.parentAgentId === parentAgentId;
}

/**
 * How the caller received this record, which decides the outcome wording.
 *
 *   - "inline": a foreground spawn or a resume. The full output is in this very
 *     result and no agent id was handed back, so the note must say there is
 *     nothing left to fetch — otherwise the parent invents an id, calls
 *     `get_subagent_result`, and hits "not owned by this parent" (#174, the same
 *     trap the top-level foreground path fell into).
 *   - "fetched": `get_subagent_result` on a background child. The parent holds a
 *     valid id and can poll again, so the background wording applies.
 */
type ResultPosition = "inline" | "fetched";

function formatRecord(record: AgentRecord, position: ResultPosition): string {
  if (record.status === "error") {
    return `Agent failed: ${record.error ?? "unknown error"}${partialOutputSuffix(record)}`;
  }
  if (record.runSettled === false && record.status !== "stopped") {
    return `Agent ${record.id} is still settling (${record.status}); its final result is not ready.`;
  }
  if (record.status === "queued" || record.status === "running") {
    return `Agent ${record.id} is ${record.status}.`;
  }
  // A truncated run must not read as a finished one. The top-level path carries
  // this in its result headline; a nested result has no headline, so the note
  // leads — appended, it would look like part of the child's own output.
  const text = record.structuredJson
    ? renderAgentResult(record, "summary")
    : record.result?.trim() || record.error?.trim() || "No output.";
  const note = position === "inline"
    ? getForegroundOutcomeNote(record.status)
    : getStatusNote(record.status);
  return note ? `Nested agent${note}.\n\n${text}` : text;
}

export interface NestedSubagentTools extends Array<ToolDefinition> {
  /** Install after SDK creation, before the first prompt. Release on disposal, not settlement. */
  install(session: AgentSession): () => void;
  dispose(): void;
}

/** Build child-safe orchestration tools scoped to one parent agent instance. */
export function createNestedSubagentTools(context: NestedToolContext): NestedSubagentTools {
  const coordinator = new TaskCoordinator();
  const workflows = new Map<string, WorkflowTask>();
  const workflowRecords = new Map<string, AgentRecord>();
  const ownedChildren = new Set<string>();
  let installedSession: AgentSession | undefined;
  let releaseSession: (() => void) | undefined;
  let closed = false;
  const assignmentInput = (params: { task_key?: string; scope?: string[]; deliverable?: string; input_version?: string; independent_work?: string[]; required?: boolean }): AssignmentInput => ({
    taskKey: params.task_key, scope: params.scope, deliverable: params.deliverable,
    inputVersion: params.input_version, independentWork: params.independent_work, required: params.required,
  });
  const register = (record: AgentRecord, params: Parameters<typeof assignmentInput>[0]) => {
    record.resultConsumed = false;
    coordinator.register(record, assignmentInput(params));
  };
  const accountUsage: NonNullable<NestedSpawnOptions["onAssistantUsage"]> = usage => {
    for (let id: string | undefined = context.parentAgentId; id !== undefined; ) {
      const ancestor = context.manager.getRecord(id);
      if (!ancestor) break;
      addUsage(ancestor.lifetimeUsage, usage);
      id = ancestor.parentAgentId;
    }
  };
  // Agents resolve from a registry built for THIS branch's config root (under
  // worktree isolation, the copy). Never via registerAgents — that is
  // process-global state shared with the main session and every other agent.
  const loadRegistry = () => buildAgentRegistry(loadCustomAgents(context.configCwd));
  const allowedTypesIn = (registry: Map<string, AgentConfig>): Set<string> | undefined =>
    context.allowedSubagents === "all"
      ? undefined
      : new Set((context.allowedSubagents || []).map(name => resolveTypeIn(registry, name) ?? name));
  const availableIn = (registry: Map<string, AgentConfig>): string[] => {
    const allowed = allowedTypesIn(registry);
    return getAvailableTypesIn(registry).filter(name => allowed === undefined || allowed.has(name));
  };

  const agentTool = defineTool({
    name: NESTED_TOOL_NAMES[0],
    label: "Agent",
    description:
      "Launch a child-safe nested subagent for bounded delegated work. " +
      "Only use agent types allowed by this parent agent; nesting is depth-limited.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task for the nested agent." }),
      description: Type.String({ description: "Short 3-5 word task description." }),
      subagent_type: Type.String({ description: `Allowed nested agent type. Available: ${availableIn(loadRegistry()).join(", ") || "none"}.` }),
      model: Type.Optional(Type.String({ description: "Optional provider/model override." })),
      thinking: Type.Optional(Type.String({ description: "Optional thinking level." })),
      max_turns: Type.Optional(Type.Number({ minimum: 1 })),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "With a session coordinator, defaults to background and joins at the next request. Without it, defaults to foreground. Explicit background children must be collected before finishing.",
        }),
      ),
      resume: Type.Optional(Type.String({ description: "Resume a nested agent owned by this parent." })),
      isolated: Type.Optional(Type.Boolean()),
      inherit_context: Type.Optional(Type.Boolean()),
      task_key: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      scope: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 12 })),
      deliverable: Type.Optional(Type.String({ minLength: 1, maxLength: 600 })),
      input_version: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      independent_work: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 8 })),
      required: Type.Optional(Type.Boolean()),
      result_format: Type.Optional(Type.Union([Type.Literal("structured"), Type.Literal("text")])),
      ...isolationParam(isWorktreeIsolationEnabled()),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (closed) return textResult("Nested orchestration is closed.", true);
      try { validateAssignmentInput(assignmentInput(params)); }
      catch (error) { return textResult(error instanceof Error ? error.message : String(error), true); }
      if (params.resume) {
        const existing = context.manager.getRecord(params.resume);
        if (!ownsRecord(existing, context.parentAgentId)) {
          return textResult(`Nested agent not found or not owned by this parent: "${params.resume}".`, true);
        }
        if (existing.status === "running" || existing.status === "queued") return textResult("Nested agent is still running; use steer_subagent.", true);
        const format = existing.resultFormat ?? (existing.structuredJson ? "structured" : "text");
        if (params.result_format && params.result_format !== format) return textResult("Cannot switch result_format on resume; start a new agent.", true);
        register(existing, params);
        try {
          const resumed = await context.manager.resume(params.resume, params.prompt, signal);
          coordinator.consumeRecord(resumed ?? existing);
          return resumed
            ? textResult(formatRecord(resumed, "inline"), resumed.status === "error")
            : textResult(`Failed to resume nested agent "${params.resume}".`, true);
        } catch (error) {
          coordinator.consumeRecord(existing);
          return textResult(error instanceof Error ? error.message : String(error), true);
        }
      }

      if (context.allowedSubagents === false || context.depth >= context.maxSubagentDepth) {
        return textResult(
          `Nested subagent call blocked by delegation policy or depth (depth=${context.depth}, max=${context.maxSubagentDepth}). Complete the task directly.`,
          true,
        );
      }

      // Reloaded per call so new agent files are picked up without a restart.
      const registry = loadRegistry();
      const rawType = params.subagent_type;
      // Strict resolve, never the fallback policy: a project-level
      // `fallbackSubagent` must not hand a nested caller an agent its allowlist
      // never named. The list stays allowlist-filtered so a typo can't enumerate
      // agents this parent may not reach.
      const resolvedType = resolveEnabledTypeIn(registry, rawType);
      if (resolvedType === undefined) {
        return textResult(
          `Unknown or disabled nested agent type: "${rawType}". Allowed: ${availableIn(registry).join(", ") || "none"}.`,
          true,
        );
      }
      const allowed = allowedTypesIn(registry);
      if (allowed !== undefined && !allowed.has(resolvedType)) {
        return textResult(
          `Nested agent type "${resolvedType}" is not allowed for this parent. Allowed: ${[...allowed].join(", ")}.`,
          true,
        );
      }

      const config = getAgentConfigIn(registry, resolvedType);
      // Foreground without an installed gate; coordinated background otherwise.
      // Agent configuration and explicit caller overrides retain their precedence.
      const invocation = resolveAgentInvocationConfig(config, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: installedSession !== undefined,
      });
      let model = ctx.model;
      if (invocation.modelInput) {
        const resolvedModel = resolveModel(invocation.modelInput, ctx.modelRegistry);
        if (typeof resolvedModel === "string") {
          if (invocation.modelFromParams) return textResult(resolvedModel, true);
        } else {
          model = resolvedModel;
        }
      }

      // Same scopeModels policy as the top-level Agent tool — a nested spawn
      // must not escape the allowlist. A "warn" verdict proceeds silently:
      // child sessions have no UI surface to toast to.
      const scopeVerdict = checkModelScope({
        model,
        cwd: context.configCwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: invocation.modelFromParams,
        agentLabel: config?.displayName ?? resolvedType,
        modelInput: invocation.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message, true);

      // The whole branch shares the root session's transcript directory; read it
      // off the owning parent rather than this child session's own id.
      const rootSessionId = context.manager.getRecord(context.parentAgentId)?.rootSessionId;
      const childDepth = context.depth + 1;
      const options: NestedSpawnOptions = {
        description: params.description,
        model,
        maxTurns: invocation.maxTurns,
        isolated: invocation.isolated,
        inheritContext: invocation.inheritContext,
        thinkingLevel: invocation.thinking,
        isolation: invocation.isolation,
        invocation: {
          thinking: invocation.thinking,
          maxTurns: invocation.maxTurns,
          isolated: invocation.isolated,
          inheritContext: invocation.inheritContext,
          runInBackground: invocation.runInBackground,
          isolation: invocation.isolation,
        },
        // Nested children are hidden from every reporting surface, so their spend
        // would otherwise be unattributable. Fold it into every ancestor's record:
        // the top-level one appears in lifecycle events, completion notifications,
        // and `/agents`, and those all read `lifetimeUsage`. The whole chain is
        // walked, not just the immediate parent — a spawn callback only fires for
        // that child's OWN turns, so stopping at one level would hide a
        // great-grandchild from the only record anyone can see. (The live
        // widget/fleet counters read their own per-agent activity tracker, which
        // still sees only the top-level agent's own turns.)
        onAssistantUsage: accountUsage,
        structuredOutput: params.result_format === "structured" || (installedSession && params.result_format !== "text") ? compiledResultReport : undefined,
        depth: childDepth,
        parentAgentId: context.parentAgentId,
        maxSubagentDepth: context.maxSubagentDepth,
        configCwd: context.configCwd,
        rootSessionId,
      };

      // Transcript wiring, same gate as the top-level path: the child's
      // `output_transcript` frontmatter wins, else the project default. Without
      // it a nested run leaves no artifact but the string it returned — the
      // parent's own transcript records the call and the answer, never the tool
      // calls in between, which is exactly what a misbehaving child needs to
      // explain itself. Filed under the ROOT session and this branch's config
      // root, so a nested transcript lands in the same `tasks/` directory as its
      // ancestors' rather than in a directory of its own.
      const transcriptSessionId =
        rootSessionId !== undefined && (config?.outputTranscript ?? getOutputTranscriptDefault())
          ? rootSessionId
          : undefined;
      let childId: string | undefined;
      // Startup failure can remove the manager entry after coordination registered
      // it. Keep the same object so the next request cannot wait on that orphan.
      let registeredRecord: AgentRecord | undefined;
      const attachTranscript = (id: string): void => {
        childId = id;
        const rec = context.manager.getRecord(id);
        if (!rec) return;
        registeredRecord = rec;
        ownedChildren.add(id);
        rec.resultFormat = options.structuredOutput ? "structured" : "text";
        register(rec, params);
        if (transcriptSessionId === undefined) return;
        rec.outputFile = createOutputFilePath(context.configCwd, id, transcriptSessionId);
        writeInitialEntry(rec.outputFile, id, params.prompt, ctx.cwd);
      };
      options.onSessionCreated = (session) => {
        const rec = childId === undefined ? undefined : context.manager.getRecord(childId);
        if (rec?.outputFile && childId !== undefined) {
          rec.outputCleanup = streamToOutputFile(session, rec.outputFile, childId, ctx.cwd);
        }
      };

      // `ctx` is forwarded to the manager unmodified, never captured at tool-build
      // time: each AgentSession builds its own ExtensionRunner from that session's
      // cwd/sessionManager/modelRegistry, so this is the CHILD's context. Capturing
      // one earlier would silently give a grandchild the wrong worktree base, the
      // wrong conversation under inherit_context, and the wrong inherited model.
      //
      // spawn() throws on strict worktree-isolation failure and cwd validation —
      // report it as a tool error, like the top-level Agent tool does, instead of
      // letting it escape into the child's turn.
      try {
        if (invocation.runInBackground) {
          const id = context.manager.spawn(context.pi, ctx, resolvedType, params.prompt, {
            ...options,
            isBackground: true,
          });
          // Synchronous, before the event loop yields — onSessionCreated fires
          // asynchronously inside runAgent, so the file is attached in time.
          attachTranscript(id);
          // Worktree isolation starts the agent asynchronously; surface its
          // failure as a tool error, like the synchronous throw used to.
          await context.manager.awaitStartup(id);
          return textResult(`Nested agent started in background. Agent ID: ${id}\nTask registered; ${installedSession ? "the next model request waits for required results and adopts them" : "use get_subagent_result wait:true before finishing"}. Do not repeat delegated work.`);
        }

        const { record } = await context.manager.spawnAndWait(
          context.pi,
          ctx,
          resolvedType,
          params.prompt,
          { ...options, signal },
          attachTranscript,
        );
        coordinator.consumeRecord(record);
        return textResult(formatRecord(record, "inline"), record.status === "error");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (registeredRecord) {
          const record = registeredRecord;
          if (context.manager.getRecord(record.id) !== record && record.promise === undefined) {
            // No run was started; Agent already returns this failure inline.
            record.status = "error";
            record.error = message;
            record.runSettled = true;
            record.completedAt ??= Date.now();
          }
          // A transcript/wiring error may occur after a child actually started.
          // Do not consume that live child's result or detach its output stream.
          if (record.status !== "running" && record.status !== "queued" && record.runSettled !== false) {
            coordinator.consumeRecord(record);
            ownedChildren.delete(record.id);
            try { record.outputCleanup?.(); } catch { /* best-effort transcript detach */ }
            record.outputCleanup = undefined;
          }
        }
        coordinator.changed();
        return textResult(message, true);
      }
    },
  });

  const resultTool = defineTool({
    name: NESTED_TOOL_NAMES[1],
    label: "Get Nested Agent Result",
    description: "Check or wait for a background nested agent owned by this parent.",
    parameters: Type.Object({
      agent_id: Type.String(),
      wait: Type.Optional(Type.Boolean()),
      view: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("evidence"), Type.Literal("full")])),
    }),
    execute: async (_toolCallId, params, signal) => {
      if (closed) return textResult("Nested orchestration is closed.", true);
      const record = workflowRecords.get(params.agent_id) ?? context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId)) {
        return textResult(`Nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      // Wait for completion if requested. Cancellation (e.g. the parent's tool
      // call is aborted) stops only this wait; the nested child keeps running and
      // stays unconsumed. Queued records have no promise until the manager starts
      // them, so poll — abortably — until they leave the queue, then await.
      if (params.wait && (record.status === "queued" || record.status === "running" || (record.runSettled === false && record.status !== "stopped"))) {
        while (record.status === "queued") {
          await abortable(new Promise<void>(resolve => setTimeout(resolve, 250)), signal);
        }
        if (record.promise) await abortable(record.promise, signal);
      }
      if (record.status !== "running" && record.status !== "queued" && record.runSettled !== false) coordinator.consumeRecord(record);
      return textResult(params.view ? renderAgentResult(record, params.view) : formatRecord(record, "fetched"), record.status === "error");
    },
  });

  const steerTool = defineTool({
    name: NESTED_TOOL_NAMES[2],
    label: "Steer Nested Agent",
    description: "Send guidance to a running nested agent owned by this parent.",
    parameters: Type.Object({
      agent_id: Type.String(),
      message: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      if (closed) return textResult("Nested orchestration is closed.", true);
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId) || record.status !== "running") {
        return textResult(`Running nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      // Session not ready yet — queue the steer. The manager flushes pending
      // steers when the session is created (same contract as the top-level tool).
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        return textResult(`Steering message queued for nested agent ${params.agent_id}.`);
      }
      try {
        await record.session.steer(params.message);
      } catch (err) {
        return textResult(`Failed to steer nested agent: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      return textResult(`Steering message sent to nested agent ${params.agent_id}.`);
    },
  });

  const tasksTool = defineTool({
    name: NESTED_TOOL_NAMES[3],
    label: "Nested Subagent Tasks",
    description: "Coordinate only this owner's tasks: independent grants one independent request batch; wait revokes that grant; finish requires adopted required results.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("independent"), Type.Literal("wait"), Type.Literal("finish")]),
      work: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 8 })),
    }),
    execute: async (_id, params, signal) => {
      if (closed) return textResult("Nested orchestration is closed.", true);
      try {
        if (params.action === "independent") {
          if (!installedSession) throw new Error("Request coordination is not installed; collect children with get_subagent_result wait:true.");
          coordinator.allowIndependent(params.work ?? []);
        } else if (params.action === "wait") {
          coordinator.requireWait();
          // A non-SDK host still gets a real join, rather than an inert tool.
          if (!installedSession) {
            await coordinator.waitForRequest(signal);
            const deliveries = coordinator.deliveries();
            for (const delivery of deliveries) coordinator.consume(delivery);
            return textResult(deliveries.map(delivery => delivery.content).join("\n\n") || "No required results outstanding.");
          }
        } else coordinator.finish();
        return textResult(coordinator.snapshot() || "No outstanding delegated work.");
      } catch (error) { return textResult(error instanceof Error ? error.message : String(error), true); }
    },
  });

  const workflowTool = defineTool({
    name: NESTED_TOOL_NAMES[4],
    label: "Nested Subagent Workflow",
    description: "Run the existing deterministic workflow runtime, owned only by this agent. Requires explicit user opt-in to workflows. Uses the same agent allowlist and depth cap as Agent. Background runs join at this owner's next request; results are available via get_subagent_result. Scripts use export const meta={name,description}; agent(), parallel(), pipeline(), workflow(), log(), phase(), args and budget. Shell gates call this owner's bash via ctx.executeTool, enforcing its tool permissions and safety handlers.",
    parameters: Type.Object({
      script: Type.Optional(Type.String({ maxLength: MAX_SCRIPT_LENGTH })),
      scriptPath: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      args: Type.Optional(Type.Any()),
      resumeFromRunId: Type.Optional(Type.String({ pattern: "^wf_[a-z0-9-]{6,}$" })),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      required: Type.Optional(Type.Boolean()),
      independent_work: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 8 })),
    }),
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      if (closed || context.workflowsEnabled === false || context.allowedSubagents === false || context.depth >= context.maxSubagentDepth) {
        return textResult("Nested workflow blocked by feature, delegation policy or depth limit.", true);
      }
      try {
        validateAssignmentInput(assignmentInput(params));
        const prior = params.resumeFromRunId === undefined ? undefined : workflows.get(params.resumeFromRunId);
        if (params.resumeFromRunId && (!prior || prior.status === "running")) {
          return textResult("Workflow resume target not found, still running, or not owned by this parent.", true);
        }
        const resolved = resolveWorkflowScript(
          prior && params.script === undefined && params.scriptPath === undefined && params.name === undefined
            ? { scriptPath: prior.scriptPath, script: prior.script } : params, ctx.cwd,
        );
        if (!resolved.ok) return textResult(resolved.message, true);
        const meta = extractMeta(resolved.script).meta;
        const id = workflowRunId();
        let scriptPath: string | undefined;
        let journalPath: string | undefined;
        try {
          // Child session id isolates persisted artifacts from the root and siblings.
          const dir = sessionTaskDir(context.configCwd, ctx.sessionManager.getSessionId());
          scriptPath = join(dir, `${id}.workflow.js`);
          writeFileSync(scriptPath, resolved.script, "utf-8");
          journalPath = join(dir, `${id}.workflow.jsonl`);
        } catch { scriptPath = undefined; journalPath = undefined; }
        const task = createWorkflowTask({
          id, script: resolved.script, scriptPath: resolved.scriptPath ?? scriptPath,
          args: params.args, meta, toolCallId, journalPath,
          ...(prior?.journalPath ? { replay: readJournal(prior.journalPath), resumedFrom: prior.id } : {}),
        });
        workflows.set(id, task);
        const record: AgentRecord = {
          id, type: "workflow", description: meta.description, status: "running", runSettled: false,
          parentAgentId: context.parentAgentId, depth: context.depth,
          maxSubagentDepth: context.maxSubagentDepth, toolUses: 0, startedAt: Date.now(),
          lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
          abortController: task.abortController,
        };
        workflowRecords.set(id, record);
        register(record, params);
        // Foreground tool cancellation follows the workflow, background cancellation
        // follows the owner's lifetime instead (not a completed tool-call signal).
        const forwardAbort = () => task.abortController.abort(signal?.reason);
        const foreground = installedSession === undefined;
        if (foreground) signal?.addEventListener("abort", forwardAbort, { once: true });
        if (foreground && signal?.aborted) forwardAbort();
        record.promise = (async () => {
          try {
            const result = await runWorkflow({
              script: task.script, args: task.args, signal: task.abortController.signal,
              host: createWorkflowHost({
                pi: context.pi, ctx, manager: context.manager,
                signal: task.abortController.signal, workflowId: id,
                rootSessionId: context.manager.getRecord(context.parentAgentId)?.rootSessionId,
                nested: {
                  parentAgentId: context.parentAgentId, depth: context.depth,
                  maxSubagentDepth: context.maxSubagentDepth, configCwd: context.configCwd,
                  allowedSubagents: context.allowedSubagents, onAssistantUsage: accountUsage,
                },
                executeGate: context.executeWorkflowGate ?? ((command, cwd, gateSignal) => executeNestedWorkflowGate(ctx, command, cwd, gateSignal)),
              }),
              onProgress: entries => {
                updateWorkflowProgressBatch(task, entries);
                if (!closed) for (const entry of entries) {
                  if (entry.type === "workflow_agent" && entry.recordId
                    && ownsRecord(context.manager.getRecord(entry.recordId), context.parentAgentId)) ownedChildren.add(entry.recordId);
                }
              },
              journal: {
                ...(task.replay ? { entries: task.replay } : {}),
                ...(journalPath ? { append: entry => appendJournal(journalPath!, entry) } : {}),
              },
            });
            completeWorkflowTask(task, result);
            record.status = result.status === "completed" ? "completed" : result.status === "killed" ? "stopped" : "error";
          } catch (error) {
            failWorkflowTask(task, error instanceof Error ? error.message : String(error));
            record.status = "error";
          } finally {
            if (foreground) signal?.removeEventListener("abort", forwardAbort);
            const failures = collapse(task.workflowProgress).agents.filter(agent => agent.state === "error");
            const failureNote = failures.length
              ? `Workflow script settled with ${failures.length} failed child call(s):\n${failures.slice(0, 6).map(agent => `${agent.label}: ${(agent.error ?? "Child failed").slice(0, 400)}`).join("\n")}\n\n`
              : "";
            record.result = failureNote + workflowResultText(task);
            record.error = task.error;
            record.runSettled = true;
            record.completedAt = Date.now();
            coordinator.changed();
          }
          return record.result!;
        })();
        if (foreground) {
          await record.promise;
          coordinator.consumeRecord(record);
          return textResult(formatRecord(record, "inline"), record.status === "error");
        }
        return textResult(`Nested workflow "${meta.name}" started. Agent ID: ${id}\nThe next owner request waits for required results. Use get_subagent_result for targeted verification.`);
      } catch (error) { return textResult(error instanceof Error ? error.message : String(error), true); }
    },
  });

  const dispose = () => {
    if (closed) return;
    closed = true;
    coordinator.dispose();
    for (const task of workflows.values()) task.abortController.abort(new Error("Nested owner disposed"));
    for (const id of ownedChildren) {
      const record = context.manager.getRecord(id);
      if (ownsRecord(record, context.parentAgentId)
        && (record.status === "running" || record.status === "queued" || record.runSettled === false)) context.manager.abort(id);
    }
    ownedChildren.clear();
    workflows.clear();
    workflowRecords.clear();
    releaseSession?.();
    releaseSession = undefined;
    installedSession = undefined;
  };
  const install = (session: AgentSession): (() => void) => {
    if (closed) throw new Error("Nested orchestration is closed");
    if (installedSession) {
      if (installedSession !== session) throw new Error("Nested tools cannot be shared between owner sessions");
      return dispose;
    }
    installedSession = session;
    const stop = new AbortController();
    let released = false;
    const previousRequest = session.agent.prepareRequest;
    const previousFinish = session.agent.finishTurn;
    const gate: NonNullable<typeof previousRequest> = async (request, signal) => {
      if (released) return (await previousRequest?.(request, signal)) ?? undefined;
      const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
      await coordinator.waitForRequest(combined);
      combined.throwIfAborted();
      for (const delivery of coordinator.deliveries()) {
        session.sessionManager.appendCustomMessageEntry("subagent-notification", delivery.content, false, {
          displayOrigin: "pi-subagents", agentId: delivery.record.id,
          assignment: { ...delivery.assignment, delivery: "consumed" },
        });
        coordinator.consume(delivery);
      }
      const prepared = await previousRequest?.(request, combined);
      combined.throwIfAborted();
      const state = coordinator.snapshot();
      const current = prepared?.context ?? request.context;
      return { ...prepared, context: state ? { ...current, messages: [...current.messages, {
        role: "custom" as const, customType: "subagent-task-state", content: state, display: false, timestamp: Date.now(),
      }] } : current };
    };
    const finish: NonNullable<typeof previousFinish> = async (turn, signal) => {
      const decision = await previousFinish?.(turn, signal);
      if (released || decision?.action === "end") return decision ?? undefined;
      if (!turn.message.content.some(block => block.type === "toolCall") && coordinator.needsContinuation()) {
        coordinator.requireWait();
        session.sessionManager.appendCustomMessageEntry("subagent-task-state",
          "Required delegated results are outstanding. Adopt them at the next request before finalizing.", false);
        return { action: "continue" };
      }
      return decision ?? undefined;
    };
    session.agent.prepareRequest = gate;
    session.agent.finishTurn = finish;
    const unsubscribe = session.subscribe(event => {
      if (event.type === "message_start" && event.message.role === "user") coordinator.begin();
      if (event.type === "agent_settled") {
        coordinator.end();
        for (const task of workflows.values()) if (task.status === "running") task.abortController.abort();
      }
    });
    // Observe admitted input, not preflight events which other extensions may refuse.
    const originalPrompt = session.prompt, originalSteer = session.steer, originalFollowUp = session.followUp;
    const prompt: typeof session.prompt = (text, options) => originalPrompt.call(session, text, {
      ...options, preflightResult(disposition) {
        if (!released && disposition === "queued" && options?.source !== "extension") coordinator.acceptedInput();
        options?.preflightResult?.(disposition);
      },
    });
    const steer: typeof session.steer = async (text, images, options) => {
      const disposition = await originalSteer.call(session, text, images, options);
      if (!released && disposition === "queued" && options?.source !== "extension") coordinator.acceptedInput();
      return disposition;
    };
    const followUp: typeof session.followUp = async (text, images, options) => {
      const disposition = await originalFollowUp.call(session, text, images, options);
      if (!released && disposition === "queued" && options?.source !== "extension") coordinator.acceptedInput();
      return disposition;
    };
    session.prompt = prompt; session.steer = steer; session.followUp = followUp;
    releaseSession = () => {
      released = true;
      stop.abort(new Error("Nested coordination disposed"));
      unsubscribe();
      if (session.agent.prepareRequest === gate) session.agent.prepareRequest = previousRequest;
      if (session.agent.finishTurn === finish) session.agent.finishTurn = previousFinish;
      if (session.prompt === prompt) session.prompt = originalPrompt;
      if (session.steer === steer) session.steer = originalSteer;
      if (session.followUp === followUp) session.followUp = originalFollowUp;
    };
    return dispose;
  };
  const tools = context.allowedSubagents === false || context.depth >= context.maxSubagentDepth
    ? [] : [agentTool, resultTool, steerTool, tasksTool, ...(context.workflowsEnabled === false ? [] : [workflowTool])];
  return Object.assign(tools, { install, dispose });
}
