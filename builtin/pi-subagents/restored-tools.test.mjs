import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "pi-restored-owner-"));
const bundleDir = await mkdtemp(new URL("../../.tmp-restored-tools-", import.meta.url));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(dir, "global");
await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
await mkdir(join(dir, ".pi", "agents"), { recursive: true });
await writeFile(join(dir, ".pi", "agents", "fixture.md"), "---\ntools: none\nextensions: false\nskills: false\noutput_transcript: false\n---\nLocal fixture only.");
await build({
  stdin: { contents: 'export {createRestoredSubagentTools} from "./builtin/pi-subagents/src/index.ts"; export * from "./builtin/pi-subagents/src/desktop-host.ts"; export {getDefaultMaxTurns,getGraceTurns,getRememberAgents} from "./builtin/pi-subagents/src/agent-runner.ts"; export {getAgentConfig,isDefaultsDisabled,getFallbackSubagent} from "./builtin/pi-subagents/src/agent-types.ts"; export {isScopeModelsEnabled} from "./builtin/pi-subagents/src/model-scope.ts"; export {isWorktreeIsolationEnabled} from "./builtin/pi-subagents/src/worktree.ts"; export {getOutputTranscriptDefault} from "./builtin/pi-subagents/src/output-file.ts"; export {getMaxSubagentDepth} from "./builtin/pi-subagents/src/nested-tools.ts";', resolveDir: root, loader: "ts" },
  outfile: join(bundleDir, "test.mjs"), bundle: true, platform: "node", format: "esm", external: ["@earendil-works/*"],
  banner: { js: 'import {createRequire} from "node:module"; globalThis.require=createRequire(import.meta.url);' },
});
const api = await import(pathToFileURL(join(bundleDir, "test.mjs")));
test.after(async () => {
  api.configureDesktopHost(undefined);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  await rm(bundleDir, { recursive: true, force: true, maxRetries: 5 });
});
const names = ["Agent", "get_subagent_result", "steer_subagent", "subagent_tasks", "SubagentWorkflow"];
const settingsPath = join(dir, ".pi", "subagents.json");
const policy = extra => ({ tools: [], extensions: true, skills: true, allowedSubagents: "all", depth: 2, maxSubagentDepth: 4, configCwd: dir, ...extra });
const request = () => ({ context: { messages: [], tools: [] } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function session() {
  const listeners = new Set(), entries = [];
  return {
    agent: { prepareRequest: async r => ({ context: r.context }), finishTurn: async () => undefined },
    sessionManager: { appendCustomMessageEntry(...entry) { entries.push(entry); } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    prompt: async () => undefined, steer: async () => "queued", followUp: async () => "queued",
    listeners, entries,
  };
}
async function setup(extra = {}, settings = {}, hostExtra = {}, restoredSession) {
  await writeFile(settingsPath, JSON.stringify(settings));
  const managers = [], registered = [], handlers = new Map(), emitted = [];
  let limit = 6;
  const host = { cwd: dir, get maxConcurrent() { return limit; }, onManager(m) { managers.push(m); }, async shutdownChild() {}, ...hostExtra };
  api.configureDesktopHost(host);
  const pi = { registerTool(tool) { registered.push(tool); }, on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); }, events: { emit(...args) { emitted.push(args); } }, exec() { assert.fail("No shell or provider calls expected"); } };
  const managerKey = Symbol.for("pi-subagents:manager"), originalRegistry = globalThis[managerKey];
  const emit = async name => { for (const handler of [...(handlers.get(name) ?? [])]) await handler({ type: name }); };
  let tools;
  const create = () => { tools = api.createRestoredSubagentTools(pi, policy(extra), "saved-session-id"); };
  if (restoredSession) {
    // Match the adapter's real timing: session_start handlers are snapshotted,
    // and the helper is only created once that callback is already executing.
    pi.on("session_start", () => { create(); tools.install(restoredSession); });
    await emit("session_start");
  } else create();
  assert.equal(globalThis[managerKey], originalRegistry, "Restoration does not publish a global parent manager");
  assert.equal(managers.length, 1);
  assert.deepEqual(registered, [...tools]);
  assert.equal(emitted.length, 0, "No root lifecycle notifications are exposed");
  return { tools, pi, manager: managers[0], emit, registered, setLimit(n) { limit = n; } };
}
const ctx = { cwd: dir, model: undefined, modelRegistry: {}, sessionManager: { getSessionId: () => "saved-session-id" } };
const invoke = (tools, name, params) => tools.find(t => t.name === name).execute("fixture-call", params, undefined, undefined, ctx);
const spawn = extra => ({ subagent_type: "fixture", prompt: "Local task", description: "Local fixture", run_in_background: true, ...extra });
function captureSpawns(manager) {
  const calls = [];
  manager.spawn = (_pi, _ctx, type, prompt, options) => {
    calls.push({ type, prompt, options });
    const id = `fixture-child-${calls.length}`;
    // Insert controlled records into the real manager; no provider is contacted.
    manager.agents.set(id, { id, type, status: "running", runSettled: false, parentAgentId: options.parentAgentId,
      depth: options.depth, abortController: new AbortController(), lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, toolUses: 0, startedAt: Date.now(), compactionCount: 0 });
    return id;
  };
  manager.awaitStartup = async () => undefined;
  return calls;
}

test("restored helper created during session_start immediately maintains even fully filtered owners", async () => {
  for (const disallowedTools of [[], names]) {
    const s = session(), original = s.agent.prepareRequest;
    const f = await setup({ disallowedTools }, {}, {}, s);
    try {
      assert.notEqual(s.agent.prepareRequest, original);
      assert.ok(f.manager.cleanupInterval, "Maintenance must start during the current restore, not a future session_start");
      const timer = f.manager.cleanupInterval;
      f.manager.startMaintenance(); assert.equal(f.manager.cleanupInterval, timer, "Starting twice keeps one maintenance timer");
    } finally { await f.emit("session_shutdown"); }
    assert.equal(f.manager.cleanupInterval, undefined);
    assert.equal(s.agent.prepareRequest, original); assert.equal(s.listeners.size, 0);
    await f.emit("session_shutdown");
    f.manager.startMaintenance(); assert.equal(f.manager.cleanupInterval, undefined, "Disposed manager cannot restart maintenance");
  }
});

test("restored owner keeps historical depth, isolates records and applies exported settings", async () => {
  const f = await setup({}, { defaultMaxTurns: 7, graceTurns: 2, maxConcurrent: 3, maxConcurrentForeground: 2,
    rememberAgents: false, scopeModels: true, worktreeIsolation: false, outputTranscript: false,
    disableDefaultAgents: true, fallbackSubagent: "none", maxSubagentDepth: 1 });
  try {
    assert.deepEqual(f.tools.map(t => t.name), names);
    assert.equal(f.manager.getMaxConcurrent(), 6, "Host wins over saved settings");
    assert.equal(f.manager.getMaxConcurrentForeground(), 2);
    assert.equal(api.getDefaultMaxTurns(), 7); assert.equal(api.getGraceTurns(), 2); assert.equal(api.getRememberAgents(), false);
    assert.equal(api.isScopeModelsEnabled(), true); assert.equal(api.isWorktreeIsolationEnabled(), false);
    assert.equal(api.getOutputTranscriptDefault(), false); assert.equal(api.isDefaultsDisabled(), true);
    assert.equal(api.getFallbackSubagent(), "none"); assert.equal(api.getMaxSubagentDepth(), 1);
    assert.ok(api.getAgentConfig("fixture"), "Restored namespace registry is initialized");
    const calls = captureSpawns(f.manager);
    assert.equal((await invoke(f.tools, "Agent", spawn())).isError, false);
    assert.equal(calls[0].options.parentAgentId, "restored:saved-session-id");
    assert.equal(calls[0].options.depth, 3); assert.equal(calls[0].options.maxSubagentDepth, 4, "Policy cap overrides current settings for this owner");
    assert.equal(calls[0].options.configCwd, dir);
    f.manager.agents.set("former-parent-child", { id: "former-parent-child", parentAgentId: "finished-parent", status: "completed", runSettled: true });
    assert.equal((await invoke(f.tools, "get_subagent_result", { agent_id: "former-parent-child" })).isError, true);
    assert.equal(f.manager.getRecord("restored:saved-session-id"), undefined, "No former parent or synthetic root task was reattached");
    const timer = f.manager.cleanupInterval; assert.ok(timer);
    f.setLimit(9); await f.emit("session_start"); assert.equal(f.manager.getMaxConcurrent(), 9);
    assert.equal(f.manager.cleanupInterval, timer, "Reload/session_start keeps the existing maintenance timer");
  } finally { await f.emit("session_shutdown"); }
  assert.equal(f.manager.getRecord("fixture-child-1"), undefined); assert.equal(f.manager.cleanupInterval, undefined);
});

test("depth cap and allowed false return empty tools with working original install/dispose", async () => {
  for (const extra of [{ depth: 4 }, { allowedSubagents: false }]) {
    const f = await setup(extra);
    const s = session(), original = s.agent.prepareRequest;
    assert.equal(f.tools.length, 0); assert.equal(typeof f.tools.install, "function"); assert.equal(typeof f.tools.dispose, "function");
    const release = f.tools.install(s); assert.equal(release, f.tools.dispose);
    assert.notEqual(s.agent.prepareRequest, original); assert.deepEqual((await s.agent.prepareRequest(request())).context.messages, []);
    await f.emit("session_shutdown"); assert.equal(s.agent.prepareRequest, original); assert.equal(s.listeners.size, 0);
    f.tools.dispose(); assert.throws(() => f.tools.install(s), /closed/);
  }
});

test("allowlist blocks Agent and real workflow without spawning, and disallowed filters only capability", async () => {
  const denied = await setup({ allowedSubagents: ["scout"] }); const calls = captureSpawns(denied.manager);
  try {
    assert.equal((await invoke(denied.tools, "Agent", spawn())).isError, true);
    const result = await invoke(denied.tools, "SubagentWorkflow", { script: "export const meta={name:'restored-fixture',description:'Local'}; return await agent('local',{agentType:'fixture'});" });
    assert.match(result.content[0].text, /not allowed/); assert.equal(calls.length, 0);
  } finally { await denied.emit("session_shutdown"); }
  for (const disallowedTools of [["Agent", "SubagentWorkflow"], names]) {
    const f = await setup({ disallowedTools }); const s = session(), original = s.agent.prepareRequest;
    assert.deepEqual(f.tools.map(t => t.name), names.filter(n => !disallowedTools.includes(n)));
    assert.equal(f.tools.install(s), f.tools.dispose); assert.notEqual(s.agent.prepareRequest, original);
    await f.emit("session_shutdown"); assert.equal(s.agent.prepareRequest, original); assert.equal(s.listeners.size, 0);
  }
});

test("workflow switch removes only workflow; shutdown aborts children and awaits manager cleanup", async () => {
  const started = Promise.withResolvers(), cleanup = Promise.withResolvers();
  const f = await setup({}, { workflowsEnabled: false }, { async shutdownChild(child) { assert.equal(child.fixtureChild, true); started.resolve(); await cleanup.promise; } });
  assert.deepEqual(f.tools.map(t => t.name), names.slice(0, 4));
  const calls = captureSpawns(f.manager), s = session(), original = s.agent.prepareRequest; f.tools.install(s);
  await invoke(f.tools, "Agent", spawn()); assert.equal(calls.length, 1);
  const child = f.manager.getRecord("fixture-child-1"); child.session = { fixtureChild: true };
  await f.emit("session_start");
  let done = false; const shutdown = f.emit("session_shutdown").then(() => { done = true; });
  await started.promise; await tick();
  assert.equal(done, false, "session_shutdown awaits child shutdown, not fire-and-forget");
  assert.equal(child.abortController.signal.aborted, true); assert.equal(s.agent.prepareRequest, original); assert.equal(s.listeners.size, 0);
  assert.equal(f.manager.getRecord(child.id), undefined); assert.equal(f.manager.cleanupInterval, undefined);
  cleanup.resolve(); await shutdown; await f.emit("session_shutdown"); assert.equal(done, true);
});

test("missing owner id is refused before creating a manager", () => {
  let created = 0; api.configureDesktopHost({ cwd: dir, onManager() { created++; } });
  for (const id of [undefined, "", "  "]) assert.throws(() => api.createRestoredSubagentTools({}, policy(), id), /session id/);
  assert.equal(created, 0);
});
