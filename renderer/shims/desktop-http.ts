/**
 * The single place where renderer code talks to the backend.
 *
 * pi-web's components were written against `fetch("/api/…")` and `EventSource`.
 * Instead of rewriting 87 call sites, those two globals are re-pointed here, so
 * the original components keep working while the transport underneath becomes
 * Electron IPC with no HTTP listener anywhere.
 */
import type { DesktopBridge } from "../../shared/contract";

/** Must match VIRTUAL_ORIGIN in services/http-router.ts. */
export const VIRTUAL_ORIGIN = "http://127.0.0.1:30141";

/**
 * Headers the browser would normally add for its own request. They describe a
 * network hop that does not exist here, and the ported host/origin checks treat
 * requests without them as first-party — which they are, since only this window
 * can reach the backend.
 */
const BROWSER_ONLY_HEADERS = new Set([
  "origin",
  "referer",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
]);

export function bridge(): DesktopBridge {
  // pi-web declares its own narrow `window.piDesktop` shape (SessionSidebar.tsx),
  // so the full bridge is reached through a cast.
  const api = (window as { piDesktop?: unknown }).piDesktop as DesktopBridge | undefined;
  if (!api) throw new Error("the desktop bridge is not available");
  return api;
}

export function isApiUrl(url: URL): boolean {
  return url.pathname.startsWith("/api/") || url.pathname === "/api";
}

/** Resolves the many shapes of fetch/EventSource input into one URL. */
export function resolveUrl(input: string | URL): URL | null {
  try {
    return new URL(input.toString(), window.location.href);
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Serialises a FormData upload the way the browser would, boundary included. */
async function encodeMultipart(form: FormData): Promise<{ bytes: Uint8Array; contentType: string }> {
  const boundary = `----piDesktop${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  for (const [name, value] of form.entries()) {
    const disposition = `content-disposition: form-data; name="${name.replace(/"/g, "%22")}"`;
    if (typeof value === "string") {
      parts.push(encoder.encode(`--${boundary}\r\n${disposition}\r\n\r\n${value}\r\n`));
      continue;
    }
    const file = value as File;
    parts.push(
      encoder.encode(
        `--${boundary}\r\n${disposition}; filename="${(file.name ?? "blob").replace(/"/g, "%22")}"\r\n`
        + `content-type: ${file.type || "application/octet-stream"}\r\n\r\n`,
      ),
      new Uint8Array(await file.arrayBuffer()),
      encoder.encode("\r\n"),
    );
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  return { bytes: concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function encodeBody(
  body: BodyInit | null | undefined,
  headers: Headers,
): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    return new TextEncoder().encode(body);
  }
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return new TextEncoder().encode(body.toString());
  }
  if (body instanceof FormData) {
    const { bytes, contentType } = await encodeMultipart(body);
    headers.set("content-type", contentType);
    return bytes;
  }
  if (body instanceof Blob) {
    if (body.type && !headers.has("content-type")) headers.set("content-type", body.type);
    return new Uint8Array(await body.arrayBuffer());
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new Error(`Unsupported request body: ${Object.prototype.toString.call(body)}`);
}

const HOP_BY_HOP = new Set(["connection", "transfer-encoding", "keep-alive", "content-length"]);

function responseHeaders(entries: [string, string][]): Headers {
  const headers = new Headers();
  for (const [key, value] of entries) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  }
  return headers;
}

export interface BridgeRequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
  /** Coarse upload progress: encoded body ready, then completion at response. */
  onBodyEncoded?: (bytes: number) => void;
}

/** Enforce the upstream file limits before any Blob is read into memory. */
function uploadError(body: BodyInit | null | undefined): string | undefined {
  const fileLimit = 25 * 1024 * 1024;
  const totalLimit = 100 * 1024 * 1024;
  if (body instanceof FormData) {
    let total = 0;
    for (const [name, value] of body.entries()) {
      if (typeof value !== "string" && value.size > fileLimit) return "Each upload must be 25MB or smaller";
      total += typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.size;
      // Bound multipart metadata as well as file bytes.
      total += new TextEncoder().encode(name).byteLength + 256;
      if (typeof value !== "string") total += new TextEncoder().encode(value.name).byteLength;
      if (total > totalLimit) return "Uploads including form data must total 100MB or less";
    }
  } else {
    const size = body instanceof Blob ? body.size
      : body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? body.byteLength
      : typeof body === "string" ? new TextEncoder().encode(body).byteLength : 0;
    if (size > totalLimit) return "Request body must be 100MB or smaller";
  }
}

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(aborted(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Owns both the response reader and its abort listener until consumption ends. */
function responseBody(
  streamId: string,
  buffered: Uint8Array | null,
  signal?: AbortSignal | null,
): ReadableStream<Uint8Array> {
  const api = bridge();
  let finished = false;
  let abort: () => void;
  const cleanup = () => {
    finished = true;
    signal?.removeEventListener("abort", abort);
  };
  const cancelBackend = () => { void api.invoke("http.cancel", { streamId }).catch(() => {}); };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (finished) return;
        cleanup();
        cancelBackend();
        controller.error(aborted(signal!));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(controller) {
      try {
        if (buffered !== null) {
          controller.enqueue(buffered);
          cleanup();
          controller.close();
          return;
        }
        const { done, chunkBase64 } = await api.invoke("http.pull", { streamId });
        if (finished) return;
        if (done) {
          cleanup();
          controller.close();
        } else {
          controller.enqueue(decodeBase64(chunkBase64 ?? ""));
        }
      } catch (error) {
        if (finished) return;
        cleanup();
        cancelBackend();
        controller.error(error);
      }
    },
    cancel() {
      cleanup();
      cancelBackend();
    },
  }, { highWaterMark: 0 });
}

/**
 * One request through the ported pi-web router.
 *
 * Response bodies with a streaming content type (server-sent events, and the
 * file watcher) come back as a live stream: the backend only reads a chunk when
 * this side asks for one, so a busy session cannot flood the window.
 */
export async function bridgeRequest(
  input: string | URL,
  init: BridgeRequestInit = {},
): Promise<Response> {
  const url = resolveUrl(input);
  if (!url) throw new Error(`Unsupported request URL: ${String(input)}`);
  const api = bridge();

  const headers = new Headers(init.headers);
  for (const name of [...headers.keys()]) {
    if (BROWSER_ONLY_HEADERS.has(name.toLowerCase())) headers.delete(name);
  }

  init.signal?.throwIfAborted();
  const method = (init.method ?? "GET").toUpperCase();
  const limitError = uploadError(init.body);
  if (limitError) return Response.json({ error: limitError }, { status: 413 });
  const bytes = await abortable(encodeBody(init.body, headers), init.signal);
  init.signal?.throwIfAborted();
  init.onBodyEncoded?.(bytes?.byteLength ?? 0);

  const rawHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });

  const requested = `${url.pathname}${url.search}`;
  const streamId = crypto.randomUUID();
  const cancel = () => { void api.invoke("http.cancel", { streamId }).catch(() => {}); };
  init.signal?.addEventListener("abort", cancel, { once: true });
  try {
    init.signal?.throwIfAborted();
    const result = await abortable(api.invoke("http.request", {
      url: requested,
      method,
      headers: rawHeaders,
      bodyBase64: bytes ? encodeBase64(bytes) : undefined,
      streamId,
    }), init.signal);
    init.signal?.throwIfAborted();
    const noBody = method === "HEAD" || [204, 205, 304].includes(result.status);
    if (noBody && result.streamed) cancel();
    const body = noBody ? null : responseBody(
      streamId,
      result.streamed ? null : decodeBase64(result.bodyBase64),
      init.signal,
    );
    return new Response(body as BodyInit | null, {
      status: result.status,
      statusText: result.statusText || undefined,
      headers: responseHeaders(result.headers),
    });
  } catch (error) {
    cancel();
    throw error;
  } finally {
    // Once headers arrive the body owns its own abort listener.
    init.signal?.removeEventListener("abort", cancel);
  }
}
