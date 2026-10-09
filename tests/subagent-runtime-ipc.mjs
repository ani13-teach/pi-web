// Built-backend IPC acceptance with throwaway configuration; no model, network or personal files.
// Run after npm run build:desktop: node tests/subagent-runtime-ipc.mjs
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "pi-subagent-runtime-ipc-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
await mkdir(join(agentDir, "agents"), { recursive: true });
await mkdir(cwd);
const globalPath = join(agentDir, "subagents.json");
const legacyPath = join(agentDir, "agents", "settings.json");
await writeFile(globalPath, JSON.stringify({ maxConcurrent: 4, defaultMaxTurns: 30, futureSetting: { keep: true } }));
await writeFile(legacyPath, JSON.stringify({ builtInEnabled: true, maxConcurrent: 10 }));
const child = fork(fileURLToPath(new URL("../dist/main/backend.mjs", import.meta.url)), [], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_SKIP_VERSION_CHECK: "1" },
});
const pending = new Map();
let diagnostics = "";
child.stdout.on("data", data => { diagnostics += String(data); });
child.stderr.on("data", data => { diagnostics += String(data); });
child.on("message", message => {
  if (message?.kind === "proxy.query") {
    // A local settings test must never start any outbound request.
    child.send({ kind: "proxy.result", id: message.id, ok: false, error: "Network prohibited in runtime-settings fixture" });
    return;
  }
  if (message?.kind !== "response") return;
  const envelope = message.envelope;
  const entry = pending.get(envelope?.id);
  if (!entry) return;
  pending.delete(envelope.id);
  clearTimeout(entry.timer);
  if (envelope.ok) entry.resolve(envelope.result);
  else entry.reject(new Error(envelope.error));
});
child.on("exit", code => {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(`Backend exited ${code}: ${diagnostics}`));
  }
  pending.clear();
});
const exited = new Promise(resolve => child.once("exit", resolve));
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.send({ kind: "request", envelope: { id, method, params } });
  });
}
async function request(url, body) {
  const result = await call("http.request", {
    url, method: body === undefined ? "GET" : "PUT",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64") }),
  });
  return { status: result.status, data: JSON.parse(Buffer.from(result.bodyBase64, "base64").toString("utf8")) };
}
let count = 0;
async function check(name, fn) {
  await fn();
  count++;
  console.log(`PASS: ${name}`);
}
let failed = false;
try {
  // Validation route grants only this fixture directory access for the backend.
  const validation = await call("http.request", { url: "/api/cwd/validate", method: "POST", headers: { "content-type": "application/json" }, bodyBase64: Buffer.from(JSON.stringify({ cwd })).toString("base64") });
  assert.equal(validation.status, 200);
  const url = `/api/subagents/runtime-settings?cwd=${encodeURIComponent(cwd)}`;
  await check("generated IPC route reads native concurrency 4, not legacy 10", async () => {
    const { status, data } = await request(url);
    assert.equal(status, 200);
    assert.equal(data.effective.maxConcurrent, 4);
    assert.equal(data.legacyMaxConcurrent, 10);
    assert.equal(data.filePath, globalPath);
  });
  await check("IPC global patch writes only edits and preserves unknown fields", async () => {
    const { status } = await request("/api/subagents/runtime-settings", { cwd, scope: "global", patch: { graceTurns: 8, schedulingEnabled: false } });
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), { maxConcurrent: 4, defaultMaxTurns: 30, futureSetting: { keep: true }, graceTurns: 8, schedulingEnabled: false });
  });
  await check("IPC project override retains zero and false, overrides global", async () => {
    const { status, data } = await request("/api/subagents/runtime-settings", { cwd, scope: "project", patch: { maxConcurrent: 2, defaultMaxTurns: 0, workflowsEnabled: false } });
    assert.equal(status, 200);
    assert.equal(data.effective.maxConcurrent, 2);
    assert.equal(data.effective.defaultMaxTurns, 0);
    assert.equal(data.effective.workflowsEnabled, false);
    assert.deepEqual(JSON.parse(await readFile(join(cwd, ".pi", "subagents.json"), "utf8")), { maxConcurrent: 2, defaultMaxTurns: 0, workflowsEnabled: false });
  });
  await check("IPC inheritance deletes only the selected key", async () => {
    const { status, data } = await request("/api/subagents/runtime-settings", { cwd, scope: "project", patch: { maxConcurrent: null } });
    assert.equal(status, 200);
    assert.equal(data.effective.maxConcurrent, 4);
    assert.equal(data.values.maxConcurrent, undefined);
    assert.equal(data.effective.defaultMaxTurns, 0);
  });
  await check("IPC invalid patch fails with no filesystem changes", async () => {
    const before = await readFile(globalPath, "utf8");
    const { status } = await request("/api/subagents/runtime-settings", { cwd, scope: "global", patch: { maxConcurrent: 0, graceTurns: 9 } });
    assert.equal(status, 400);
    assert.equal(await readFile(globalPath, "utf8"), before);
  });
  await check("legacy Desktop file is not rewritten", async () => {
    assert.deepEqual(JSON.parse(await readFile(legacyPath, "utf8")), { builtInEnabled: true, maxConcurrent: 10 });
  });
} catch (error) {
  failed = true;
  console.error(error);
  console.error(diagnostics);
} finally {
  if (child.connected) child.disconnect();
  await Promise.race([exited, new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
    exited.then(() => { clearTimeout(timer); resolve(); });
  })]);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(`${count}/6 runtime settings IPC checks passed`);
if (failed || count !== 6) process.exitCode = 1;
