/**
 * mention-clone.ts — start a mentioned agent through a clone of this
 * conversation, without putting anything in the chat.
 *
 * Claude Code routes `@agent-<type>` through the main model: the mention
 * becomes a `<system-reminder>` appended to the prompt and the model makes the
 * tool call (see `agentMentionReminder`). That buys the spawned agent a prompt
 * written with conversation context, and costs a visible turn — the model's
 * reasoning and its tool block land in the transcript, for a decision the user
 * already made when they typed the handle.
 *
 * So the turn happens somewhere else. The conversation is cloned into a
 * throwaway in-memory session — same conversation, live system prompt and model.
 * Pi's canonical projection resolves the active branch, compaction summaries
 * and context edits before that history is stored in the clone's own manager.
 * Parent system messages are replaced with the live prompt and the clone's
 * single-tool loadout, so old parent tool declarations cannot leak into it.
 * No session file or parent message objects are reused.
 *
 * Four details make the spawn belong to the real session rather than the
 * clone:
 *
 *   - the clone is handed the *registered* `Agent` tool, whose handler closes
 *     over the main activation, so it spawns top-level: widget, fleet row,
 *     handle, completion notification, all as if the main model had called it;
 *   - that tool is re-bound to the main `ExtensionContext`, because the handler
 *     reads `cwd`, `model` and `sessionManager.getSessionId()` off it to place
 *     the transcript and the `rootSessionId`. The clone's own context would
 *     file both under the throwaway fork;
 *   - it is called with no tool-call id. The clone's turn produces one, but the
 *     real session never issued it, and a `<tool-use-id>` pointing at nothing
 *     is exactly the bug the mention-resume path had to fix;
 *   - and it is forced into the background. A foreground agent returns its
 *     answer as the tool result and is marked `resultConsumed` so no completion
 *     notification is sent — correct when the caller is the real conversation,
 *     silent loss when the caller is a fork about to be discarded. Background
 *     delivery is the only route from a mention back to the main model.
 *
 * The clone gets one tool and one job. It cannot read, write or run anything —
 * an invisible turn with the full toolset could do invisible work.
 */

import {
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionToolContext,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runInChildSessionContext } from "./child-context.js";
import { agentMentionReminder } from "./mention.js";
import type { SubagentType } from "./types.js";

export interface MentionCloneOptions {
  /** The MAIN session's context — what the spawn is attributed to, and the
   * source of both the conversation and the live system prompt. */
  ctx: ExtensionContext;
  /** Agent type the handle resolved to. */
  type: SubagentType;
  /** What the user typed after the handle. */
  message: string;
  /** The registered `Agent` tool, reused so the spawn is an ordinary one. */
  agentTool: ToolDefinition;
}

export interface MentionCloneResult {
  /** True once the clone actually called `Agent`. */
  spawned: boolean;
  /** Why not, when it didn't. Absent on success. */
  error?: string;
}

/**
 * Fork the conversation, let the copy make the tool call, throw the copy away.
 * Never rejects: a clone that cannot run is reported so the caller can fall
 * back to starting the agent directly.
 */
export async function runMentionClone(opts: MentionCloneOptions): Promise<MentionCloneResult> {
  const { ctx, type, message, agentTool } = opts;

  let spawned = false;
  const cloneAgentTool: ToolDefinition = {
    ...agentTool,
    execute: (_cloneToolCallId, params, signal, onUpdate, cloneCtx) => {
      // One spawn per mention. The clone has a single tool and every reason to
      // stop after using it, but a model that decides to "also" launch a second
      // agent would do it where nobody can see and nobody asked.
      if (spawned) {
        return Promise.resolve({
          content: [{ type: "text" as const, text: "Already started an agent for this mention. Stop here." }],
          details: undefined,
          isError: true,
        });
      }
      spawned = true;
      // undefined tool-call id + the main ctx: see the header. Background is
      // forced rather than left to the clone: `run_in_background` defaults to
      // false, and a foreground agent answers through its TOOL RESULT — which
      // here is delivered into a session that is disposed moments later, so the
      // agent would run, appear in the widget and the fleet, and reach nobody.
      const toolContext: ExtensionToolContext = {
        ...ctx,
        // Nested execution belongs to the clone's actual tool invocation;
        // cwd, model, UI and session ownership still belong to the parent.
        tools: cloneCtx.tools,
        executeTool: (name, args, options) => cloneCtx.executeTool(name, args, options),
      };
      return agentTool.execute(
        undefined as never,
        { ...(params as Record<string, unknown>), run_in_background: true } as typeof params,
        signal,
        onUpdate,
        toolContext,
      );
    },
  };

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    // Keep the existing registry-to-runtime bridge so the clone reuses the
    // parent's extension providers and request-time authentication.
    const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
    // Resolve compaction and context edits once, then seed canonical history
    // before construction. Mutating agent.state.messages no longer restores it.
    const conversation = buildSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
    );
    const cloneManager = SessionManager.inMemory(ctx.cwd);
    for (const parentMessage of conversation.messages) {
      const historyMessage = structuredClone(parentMessage);
      switch (historyMessage.role) {
        case "system":
          // The parent loadout must not restore tools in this one-tool clone.
          break;
        case "compactionSummary":
          cloneManager.appendCompaction(historyMessage.summary, null, historyMessage.tokensBefore);
          break;
        case "branchSummary":
          cloneManager.branchWithSummary(cloneManager.getLeafId(), historyMessage.summary);
          break;
        default:
          cloneManager.appendMessage(historyMessage);
      }
    }
    const systemPrompt = ctx.getSystemPrompt();
    const created = await runInChildSessionContext(async () => {
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir,
        settingsManager,
        systemPromptOverride: () => systemPrompt,
        appendSystemPromptOverride: () => [],
        extensionFactories: [(pi) => {
          // Custom prompts still gain structured sections (e.g. cwd). The
          // native hook sends the parent's effective prompt verbatim instead.
          pi.on("before_agent_start", () => ({ systemPrompt }));
        }],
      });
      await resourceLoader.reload();
      return createAgentSession({
        cwd: ctx.cwd,
        sessionManager: cloneManager,
        resourceLoader,
        settingsManager,
        model: ctx.model,
        ...(ctx.thinkingLevel && { thinkingLevel: ctx.thinkingLevel }),
        ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime }),
        // An allowlist naming exactly the clone's own tool. NOT `noTools:
        // "all"`, whose doc comment ("start with no tools enabled") reads like
        // it spares custom tools and does not: it resolves to an EMPTY
        // allowlist, and `isAllowedTool` then drops every tool from the
        // registry — the custom one included. The clone would be prompted with
        // nothing to call, answer in prose, and every mention would fall
        // through to the direct start with a warning. Same idiom as
        // agent-runner's `tools: sessionTools` beside its nested `customTools`.
        tools: [cloneAgentTool.name],
        customTools: [cloneAgentTool],
      });
    });
    session = created.session;

    // User text first, reminder after — the order Claude Code's attachment
    // renderer produces, where the reminder trails the message it is about.
    await session.prompt(`${message}\n\n${agentMentionReminder(type)}`);
  } catch (err) {
    return { spawned, error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.dispose?.();
  }

  return spawned
    ? { spawned: true }
    : { spawned: false, error: "the conversation clone did not start it" };
}
