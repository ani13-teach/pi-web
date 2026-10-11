/** Check the installed/candidate desktop backend through real IPC, using only a local mock provider. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const installed = join(process.env.LOCALAPPDATA, "Programs", "Pi Desktop");
const backend = resolve(process.argv[2] ?? join(installed, "resources", "app.asar.unpacked", "dist", "main", "backend.mjs"));
const root = await mkdtemp(join(tmpdir(), "pi-loader-ipc-check-"));
const agentDir = join(root, "agent");
const cwd = join(root, "workspace");
let child;
let stderr = "";
const pending = new Map();
const checks = [];
const passed = (name) => { checks.push(name); console.log("PASS  " + name); };
try {
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(agentDir, "agents"));
  await mkdir(cwd);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["+codemode"], compaction: { enabled: false }, retry: { enabled: false } }));
  await writeFile(join(agentDir, "agents", "settings.json"), '{"builtInEnabled":false}');
  await writeFile(join(agentDir, "extensions", "fixture.js"), `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  // Local mock for the existing guard's default model. It approves ONLY this
  // harmless fixed arithmetic script; no permission or automode config changes.
  pi.registerProvider("DeepSeek", {
    api: "loader-fixture-classifier", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
    models: [{ id: "deepseek-flash", name: "Local guard fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 8192 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const texts = context.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === "text").map(block => block.text) : [String(message.content)]);
      let action;
      for (const text of texts) { try { const value = JSON.parse(text); if (value.toolName) action = value; } catch {} }
      const safe = action?.toolName === "codemode" && action?.input?.code === "return 2 + 3;";
      const fast = texts.at(-1)?.includes("Return exactly one digit");
      const text = fast ? (safe ? "0" : "1") : JSON.stringify({ decision: safe ? "allow" : "block", tier: safe ? "allow" : "none", reason: "Fixed arithmetic-only local test" });
      queueMicrotask(() => {
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: "stop", message }); stream.end();
      });
      return stream;
    }
  });
  let scripted = false;
  pi.registerProvider("loader-local", {
    api: "loader-local-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
    models: [{ id: "mock", name: "Local fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const script = !scripted;
      scripted = true;
      queueMicrotask(() => {
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: script ? [{ type: "toolCall", id: "fixture-script", name: "codemode", arguments: { code: "return 2 + 3;" } }] : [{ type: "text", text: "local fixture finished" }],
          stopReason: script ? "toolUse" : "stop", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
      });
      return stream;
    }
  });
}`);
  let launchBackend = backend;
  if (process.argv.includes("--stage")) {
    const staged = join(root, "app");
    await mkdir(join(staged, "dist", "main"), { recursive: true });
    await symlink(join(installed, "resources", "app.asar.unpacked", "node_modules"), join(staged, "node_modules"), "junction");
    launchBackend = join(staged, "dist", "main", "backend.mjs");
    await copyFile(backend, launchBackend);
    await copyFile(join(dirname(backend), "desktop-extension-loader-fix.mjs"), join(dirname(launchBackend), "desktop-extension-loader-fix.mjs"));
    await copyFile(join(installed, "resources", "app.asar.unpacked", "dist", "main", "pi-subagents.mjs"), join(dirname(launchBackend), "pi-subagents.mjs"));
  }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_WEB_IDLE_TIMEOUT_MS: "0" };
  delete env.PI_CODING_AGENT_SESSION_DIR;
  delete env.NODE_PATH;
  child = fork(launchBackend, [], { execPath: join(installed, "Pi Desktop.exe"), cwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stderr.on("data", (data) => { stderr += String(data); });
  child.stdout.on("data", () => {});
  child.on("message", (message) => {
    if (message?.kind === "proxy.query") {
      child.send({ kind: "proxy.result", id: message.id, ok: true, value: "DIRECT" });
    } else if (message?.kind === "response" && message.envelope) {
      const entry = pending.get(message.envelope.id);
      if (!entry) return;
      pending.delete(message.envelope.id); clearTimeout(entry.timer);
      if (message.envelope.ok) entry.resolve(message.envelope.result);
      else entry.reject(new Error(message.envelope.error));
    }
  });
  child.on("exit", (code) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`Backend exit ${code}\n${stderr}`)); }
    pending.clear();
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`IPC timeout: ${method}\n${stderr}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    child.send({ kind: "request", envelope: { id, method, params } });
  });
  const request = async (url, body, extra = {}) => {
    const result = await call("http.request", { url, method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      bodyBase64: body === undefined ? undefined : Buffer.from(JSON.stringify(body)).toString("base64"), ...extra });
    const text = Buffer.from(result.bodyBase64 ?? "", "base64").toString("utf8");
    assert.equal(result.status, 200, `${url}: ${text}\n${stderr}`);
    return text ? JSON.parse(text) : {};
  };
  const info = await call("app.info");
  assert.equal(resolve(info.agentDir), resolve(agentDir));
  passed("installed Electron runtime starts backend with isolated configuration");
  const created = await request("/api/agent/new", { cwd, type: "ensure_session", provider: "loader-local", modelId: "mock" });
  const id = created.sessionId;
  assert.ok(id);
  assert.equal(created.model.provider, "loader-local");
  const tools = async () => (await request(`/api/agent/${id}`, { type: "get_tools" })).data;
  assert.equal((await tools()).filter((tool) => tool.name === "codemode" && tool.active).length, 1);
  passed("real desktop session registers and activates codemode exactly once");
  const streamId = randomUUID();
  await request(`/api/agent/${id}/events`, undefined, { streamId });
  await request(`/api/agent/${id}`, { type: "prompt", message: "Run the local minimal script." });
  let events = "";
  const deadline = Date.now() + 30000;
  while (!/"type":"(agent_settled|prompt_done)"/.test(events) && Date.now() < deadline) {
    const pulled = await call("http.pull", { streamId });
    if (pulled.done) break;
    events += Buffer.from(pulled.chunkBase64 ?? "", "base64").toString("utf8");
  }
  assert.ok(events.includes("Script completed"), `Minimal script failed: ${events.slice(-4000)}\n${stderr}`);
  assert.ok(events.includes("local fixture finished"), `Mock turn did not finish: ${events.slice(-2000)}`);
  passed("model-issued minimal script executes in shipped QuickJS runtime");
  await call("http.cancel", { streamId });
  const settingsPath = join(agentDir, "settings.json");
  const update = async (extensions) => {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    await writeFile(settingsPath, JSON.stringify({ ...settings, extensions }));
    await request(`/api/agent/${id}`, { type: "reload" });
  };
  await update(["-builtin:codemode"]);
  assert.equal((await tools()).some((tool) => tool.name === "codemode"), false);
  passed("explicit builtin exclusion takes effect after desktop reload");
  await update([]);
  assert.equal((await tools()).filter((tool) => tool.name === "codemode" && tool.active).length, 1);
  passed("removing exclusion restores codemode on desktop reload");
  const chat = await request("/api/agent/new", { cwd, type: "ensure_session", toolNames: [] });
  const chatTools = (await request(`/api/agent/${chat.sessionId}`, { type: "get_tools" })).data;
  assert.equal(chatTools.some((tool) => tool.name === "codemode"), false);
  passed("chat-only desktop session does not gain codemode");
  await call("backend.shutdown");
  console.log(`${checks.length}/${checks.length} desktop loader IPC checks passed (local mock, no user credentials)`);
} finally {
  if (child && child.exitCode === null) {
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exit;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
