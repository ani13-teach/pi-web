/**
 * Serves the ported pi-web App Router handlers inside the backend process.
 *
 * There is no HTTP listener: requests arrive over the process IPC channel
 * (see shared/contract.ts -> "http.request") carrying the original method,
 * path, headers and body, and the resulting Response is sent back the same way.
 * Streaming responses are forwarded chunk by chunk as push messages.
 */
import { attachNextRequestHelpers, type NextRequest } from "../desktop/shims/next-server";
import { ROUTES } from "./routes.gen";

export type RouteContext = { params: Promise<any> };
/**
 * The request handed to a handler carries Next's `nextUrl` and `cookies` (see
 * attachNextRequestHelpers), so routes typed against NextRequest fit here and
 * routes typed against plain Request keep working.
 */
export type RouteHandler = (request: NextRequest, context: RouteContext) => Response | Promise<Response>;
export type RouteModule = {
  GET?: RouteHandler;
  POST?: RouteHandler;
  PUT?: RouteHandler;
  PATCH?: RouteHandler;
  DELETE?: RouteHandler;
  HEAD?: RouteHandler;
  OPTIONS?: RouteHandler;
};

/**
 * The base the renderer pretends to talk to. pi-web's request-security checks
 * the Host header against loopback / configured hosts, so requests must arrive
 * addressed to a loopback origin even though nothing is listening on it.
 */
export const VIRTUAL_ORIGIN = "http://127.0.0.1:30141";

type CompiledRoute = {
  path: string;
  segments: string[];
  module: RouteModule;
};

const compiled: CompiledRoute[] = ROUTES.map((route) => ({
  path: route.path,
  segments: route.path.split("/").filter(Boolean),
  module: route.module,
}));

const staticRoutes = new Map<string, CompiledRoute>();
const dynamicRoutes: CompiledRoute[] = [];

for (const route of compiled) {
  if (route.segments.some((segment) => segment.startsWith("["))) {
    dynamicRoutes.push(route);
  } else {
    staticRoutes.set(route.path, route);
  }
}

// Most specific first: more literal segments wins, catch-all loses.
dynamicRoutes.sort((a, b) => a.segments.length - b.segments.length);

function matchRoute(pathname: string): { route: CompiledRoute; params: Record<string, string | string[]> } | null {
  const direct = staticRoutes.get(pathname);
  if (direct) return { route: direct, params: {} };

  const parts = pathname.split("/").filter(Boolean);
  for (const route of dynamicRoutes) {
    const params: Record<string, string | string[]> = {};
    const pattern = route.segments;
    let matched = true;
    let index = 0;

    for (let p = 0; p < pattern.length; p += 1) {
      const segment = pattern[p];
      const optionalCatchAll = segment.startsWith("[[...") && segment.endsWith("]]");
      const catchAll = optionalCatchAll || (segment.startsWith("[...") && segment.endsWith("]"));

      if (catchAll) {
        const name = segment.replace(/^\[{1,2}\.\.\./, "").replace(/\]{1,2}$/, "");
        const rest = parts.slice(index).map(decodeURIComponent);
        if (rest.length === 0 && !optionalCatchAll) {
          matched = false;
          break;
        }
        params[name] = rest;
        index = parts.length;
        break;
      }

      const value = parts[index];
      if (value === undefined) {
        matched = false;
        break;
      }
      if (segment.startsWith("[") && segment.endsWith("]")) {
        params[segment.slice(1, -1)] = decodeURIComponent(value);
      } else if (decodeURIComponent(value) !== segment) {
        matched = false;
        break;
      }
      index += 1;
    }

    if (matched && index === parts.length) return { route, params };
  }

  return null;
}

export type RouterRequest = {
  /** Path plus query, e.g. "/api/sessions?force=1". */
  url: string;
  method: string;
  headers?: Record<string, string>;
  /** Base64 for binary payloads; omit for empty bodies. */
  bodyBase64?: string;
  /** Aborted when the caller stops reading a streaming response. */
  signal?: AbortSignal;
};

export type RouterResult =
  | { kind: "buffered"; status: number; statusText: string; headers: [string, string][]; bodyBase64: string }
  | { kind: "stream"; status: number; statusText: string; headers: [string, string][]; body: ReadableStream<Uint8Array> };

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Route handlers expect the Next.js request shape: an absolute URL plus
 * `nextUrl` for query access. Nothing here trusts the URL's authority for
 * security decisions beyond the loopback host check performed by route code.
 */
function buildRequest(input: RouterRequest): NextRequest {
  const url = new URL(input.url.startsWith("http") ? input.url : VIRTUAL_ORIGIN + input.url);
  const headers = new Headers();
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    headers.set(key, value);
  }
  // Requests come from the app window, which is same-origin by construction.
  if (!headers.has("host")) headers.set("host", url.host);

  const hasBody = input.method !== "GET" && input.method !== "HEAD" && input.bodyBase64;
  const body = hasBody ? base64ToBytes(input.bodyBase64!) : undefined;

  const init = { method: input.method, headers, body, signal: input.signal };
  // The helpers are attached right after construction, so the cast below is
  // about telling the type system what this object already is.
  const request = new Request(url, init as unknown as RequestInit) as NextRequest;
  attachNextRequestHelpers(request, url);
  return request;
}

function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("text/event-stream");
}

export async function handleRequest(input: RouterRequest): Promise<RouterResult> {
  const url = new URL(input.url.startsWith("http") ? input.url : VIRTUAL_ORIGIN + input.url);
  const method = input.method.toUpperCase();

  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    return json(405, { error: `Unsupported method ${method}` });
  }

  const found = matchRoute(url.pathname);
  if (!found) {
    return json(404, { error: `No route for ${method} ${url.pathname}` });
  }

  const handler = found.route.module[method as (typeof HTTP_METHODS)[number]];
  if (!handler) {
    return json(405, { error: `Method ${method} not allowed for ${url.pathname}` });
  }

  const request = buildRequest(input);
  const context: RouteContext = { params: Promise.resolve(found.params) };
  const response = await handler(request, context);

  const headers: [string, string][] = [];
  response.headers.forEach((value, key) => {
    headers.push([key, value]);
  });

  // SSE is pulled chunk by chunk. Other response bodies remain buffered;
  // large downloads are a documented limitation of the current transport.
  if (response.body && isEventStream(response)) {
    return {
      kind: "stream",
      status: response.status,
      statusText: response.statusText,
      headers,
      body: response.body,
    };
  }

  // Downloads are still buffered by this transport. Cancellation must reach
  // their source reader too, rather than waiting for the whole file to finish.
  const reader = response.body?.getReader();
  const abort = () => { void reader?.cancel().catch(() => {}); };
  input.signal?.addEventListener("abort", abort, { once: true });
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    if (input.signal?.aborted) {
      await reader?.cancel();
      input.signal.throwIfAborted();
    }
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        input.signal?.throwIfAborted();
        if (done) break;
        parts.push(value);
        length += value.byteLength;
      }
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
    reader?.releaseLock();
  }
  const buffer = Buffer.concat(parts, length);
  return {
    kind: "buffered",
    status: response.status,
    statusText: response.statusText,
    headers,
    bodyBase64: bytesToBase64(buffer),
  };
}

function json(status: number, payload: unknown): RouterResult {
  return {
    kind: "buffered",
    status,
    statusText: "",
    headers: [["content-type", "application/json; charset=utf-8"]],
    bodyBase64: bytesToBase64(new TextEncoder().encode(JSON.stringify(payload))),
  };
}

export function listRoutePaths(): string[] {
  return ROUTES.map((route) => route.path);
}
