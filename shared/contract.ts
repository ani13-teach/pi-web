/**
 * Shared contract between the renderer, the Electron main process and the
 * backend process.
 *
 * Everything crosses process boundaries as plain JSON. There is intentionally
 * no HTTP server, no listening port and no SSE endpoint: the renderer sends
 * HTTP-shaped requests through Electron IPC, the backend runs the original
 * pi-web route handler, and streaming responses are pulled chunk by chunk.
 */

export interface BackendMethods {
  "app.info": {
    params: Record<string, never>;
    result: {
      pid: number;
      nodeVersion: string;
      electron: string | null;
      agentDir: string;
      cwd: string;
    };
  };

  /**
   * Checks that npm is reachable for `npx skills …` (skill and plugin installs).
   * Reports the failure verbatim, because the usual cause is a missing npm next
   * to the app binary.
   */
  "npx.probe": {
    params: Record<string, never>;
    result: { ok: boolean; version?: string; error?: string };
  };

  /**
   * Runs one ported App Router handler. `url` is a path plus query, e.g.
   * "/api/sessions?force=1"; the router supplies the loopback origin the
   * handlers expect. Pass `streamId` for routes that answer with a stream
   * (anything with `text/event-stream`): the response comes back as headers
   * plus a stream id, and the body is read with "http.pull".
   */
  "http.request": {
    params: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      bodyBase64?: string;
      streamId?: string;
    };
    result: {
      status: number;
      statusText: string;
      headers: [string, string][];
      bodyBase64: string;
      streamed: boolean;
    };
  };

  /** Reads the next chunk of a streaming response. `done` ends the stream. */
  "http.pull": {
    params: { streamId: string };
    result: { done: boolean; chunkBase64?: string };
  };

  /** Stops reading a streaming response and lets the route clean up. */
  "http.cancel": {
    params: { streamId: string };
    result: { cancelled: boolean };
  };

  "backend.shutdown": {
    params: Record<string, never>;
    result: { closed: boolean };
  };
}

export type BackendMethod = keyof BackendMethods;
export type ParamsOf<M extends BackendMethod> = BackendMethods[M]["params"];
export type ResultOf<M extends BackendMethod> = BackendMethods[M]["result"];

/** Renderer/main -> backend. */
export interface BackendRequestEnvelope {
  id: string;
  method: BackendMethod;
  params: unknown;
}

/** Backend -> renderer/main. */
export type BackendResponseEnvelope =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string; code?: string };

/** Backend -> main -> renderer, outside of request/response. */
export type BackendPush =
  | { type: "backend.log"; level: "info" | "error"; message: string }
  | { type: "backend.down"; reason: string };

/**
 * Backend -> main: which proxy does the system want for this target?
 *
 * The backend cannot read Chromium's proxy configuration (or its bypass rules
 * and PAC scripts) on its own, so it asks the process that can.
 */
export interface ProxyQueryMessage {
  kind: "proxy.query";
  id: string;
  /** Absolute URL, e.g. "https://chatgpt.com/backend-api/codex/responses". */
  url: string;
}

/**
 * Main -> backend: the answer, in Chromium's own spelling ("DIRECT",
 * "PROXY host:port", ...). A failed lookup is reported as a failure rather
 * than as DIRECT, so a broken lookup cannot quietly bypass a proxy.
 */
export type ProxyResultMessage =
  | { kind: "proxy.result"; id: string; ok: true; value: string }
  | { kind: "proxy.result"; id: string; ok: false; error: string };

/** Messages the backend process sends on its IPC channel. */
export type BackendOutMessage =
  | { kind: "response"; envelope: BackendResponseEnvelope }
  | { kind: "push"; push: BackendPush }
  | ProxyQueryMessage;

/** Messages the main process sends to the backend process. */
export type BackendInMessage =
  | { kind: "request"; envelope: BackendRequestEnvelope }
  | ProxyResultMessage;

/** Shape exposed to the renderer through the preload bridge. */
export interface DesktopBridge {
  app: {
    version: string;
    platform: string;
  };
  /** Native folder picker. Returns null when the user cancels. */
  pickDirectory: (defaultPath?: string) => Promise<string | null>;
  invoke: <M extends BackendMethod>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>;
  /** Start the backend again after it stopped or crashed. */
  restartBackend: () => Promise<void>;
  /** Returns an unsubscribe function. */
  onPush: (listener: (push: BackendPush) => void) => () => void;
}

export const DESKTOP_CHANNEL = {
  invoke: "pi-desktop:invoke",
  push: "pi-desktop:push",
  pickDirectory: "pi-desktop:pick-directory",
  restartBackend: "pi-desktop:restart-backend",
} as const;
