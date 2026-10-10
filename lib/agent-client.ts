// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

export class AgentReadinessTimeoutError extends Error {
  constructor() {
    super("Timed out starting the agent session. Your message was not sent; please try again.");
    this.name = "AgentReadinessTimeoutError";
  }
}

/** One absolute budget for activation plus the event-stream handshake. */
export async function runWithAgentReadinessDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("Invalid agent readiness timeout");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let releaseParent: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const abortParent = () => {
      const error = parentSignal?.reason ?? new DOMException("Agent activation cancelled", "AbortError");
      reject(error);
      controller.abort(error);
    };
    if (parentSignal?.aborted) { abortParent(); return; }
    if (parentSignal) {
      parentSignal.addEventListener("abort", abortParent, { once: true });
      releaseParent = () => parentSignal.removeEventListener("abort", abortParent);
    }
    timer = setTimeout(() => {
      const error = new AgentReadinessTimeoutError();
      // Reject independently of fetch: some bridge transports ignore abort.
      reject(error);
      controller.abort(error);
      try { onTimeout?.(); } catch { /* Preserve the readiness timeout. */ }
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation(controller.signal);
    }), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    releaseParent?.();
  }
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
    signal: options.signal,
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
    );
  }
  return body.data as T;
}
