/** Real backend IPC regression; only synthetic temp history, no model prompt. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backend = join(root, "dist/main/backend.mjs");
assert.ok(existsSync(backend), "Run npm run build:desktop first");
const sandbox = await mkdtemp(join(tmpdir(), "pi-resource-lifecycle-"));
const agentDir = join(sandbox, "agent");
const project = join(sandbox, "project");
const historyDir = join(agentDir, "sessions", "fixture");
const extensionDir = join(agentDir, "extensions");
const auditPath = join(sandbox, "activation-audit.jsonl");
await Promise.all([mkdir(historyDir, { recursive: true }), mkdir(extensionDir, { recursive: true }), mkdir(project), mkdir(join(sandbox, "roaming")), mkdir(join(sandbox, "local"))]);
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
await writeFile(join(extensionDir, "resource-audit.ts"), `
import { appendFileSync } from "node:fs";
export default function(pi) {
  const record = (type) => appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify({type}) + "\\n");
  record("factory");
  pi.on("session_start", () => record("start"));
  pi.on("session_shutdown", () => record("shutdown"));
}
`);
const sessionId = randomUUID();
const timestamp = new Date().toISOString();
await writeFile(join(historyDir, "history.jsonl"), [
  { type: "session", version: 3, id: sessionId, cwd: project, timestamp },
  { type: "message", id: "fixture1", parentId: null, timestamp, message: { role: "user", content: "Synthetic resource lifecycle history", timestamp: Date.now() } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
const env = {
  ...process.env,
  HOME: sandbox, USERPROFILE: sandbox, APPDATA: join(sandbox, "roaming"), LOCALAPPDATA: join(sandbox, "local"),
  PI_CODING_AGENT_DIR: agentDir, PI_WEB_IDLE_TIMEOUT_MS: "1200", PI_OFFLINE: "1", PI_TELEMETRY: "0",
};
delete env.PI_DESKTOP_SMOKE;
delete env.PI_DESKTOP_SCENARIO;
const child = fork(backend, [], { cwd: project, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
let stderr = "";
let exit;
let passed = 0;
const pending = new Map();
child.stdout.on("data", () => {});
child.stderr.on("data", (data) => { stderr = (stderr + String(data)).slice(-16000); });
const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => {
  exit = { code, signal };
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(`Backend exited: ${JSON.stringify(exit)}\n${stderr}`)); }
  pending.clear();
  resolveExit(exit);
}));
child.on("message", (message) => {
  if (message?.kind === "proxy.query") { child.send({ kind: "proxy.result", id: message.id, ok: true, value: "DIRECT" }); return; }
  const envelope = message?.envelope;
  if (message?.kind !== "response" || !envelope) return;
  const waiting = pending.get(envelope.id);
  if (!waiting) return;
  clearTimeout(waiting.timer); pending.delete(envelope.id);
  if (envelope.ok) waiting.resolve(envelope.result);
  else waiting.reject(new Error(envelope.error));
});
function call(method, params = {}) {
  return new Promise((resolveCall, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`IPC timed out: ${method}\n${stderr}`)); }, 20000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    child.send({ kind: "request", envelope: { id, method, params } });
  });
}
async function request(url, { body, streamId } = {}) {
  const result = await call("http.request", {
    url, method: body === undefined ? "GET" : "POST", streamId,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64") }),
  });
  const text = Buffer.from(result.bodyBase64 ?? "", "base64").toString("utf8");
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* Plain-text HTTP errors. */ }
  return { ...result, text, json };
}
function check(name, condition) { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); }
async function readUntil(streamId, match) {
  let text = "";
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const part = await call("http.pull", { streamId });
    if (part.done) break;
    text += Buffer.from(part.chunkBase64 ?? "", "base64").toString("utf8");
    if (match(text)) return text;
  }
  throw new Error(`Stream did not reach expected state: ${text.slice(-1200)}`);
}
async function auditCounts() {
  const counts = { factory: 0, start: 0, shutdown: 0 };
  if (existsSync(auditPath)) for (const line of (await readFile(auditPath, "utf8")).trim().split("\n")) {
    const { type } = JSON.parse(line);
    if (Object.hasOwn(counts, type)) counts[type]++;
  }
  return counts;
}
const state = () => request(`/api/sessions/${sessionId}/state`);
const activate = () => request(`/api/agent/${sessionId}`, { body: { type: "ensure_session" } });
try {
  const info = await call("app.info");
  check("backend uses isolated agent directory", resolve(info.agentDir) === resolve(agentDir));
  const grant = await request("/api/cwd/validate", { body: { cwd: project } });
  check("synthetic workspace is valid", grant.status === 200);
  for (let i = 0; i < 3; i++) {
    const history = await request(`/api/sessions/${sessionId}`);
    check(`history read ${i + 1} does not initialize runtime`, history.status === 200 && (await state()).json.runtimeActive === false);
  }
  const dormantStream = randomUUID();
  const dormantOpened = await request(`/api/agent/${sessionId}/events`, { streamId: dormantStream });
  check("cold event subscription is a lightweight stream", dormantOpened.status === 200 && dormantOpened.streamed === true);
  const dormant = await readUntil(dormantStream, (text) => text.includes('"type":"dormant"'));
  check("cold event subscription publishes dormant, not connected", !dormant.includes('"type":"connected"') && (await state()).json.runtimeActive === false);
  await call("http.cancel", { streamId: dormantStream });
  const readOnly = await request(`/api/agent/${sessionId}`, { body: { type: "get_tools" } });
  check("read-only command does not initialize dormant runtime", readOnly.status === 409 && (await state()).json.runtimeActive === false);
  const missing = await request(`/api/agent/${randomUUID()}/events`, { streamId: randomUUID() });
  check("missing history returns 404 without initialization", missing.status === 404);
  check("history, cold SSE and read-only requests execute no extension factory", (await auditCounts()).factory === 0);
  const activations = await Promise.all(Array.from({ length: 6 }, activate));
  check("concurrent activation requests reuse the same session", activations.every((item) => item.status === 200 && item.json.data.sessionId === sessionId));
  const firstAudit = await auditCounts();
  check("six concurrent activations execute exactly one factory and session_start", firstAudit.factory === 1 && firstAudit.start === 1 && firstAudit.shutdown === 0);
  check("explicit activation initializes runtime", (await state()).json.runtimeActive === true);
  const activeStream = randomUUID();
  const opened = await request(`/api/agent/${sessionId}/events`, { streamId: activeStream });
  check("active runtime event subscription succeeds", opened.status === 200 && opened.streamed === true);
  const ready = await readUntil(activeStream, (text) => text.includes('"type":"connected"'));
  check("active runtime publishes ready handshake", true);
  if (!ready.includes('"type":"dormant"')) await readUntil(activeStream, (text) => text.includes('"type":"dormant"'));
  check("an observing SSE client does not prevent idle collection", (await state()).json.runtimeActive === false);
  const idleAudit = await auditCounts();
  check("idle collection dispatches shutdown exactly once", idleAudit.factory === 1 && idleAudit.start === 1 && idleAudit.shutdown === 1);
  const ended = await call("http.pull", { streamId: activeStream });
  check("idle collection closes the event stream", ended.done === true);
  await call("http.cancel", { streamId: activeStream });
  const reactivated = await activate();
  check("collected history can be explicitly reactivated", reactivated.status === 200 && reactivated.json.data.sessionId === sessionId && (await state()).json.runtimeActive === true);
  const shutdown = await call("backend.shutdown");
  check("backend cleans up all test resources", shutdown.closed === true);
  let exitTimer;
  let exitResult;
  try {
    exitResult = await Promise.race([exited, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error("Backend did not exit")), 10000); })]);
  } finally { clearTimeout(exitTimer); }
  check("isolated backend exits cleanly", exitResult.code === 0);
  const finalAudit = await auditCounts();
  check("reactivation and final shutdown leave no live extension instance", finalAudit.factory === 2 && finalAudit.start === 2 && finalAudit.shutdown === 2);
  console.log(`${passed}/${passed} resource lifecycle IPC checks passed (no model calls)`);
} catch (error) {
  console.error(error);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  if (!exit) child.kill();
  await exited;
  for (const { timer } of pending.values()) clearTimeout(timer);
  if (process.exitCode) console.error(`Diagnostics fixture retained at ${sandbox}`);
  else await rm(sandbox, { recursive: true, force: true });
}
