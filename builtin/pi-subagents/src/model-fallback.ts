import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";

export interface ModelFallbackInfo {
  from: string;
  to: string;
  reason: string;
}

export interface ModelFallbackOptions {
  fallbackModel?: string;
  modelRegistry: ExtensionContext["modelRegistry"];
  cwd: string;
  agentLabel: string;
  signal?: AbortSignal;
  canFallback?: () => boolean;
  onModelFallback?: (info: ModelFallbackInfo) => void;
  onWarning?: (message: string) => void;
}

// A continuation hint, not an enforcement mechanism for avoiding repeated tools.
const CONTINUATION = "Continue the current task using the existing conversation history and completed tool results. Do not restart the task or replay already completed operations. Finish only the remaining work.";

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "Unknown error";
}

/** Conservative allowlist: local programming/configuration errors are not failover triggers. */
function failureKind(error: unknown, providerReported = false): "auth" | "provider" | undefined {
  const text = errorText(error);
  const details = error && typeof error === "object"
    ? error as { name?: string; code?: string; status?: number; statusCode?: number; cause?: unknown }
    : undefined;
  if (details?.name === "AbortError" || /^(ABORT_ERR|ERR_ABORTED)$/.test(details?.code ?? "") ||
      /\b(abort(?:ed)?|cancel(?:led|ed)?)\b/i.test(text)) return undefined;
  if (/context (?:window|length)|too many tokens|maximum.*tokens|token limit|structured (?:output|response)|schema validation/i.test(text)) return undefined;
  const status = details?.status ?? details?.statusCode;
  if (status === 401 || status === 403 || details?.name === "AuthenticationError" ||
      /no api key(?: found)?(?: for)?|invalid api[ _-]?key|authentication (?:failed|error)|unauthorized|invalid (?:access )?token|credentials? (?:expired|invalid)|\b(?:401|403)\b.*(?:unauthorized|forbidden)/i.test(text)) return "auth";
  if ((typeof status === "number" && status >= 400 && status <= 599) ||
      /^(?:APIError|APICallError|APIConnectionError|APIConnectionTimeoutError|RateLimitError|InternalServerError|PermissionDeniedError)$/.test(details?.name ?? "") ||
      /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(details?.code ?? "") ||
      /\b(?:rate[ _-]?limit(?:ed)?|overloaded|service unavailable|internal server error|bad gateway|gateway timeout|fetch failed|network error|connection error|connection reset|socket hang up|request timed out|connection timed out)\b|\b(?:HTTP|status(?: code)?)\s*[:=]?\s*[45]\d\d\b|^[45]\d\d\b/i.test(text)) return "provider";
  // fetch commonly wraps a network code in its cause.
  if (details?.cause && details.cause !== error) return failureKind(details.cause);
  // A finalized assistant error is already identified as a provider failure
  // by the kernel. It need not use one of the English exception spellings.
  return providerReported ? "provider" : undefined;
}

/** One switch budget per closure; callers may share it across structured follow-up prompts. */
export function createModelFallback(
  session: Pick<AgentSession, "prompt" | "setModel" | "model" | "messages">,
  options: ModelFallbackOptions,
): (prompt: string) => Promise<void> {
  let switchAttempted = false;
  const warn = (message: string) => {
    // Observability must not change the prompt's resolve/reject semantics.
    try { options.onWarning?.(message); } catch { /* notification only */ }
  };
  const allowed = () => !options.signal?.aborted && (options.canFallback?.() ?? true);

  return async (prompt: string): Promise<void> => {
    if (options.signal?.aborted) return;
    const before = new Set(session.messages);
    let thrown = false;
    let originalError: unknown;
    try {
      // prompt waits for the kernel's retries and settled lifecycle, unlike agent.continue().
      await session.prompt(prompt);
    } catch (error) {
      thrown = true;
      originalError = error;
    }
    const preserveResult = () => { if (thrown) throw originalError; };
    const added = session.messages.filter(message => !before.has(message));
    const lastAssistant = [...session.messages].reverse().find(message => message.role === "assistant");
    const freshAssistant = lastAssistant && !before.has(lastAssistant) ? lastAssistant : undefined;
    if (freshAssistant?.stopReason === "aborted" || freshAssistant?.stopReason === "length") {
      return preserveResult();
    }
    if (!thrown) {
      if (freshAssistant?.stopReason !== "error") return;
      originalError = freshAssistant.errorMessage;
    }
    const kind = failureKind(originalError, !thrown);
    if (!options.fallbackModel?.trim() || switchAttempted || !kind || !allowed()) return preserveResult();
    const hasUser = added.some(message => message.role === "user");
    const hasToolResult = added.some(message => message.role === "toolResult");
    // A rejected preflight has not recorded this prompt. Only explicit auth failure
    // permits sending the original prompt once; otherwise never continue an old task.
    if (!hasUser && !hasToolResult && kind !== "auth") return preserveResult();
    const nextPrompt = !hasUser && kind === "auth" ? prompt : CONTINUATION;
    const input = options.fallbackModel.trim();
    const previousModel = session.model;
    const from = previousModel ? `${previousModel.provider}/${previousModel.id}` : "unknown";
    let model: ReturnType<typeof resolveModel>;
    if (!allowed()) return preserveResult();
    try {
      model = await resolveModel(input, options.modelRegistry);
    } catch (error) {
      warn(`Agent "${options.agentLabel}" could not resolve fallback model "${input}": ${errorText(error).split("\n")[0]}`);
      return preserveResult();
    }
    if (!allowed()) return preserveResult();
    if (typeof model === "string") {
      // resolveModel includes the entire available catalogue; do not put it in a warning.
      warn(`Agent "${options.agentLabel}" fallback model "${input}" is unavailable.`);
      return preserveResult();
    }
    const slash = input.indexOf("/");
    if (slash !== -1 && input.slice(0, slash).toLowerCase() !== model.provider.toLowerCase()) {
      warn(`Agent "${options.agentLabel}" fallback model "${input}" resolved to a different provider; not switching.`);
      return preserveResult();
    }
    const to = `${model.provider}/${model.id}`;
    if (to.toLowerCase() === from.toLowerCase()) {
      warn(`Agent "${options.agentLabel}" fallback model is already active (${to}); not switching.`);
      return preserveResult();
    }
    let scope: ReturnType<typeof checkModelScope>;
    try {
      scope = checkModelScope({
        model, cwd: options.cwd, modelRegistry: options.modelRegistry,
        callerSupplied: false, agentLabel: options.agentLabel, modelInput: input,
      });
    } catch (error) {
      warn(`Agent "${options.agentLabel}" could not check fallback model scope: ${errorText(error).split("\n")[0]}`);
      return preserveResult();
    }
    if (scope.kind !== "ok") warn(scope.message);
    if (scope.kind === "error" || !allowed()) return preserveResult();
    switchAttempted = true;
    try {
      await session.setModel(model);
    } catch (error) {
      warn(`Agent "${options.agentLabel}" could not use fallback model "${input}": ${errorText(error).split("\n")[0]}`);
      return preserveResult();
    }
    if (!allowed()) {
      // setModel is async: cancellation may arrive after it has committed.
      // Restore the original choice where possible; never start a continuation.
      if (previousModel) {
        try { await session.setModel(previousModel); }
        catch {
          warn(`Agent "${options.agentLabel}" was cancelled while switching; could not restore model "${from}". Current model: ${to}.`);
          try { options.onModelFallback?.({ from, to, reason: "Cancelled during model switch; restoring the original model failed." }); } catch { /* notification only */ }
        }
      }
      return preserveResult();
    }
    try { options.onModelFallback?.({ from, to, reason: errorText(originalError) }); }
    catch { warn(`Agent "${options.agentLabel}" model fallback notification failed.`); }
    if (!allowed()) return preserveResult();
    // No recursive wrapper: the backup's own failure is final (including resolved assistant errors).
    await session.prompt(nextPrompt, { expandPromptTemplates: false });
  };
}
