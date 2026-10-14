import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createObservedMcpExtension } from "../builtin/mcp/core.mjs";
const { codemodeSchema } = await import(new URL("./extensions/codemode/tool.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const jiti = createJiti(import.meta.url);
const { createDesktopMcpExtension, getDesktopMcpRuntime, loadMcpCoreConfigApi, mcpMayEnableCodemode } = await jiti.import("./mcp-runtime.ts");

function host(id = "synthetic-session", cwd = tmpdir()) {
  const handlers = new Map(), tools = new Map(), notices = [];
  let active = ["read"];
  const pi = {
    on(name, callback) { const list = handlers.get(name) ?? []; list.push(callback); handlers.set(name, list); },
    getMcpServers: () => [], registerToolRenderer() {}, registerCommand() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools: () => [{ name: "codemode", exposure: "direct", parameters: codemodeSchema }, ...tools.values()],
    getActiveTools: () => active,
    setActiveTools(names) { active = names; },
  };
  const ctx = { cwd, mode: "rpc", hasUI: false, isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => id }, modelRegistry: {},
    ui: { notify(message) { notices.push(message); }, setStatus() {} } };
  return { pi, ctx, tools, notices, async event(name, event = {}) { for (const callback of handlers.get(name) ?? []) await callback(event, ctx); } };
}

class SyntheticTransport {
  constructor({ fail = false, hang = false } = {}) { this.fail = fail; this.hang = hang; this.closed = false; this.methods = []; this.messages = new Set(); this.errors = new Set(); this.closes = new Set(); }
  onMessage(fn) { this.messages.add(fn); return () => this.messages.delete(fn); }
  onError(fn) { this.errors.add(fn); return () => this.errors.delete(fn); }
  onClose(fn) { this.closes.add(fn); return () => this.closes.delete(fn); }
  async start() { if (this.fail) throw new Error("https://user:password@private.invalid?token=secret Authorization: Bearer secret"); }
  async close() { this.closed = true; for (const fn of this.closes) fn(); }
  async send(message) {
    if (this.closed) throw new Error("closed");
    this.methods.push(message.method);
    if (message.id === undefined || this.hang) return;
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "synthetic", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "ping", description: "Fixture only", inputSchema: { type: "object", properties: {} } }] }
      : message.method === "resources/list" ? { resources: [{ uri: "fixture://resource", name: "test" }] }
      : message.method === "resources/templates/list" ? { resourceTemplates: [] }
      : message.method === "tools/call" ? { content: [{ type: "text", text: "SECRET_RESULT" }] } : {};
    queueMicrotask(() => { for (const fn of this.messages) { fn({ jsonrpc: "2.0", id: message.id, result }); if (message.method === "tools/list") fn({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", logger: "SECRET_LOGGER", data: "SECRET_LOG_BODY" } }); } });
  }
}

async function isolated(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-runtime-"));
  const agent = join(root, "agent"), project = join(root, "project"), actual = join(root, "actual");
  await Promise.all([mkdir(agent), mkdir(join(project, ".pi"), { recursive: true }), mkdir(actual)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, agent, project, actual };
}

test("real vendored factory observes connected/failed/disabled; check does not execute tools; retry closes old transport", async (t) => {
  const { agent } = await isolated(t);
  const h = host(); const transports = [], snapshots = [], logs = [];
  let controller;
  await createObservedMcpExtension({
    loadConfig: () => ({ errors: ["SECRET_CONFIG"], servers: [
      { name: "good", source: join(agent, "mcp.json"), scope: "global", config: { command: "fixture", exposure: "codemode" } },
      { name: "bad", source: join(agent, "mcp.json"), config: { command: "fixture" } },
      { name: "off", source: join(agent, "mcp.json"), config: { command: "fixture", enabled: false } },
    ] }),
    log: { write(name, message) { logs.push({ name, message }); } },
    createTransport: (entry) => { const transport = new SyntheticTransport({ fail: entry.name === "bad" }); transports.push(transport); return transport; },
    onSnapshot: (value) => snapshots.push(value), onController: (value) => { controller = value; },
  })(h.pi);
  await h.event("session_start");
  t.after(() => h.event("session_shutdown"));
  const ready = await controller.check(4000);
  assert.deepEqual(ready.servers.map((server) => server.state), ["connected", "failed", "disabled"]);
  assert.equal(ready.servers[0].resourceCount, 1);
  assert.equal(ready.servers[0].tools[0].name, "ping");
  assert.ok(h.pi.getActiveTools().includes("codemode"));
  assert.equal(transports.some((transport) => transport.methods.includes("tools/call")), false);
  assert.equal(JSON.stringify(ready).includes("SECRET"), false);
  assert.equal(JSON.stringify(ready).includes("password"), false);
  assert.doesNotMatch(JSON.stringify(h.notices), /SECRET|password|Bearer/);
  assert.ok(logs.length > 0);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|password|Bearer/);
  await h.event("tool_result", { toolName: "mcp__good__ping", isError: false, content: "SECRET_RESULT" });
  await h.event("tool_result", { toolName: "mcp__not-owned__ping", isError: true });
  assert.equal(snapshots.at(-1).servers[0].lastCall.success, true);
  assert.equal(JSON.stringify(snapshots).includes("SECRET_RESULT"), false);
  await h.event("tool_result", { toolName: "mcp__good__ping", isError: true });
  assert.equal(snapshots.at(-1).servers[0].lastCall.success, false);
  await controller.retry("good");
  assert.equal(transports[0].closed, true);
  await assert.rejects(controller.retry("off"));
  await h.event("session_shutdown");
  assert.ok(transports.every((transport) => transport.closed));
  await assert.rejects(controller.check(5), /no longer active/);
  await assert.rejects(controller.retry("good"), /no longer active/);
});

test("check is bounded for a pending real connection; shutdown cancels waiting check", async (t) => {
  const h = host(); let controller; let transport;
  await createObservedMcpExtension({ loadConfig: () => ({ errors: [], servers: [{ name: "slow", source: "fixture", config: { command: "fixture" } }] }),
    log: { append() {} }, createTransport: () => (transport = new SyntheticTransport({ hang: true })), onController: (value) => { controller = value; } })(h.pi);
  await h.event("session_start");
  t.after(() => h.event("session_shutdown"));
  const started = Date.now();
  const value = await controller.check(20);
  assert.ok(Date.now() - started < 1000);
  assert.equal(value.servers[0].state, "connecting");
  const waiting = assert.rejects(controller.check(4000), /no longer active/);
  await h.event("session_shutdown"); await waiting;
  assert.equal(transport.closed, true);
});

test("desktop wrapper uses settings root not process cwd; trust and explicit codemode restrictions are preserved", async (t) => {
  const { agent, project, actual } = await isolated(t);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultTools: ["read"] }));
  await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { global: { command: "fixture", enabled: false } } }));
  await writeFile(join(project, ".pi/settings.json"), JSON.stringify({ defaultTools: ["codemode"] }));
  await writeFile(join(project, ".pi/mcp.json"), JSON.stringify({ mcpServers: { project: { command: "fixture", enabled: false } } }));
  await writeFile(join(actual, ".pi-mcp-decoy.json"), "{}");
  const settings = SettingsManager.create(project, agent, { projectTrusted: false });
  const api = await loadMcpCoreConfigApi();
  assert.equal(typeof api.validateMcpServerConfig("test", { command: "fixture" }), "object");
  assert.equal(mcpMayEnableCodemode(settings), false);
  const h = host("desktop-isolated", actual);
  await createDesktopMcpExtension(actual, settings).factory(h.pi);
  await h.event("session_start");
  const old = getDesktopMcpRuntime("desktop-isolated");
  const initial = await old.check(500);
  assert.deepEqual(initial.servers.map((server) => server.name), ["global"]);
  assert.equal(initial.autoEnableCodemode, false);
  initial.servers[0].name = "mutated";
  assert.equal(old.snapshot().servers[0].name, "global");
  settings.setProjectTrusted(true);
  assert.equal(mcpMayEnableCodemode(settings), true);
  await h.event("session_start");
  const newer = getDesktopMcpRuntime("desktop-isolated");
  assert.ok(newer.generation > old.generation);
  await assert.rejects(old.check(1));
  assert.deepEqual((await newer.check(500)).servers.map((server) => server.name), ["global", "project"]);
  await old.dispose();
  assert.equal(getDesktopMcpRuntime("desktop-isolated"), newer);
  h.ctx.sessionManager.getSessionId = () => "desktop-switched";
  await h.event("session_start");
  assert.equal(getDesktopMcpRuntime("desktop-isolated"), undefined);
  assert.ok(getDesktopMcpRuntime("desktop-switched").generation > newer.generation);
  await assert.rejects(newer.check(1));
  await h.event("session_shutdown");
  assert.equal(getDesktopMcpRuntime("desktop-switched"), undefined);
  assert.equal(getDesktopMcpRuntime("desktop-isolated"), undefined);
  await assert.rejects(newer.retry("global"));
});

test("effective codemode policy handles modifiers and untrusted project override", () => {
  const manager = SettingsManager.inMemory({ defaultTools: ["-codemode"] });
  assert.equal(mcpMayEnableCodemode(manager), false);
  for (const [defaultTools, allowed] of [[undefined, true], [["+read"], true], [[], false], [["codemode", "read"], true]]) {
    assert.equal(mcpMayEnableCodemode(SettingsManager.inMemory({ defaultTools })), allowed);
  }
});
