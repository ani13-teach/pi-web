/**
 * End-to-end checks for the desktop backend.
 *
 * Every request goes through the real IPC channel, so this covers the ported
 * pi-web route handlers, the request/response envelope and the streaming pull
 * protocol. Run with --prompt to also send a real model prompt.
 */
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tests$/, "");
const backendPath = join(root, "dist", "main", "backend.mjs");
const withPrompt = process.argv.includes("--prompt");

if (!existsSync(backendPath)) {
  console.error(`missing ${backendPath} — run: npm run build:desktop`);
  process.exit(1);
}

const results = [];
/** Session files this run created, removed again in cleanup below. */
const createdSessionFiles = new Set();
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const child = fork(backendPath, [], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? "" },
});

const pending = new Map();
let stderr = "";

child.stderr.on("data", (data) => {
  stderr += String(data);
});
child.stdout.on("data", () => {});

child.on("message", (message) => {
  if (message?.kind === "response" && message.envelope) {
    const entry = pending.get(message.envelope.id);
    if (!entry) return;
    pending.delete(message.envelope.id);
    if (message.envelope.ok) entry.resolve(message.envelope.result);
    else entry.reject(new Error(message.envelope.error));
  }
});

child.on("exit", (code) => {
  for (const entry of pending.values()) entry.reject(new Error(`backend exited with ${code}\n${stderr}`));
  pending.clear();
});

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    child.send({ kind: "request", envelope: { id, method, params } });
  });
}

/** One request/response round trip through the ported router. */
async function request(url, init = {}) {
  const bodyBase64 = init.body === undefined
    ? undefined
    : Buffer.from(typeof init.body === "string" ? init.body : JSON.stringify(init.body)).toString("base64");
  const headers = { ...(init.body === undefined ? {} : { "content-type": "application/json" }) };
  const result = await call("http.request", {
    url,
    method: init.method ?? "GET",
    headers,
    bodyBase64,
    streamId: init.streamId,
  });
  const text = Buffer.from(result.bodyBase64 ?? "", "base64").toString("utf8");
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { ...result, text, json };
}

const jsonInit = (body, method = "POST") => ({ method, body });

/**
 * Reads a streaming response until `stop` matches or the deadline expires.
 * The caller owns the stream and cancels it explicitly, so reading can continue
 * across several checks.
 */
async function readStream(streamId, stop, { deadlineMs = 20_000, maxChunks = 400 } = {}) {
  let text = "";
  const until = Date.now() + deadlineMs;
  for (let i = 0; i < maxChunks && Date.now() < until; i += 1) {
    const pulled = await Promise.race([
      call("http.pull", { streamId }),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), until - Date.now())),
    ]);
    if (pulled.timedOut || pulled.done) break;
    text += Buffer.from(pulled.chunkBase64 ?? "", "base64").toString("utf8");
    if (stop && stop(text)) break;
  }
  return text;
}

const cwd = root;
let exitCode = null;
child.on("exit", (code) => {
  exitCode = `code ${code}`;
});

try {
  const info = await call("app.info", {});
  check("backend reports its runtime", Number.isInteger(info.pid) && Boolean(info.agentDir), `node=${info.nodeVersion} agentDir=${info.agentDir}`);

  // --- plain JSON routes -----------------------------------------------------
  const sessions = await request("/api/sessions");
  check("GET /api/sessions answers JSON", sessions.status === 200 && Array.isArray(sessions.json?.sessions),
    `${sessions.json?.sessions?.length ?? "?"} sessions`);

  const models = await request("/api/models");
  check("GET /api/models answers JSON", models.status === 200 && Boolean(models.json),
    Object.keys(models.json ?? {}).slice(0, 4).join(","));

  const defaults = await request("/api/default-cwd", jsonInit({}));
  check("POST /api/default-cwd answers", defaults.status === 200, JSON.stringify(defaults.json).slice(0, 60));

  // The web UI grants file access by validating a workspace first; same flow here.
  const granted = await request("/api/cwd/validate", jsonInit({ cwd }));
  check("POST /api/cwd/validate accepts the workspace", granted.status === 200, JSON.stringify(granted.json).slice(0, 80));

  // pi-web encodes an absolute file path as slash-separated, percent-encoded segments.
  const filePath = join(cwd, "package.json").replace(/\\/g, "/");
  const encodedFilePath = filePath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const fileList = await request(`/api/files/${encodedFilePath}?type=read`);
  check("GET /api/files reads a real file", fileList.status === 200 && fileList.text.includes("pi-desktop"),
    `${fileList.text.length} bytes — ${fileList.text.slice(0, 60).replace(/\s+/g, " ")}`);

  const missing = await request("/api/definitely-not-a-route");
  check("unknown paths return a 404 envelope", missing.status === 404, missing.json?.error ?? "");

  const git = await request(`/api/git/status?cwd=${encodeURIComponent(cwd)}`);
  check("GET /api/git/status answers", git.status === 200, `status=${git.status}`);

  // Everything else the interface reads on startup, so a broken route shows up
  // here rather than as a silently empty panel.
  const readOnlyRoutes = [
    ["/api/home", "the home/config panel"],
    [`/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(join(cwd, "package.json"))}`, "the diff view"],
    [`/api/file-index?cwd=${encodeURIComponent(cwd)}&q=package`, "the file search index"],
    ["/api/models-config", "the model configuration"],
    ["/api/models-config/catalog", "the model catalog"],
    ["/api/tools/settings", "the tool settings"],
    [`/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`, "the subagent profiles"],
    [`/api/subagents/settings?cwd=${encodeURIComponent(cwd)}`, "the subagent settings"],
    [`/api/skills?cwd=${encodeURIComponent(cwd)}`, "the installed skills"],
    [`/api/plugins?cwd=${encodeURIComponent(cwd)}`, "the installed plugins"],
    [`/api/worktrees?cwd=${encodeURIComponent(cwd)}`, "the worktree list"],
    ["/api/auth/providers", "the provider list"],
    [`/api/project-trust?cwd=${encodeURIComponent(cwd)}`, "the project trust state"],
    ["/api/push/config", "the notification settings"],
  ];
  const broken = [];
  for (const [path, label] of readOnlyRoutes) {
    const response = await request(path);
    if (response.status >= 400) broken.push(`${label} (${response.status})`);
  }
  check("the read-only routes behind the panels all answer", broken.length === 0,
    broken.length ? `failed: ${broken.join(", ")}` : `${readOnlyRoutes.length} routes answered`);

  // Update checks are POSTs; they must answer without npm being installed.
  const pluginCheck = await request("/api/plugins/check", jsonInit({ cwd }));
  check("POST /api/plugins/check answers", pluginCheck.status < 500, `${pluginCheck.status} ${pluginCheck.text.slice(0, 90)}`);
  const skillCheck = await request("/api/skills/check", jsonInit({ cwd }));
  check("POST /api/skills/check answers", skillCheck.status < 500, `${skillCheck.status} ${skillCheck.text.slice(0, 90)}`);

  // --- streaming route -------------------------------------------------------
  const created = await request("/api/terminal", jsonInit({ cwd, cols: 80, rows: 24 }));
  check("POST /api/terminal creates a terminal", created.status === 200 && typeof created.json?.id === "string", created.json?.id ?? created.text.slice(0, 80));

  if (created.json?.id) {
    const terminalId = created.json.id;
    const streamId = randomUUID();
    const opened = await request(`/api/terminal/${terminalId}/events`, { streamId });
    check("terminal events open as a stream", opened.status === 200 && opened.streamed === true,
      `content-type=${opened.headers.find(([k]) => k === "content-type")?.[1] ?? "?"}`);

    const first = await readStream(streamId, (text) => text.length > 0, { deadlineMs: 15_000, maxChunks: 4 });
    check("the stream delivers SSE frames", first.includes("event:") || first.includes(":"), JSON.stringify(first.slice(0, 60)));

    // The shell echoes the command it was handed, so a marker that is also in the
    // input proves nothing. cmd expands %i after echoing, so ipc_42 can only come
    // from the command's real output.
    await request(`/api/terminal/${terminalId}`, jsonInit({ type: "input", data: "for /l %i in (42,1,42) do @echo ipc_%i\r\n" }));
    await request(`/api/terminal/${terminalId}`, jsonInit({ type: "resize", cols: 100, rows: 30 }));
    const echoed = await readStream(streamId, (text) => text.includes("ipc_42"), { deadlineMs: 20_000 });
    check("terminal input round-trips through the stream", echoed.includes("ipc_42"), `${echoed.length} bytes`);

    const cancelled = await call("http.cancel", { streamId });
    check("http.cancel closes the stream", cancelled.cancelled === true);

    const afterCancel = await call("http.pull", { streamId });
    check("a cancelled stream reports done", afterCancel.done === true);

    const killed = await request(`/api/terminal/${terminalId}`, { method: "DELETE" });
    check("DELETE /api/terminal/[id] kills the terminal", killed.status === 200, JSON.stringify(killed.json).slice(0, 60));
  }

  // --- agent routes ----------------------------------------------------------
  const agentNew = await request("/api/agent/new", jsonInit({ cwd, type: "ensure_session" }));
  const sessionId = agentNew.json?.sessionId ?? agentNew.json?.id ?? agentNew.json?.session?.id;
  check("POST /api/agent/new creates a session", agentNew.status === 200 && typeof sessionId === "string",
    `${agentNew.text.slice(0, 120)}`);
  if (agentNew.json?.sessionFile) createdSessionFiles.add(agentNew.json.sessionFile);

  if (sessionId) {
    const state = await request(`/api/sessions/${sessionId}/state`);
    check("GET /api/sessions/[id]/state answers", state.status === 200, `${state.text.length} bytes`);

    const context = await request(`/api/sessions/${sessionId}/context`);
    check("GET /api/sessions/[id]/context answers", context.status === 200, `${context.text.length} bytes`);
  }

  // --- built-in auto mode ----------------------------------------------------
  const automode = await request("/api/automode");
  check("GET /api/automode reports the built-in copy",
    automode.status === 200 && typeof automode.json?.builtin?.version === "string",
    `builtin ${automode.json?.builtin?.version ?? "?"}, in force: ${automode.json?.effective?.enabled ? "on" : "off"}, model=${automode.json?.effective?.classifierModel ?? "none"}`);
  check("GET /api/automode names both configuration files",
    typeof automode.json?.paths?.global === "string" && typeof automode.json?.paths?.project === "string",
    `${automode.json?.paths?.global ?? "?"}`);

  const badPatch = await request("/api/automode", jsonInit({ scope: "global", patch: { classifierTimeoutMs: 1 } }, "PUT"));
  check("PUT /api/automode refuses an out-of-range value", badPatch.status === 400,
    (badPatch.json?.error ?? badPatch.text).slice(0, 80));

  // A save has to end up in a file, and only for the fields that were touched.
  // It goes to a throwaway project so the real configuration is never written:
  // a project with no trust-requiring resources counts as trusted, so this
  // needs no trust decision.
  //
  // The project file is a pi project-settings file: auto-mode keys live under
  // "autoMode" and everything else in it was put there by the user, so a save
  // has to leave it alone.
  const sandbox = mkdtempSync(join(tmpdir(), "pi-automode-"));
  const projectConfig = join(sandbox, ".pi", "automode.local.json");
  const readSandbox = () =>
    existsSync(projectConfig) ? JSON.parse(readFileSync(projectConfig, "utf8")) : {};
  const readEffective = async () =>
    (await request(`/api/automode?cwd=${encodeURIComponent(sandbox)}`)).json;
  try {
    mkdirSync(join(sandbox, ".pi"), { recursive: true });
    writeFileSync(projectConfig, JSON.stringify({
      autoMode: { enabled: true, log: { enabled: true } },
      permissions: { deny: ["Bash(rm:*)"] },
    }, null, 2));

    const saved = await request("/api/automode", jsonInit({
      scope: "project",
      cwd: sandbox,
      patch: { classifierTimeoutMs: 12345, classifierFallbackModels: ["KBQ/check-model"] },
    }, "PUT"));
    check("PUT /api/automode writes the project file", saved.status === 200 && existsSync(projectConfig),
      `${saved.status}, ${projectConfig.replace(sandbox, "<tmp>")}`);

    const written = readSandbox();
    const autoMode = written.autoMode ?? {};
    check("the written file holds the touched fields and nothing else",
      autoMode.classifierTimeoutMs === 12345
      && JSON.stringify(autoMode.classifierFallbackModels) === JSON.stringify(["KBQ/check-model"])
      && Object.keys(autoMode).length === 4,
      JSON.stringify(autoMode));
    check("a save leaves the rest of the file alone",
      autoMode.enabled === true && autoMode.log?.enabled === true
      && JSON.stringify(written.permissions) === JSON.stringify({ deny: ["Bash(rm:*)"] }),
      JSON.stringify({ enabled: autoMode.enabled, log: autoMode.log, permissions: written.permissions }));

    const reread = await readEffective();
    check("a saved value comes back as the project's own",
      reread?.sources?.classifierTimeoutMs === "project" && reread?.effective?.classifierTimeoutMs === 12345,
      `source=${reread?.sources?.classifierTimeoutMs}, in force=${reread?.effective?.classifierTimeoutMs}`);

    const cleared = await request("/api/automode", jsonInit({
      scope: "project",
      cwd: sandbox,
      patch: { classifierTimeoutMs: null },
    }, "PUT"));
    const afterClear = readSandbox().autoMode ?? {};
    const inherited = await readEffective();
    check("clearing a field drops the key so the level below applies",
      cleared.status === 200 && !("classifierTimeoutMs" in afterClear)
      && inherited?.effective?.classifierTimeoutMs !== 12345
      && inherited?.sources?.classifierTimeoutMs !== "project",
      `${JSON.stringify(afterClear)}, now ${inherited?.effective?.classifierTimeoutMs} from ${inherited?.sources?.classifierTimeoutMs}`);

    const broken = await request("/api/automode", jsonInit({
      scope: "project",
      cwd: sandbox,
      patch: { classifierReasoningLevel: "insane", nonsense: true },
    }, "PUT"));
    check("PUT /api/automode refuses unknown values and keys",
      broken.status === 400 && !("classifierReasoningLevel" in (readSandbox().autoMode ?? {}))
      && !("nonsense" in (readSandbox().autoMode ?? {})),
      (broken.json?.error ?? broken.text).slice(0, 90));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  if (sessionId) {
    // The extension sets this status only when it is loaded and bound to a
    // session, so its presence is what proves the bundled copy is live.
    const liveState = await request(`/api/sessions/${sessionId}/state`);
    const statuses = liveState.json?.state?.extensionStatuses ?? [];
    const automodeStatus = statuses.find((entry) => entry?.key === "pi-automode");
    check("the bundled auto mode extension is live in a session", Boolean(automodeStatus),
      automodeStatus
        ? String(automodeStatus.text).replace(/\u001b\[[0-9;]*m/g, "")
        : `extension statuses: ${statuses.map((entry) => entry?.key).join(", ") || "none"}`);
  }

  if (withPrompt && sessionId) {
    const eventsStreamId = randomUUID();    await request(`/api/agent/${sessionId}/events`, { streamId: eventsStreamId });
    // The UI sends a typed command, not a bare message.
    const prompted = await request(
      `/api/agent/${sessionId}`,
      jsonInit({ type: "prompt", message: "Reply with exactly: ported routes work" }),
    );
    check("POST /api/agent/[id] accepts a prompt", prompted.status === 200, prompted.text.slice(0, 80));
    // The ported stream sends data-only frames carrying JSON events, so the
    // checks look at the event types inside the payload.
    const events = await readStream(
      eventsStreamId,
      (text) => /"type":"(turn_end|agent_end)"/.test(text),
      { deadlineMs: 120_000, maxChunks: 3000 },
    );
    const types = [...new Set([...events.matchAll(/"type":"([a-z_]+)"/g)].map((match) => match[1]))];
    check("the agent event stream reports a finished turn",
      /"type":"(turn_end|agent_end)"/.test(events),
      `${events.length} bytes, types: ${types.join(" ")}`);
    // A start event is not an answer, and the prompt text itself appears in the
    // stream, so the marker is looked up in the stored transcript instead:
    // only messages written by the assistant can carry it there.
    const stored = await request(`/api/sessions/${sessionId}/context`);
    const storedMessages = stored.json?.messages ?? stored.json?.context?.messages ?? [];
    const assistantText = storedMessages
      .filter((message) => message.role === "assistant")
      .map((message) => JSON.stringify(message.content ?? ""))
      .join("\n");
    const answered = assistantText.includes("ported routes work");
    check("the model answered with the text it was asked for", answered,
      answered ? `${assistantText.length} bytes of assistant text` : `no marker in ${assistantText.length} bytes of assistant text`);

    // Leave no test conversation in the user's session store.
    await request(`/api/sessions/${sessionId}`, { method: "DELETE" });
  }

  const shutdown = await call("backend.shutdown", {});
  check("backend.shutdown answers", shutdown.closed === true);
  await new Promise((resolve) => setTimeout(resolve, 800));
  check("backend exits cleanly after shutdown", exitCode === "code 0", String(exitCode));

  for (const file of createdSessionFiles) {
    try {
      if (existsSync(file)) unlinkSync(file);
      const folder = dirname(file);
      if (existsSync(folder) && readdirSync(folder).length === 0) rmSync(folder, { recursive: true, force: true });
    } catch {
      // cleanup is best effort
    }
  }

  // The prompt run leaves an empty per-workspace folder behind; drop it too.
  try {
    const sessionsRoot = join(homedir(), ".pi", "agent", "sessions");
    for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = join(sessionsRoot, entry.name);
      if (readdirSync(folder).length === 0) rmSync(folder, { recursive: true, force: true });
    }
  } catch {
    // best effort
  }
} catch (error) {
  check("test run completed", false, error instanceof Error ? error.message : String(error));
} finally {
  if (!child.killed) child.kill();
}

console.log(`\n${results.length - failures}/${results.length} checks passed${withPrompt ? " (with a real model prompt)" : ""}`);
process.exit(failures ? 1 : 0);
