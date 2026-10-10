import { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildSubagentFactory } from "./build-subagent-factory.mjs";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme();
const dir = await mkdtemp(new URL("../.tmp-subagent-factory-", import.meta.url));
const src = fileURLToPath(new URL("../builtin/pi-subagents/src/", import.meta.url));
const entryPoint = join(dir, "fixture.ts");
await writeFile(entryPoint, [
  `export { default } from ${JSON.stringify(join(src, "index.ts"))};`,
  ...["index", "desktop-host", "agent-types", "agent-runner", "agent-manager", "settings"].map(name =>
    `export * from ${JSON.stringify(join(src, `${name}.ts`))};`),
  'export const fixtureUrl = import.meta.url;',
].join("\n"));
const outfile = join(dir, "pi-subagents.mjs");
const built = await buildSubagentFactory({ entryPoint, outfile });
const url = pathToFileURL(outfile).href;
const namespace = await import(url);
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
await mkdir(process.env.PI_CODING_AGENT_DIR);
test.after(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

let nextRoot = 0;
function api() {
  const sessionId = `factory-root-${++nextRoot}`;
  const handlers = new Map();
  const listeners = new Map();
  const tools = [];
  const messages = [];
  const pi = new Proxy({
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    events: {
      on(name, handler) {
        const list = listeners.get(name) ?? new Set(); list.add(handler); listeners.set(name, list);
        return () => { list.delete(handler); if (!list.size) listeners.delete(name); };
      },
      emit(name, data) { for (const handler of listeners.get(name) ?? []) handler(data); },
    },
    registerTool(tool) { tools.push(tool); },
    getAllTools() { return tools; },
    getFlag() {},
    sendMessage(message) { messages.push(message); },
  }, { get(target, key) { return target[key] ?? (() => {}); } });
  const model = { provider: "哈尔", id: "gpt-6.1-sol", name: "Fixture" };
  const ctx = { cwd: dir, hasUI: false, model, modelRegistry: { getAvailable: () => [model], getAll: () => [model], find: () => model }, ui: { notify() {}, setWidget() {}, setStatus() {} }, sessionManager: { getSessionId: () => sessionId, getEntries: () => [], getBranch: () => [] } };
  return { pi, ctx, handlers, listeners, tools, messages, async emit(name) { for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx); } };
}
function activate(native, runtime) {
  let manager;
  native.configureDesktopHost({ cwd: dir, onManager(value) { manager = value; }, bindChild: async () => {}, shutdownChild: async () => {} });
  native.default(runtime.pi);
  return manager;
}

test("real complete graph factory shares one namespace but isolates host, registry and configuration", async () => {
  assert.equal(await import(url), namespace);
  assert.ok(built.sdkExternals.includes("@earendil-works/pi-coding-agent"));
  const source = await readFile(outfile, "utf8");
  assert.doesNotMatch(source, /globalThis\.require|\?activation=|new Function/);
  assert.match(source, /export function createSubagentModule/);
  const a = namespace.createSubagentModule();
  const b = namespace.createSubagentModule();
  assert.equal(a.fixtureUrl, url, "import.meta.url survives the CJS compiler");
  assert.notEqual(a.AgentManager, b.AgentManager);
  a.configureDesktopHost({ cwd: "A" }); b.configureDesktopHost({ cwd: "B" });
  assert.equal(a.desktopCwd(), "A"); assert.equal(b.desktopCwd(), "B");
  a.setDefaultsDisabled(true);
  a.registerAgents(new Map([["only-a", { description: "A", systemPrompt: "A" }]]));
  b.registerAgents(new Map([["only-b", { description: "B", systemPrompt: "B" }]]));
  assert.ok(a.getAllTypes().includes("only-a")); assert.ok(!b.getAllTypes().includes("only-a"));
  assert.ok(!a.getAllTypes().includes("only-b")); assert.ok(b.getAllTypes().includes("only-b"));
  a.setDefaultMaxTurns(7); b.setDefaultMaxTurns(19);
  assert.equal(a.getDefaultMaxTurns(), 7); assert.equal(b.getDefaultMaxTurns(), 19);
  a.configureDesktopHost(undefined);
  assert.equal(b.desktopCwd(), "B");
  b.configureDesktopHost(undefined);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Use the compiled factory's real spawn/launch/drain/dequeue/settle paths;
// only startup and model execution are controlled, so no model is called.
function controlledQueueManager() {
  const native = namespace.createSubagentModule();
  const manager = new native.AgentManager(undefined, 1);
  const runtime = api();
  let startup, completion;
  let starts = 0;
  manager.startAgent = async (id, record, { options }) => {
    starts++;
    record.status = "running";
    record.startGate = undefined;
    manager.runningBackground++;
    try { await startup.promise; }
    catch (error) { manager.runningBackground--; throw error; }
    if (record.status === "stopped") {
      manager.runningBackground--;
      manager.drainQueue();
      return;
    }
    const detach = options.signal
      ? manager.trackParentAbort(options.signal, () => manager.abort(id))
      : () => {};
    record.promise = completion.promise.then(() => {
      detach();
      record.status = "completed";
      record.completedAt = Date.now();
      manager.settleRun(record, true, "background");
    });
  };
  return {
    manager,
    get starts() { return starts; },
    queue(signal) {
      startup = deferred(); completion = deferred();
      manager.runningBackground = 1; // Occupy the only slot before real spawn.
      const id = manager.spawn(runtime.pi, runtime.ctx, "work", "fixture", { isBackground: true, signal });
      const record = manager.agents.get(id);
      return { id, record, gate: record.startGate, startup, completion };
    },
    drain() { manager.runningBackground = 0; manager.drainQueue(); },
  };
}
function assertParentSubscriptions(manager, signal, count, message) {
  assert.equal(getEventListeners(signal, "abort").length, count, message);
  assert.equal(manager.parentSignalReleases.size, count, message);
}

test("compiled manager releases queued subscriptions after repeated startup and normal completion", async () => {
  const fixture = controlledQueueManager();
  const caller = new AbortController();
  for (let i = 0; i < 12; i++) {
    const queued = fixture.queue(caller.signal);
    assert.equal(queued.record.status, "queued");
    assertParentSubscriptions(fixture.manager, caller.signal, 1);
    fixture.drain();
    assert.equal(queued.record.status, "running");
    assertParentSubscriptions(fixture.manager, caller.signal, 1, "queued abort protects awaited startup");
    queued.startup.resolve();
    await queued.gate;
    assertParentSubscriptions(fixture.manager, caller.signal, 1); // Only running subscription remains.
    queued.completion.resolve();
    await queued.record.promise;
    assert.equal(queued.record.status, "completed");
    assertParentSubscriptions(fixture.manager, caller.signal, 0);
    assert.equal(fixture.manager.queue.length, 0);
    assert.equal(fixture.manager.startups.size, 0);
    assert.equal(fixture.manager.runningBackground, 0);
    assert.equal(caller.signal.aborted, false);
    assert.equal(fixture.manager.disposed, false);
  }
  assert.equal(fixture.starts, 12);
});

test("compiled manager releases queued subscriptions on abort, dequeue, stale entry and failed startup", async (t) => {
  for (const scenario of ["queued abort", "dequeue", "stale status", "missing record", "startup rejection", "abort during startup", "already aborted", "no signal"]) {
    await t.test(scenario, async () => {
      const fixture = controlledQueueManager();
      const caller = new AbortController();
      if (scenario === "already aborted") caller.abort();
      const queued = fixture.queue(scenario === "no signal" ? undefined : caller.signal);
      if (scenario === "already aborted") {
        assert.equal(queued.record.status, "stopped");
        assert.equal(queued.gate, undefined);
      } else {
        assertParentSubscriptions(fixture.manager, caller.signal, scenario === "no signal" ? 0 : 1);
        if (scenario === "queued abort") caller.abort();
        else if (scenario === "dequeue") fixture.manager.dequeue(entry => entry.id === queued.id);
        else {
          if (scenario === "stale status") queued.record.status = "stopped";
          if (scenario === "missing record") fixture.manager.agents.delete(queued.id);
          fixture.drain();
          if (scenario === "startup rejection") queued.startup.reject(new Error("STARTUP_FAILED"));
          if (scenario === "abort during startup") {
            assertParentSubscriptions(fixture.manager, caller.signal, 1);
            caller.abort();
            assert.equal(queued.record.status, "stopped");
            assert.equal(queued.record.abortController.signal.aborted, true);
            queued.startup.resolve();
          }
          if (scenario === "no signal") queued.startup.resolve();
        }
        await queued.gate;
        if (scenario === "startup rejection") {
          assert.equal(queued.record.status, "error");
          assert.equal(queued.record.error, "STARTUP_FAILED");
        }
        if (scenario === "no signal") {
          queued.completion.resolve();
          await queued.record.promise;
        }
      }
      assertParentSubscriptions(fixture.manager, caller.signal, 0);
      assert.equal(fixture.manager.queue.length, 0);
      assert.equal(fixture.manager.startups.size, 0);
      assert.equal(fixture.manager.disposed, false);
      if (["queued abort", "dequeue", "stale status", "missing record", "already aborted"].includes(scenario)) assert.equal(fixture.starts, 0);
      if (!["queued abort", "abort during startup", "already aborted"].includes(scenario)) assert.equal(caller.signal.aborted, false);
    });
  }
});

test("activation maintenance, RPC listeners, manager records and callbacks release on repeated shutdown", async (t) => {
  for (let i = 0; i < 12; i++) {
    const native = namespace.createSubagentModule();
    const runtime = api();
    const manager = activate(native, runtime);
    const caller = new AbortController();
    manager.trackParentAbort(caller.signal, () => {});
    assert.equal(getEventListeners(caller.signal, "abort").length, 1);
    assert.equal(manager.cleanupInterval, undefined, "filtered factories arm no timers");
    await runtime.emit("session_start");
    assert.ok(manager.cleanupInterval);
    assert.ok(runtime.listeners.size > 0);
    assert.equal(native.hasActiveWork(), false);
    manager.agents.set("history", { id: "history", status: "completed", resultConsumed: true });
    assert.equal(native.hasActiveWork(), false, "completed history is not background activity");
    await runtime.emit("session_shutdown");
    await runtime.emit("session_shutdown");
    assert.equal(runtime.listeners.size, 0);
    assert.equal(manager.cleanupInterval, undefined);
    assert.equal(manager.agents.size, 0);
    assert.equal(manager.tombstones.size, 0);
    assert.equal(manager.startups.size, 0);
    assert.equal(manager.worktreeRepos.size, 0);
    assert.equal(manager.onComplete, undefined);
    assert.equal(manager.onStart, undefined);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    assert.equal(manager.parentSignalReleases.size, 0);
    assert.equal(native.hasActiveWork(), false);
    await runtime.emit("session_start");
    assert.equal(manager.cleanupInterval, undefined, "late start cannot revive a disposed activation");
    assert.throws(() => manager.spawn(null, null, "work", "late", {}), /disposed/);
    native.configureDesktopHost(undefined);
  }
  t.diagnostic(JSON.stringify({ factoryActivations: 12, afterShutdown: { listeners: 0, maintenanceTimers: 0, records: 0, tombstones: 0, startups: 0, parentSignalSubscriptions: 0, callbacks: 0 } }));
});

test("scheduler activity ignores disabled/invalid/history jobs and includes armed jobs", async () => {
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, "subagents.json"), JSON.stringify({ schedulingEnabled: true }));
  const native = namespace.createSubagentModule(); const runtime = api();
  const idle = namespace.createSubagentModule(); const idleRuntime = api();
  activate(idle, idleRuntime);
  await idleRuntime.emit("session_start");
  activate(native, runtime);
  await runtime.emit("session_start");
  assert.equal(native.hasActiveWork(), false, "empty scheduler is idle");
  const tool = runtime.tools.find(tool => tool.name === "Agent");
  const past = await tool.execute("past", { subagent_type: "work", prompt: "past", description: "past", schedule: "2020-01-01T00:00:00Z" }, undefined, undefined, runtime.ctx);
  assert.match(past.content[0].text, /scheduled/i);
  assert.equal(native.hasActiveWork(), false, "expired disabled one-shot is not work");
  const invalid = await tool.execute("invalid", { subagent_type: "work", prompt: "invalid", description: "invalid", schedule: "invalid-cron" }, undefined, undefined, runtime.ctx);
  assert.equal(native.hasActiveWork(), false, "invalid schedule is not work");
  assert.ok(invalid.content[0].text);
  const result = await tool.execute("schedule", { subagent_type: "work", prompt: "future", description: "future", name: "future", schedule: "+1h" }, undefined, undefined, runtime.ctx);
  assert.match(result.content[0].text, /scheduled|schedule/i);
  assert.equal(native.hasActiveWork(), true);
  assert.equal(idle.hasActiveWork(), false, "other root's scheduled job cannot keep this root alive");
  await runtime.emit("session_shutdown");
  assert.equal(idle.hasActiveWork(), false);
  await idleRuntime.emit("session_shutdown");
  idle.configureDesktopHost(undefined);
  assert.equal(native.hasActiveWork(), false);
  native.configureDesktopHost(undefined);
  await rm(join(process.env.PI_CODING_AGENT_DIR, "subagents.json"));
});

test("workflow workers and held notifications are activity, completed workflow history is idle", async () => {
  const native = namespace.createSubagentModule(); const runtime = api();
  const manager = activate(native, runtime);
  await runtime.emit("session_start");
  const tool = runtime.tools.find(tool => tool.name === "SubagentWorkflow");
  assert.ok(tool);
  const quick = 'export const meta = { name: "quick", description: "quick" }; return "done";';
  await tool.execute("quick", { script: quick }, undefined, undefined, runtime.ctx);
  assert.equal(manager.hasRunning(), false);
  assert.equal(native.hasActiveWork(), true, "worker-only workflow must protect the host session");
  // Poll the worker settling, not RSS or Node's private ESM cache.
  const deadline = Date.now() + 5000;
  while (!runtime.messages.length && Date.now() < deadline) {
    assert.equal(native.hasActiveWork(), true, "notification remains active until delivered");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(runtime.messages.length, 1);
  assert.equal(native.hasActiveWork(), false, "historical workflow is not activity");
  const held = 'export const meta = { name: "held", description: "held" }; await new Promise(() => {});';
  await tool.execute("held", { script: held }, undefined, undefined, runtime.ctx);
  assert.equal(native.hasActiveWork(), true);
  await runtime.emit("session_shutdown");
  assert.equal(native.hasActiveWork(), false);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(runtime.messages.length, 1, "late completion cannot enqueue a post-shutdown nudge");
  assert.equal(runtime.listeners.size, 0);
  native.configureDesktopHost(undefined);
});

test("31 create/discard operations reuse a stable namespace: GC heap diagnostic, not RSS assertion", async (t) => {
  const probe = join(dir, "memory-probe.mjs");
  await writeFile(probe, [
    `import { createSubagentModule } from ${JSON.stringify(url)};`,
    'const samples = [];',
    'for (let iteration = 1; iteration <= 31; iteration++) {',
    '  createSubagentModule();',
    '  if ([1, 11, 21, 31].includes(iteration)) {',
    '    await new Promise(resolve => setImmediate(resolve));',
    '    for (let i = 0; i < 3; i++) globalThis.gc();',
    '    samples.push({ iteration, heapMB: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)) });',
    '  }',
    '}',
    'console.log(JSON.stringify({ factoryCalls: 31, esmUrls: 1, samples }));',
  ].join("\n"));
  const result = JSON.parse(execFileSync(process.execPath, ["--expose-gc", probe], { encoding: "utf8", timeout: 30000 }));
  assert.equal(result.factoryCalls, 31);
  assert.equal(result.samples.length, 4);
  t.diagnostic(JSON.stringify(result));
});

test("manager shutdown propagates real failures while clearing every instance reference", async () => {
  const native = namespace.createSubagentModule();
  native.configureDesktopHost({ cwd: dir, async shutdownChild() { throw new Error("CHILD_SHUTDOWN_FAILED"); } });
  const manager = new native.AgentManager();
  manager.startMaintenance();
  manager.agents.set("child", { id: "child", status: "completed", session: {} });
  manager.tombstones.set("old", {});
  const pending = manager.dispose();
  assert.equal(manager.dispose(), pending);
  await assert.rejects(pending, error => error instanceof AggregateError && error.errors.some(error => /CHILD_SHUTDOWN_FAILED/.test(error.message)));
  assert.equal(manager.agents.size, 0);
  assert.equal(manager.tombstones.size, 0);
  assert.equal(manager.cleanupInterval, undefined);
  native.configureDesktopHost(undefined);
});
