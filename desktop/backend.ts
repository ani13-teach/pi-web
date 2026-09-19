/**
 * Backend process: hosts the ported pi-web server code.
 *
 * Nothing is exposed over the network. The renderer sends HTTP-shaped requests
 * over Electron IPC, this process runs the original App Router handler, and the
 * response travels back the same way. Streaming responses are pulled chunk by
 * chunk, so a slow window applies real backpressure instead of buffering.
 */
import { randomUUID } from "node:crypto";
import { handleRequest, type RouterRequest } from "../services/http-router";
import { killTerminal } from "../lib/terminal-manager";

// The web build configured the outbound HTTP dispatcher (proxy support) from
// Next.js instrumentation.ts. Same job here, without Next.js.
const { configureHttpDispatcher } = await import("../lib/http-dispatcher");
configureHttpDispatcher();

const AGENT_DIR = await import("../lib/session-reader").then((m) => m.getAgentDir());

type PendingRequest = {
  controller: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  pendingRead?: Promise<ReadableStreamReadResult<Uint8Array>>;
  timer?: NodeJS.Timeout;
};

// Register before entering the route, so cancellation also covers a handler
// that has not returned response headers yet.
const requests = new Map<string, PendingRequest>();
const STREAM_IDLE_MS = 5 * 60 * 1000;
let shutdownPromise: Promise<{ closed: boolean }> | undefined;

async function disposeRequest(id: string): Promise<void> {
  const entry = requests.get(id);
  if (!entry) return;
  requests.delete(id);
  clearTimeout(entry.timer);
  // Some upstream routes watch the signal; file watches clean up in cancel().
  // Both paths must run, including when a reader.read() is still pending.
  entry.controller.abort();
  try {
    await entry.reader?.cancel();
  } catch {
    // An errored stream is already closed, but still holds its reader lock.
  } finally {
    entry.reader?.releaseLock();
  }
}

function renewLease(id: string, entry: PendingRequest, ms = STREAM_IDLE_MS): void {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { void disposeRequest(id); }, ms);
  entry.timer.unref?.();
}

export type BackendRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  streamId?: string;
};

async function request(input: BackendRequest) {
  const id = input.streamId ?? randomUUID();
  if (requests.has(id)) throw new Error(`Request ${id} is already open`);
  const entry: PendingRequest = { controller: new AbortController() };
  requests.set(id, entry);
  renewLease(id, entry, 120_000);
  let streamed = false;
  try {
    const params: RouterRequest = { ...input, signal: entry.controller.signal };
    const result = await handleRequest(params);
    if (result.kind === "stream") {
      entry.reader = result.body.getReader();
      if (entry.controller.signal.aborted || !input.streamId) {
        try {
          await entry.reader.cancel();
        } finally {
          entry.reader.releaseLock();
          entry.reader = undefined;
        }
        throw new Error(entry.controller.signal.aborted ? "Request cancelled" : "Streaming responses require a streamId");
      }
      renewLease(id, entry);
      streamed = true;
    }
    if (entry.controller.signal.aborted) throw new Error("Request cancelled");
    return {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      bodyBase64: result.kind === "buffered" ? result.bodyBase64 : "",
      streamed,
    };
  } finally {
    if (!streamed) await disposeRequest(id);
  }
}

async function pullStream(id: string): Promise<{ done: boolean; chunkBase64?: string }> {
  const entry = requests.get(id);
  if (!entry?.reader) return { done: true };
  // Keep a lease even while read() is pending. A window that disappears must
  // not leave an unbounded read in the backend.
  renewLease(id, entry);
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    // OAuth can wait silently while the user finishes browser authorization.
    // A comment keeps the IPC pull alive without adding application events.
    entry.pendingRead ??= entry.reader.read();
    const result = await Promise.race([
      entry.pendingRead,
      new Promise<null>((resolve) => { heartbeat = setTimeout(() => resolve(null), 25_000); }),
    ]);
    if (result === null) return { done: false, chunkBase64: Buffer.from(": keepalive\n\n").toString("base64") };
    entry.pendingRead = undefined;
    const { value, done } = result;
    if (done) {
      await disposeRequest(id);
      return { done: true };
    }
    return { done: false, chunkBase64: Buffer.from(value).toString("base64") };
  } catch (error) {
    await disposeRequest(id);
    throw error;
  } finally {
    clearTimeout(heartbeat);
  }
}

function shutdown(): Promise<{ closed: boolean }> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const closing = [...requests.keys()].map(disposeRequest);
    for (const id of globalThis.__piWebTerminals?.keys() ?? []) killTerminal(id, true);
    const sessions = [...(globalThis.__piSessions?.values() ?? [])];
    await Promise.allSettled([...closing, ...sessions.map((session) => session.shutdown())]);
    return { closed: true };
  })();
  return shutdownPromise;
}

type Handler = (params: never) => Promise<unknown> | unknown;

const handlers: Record<string, Handler> = {
  "app.info": () => ({
    pid: process.pid,
    nodeVersion: process.versions.node,
    electron: process.versions.electron ?? null,
    agentDir: AGENT_DIR,
    cwd: process.cwd(),
  }),

  "npx.probe": async () => {
    const { runNpx } = await import("../lib/npx");
    try {
      const { stdout, stderr } = await runNpx(["--version"], { timeout: 30_000 });
      const version = `${stdout}${stderr}`.trim().split("\n").pop() ?? "";
      return version ? { ok: true, version } : { ok: false, error: "npx produced no output" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  "http.request": request,

  "http.pull": (params: { streamId: string }) => pullStream(params.streamId),

  "http.cancel": async (params: { streamId: string }) => {
    const open = requests.has(params.streamId);
    await disposeRequest(params.streamId);
    return { cancelled: open };
  },

  "backend.shutdown": shutdown,
};

const send = (message: unknown): void => {
  process.send?.(message);
};

process.on("message", (raw: unknown) => {
  const message = raw as { kind?: string; envelope?: { id: string; method: string; params: unknown } };
  if (message?.kind !== "request" || !message.envelope) return;
  const { id, method, params } = message.envelope;

  const handler = handlers[method];
  if (!handler) {
    send({ kind: "response", envelope: { id, ok: false, error: `Unknown backend method: ${method}` } });
    return;
  }

  Promise.resolve()
    .then(() => {
      if (shutdownPromise && method !== "backend.shutdown" && method !== "http.cancel") throw new Error("backend is shutting down");
      return handler(params as never);
    })
    .then((result) => {
      send({ kind: "response", envelope: { id, ok: true, result } });
      if (method === "backend.shutdown") {
        // The IPC channel keeps the loop alive; leaving is the point of shutdown.
        setTimeout(() => process.exit(0), 50);
      }
    })
    .catch((error: unknown) => {
      const text = error instanceof Error ? `${error.message}` : String(error);
      send({ kind: "response", envelope: { id, ok: false, error: text } });
    });
});

process.on("disconnect", () => {
  // No supervisor remains to enforce the deadline after an unexpected exit.
  const deadline = setTimeout(() => process.exit(1), 5_000);
  void shutdown().finally(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
});

send({ kind: "push", push: { type: "backend.log", level: "info", message: `backend ready (pid ${process.pid})` } });
