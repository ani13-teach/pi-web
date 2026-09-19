/**
 * Electron main process.
 *
 * Responsibilities, and deliberately nothing else:
 *   - own the window, and serve the built renderer from a custom `pi-app://`
 *     scheme (a stable origin, and no HTTP listener anywhere);
 *   - own the backend child process and correlate request/response traffic;
 *   - expose a small, explicit bridge to the renderer.
 *
 * The window is unprivileged: no Node integration, sandbox on, context
 * isolation on. Everything powerful happens in the backend process or here.
 */

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from "electron";

import {
  APP_ORIGIN,
  APP_SCHEME,
  EXPORT_PREVIEW_CSP,
  PREVIEW_PARTITION,
  PREVIEW_SCHEME,
  decideNavigation,
  decidePreviewNavigation,
  decideWindowOpen,
  isExportPreviewRequestAllowed,
  previewUrlFor,
} from "./navigation";
import {
  DESKTOP_CHANNEL,
  type BackendInMessage,
  type BackendMethod,
  type BackendOutMessage,
  type BackendPush,
  type BackendRequestEnvelope,
  type BackendResponseEnvelope,
  type ParamsOf,
  type ProxyQueryMessage,
  type ProxyResultMessage,
  type ResultOf,
} from "../shared/contract";

// main.ts is always bundled to CommonJS, so __dirname is the reliable anchor.
const here = __dirname;
const appRoot = resolve(here, "..", "..");
const rendererDir = join(appRoot, "dist", "renderer");
/**
 * In a packaged build the backend is unpacked next to the asar archive, because
 * fork() needs a real file on disk. Electron's fs layer hides that difference
 * for reads, but not for spawning.
 */
const backendEntry = join(here, "backend.mjs").replace("app.asar", "app.asar.unpacked");

const delay = (ms: number) => new Promise((resolveCall) => setTimeout(resolveCall, ms));

/** Loaded before `app` is ready: the scheme must be privileged to behave like a
 * normal web origin (localStorage, secure context, module scripts). */
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
  {
    // The export preview is a document plus inline scripts; it never fetches.
    scheme: PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
  },
]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function serveRenderer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const target = normalize(join(rendererDir, requested));
  if (!target.startsWith(rendererDir + sep)) {
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }
  return readFile(target)
    .then(
      (data) =>
        new Response(new Uint8Array(data), {
          headers: {
            "Content-Type": MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
            // The renderer is served from disk, so it must never be cached
            // across app updates.
            "Cache-Control": "no-store",
            ...(requested.endsWith(".html") ? { "Content-Security-Policy": CONTENT_SECURITY_POLICY } : {}),
          },
        }),
    )
    .catch(() => new Response("Not found", { status: 404 }));
}

/**
 * No page in this app talks to the network: model traffic leaves from the
 * backend. Locking the window down keeps it that way, so a hostile page loaded
 * by the agent's own output cannot exfiltrate anything.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  // React sets style attributes and several bundled libraries inject <style>.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  // Same origin only: the file API and the bridge live there. Frames are needed
  // for the file viewer's previews (PDF and documents by URL, HTML by srcdoc);
  // they are sandboxed at the call site, and anything off-origin stays blocked.
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Requests the browser makes itself: `<img>`, `<audio>`, `<video>`, downloads
 * and iframe-free navigations. They cannot use the fetch shim, so the same
 * router answers them here and the response is handed back verbatim.
 */
const HOP_BY_HOP = new Set(["connection", "transfer-encoding", "keep-alive", "content-length"]);
const BROWSER_ONLY_HEADERS = new Set([
  "origin",
  "referer",
  "host",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "accept-encoding",
  "content-length",
  "connection",
  "transfer-encoding",
]);

async function serveApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!BROWSER_ONLY_HEADERS.has(key.toLowerCase())) headers[key] = value;
  });

  let bodyBase64: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const buffer = Buffer.from(await request.arrayBuffer());
    if (buffer.byteLength > 0) bodyBase64 = buffer.toString("base64");
  }

  const streamId = randomUUID();
  const cancel = () => { void backend.request("http.cancel", { streamId }, 5_000).catch(() => {}); };
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    request.signal.throwIfAborted();
    const result = await backend.request("http.request", {
      url: `${url.pathname}${url.search}`,
      method: request.method,
      headers,
      bodyBase64,
      streamId,
    });
    request.signal.throwIfAborted();
    if (result.streamed) {
      cancel();
      return new Response("This endpoint must be read through the bridge.", { status: 500 });
    }
    const outHeaders = new Headers();
    for (const [key, value] of result.headers) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders.set(key, value);
    }
    const bytes = result.bodyBase64 ? Buffer.from(result.bodyBase64, "base64") : undefined;
    return new Response(bytes ? new Uint8Array(bytes) : null, {
      status: result.status,
      statusText: result.statusText || undefined,
      headers: outHeaders,
    });
  } catch (error) {
    cancel();
    return new Response(error instanceof Error ? error.message : String(error), { status: 502 });
  } finally {
    request.signal.removeEventListener("abort", cancel);
  }
}

async function serveRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/") || url.pathname === "/api") return serveApi(request);
  return serveRenderer(request);
}

// ---------------------------------------------------------------------------
// backend supervisor
// ---------------------------------------------------------------------------

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class BackendHost {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private restarts = 0;
  private restarting: Promise<void> | null = null;

  constructor(private readonly onPush: (push: BackendPush) => void) {}

  start(): void {
    if (this.child) return;
    const child = fork(backendEntry, [], {
      // Electron's own binary, running as plain Node: no second runtime to
      // ship and no mismatch between the window's runtime and the backend's.
      // ELECTRON_RUN_AS_NODE is also inherited by the `npx` processes the skill
      // installer spawns, which is why npm can run without a Node install.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        // pi-web's update banner asks npm about the @agegr/pi-web package. That
        // package is not what is running here, so the check is switched off
        // with pi-web's own flag (no code change to the ported UI).
        PI_WEB_SKIP_VERSION_CHECK: "1",
      },
      execPath: process.execPath,
      cwd: app.getPath("home"),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      console.log(`[backend] ${chunk.toString().trimEnd()}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[backend] ${chunk.toString().trimEnd()}`);
    });
    child.on("message", (message: BackendOutMessage) => this.onMessage(message));
    child.on("exit", (code, signal) => {
      this.child = null;
      const reason = `backend exited (${signal ? `signal ${signal}` : `code ${code}`})`;
      this.failAll(new Error(reason));
      this.onPush({ type: "backend.down", reason });
    });
    child.on("error", (error) => {
      this.failAll(error);
    });
  }

  private onMessage(message: BackendOutMessage): void {
    if (message.kind === "push") {
      this.onPush(message.push);
      return;
    }
    if (message.kind === "proxy.query") {
      this.answerProxyQuery(message);
      return;
    }
    this.settle(message.envelope);
  }

  /**
   * Answers the backend's "which proxy for this target?" question.
   *
   * Chromium owns the system proxy settings, their bypass rules and any PAC
   * script, and `resolveProxy` is the only supported way to read a decision for
   * a specific URL. A failure is answered as a failure: reporting DIRECT would
   * send the request around a proxy the user switched on.
   */
  private answerProxyQuery(query: ProxyQueryMessage): void {
    const child = this.child;
    if (!child) return;

    const answer = (message: ProxyResultMessage): void => {
      // A restart replaces the child, and a late answer must not reach the new one.
      if (this.child !== child || !child.connected) return;
      try {
        child.send(message);
      } catch {
        /* the child exited between the check and the send */
      }
    };

    session.defaultSession.resolveProxy(query.url).then(
      (value) => answer({ kind: "proxy.result", id: query.id, ok: true, value }),
      (error: unknown) =>
        answer({
          kind: "proxy.result",
          id: query.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }

  private settle(envelope: BackendResponseEnvelope): void {
    const call = this.pending.get(envelope.id);
    if (!call) return;
    this.pending.delete(envelope.id);
    clearTimeout(call.timer);
    if (envelope.ok) call.resolve(envelope.result);
    else call.reject(new Error(envelope.error));
  }

  private failAll(error: Error): void {
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  request<M extends BackendMethod>(method: M, params: ParamsOf<M>, timeoutMs = 120_000): Promise<ResultOf<M>> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("backend is not running"));
    return new Promise<ResultOf<M>>((resolveCall, rejectCall) => {
      const envelope: BackendRequestEnvelope = { id: randomUUID(), method, params: params as unknown };
      const timer = setTimeout(() => {
        this.pending.delete(envelope.id);
        if (method === "http.request" || method === "http.pull") {
          const streamId = (params as { streamId?: string }).streamId;
          if (streamId) void this.request("http.cancel", { streamId }, 5_000).catch(() => {});
        }
        rejectCall(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(envelope.id, {
        resolve: resolveCall as (value: unknown) => void,
        reject: rejectCall,
        timer,
      });
      const out: BackendInMessage = { kind: "request", envelope };
      child.send(out);
    });
  }

  /** Ask the backend to release sessions and PTYs, then wait for it to exit. */
  async shutdown(timeoutMs = 5_000): Promise<void> {
    const child = this.child;
    if (!child) return;
    // One deadline for the whole thing: waiting on the request first used to
    // leave this with the default 120s request timeout before the exit wait
    // even started, so quitting could hang far longer than asked.
    const deadline = Date.now() + timeoutMs;
    const exited = new Promise<void>((resolveCall) => child.once("exit", () => resolveCall()));
    try {
      await this.request("backend.shutdown", {}, Math.max(1_000, timeoutMs - 500));
    } catch {
      // the backend may already be gone; the exit wait below still applies
    }
    const timedOut = await Promise.race([
      exited.then(() => false),
      delay(Math.max(0, deadline - Date.now())).then(() => true),
    ]);
    if (timedOut) {
      // Last resort: Windows gets no graceful signal, so terminate the process.
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      // Wait for the exit before returning: restart() must not start a second
      // backend while this one is still holding the session files.
      await Promise.race([exited, delay(1_000)]);
    }
    if (this.child === child) this.child = null;
    this.restarts += 1;
  }

  /** Simulates a crash, so recovery paths can be tested for real. */
  killHard(): number | null {
    const child = this.child;
    if (!child) return null;
    const pid = child.pid ?? null;
    child.kill();
    // Let the actual child exit event detect failure and notify the window.
    return pid;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async restart(): Promise<void> {
    // The window and the test scenarios can ask at the same time; a second
    // concurrent restart would start two backends over the same session files.
    if (this.restarting) return this.restarting;
    this.restarting = this.doRestart().finally(() => {
      this.restarting = null;
    });
    return this.restarting;
  }

  private async doRestart(): Promise<void> {
    if (this.child) await this.shutdown();
    if (this.restarts > 5) throw new Error("backend restarted too many times");
    this.start();
  }

  get running(): boolean {
    return Boolean(this.child);
  }
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let quitting = false;

function broadcast(push: BackendPush): void {
  mainWindow?.webContents.send(DESKTOP_CHANNEL.push, push);
}

const backend = new BackendHost(broadcast);

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#1a1a1a",
    title: "Pi Desktop",
    show: false,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.removeMenu();
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      app.quit();
    }
  });

  // The window stays on its own origin. Anything else goes to the system
  // browser — including the OAuth links the login flow prints.
  attachNavigationPolicy(window);

  void window.loadURL(`${APP_ORIGIN}/index.html`);
  mainWindow = window;
}

/** Hands a URL to the OS browser, ignoring the cases where no handler exists. */
function openExternal(url: string): void {
  void shell.openExternal(url).catch((error: unknown) => {
    console.warn(`could not open ${url} externally: ${String(error)}`);
  });
}

/**
 * Navigation policy for the main window: same-origin pages stay put, http(s)
 * links open in the system browser, the session export opens in its own
 * read-only preview, and every other scheme or popup is refused.
 */
function attachNavigationPolicy(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url);
    if (decision.action === "external") openExternal(decision.url);
    else if (decision.action === "preview") openExportPreview(decision.url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const decision = decideNavigation(url);
    if (decision.action === "allow") return;
    event.preventDefault();
    if (decision.action === "external") openExternal(decision.url);
    else if (decision.action === "preview") openExportPreview(decision.url);
  });
}

let previewWindow: BrowserWindow | null = null;
let previewProtocolInstalled = false;

/**
 * The preview partition serves exactly one thing — a GET of a session export
 * document — and nothing else, through the same backend route the app used to
 * reach with `shell.openExternal`. Permissions and downloads are turned off so
 * untrusted session content stays read-only.
 */
function installPreviewProtocol(): void {
  if (previewProtocolInstalled) return;
  previewProtocolInstalled = true;

  const previewSession = session.fromPartition(PREVIEW_PARTITION);
  previewSession.protocol.handle(PREVIEW_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (!isExportPreviewRequestAllowed(request.method, `${url.pathname}${url.search}`)) {
      return new Response("Not found", { status: 404 });
    }
    const response = await serveApi(
      new Request(`${APP_ORIGIN}${url.pathname}${url.search}`, { method: "GET" }),
    );
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", EXPORT_PREVIEW_CSP);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.on("will-download", (event) => event.preventDefault());
}

/**
 * Opens (or reloads) the export preview in a dedicated, unprivileged window:
 * no preload, no bridge, sandboxed, in its own session. The main app shell can
 * never be reached from here.
 */
function openExportPreview(exportUrl: string): void {
  const previewUrl = previewUrlFor(exportUrl);
  if (!previewUrl) return;
  installPreviewProtocol();

  if (previewWindow && !previewWindow.isDestroyed()) {
    void previewWindow.loadURL(previewUrl);
    previewWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1024,
    height: 820,
    backgroundColor: "#ffffff",
    title: "Pi Desktop — Session Export",
    show: false,
    webPreferences: {
      partition: PREVIEW_PARTITION,
      // Deliberately no preload: the preview must not see the app bridge.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.removeMenu();
  if (process.env.PI_DESKTOP_SCENARIO === "chat") {
    window.webContents.on("console-message", (_event, _level, message) => console.log(`INFO preview: ${message}`));
  }
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url);
    if (decision.action === "external") openExternal(decision.url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const decision = decidePreviewNavigation(url);
    if (decision.action === "allow") return;
    event.preventDefault();
    if (decision.action === "external") openExternal(decision.url);
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.on("closed", () => {
    if (previewWindow === window) previewWindow = null;
  });

  previewWindow = window;
  void window.loadURL(previewUrl);
}

// ---------------------------------------------------------------------------
// smoke mode (PI_DESKTOP_SMOKE=1)
// ---------------------------------------------------------------------------

/**
 * Drives the real window from the outside so the whole chain is exercised:
 * renderer -> preload -> main -> backend. Only runs when explicitly asked for
 * by an environment variable, so it never affects a normal launch.
 */
/**
 * Sizes the window for a layout check and waits for the renderer to agree.
 *
 * A single setContentSize right after the window appears is occasionally dropped
 * by the window manager, which used to surface as a rare "requested 1080x600,
 * actual viewport 1226x635" failure for all three sizes — a layout report that
 * says nothing about the layout. Asking again is cheap; a dropped resize is not
 * a regression, and the check should only fail when the layout really does not
 * fit.
 */
async function resizeContent(window: BrowserWindow, width: number, height: number): Promise<number[]> {
  let viewport: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    window.unmaximize();
    window.setContentSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 300 : 200));
    viewport = (await window.webContents.executeJavaScript("[innerWidth, innerHeight]", true)) as number[];
    if (viewport[0] === width && viewport[1] === height) break;
  }
  return viewport;
}

async function runSmokeChecks(window: BrowserWindow): Promise<void> {
  const holdMs = Number(process.env.PI_DESKTOP_SMOKE_HOLD_MS ?? 0);
  const probeSource = await readFile(join(here, "smoke-probe.js"), "utf8");
  // Keeping a terminal alive lets an external check confirm the PTY child is
  // cleaned up when the app quits. On by default: with the probe closing its
  // own terminal first, that check could never see anything to clean up.
  const keepTerminal = process.env.PI_DESKTOP_SMOKE_DROP_TERMINAL !== "1";
  // A known transcript avoids depending on whichever user session happens to
  // be first today (it may still be running, empty, or contain only tool output).
  const runtime = await backend.request("app.info", {});
  const fixtureId = randomUUID();
  const fixtureDir = join(runtime.agentDir, "sessions", `--desktop-smoke-${fixtureId}--`);
  const fixtureFile = join(fixtureDir, `${fixtureId}.jsonl`);
  mkdirSync(fixtureDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const fixture = [
    { type: "session", version: 3, id: fixtureId, timestamp, cwd: scenarioWorkspace() },
    { type: "message", id: "smoke-user", parentId: null, timestamp,
      message: { role: "user", content: `Desktop smoke session ${fixtureId}` } },
    { type: "message", id: "smoke-answer", parentId: "smoke-user", timestamp,
      message: { role: "assistant", content: [{ type: "text", text: `Desktop fixture answer ${fixtureId}` }],
        provider: "test", model: "fixture", api: "openai-responses", stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
  ];
  writeFileSync(fixtureFile, fixture.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await api("/api/sessions?force=1");
  await window.loadURL(`${APP_ORIGIN}/index.html?session=${fixtureId}`);
  const source = `window.__piSmokeKeepTerminal = ${keepTerminal}; window.__piSmokeSessionId = ${JSON.stringify(fixtureId)};\n${probeSource}`;

  // Renderer console output is the only place some failures show up.
  window.webContents.on("console-message", (_event, level, message) => {
    console.log(`[renderer:${level}] ${message}`);
  });

  let outcomes: { name: string; ok: boolean; detail?: string }[] = [];
  try {
    outcomes = (await window.webContents.executeJavaScript(source, true)) as typeof outcomes;
  } catch (error) {
    outcomes = [
      { name: "probe script ran", ok: false, detail: error instanceof Error ? error.message : String(error) },
    ];
  }

  const layoutSource = await readFile(join(here, "layout-probe.js"), "utf8");
  const shotDirectory = join(process.cwd(), ".tmp-shot");
  mkdirSync(shotDirectory, { recursive: true });
  for (const [width, height] of [[1080, 600], [900, 560], [760, 500]] as const) {
    const name = `chat layout fits ${width}x${height}`;
    try {
      const viewport = await resizeContent(window, width, height);
      if (viewport[0] !== width || viewport[1] !== height) {
        throw new Error(`requested ${width}x${height}, actual viewport ${viewport.join("x")}`);
      }
      const detail = await window.webContents.executeJavaScript(layoutSource, true) as string;
      outcomes.push({ name, ok: true, detail });
    } catch (error) {
      outcomes.push({ name, ok: false, detail: String(error) });
    }
    const image = await window.webContents.capturePage();
    writeFileSync(join(shotDirectory, `ui-${width}.png`), image.toPNG());
  }

  for (const outcome of outcomes) {
    console.log(`${outcome.ok ? "PASS" : "FAIL"}  ${outcome.name}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
  }
  const failed = outcomes.filter((outcome) => !outcome.ok).length;
  console.log(`\n${outcomes.length - failed}/${outcomes.length} window checks passed`);

  if (holdMs > 0) {
    console.log(`holding the app open for ${holdMs}ms (pid ${process.pid}) for external checks`);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }

  await discardSession(fixtureId);
  rmSync(fixtureDir, { recursive: true, force: true });
  process.exitCode = failed === 0 ? 0 : 1;
  app.quit();
}

// ---------------------------------------------------------------------------
// resilience scenarios (PI_DESKTOP_SCENARIO=reload|crash|skills)
// ---------------------------------------------------------------------------

/**
 * These drive the app from the outside the way a user would experience the two
 * failures the architecture is supposed to survive:
 *
 *   reload — the window is reloaded while the agent is mid-answer. The run must
 *            keep going in the backend, the prompt must not be sent twice, and
 *            the fresh window must pick the result back up.
 *   crash  — the backend process is killed mid-answer. The app must report it,
 *            restart on request, and must not replay the prompt or its tools.
 *   skills — npm has to be reachable from the app binary for `npx skills …`.
 *            Installs only ever run with PI_DESKTOP_SKILL set and
 *            PI_CODING_AGENT_DIR pointed somewhere throwaway.
 */
const scenarioResults: { name: string; ok: boolean; detail?: string }[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  scenarioResults.push({ name, ok, detail });
  // Printed as it happens: a hanging check should still show what got that far.
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Observations that are worth printing but are not pass/fail conditions. */
function info(message: string): void {
  console.log(`INFO  ${message}`);
}

async function api(path: string, init?: { method?: string; body?: unknown }): Promise<{
  status: number;
  json: Record<string, unknown>;
}> {
  const result = await backend.request("http.request", {
    url: path,
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? {} : { "content-type": "application/json" },
    bodyBase64: init?.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(init.body)).toString("base64"),
  });
  const text = Buffer.from(result.bodyBase64, "base64").toString("utf8");
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: result.status, json };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for a *new* backend pid, whoever asked for the restart. */
async function waitForPid(previous: number | null, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = backend.pid;
    if (pid !== null && pid !== previous) {
      // Confirms it is actually serving, not just spawned.
      try {
        const info = await backend.request("app.info", {});
        if (info.pid === pid) return pid;
      } catch {
        // still starting up
      }
    }
    await sleep(500);
  }
  return null;
}

/**
 * Runs a script in the window with a deadline. The window may be reloading
 * (that is part of how recovery works), and a reload can leave the call
 * hanging, which would stall the whole scenario instead of failing one check.
 */
async function inWindow<T>(script: string, timeoutMs = 20_000): Promise<T | null> {
  const window = mainWindow;
  if (!window) return null;
  try {
    return await Promise.race([
      window.webContents.executeJavaScript(script, true) as Promise<T>,
      sleep(timeoutMs).then(() => null),
    ]);
  } catch {
    return null;
  }
}

/** User messages in a session, straight from the session file on disk. */
/** Messages of a stored session, or null when the request or the shape was bad. */
async function sessionMessages(sessionId: string): Promise<{ role?: string; content?: unknown }[] | null> {
  const { status, json } = await api(`/api/sessions/${encodeURIComponent(sessionId)}/context`);
  if (status >= 400) return null;
  const messages = json.messages ?? (json.context as { messages?: unknown[] })?.messages;
  return Array.isArray(messages) ? (messages as { role?: string; content?: unknown }[]) : null;
}

/**
 * Only what the assistant produced. The prompt itself contains the marker we
 * wait for, so searching the whole transcript would pass without any answer.
 */
async function assistantText(sessionId: string): Promise<string | null> {
  const messages = await sessionMessages(sessionId);
  if (!messages) return null;
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) => JSON.stringify(message.content ?? message))
    .join("\n");
}

async function countUserMessages(sessionId: string): Promise<number | null> {
  const messages = await sessionMessages(sessionId);
  if (!messages) return null;
  return messages.filter((message) => message.role === "user").length;
}

async function startRun(cwd: string, message: string): Promise<string> {
  const created = await api("/api/agent/new", {
    method: "POST",
    body: { cwd, type: "ensure_session" },
  });
  const sessionId = created.json.sessionId as string | undefined;
  if (!sessionId) throw new Error(`could not create a session: ${JSON.stringify(created.json)}`);
  await api(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    body: { type: "prompt", message },
  });
  return sessionId;
}

/**
 * A real workspace for the scenarios: inside a packaged build `appRoot` points
 * into the asar archive, which is no place to write sessions.
 */
function scenarioWorkspace(): string {
  return app.isPackaged ? app.getPath("home") : appRoot;
}

/**
 * Removes the session a scenario created, so running the checks does not leave
 * test conversations in the user's session store.
 */
async function discardSession(sessionId: string): Promise<void> {
  const { status } = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  console.log(status < 400 ? `cleaned up session ${sessionId}` : `could not clean up ${sessionId} (status ${status})`);
}

async function runReloadScenario(window: BrowserWindow): Promise<void> {
  const backendPidBefore = backend.pid;
  const sessionId = await startRun(scenarioWorkspace(), "Reply with exactly: RELOAD_OK");

  // Reload after submitting the prompt. A fast model may already be finished;
  // this scenario does not claim the reload occurred in the middle of output.
  await sleep(1200);
  const reloaded = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
  window.webContents.reloadIgnoringCache();
  await reloaded;

  record("the backend process survives a window reload", backend.pid === backendPidBefore,
    `pid ${backendPidBefore} -> ${backend.pid}`);

  // The run has to finish on its own, without the window that started it.
  const deadline = Date.now() + 90_000;
  let answer = "";
  while (Date.now() < deadline) {
    answer = (await assistantText(sessionId)) ?? "";
    if (answer.includes("RELOAD_OK")) break;
    await sleep(1000);
  }
  record("an assistant answer is available after the reload", answer.includes("RELOAD_OK"),
    `${answer.length} bytes of assistant text`);

  const userMessages = await countUserMessages(sessionId);
  record("the stored context has one user message after reload", userMessages === 1,
    `${userMessages === null ? "context request failed" : `${userMessages} user message(s)`}`);

  // The fresh window has to be able to show a run it did not start.
  // Navigating destroys the frame that ran the script, so the navigation is
  // fire-and-forget and the DOM is checked after the next load completes.
  const navigated = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
  void window.webContents
    .executeJavaScript(
      `location.href = location.pathname + "?session=" + ${JSON.stringify(encodeURIComponent(sessionId))}; true`,
      true,
    )
    .catch(() => {});
  await navigated;

  const shown = (await window.webContents.executeJavaScript(
    `(async () => {
       const rendered = () => Array.from(
         document.querySelectorAll('[data-message-role="assistant"] [data-message-text]'),
       );
       for (let i = 0; i < 60; i += 1) {
         await new Promise((r) => setTimeout(r, 500));
         if (rendered().some((node) => node.innerText.includes("RELOAD_OK"))) return true;
       }
       return rendered().length + " assistant message(s) rendered";
     })()`,
    true,
  )) as boolean | string;
  record("the reloaded window shows the finished answer", shown === true, String(shown).slice(0, 120));

  await discardSession(sessionId);
}

async function runCrashScenario(): Promise<void> {
  const sessionId = await startRun(scenarioWorkspace(), "Count slowly from 1 to 40, one number per line.");
  await sleep(1500);

  const killed = backend.killHard();
  record("the backend process was terminated", killed !== null, `pid ${killed}`);

  const exitDeadline = Date.now() + 5_000;
  while (backend.pid === killed && Date.now() < exitDeadline) await sleep(10);
  record("the supervisor observes the terminated process", backend.pid !== killed,
    `old pid=${killed}, current pid=${backend.pid}`);

  // The window asks for the restart on its own (renderer/backend-recovery.tsx),
  // so nothing here calls restart(): if the app only came back because the test
  // asked, this check would fail.
  const recoveredPid = await waitForPid(killed, 30_000);
  record("the app brings the backend back without being asked", recoveredPid !== null,
    recoveredPid ? `pid ${killed} -> ${recoveredPid}` : "no backend came back within 30s");

  // A second crash inside the retry window must not be retried silently again:
  // that is when the bar is supposed to appear.
  const killedAgain = backend.killHard();
  const barShown = await inWindow<string>(
    `(async () => {
       for (let i = 0; i < 80; i += 1) {
         const bar = document.querySelector('[data-backend-recovery="down"]');
         if (bar) return bar.innerText.replace(/\\s+/g, " ").trim().slice(0, 120);
         await new Promise((r) => setTimeout(r, 250));
       }
       return null;
     })()`,
  );
  record("a crash it cannot fix shows the way out", Boolean(barShown), barShown ?? "the bar never appeared");

  // A picture of the real bar, in the real window, for design review.
  if (barShown && mainWindow) {
    try {
      const shot = join(appRoot, ".tmp-shot");
      mkdirSync(shot, { recursive: true });
      const image = await mainWindow.webContents.capturePage();
      const file = join(shot, "backend-bar.png");
      writeFileSync(file, image.toPNG());
      info(`screenshot: ${file}`);
    } catch (error) {
      info(`could not capture the bar: ${String(error)}`);
    }
  }

  // While the bar is up nothing is restarting it behind the scenes, so calls
  // must fail fast here rather than hang.
  const callStarted = Date.now();
  let failedFast: string | null = null;
  try {
    await backend.request("app.info", {});
  } catch (error) {
    failedFast = error instanceof Error ? error.message : String(error);
  }
  record("calls fail within one second while the backend is down",
    failedFast !== null && Date.now() - callStarted < 1_000, failedFast ?? "app.info answered");

  // Pressing the button in the bar has to be enough to get back to work, so the
  // click is made in the page, not through the bridge.
  const clicked = await inWindow<boolean>(
    `(() => {
       const bar = document.querySelector('[data-backend-recovery="down"]');
       const button = bar && [...bar.querySelectorAll("button")].find((b) => b.innerText.includes("重启后台"));
       if (!button) return false;
       button.click();
       return true;
     })()`,
    5_000,
  );
  const afterClickPid = await waitForPid(killedAgain, 30_000);
  record("pressing the button in the bar restarts the backend", clicked === true && afterClickPid !== null,
    `clicked=${clicked === true}, pid ${killedAgain} -> ${afterClickPid ?? "none"}`);

  const barGone = await inWindow<boolean>(
    `(async () => {
       for (let i = 0; i < 80; i += 1) {
         if (!document.querySelector('[data-backend-recovery="down"]')) return true;
         await new Promise((r) => setTimeout(r, 250));
       }
       return false;
     })()`,
  );
  record("the bar goes away once the backend is back", barGone === true);

  const sessions = await api("/api/sessions");
  const listed = (sessions.json.sessions as unknown[] | undefined)?.length ?? 0;
  record("the session store is readable again after the crash", sessions.status === 200 && listed > 0,
    `${listed} sessions listed`);

  // pi writes the session file when a turn settles, so a crash mid-turn can
  // leave nothing behind — a 404 on a session that was never written is the
  // expected outcome, not a failure. What must not happen is the prompt coming
  // back, or the turn quietly finishing later.
  const readContext = async () => {
    const { status, json } = await api(`/api/sessions/${encodeURIComponent(sessionId)}/context`);
    if (status >= 400) return { status, messages: null };
    const found = json.messages ?? (json.context as { messages?: unknown[] })?.messages;
    return { status, messages: Array.isArray(found) ? (found as { role?: string }[]) : null };
  };

  const first = await readContext();
  const messages = first.messages;
  const unreadable = messages === null && first.status !== 404;
  const userMessages = messages?.filter((message) => message.role === "user").length ?? null;
  const assistantMessages = messages?.filter((message) => message.role === "assistant").length ?? null;

  record("stored context has at most one user message, or was not persisted", !unreadable && (userMessages === null || userMessages <= 1),
    unreadable
      ? `context request failed with ${first.status}`
      : userMessages === null
        ? `status ${first.status}: the interrupted turn left nothing on disk`
        : `${userMessages} user message(s)`);

  // This observes persisted context only; it cannot prove that no model/tool
  // request was made without producing a stored message.
  await sleep(6000);
  const later = await readContext();
  const lastAssistant = [...(later.messages ?? [])].reverse().find((message) => message.role === "assistant") as
    | Record<string, unknown>
    | undefined;
  const unchanged = later.status === first.status && JSON.stringify(later.messages) === JSON.stringify(messages);
  record("persisted context is unchanged over six seconds", !unreadable && unchanged,
    `unchanged for 6s; last assistant entry: ${JSON.stringify(lastAssistant ?? {}).slice(0, 140)}`);
  // What survives a hard kill is up to pi's own flush timing, so this is
  // reported rather than asserted: sometimes the partial turn is on disk,
  // sometimes the crash lands before anything was written.
  info(
    (messages?.length ?? 0) === 0
      ? `the interrupted turn left nothing on disk (status ${first.status})`
      : `the interrupted turn kept ${messages?.length} message(s) on disk`,
  );
  info(assistantMessages === null ? "assistant count unavailable" : `${assistantMessages} assistant message(s)`);
  info(findSessionFile(sessionId) ? "session file present" : "session file was never written");

  // The window has to be usable again without a relaunch.
  const recovered = (await mainWindow?.webContents.executeJavaScript(
    `(async () => {
       for (let i = 0; i < 40; i += 1) {
         try {
           const response = await fetch("/api/sessions");
           if (response.ok) {
             const data = await response.json();
             return (data.sessions ?? []).length;
           }
         } catch {}
         await new Promise((r) => setTimeout(r, 500));
       }
       return 0;
     })()`,
    true,
  )) as number | undefined;
  record("the recovered window can fetch the session list", typeof recovered === "number" && recovered > 0,
    `${recovered} sessions through the bridge`);

  await discardSession(sessionId);
}

/** Everything under a directory, flat, for before/after comparisons. */
function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Skill and plugin installs shell out to `npx skills …`, which needs npm next
 * to the app binary. This checks that and, when asked to, performs one real
 * install so the whole chain is exercised instead of assumed.
 */
async function runSkillsScenario(): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR;

  const probe = await backend.request("npx.probe", {});
  record("npm is reachable from the app binary", probe.ok, probe.ok ? `npx ${probe.version}` : probe.error ?? "failed");

  const search = await api("/api/skills/search", { method: "POST", body: { query: "commit", limit: 3 } });
  const results = (search.json.results ?? []) as { package?: string }[];
  record("the skill registry answers", search.status === 200 && results.length > 0,
    `${results.length} result(s), first: ${results[0]?.package ?? "none"}`);

  const pkg = process.env.PI_DESKTOP_SKILL;
  if (!pkg) {
    info("PI_DESKTOP_SKILL is unset — checked npm and search only, installed nothing");
    return;
  }
  if (!agentDir) {
    record("an install would land in the real agent directory", false,
      "set PI_CODING_AGENT_DIR to a throwaway path before installing");
    return;
  }

  const before = listFiles(agentDir);
  const install = await api("/api/skills/install", { method: "POST", body: { package: pkg, scope: "global" } });
  record("npx installs a real skill from the registry", install.status === 200,
    JSON.stringify(install.json).slice(0, 700));

  const added = listFiles(agentDir).filter((file) => !before.includes(file));
  record("the new skill lands in the agent directory", added.length > 0,
    added.length > 0 ? added.slice(0, 5).join(", ") : `nothing changed under ${agentDir}`);
  info(`throwaway agent directory: ${agentDir} (delete it to undo)`);
}

/** Looks for the session file pi would have written for this session id. */
function findSessionFile(sessionId: string): string | null {
  const base = join(app.getPath("home"), ".pi", "agent", "sessions");
  try {
    for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.includes(sessionId)) return entry.name;
    }
  } catch {
    // no session directory at all
  }
  return null;
}

async function runChatScenario(window: BrowserWindow): Promise<void> {
  const created = await api("/api/agent/new", {
    method: "POST", body: { cwd: scenarioWorkspace(), type: "ensure_session" },
  });
  const sessionId = created.json.sessionId as string | undefined;
  if (created.status !== 200 || !sessionId) throw new Error("could not create test session");
  let activeId = sessionId;
  try {
    await window.loadURL(`${APP_ORIGIN}/index.html?session=${encodeURIComponent(sessionId)}`);
    const probe = await readFile(join(here, "chat-probe.js"), "utf8");
    const outcomes = await inWindow<{ name: string; ok: boolean; detail?: string }[]>(
      `window.__piChatSessionId = ${JSON.stringify(sessionId)};\n${probe}`, 430_000,
    );
    if (!outcomes?.length) throw new Error("chat probe returned no results");
    for (const outcome of outcomes) record(outcome.name, outcome.ok, outcome.detail);

    // A blank session can be replaced with a persisted id on the first send.
    activeId = await window.webContents.executeJavaScript("window.__piChatActiveSessionId") || sessionId;
    // Exercise the exact window.open URL used by the full-history button.
    await window.webContents.executeJavaScript(
      `window.open('/api/sessions/${encodeURIComponent(activeId)}/export?inline=1', '_blank'); true`, true,
    );
    const deadline = Date.now() + 20_000;
    let content = false, isolated = false, previewDetail = "preview window did not open";
    while (Date.now() < deadline) {
      const preview = previewWindow as BrowserWindow | null;
      if (preview && !preview.isDestroyed()) {
        try {
          const state = await preview.webContents.executeJavaScript(`({
            content: document.body.innerText.includes('UI_CONTINUE_OK'),
            detail: document.body.innerText.slice(0, 3000),
            isolated: typeof window.piDesktop === 'undefined' && typeof require === 'undefined'
          })`);
          content = state.content;
          previewDetail = state.detail;
          isolated = state.isolated;
          if (content && isolated) break;
        } catch { /* preview still loading */ }
      }
      await sleep(200);
    }
    record("full history opens with the assistant answer visible", content, content ? "assistant answer rendered" : previewDetail);
    record("the history preview has no app bridge or Node globals", isolated);
  } finally {
    (previewWindow as BrowserWindow | null)?.close();
    await discardSession(sessionId);
    if (activeId !== sessionId) await discardSession(activeId);
  }
}

async function runScenario(window: BrowserWindow, scenario: string): Promise<void> {
  try {
    if (scenario === "reload") await runReloadScenario(window);
    else if (scenario === "crash") await runCrashScenario();
    else if (scenario === "skills") await runSkillsScenario();
    else if (scenario === "chat") await runChatScenario(window);
    else throw new Error(`unknown scenario: ${scenario}`);
  } catch (error) {
    record("scenario completed", false, error instanceof Error ? error.message : String(error));
  }

  console.log("");
  const failed = scenarioResults.filter((result) => !result.ok).length;
  console.log(`\n${scenarioResults.length - failed}/${scenarioResults.length} ${scenario} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;

  // A crashed-then-restarted backend still needs a clean shutdown.
  await backend.shutdown().catch(() => {});
  app.exit(failed === 0 ? 0 : 1);
}

const windowRequests = new Map<number, Set<string>>();

ipcMain.handle(DESKTOP_CHANNEL.invoke, async (event, method: BackendMethod, params: unknown) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Only the main app window can use the backend bridge");
  }
  let owned = windowRequests.get(event.sender.id);
  if (!owned) {
    owned = new Set();
    windowRequests.set(event.sender.id, owned);
    const ids = owned;
    const clear = () => {
      for (const streamId of ids) void backend.request("http.cancel", { streamId }, 5_000).catch(() => {});
      ids.clear();
    };
    event.sender.on("did-start-navigation", (_navigation, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) clear();
    });
    event.sender.on("render-process-gone", clear);
    const senderId = event.sender.id;
    event.sender.once("destroyed", () => {
      clear();
      windowRequests.delete(senderId);
    });
  }
  const streamId = (params as { streamId?: string } | null)?.streamId;
  if (method === "http.request" && streamId) owned.add(streamId);
  try {
    const result = await backend.request(method, params as ParamsOf<BackendMethod>);
    if (streamId && (method === "http.cancel"
      || (method === "http.request" && !(result as ResultOf<"http.request">).streamed)
      || (method === "http.pull" && (result as ResultOf<"http.pull">).done))) owned.delete(streamId);
    return result;
  } catch (error) {
    if (streamId) {
      owned.delete(streamId);
      if (method !== "http.cancel") void backend.request("http.cancel", { streamId }, 5_000).catch(() => {});
    }
    throw error;
  }
});

ipcMain.handle(DESKTOP_CHANNEL.pickDirectory, async (_event, defaultPath?: string) => {
  const result = await dialog.showOpenDialog({
    defaultPath: defaultPath ?? app.getPath("home"),
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle(DESKTOP_CHANNEL.restartBackend, async () => {
  await backend.restart();
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, (request) => serveRequest(request));
    backend.start();
    createWindow();

    if (process.env.PI_DESKTOP_SMOKE === "1" && mainWindow) {
      const window = mainWindow;
      window.webContents.once("did-finish-load", () => {
        void runSmokeChecks(window);
      });
    }

    const scenario = process.env.PI_DESKTOP_SCENARIO;
    if (scenario && mainWindow) {
      const window = mainWindow;
      window.webContents.once("did-finish-load", () => {
        void runScenario(window, scenario);
      });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  // Shut the backend down explicitly: closing the window must not leave agent
  // sessions or PTYs behind.
  app.on("before-quit", (event) => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    // Stop the renderer's timers and subscriptions before shutting down the
    // service they use. Re-entrant quit events remain prevented until exit().
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    // Honour a failure recorded by smoke/scenario checks: process.exitCode is set
    // before app.quit(), and a hard app.exit(0) here used to swallow it.
    const code = typeof process.exitCode === "number" ? process.exitCode : 0;
    void backend.shutdown().finally(() => app.exit(code));
  });
}
