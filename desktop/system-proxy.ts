/**
 * Outbound network configuration for the backend process.
 *
 * Model traffic leaves the machine from here. Two different things can say
 * where the proxy is, and they are not interchangeable:
 *
 *   - proxy environment variables, which is what the web build's launcher sets;
 *   - the operating system's proxy settings, which live inside Chromium and can
 *     only be read through Electron's `session.resolveProxy`.
 *
 * Environment variables win, so a machine configured that way keeps behaving
 * exactly as before. Otherwise every request asks the main process which proxy
 * the system wants for *that* target: bypass rules, per-scheme proxies and PAC
 * scripts all depend on the URL, so one answer cannot be reused for another
 * host.
 *
 * A lookup that fails is reported as a failure. Answering "DIRECT" on doubt
 * would send traffic around a proxy the user switched on, which is the bug this
 * module exists to fix.
 */
import { randomUUID } from "node:crypto";
import * as undici from "undici";

import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, configureHttpDispatcher } from "../lib/http-dispatcher";

/** How long the backend waits for the main process to answer one lookup. */
const PROXY_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Live proxy pools, keyed by proxy URL. Bounded, because a proxy that moves to
 * a new address on every restart would otherwise leave a pool behind each time.
 */
const PROXY_POOL_LIMIT = 4;

export type ProxyChoice =
  | { kind: "direct" }
  | { kind: "proxy"; uri: string }
  | { kind: "unsupported"; detail: string };

/**
 * Reads Chromium's proxy decision. The spelling is Chromium's own, verified
 * against Electron 44: "DIRECT", "PROXY host:port", "HTTPS host:port",
 * "SOCKS5 host:port". A PAC script may return several separated by ";".
 *
 * Only the first entry is used. A second proxy would mean replaying a chat POST
 * somewhere else, which is worse than failing where the user can see it.
 */
export function parseProxyChoice(decision: string): ProxyChoice {
  const [first] = decision
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!first) return { kind: "unsupported", detail: "(empty proxy decision)" };
  if (first.toUpperCase() === "DIRECT") return { kind: "direct" };

  const parsed = /^([A-Za-z][A-Za-z0-9]*)\s+(\S+)$/.exec(first);
  if (!parsed) return { kind: "unsupported", detail: first };
  const [, scheme, hostPort] = parsed;

  switch (scheme.toUpperCase()) {
    case "PROXY":
    case "HTTP":
      return { kind: "proxy", uri: `http://${hostPort}` };
    case "HTTPS":
      return { kind: "proxy", uri: `https://${hostPort}` };
    default:
      // SOCKS and anything unknown: say so instead of connecting around it.
      return { kind: "unsupported", detail: first };
  }
}

/** True when the caller configured a proxy through the environment. */
export function hasProxyEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  // The same variables undici's own env agent honours, and no others: ALL_PROXY
  // alone was ignored before, so it stays ignored rather than changing meaning
  // under an existing setup.
  return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
}

type PendingLookup = {
  resolve: (decision: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const lookups = new Map<string, PendingLookup>();

/** Asks the main process which proxy the system wants for `url`. */
export function resolveSystemProxy(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      lookups.delete(id);
      reject(new Error(`proxy lookup timed out after ${PROXY_LOOKUP_TIMEOUT_MS}ms for ${url}`));
    }, PROXY_LOOKUP_TIMEOUT_MS);
    // A lookup must not hold the process open on its own.
    timer.unref?.();
    lookups.set(id, { resolve, reject, timer });
    try {
      process.send?.({ kind: "proxy.query", id, url });
    } catch (error) {
      clearTimeout(timer);
      lookups.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Settles a lookup from a main-process reply. Returns false for every other
 * message, so the backend keeps one listener for the whole channel.
 */
export function handleProxyMessage(raw: unknown): boolean {
  const message = raw as { kind?: string; id?: string; ok?: boolean; value?: string; error?: string };
  if (message?.kind !== "proxy.result") return false;

  const entry = lookups.get(message.id ?? "");
  if (!entry) return true; // an answer that arrived after its timeout
  lookups.delete(message.id ?? "");
  clearTimeout(entry.timer);

  if (message.ok) entry.resolve(message.value ?? "");
  else entry.reject(new Error(message.error || "proxy lookup failed"));
  return true;
}

/**
 * Builds a dispatcher that picks the connection per request.
 *
 * `lookup` is called once per request (and once per WebSocket handshake, which
 * reaches here as an upgrade of the same dispatch path). Nothing is cached but
 * the pools themselves, so a proxy that appears, moves or disappears is picked
 * up by the next connection; requests already in flight finish on the pool they
 * started on.
 */
export function createSystemProxyDispatcher(
  lookup: (url: string) => Promise<string>,
  timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): undici.Dispatcher {
  const agent = new undici.Agent({
    allowH2: false,
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  const pools = new Map<string, undici.Dispatcher>();

  const poolFor = (uri: string): undici.Dispatcher => {
    // Pools are removed from the map before they are closed, so whatever is in
    // here is still usable.
    const existing = pools.get(uri);
    if (existing) return existing;

    const created = new undici.ProxyAgent({
      uri,
      allowH2: false,
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
    });
    pools.set(uri, created);

    // Insertion order makes the first key the oldest pool. Retiring it stops new
    // requests and closes it once whatever is still in flight has finished.
    while (pools.size > PROXY_POOL_LIMIT) {
      const oldest = pools.keys().next().value as string;
      if (oldest === uri) break;
      const stale = pools.get(oldest);
      pools.delete(oldest);
      void stale?.close().catch(() => {});
    }
    return created;
  };

  return agent.compose((directDispatch) => (opts, handler) => {
    const target = `${opts.origin}${opts.path}`;

    const report = (error: unknown): void => {
      handler.onResponseError?.(null as never, error instanceof Error ? error : new Error(String(error)));
    };

    const send = (choice: ProxyChoice): void => {
      if (choice.kind === "unsupported") {
        report(new Error(`unsupported proxy for ${target}: ${choice.detail}`));
        return;
      }
      try {
        if (choice.kind === "direct") directDispatch(opts, handler);
        else poolFor(choice.uri).dispatch(opts, handler);
      } catch (error) {
        // Connecting can refuse synchronously; the handler still has to hear about it.
        report(error);
      }
    };

    // Exactly one of these runs, so nothing reports twice and nothing is lost.
    void lookup(target).then((decision) => send(parseProxyChoice(decision)), report);
    // Accepted: the handler is told what happened as soon as the lookup settles.
    return true;
  });
}

/**
 * Points the process-wide fetch and WebSocket at the system's proxy.
 *
 * `undici.install()` is what makes this work: Node's own fetch and WebSocket use
 * a bundled copy of undici, so they cannot see a dispatcher set through this
 * package. Without it the change would look applied and silently do nothing.
 */
export function configureOutboundNetworking(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
  if (hasProxyEnvironment()) {
    // Unchanged path: undici reads the variables itself, NO_PROXY included.
    configureHttpDispatcher(timeoutMs);
    return;
  }

  if (typeof undici.install !== "function") {
    throw new Error("undici.install is unavailable: the system proxy cannot be applied to global fetch");
  }
  undici.setGlobalDispatcher(createSystemProxyDispatcher(resolveSystemProxy, timeoutMs));
  undici.install();
}
