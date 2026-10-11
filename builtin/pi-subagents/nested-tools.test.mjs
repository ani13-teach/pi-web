import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, initTheme } from "@earendil-works/pi-coding-agent";

const dir = await mkdtemp(join(tmpdir(), "pi-nested-owner-"));
const bundleDir = await mkdtemp(new URL("../../.tmp-nested-tools-", import.meta.url));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(dir, "global");
await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
await mkdir(join(dir, ".pi", "agents"), { recursive: true });
await writeFile(join(dir, ".pi", "agents", "fixture.md"), "---\ntools: none\nextensions: false\nskills: false\noutput_transcript: false\n---\nLocal fixture only.");
await build({
  stdin: { contents: 'export * from "./builtin/pi-subagents/src/nested-tools.ts"; export * from "./builtin/pi-subagents/src/custom-agents.ts"; export * from "./builtin/pi-subagents/src/agent-file-toggle.ts"; export * from "./builtin/pi-subagents/src/desktop-agent-presets.ts"; export * from "./builtin/pi-subagents/src/workflow/host.ts"; export {AgentManager} from "./builtin/pi-subagents/src/agent-manager.ts"; export {createPiAutomode} from "./builtin/automode/extensions/auto-mode/extension.ts"; export {buildEffectiveConfigFromSources} from "./builtin/automode/extensions/auto-mode/config.ts";', resolveDir: process.cwd(), loader: "ts" },
  outfile: join(bundleDir, "test.mjs"), bundle: true, platform: "node", format: "esm", external: ["@earendil-works/*"],
  banner: { js: 'import {createRequire} from "node:module"; globalThis.require=createRequire(import.meta.url);' },
});
const { createNestedSubagentTools, executeNestedWorkflowGate, loadCustomAgents, serializeAgentFile, DESKTOP_AGENT_PRESETS, createWorkflowHost, AgentManager, createPiAutomode, buildEffectiveConfigFromSources } = await import(pathToFileURL(join(bundleDir, "test.mjs")));
initTheme();
test.after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  await rm(bundleDir, { recursive: true, force: true, maxRetries: 5 });
});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function bounded(promise, label = "fixture") {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 6000); })]); }
  finally { clearTimeout(timer); }
}
const usage = () => ({ input: 0, output: 0, cacheWrite: 0 });
function manager() {
  const records = new Map(); const calls = []; let counter = 0;
  records.set("owner", { id: "owner", lifetimeUsage: usage() });
  return {
    records, calls, autoComplete: false,
    getRecord(id) { return records.get(id); },
    spawn(pi, ctx, type, prompt, options) {
      calls.push({ pi, ctx, type, prompt, options });
      const id = `child-${++counter}`; const gate = Promise.withResolvers();
      const record = { id, type, description: options.description, status: "running", runSettled: false, lifetimeUsage: usage(),
        toolUses: 0, startedAt: Date.now(), compactionCount: 0, parentAgentId: options.parentAgentId,
        workflowId: options.workflowId, depth: options.depth, maxSubagentDepth: options.maxSubagentDepth, promise: gate.promise, gate,
        resultFormat: options.structuredOutput ? "structured" : "text", abortController: new AbortController() };
      records.set(id, record);
      options.signal?.addEventListener("abort", () => this.abort(id), { once: true });
      if (this.autoComplete) queueMicrotask(() => this.complete(id));
      return id;
    },
    async awaitStartup() {},
    async spawnAndWait(pi, ctx, type, prompt, options, onSpawned) {
      const id = this.spawn(pi, ctx, type, prompt, options); onSpawned?.(id);
      await records.get(id).promise; return { id, record: records.get(id) };
    },
    complete(id, text = "LOCAL_RESULT") { const r = records.get(id); r.status = "completed"; r.result = text; r.runSettled = true; r.gate.resolve(text); },
    abort(id) { const r = records.get(id); r.status = "stopped"; r.runSettled = true; r.abortController.abort(); r.gate.resolve(""); },
    async resume(id) { const r = records.get(id); r.result = "RESUMED"; r.status = "completed"; return r; },
  };
}
const ctx = { cwd: dir, model: undefined, modelRegistry: {}, sessionManager: { getSessionId: () => "local-owner" }, ui: { notify() {} } };
const pi = { exec: async () => { throw new Error("Unprotected shell must not run"); } };
function tools(m, extra = {}) { return createNestedSubagentTools({ manager: m, pi, parentAgentId: "owner", depth: 1, maxSubagentDepth: 3, configCwd: dir, allowedSubagents: "all", ...extra }); }
function invoke(ts, name, params, signal, context = ctx) { return ts.find(t => t.name === name).execute("local-call", params, signal, undefined, context); }
const spawn = extra => ({ subagent_type: "fixture", prompt: "Local task", description: "Local delegated work", ...extra });
function mockSession() {
  const entries = [], listeners = new Set();
  const originalRequest = async request => ({ context: { ...request.context, messages: [...request.context.messages, ...entries] } });
  return { entries, listeners,
    agent: { prepareRequest: originalRequest, finishTurn: async () => undefined },
    sessionManager: { appendCustomMessageEntry(customType, content, display, details) { entries.push({ role: "custom", customType, content, display, details, timestamp: Date.now() }); } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    prompt: async (_text, options) => options?.preflightResult?.("queued"), steer: async () => "queued", followUp: async () => "queued",
    emit(event) { for (const listener of listeners) listener(event); },
  };
}
const request = () => ({ context: { messages: [], tools: [] } });

test("omitted delegation inherits; false/none/empty preserve explicit opt-out on serialization", async () => {
  for (const [field, expected] of [["", undefined], ["allowed_subagents: false", false], ["allowed_subagents: none", false], ['allowed_subagents: "false"', false], ['allowed_subagents: ""', false], ["allowed_subagents: all", "all"], ["allowed_subagents: fixture, scout", ["fixture", "scout"]]]) {
    await writeFile(join(dir, ".pi", "agents", "config-case.md"), `---\n${field}\n---\nCase`);
    const config = loadCustomAgents(dir).get("config-case"); assert.deepEqual(config.allowedSubagents, expected);
    const serialized = serializeAgentFile(config);
    if (expected === false) assert.match(serialized, /allowed_subagents: false/);
    if (expected === undefined) assert.doesNotMatch(serialized, /allowed_subagents:/);
  }
  const presets = DESKTOP_AGENT_PRESETS;
  assert.ok(presets.every(p => p.extensions === true && p.skills === true));
  assert.deepEqual(new Set(presets.find(p => p.name === "work").builtinToolNames), new Set(["read", "bash", "edit", "write", "grep", "find", "ls", ...(process.platform === "win32" ? ["powershell"] : [])]));
  for (const p of presets.filter(p => p.name !== "work")) assert.deepEqual(p.builtinToolNames, ["read", "grep", "find", "ls", "bash"]);
});

test("five real owner tools; policy false, depth cap and workflow switch remove capability", () => {
  const m = manager();
  assert.deepEqual(tools(m).map(t => t.name), ["Agent", "get_subagent_result", "steer_subagent", "subagent_tasks", "SubagentWorkflow"]);
  assert.equal(tools(m, { allowedSubagents: false }).length, 0);
  assert.equal(tools(m, { depth: 3 }).length, 0);
  assert.equal(tools(m, { workflowsEnabled: false }).some(t => t.name === "SubagentWorkflow"), false);
});

test("startup failure settles the detached registration and wakes an already waiting request", async () => {
  const m = manager(), ts = tools(m), s = mockSession(); ts.install(s);
  const startup = Promise.withResolvers(); let failedRecord, cleaned = 0;
  m.awaitStartup = async id => {
    failedRecord = m.getRecord(id);
    failedRecord.promise = undefined;
    failedRecord.outputCleanup = () => { cleaned++; throw new Error("Best-effort stream cleanup"); };
    await startup.promise;
    m.records.delete(id);
    throw new Error("FIXTURE_WORKTREE_STARTUP_FAILED");
  };
  try {
    const call = invoke(ts, "Agent", spawn()); await tick();
    assert.equal(failedRecord.assignment.delivery, "pending");
    let advanced = false;
    const waiting = s.agent.prepareRequest(request()).then(() => { advanced = true; });
    await tick(); assert.equal(advanced, false);
    startup.resolve();
    const result = await bounded(call); assert.equal(result.isError, true); assert.match(result.content[0].text, /FIXTURE_WORKTREE_STARTUP_FAILED/);
    await bounded(waiting, "request after detached startup failure");
    assert.equal(failedRecord.status, "error"); assert.equal(failedRecord.runSettled, true);
    assert.equal(failedRecord.error, "FIXTURE_WORKTREE_STARTUP_FAILED"); assert.ok(failedRecord.completedAt);
    assert.equal(failedRecord.assignment.delivery, "consumed"); assert.equal(failedRecord.resultConsumed, true);
    assert.equal(failedRecord.outputCleanup, undefined); assert.equal(cleaned, 1);
    assert.equal(s.entries.length, 0, "The startup error already returned by Agent is not delivered twice");
    assert.equal((await invoke(ts, "subagent_tasks", { action: "finish" })).isError, false);
  } finally { startup.resolve(); ts.dispose(); }
  assert.equal(cleaned, 1);
});

test("a synchronous spawn error leaves no task for the next request to wait on", async () => {
  const m = manager(), ts = tools(m), s = mockSession(); ts.install(s);
  m.spawn = () => { throw new Error("FIXTURE_SYNC_STARTUP_FAILED"); };
  try {
    const result = await invoke(ts, "Agent", spawn()); assert.equal(result.isError, true); assert.match(result.content[0].text, /FIXTURE_SYNC_STARTUP_FAILED/);
    await bounded(s.agent.prepareRequest(request())); assert.equal(s.entries.length, 0);
  } finally { ts.dispose(); }
});

test("a tool error must not consume or detach a child that is genuinely still running", async () => {
  const m = manager(), ts = tools(m), s = mockSession(); ts.install(s); let cleaned = 0;
  m.awaitStartup = async id => {
    m.getRecord(id).outputCleanup = () => { cleaned++; };
    throw new Error("FIXTURE_WIRING_ERROR_WITH_LIVE_CHILD");
  };
  try {
    assert.equal((await invoke(ts, "Agent", spawn())).isError, true);
    const child = m.getRecord("child-1");
    assert.equal(child.status, "running"); assert.equal(child.runSettled, false);
    assert.equal(child.assignment.delivery, "pending"); assert.equal(child.resultConsumed, false); assert.equal(cleaned, 0);
    let advanced = false; const waiting = s.agent.prepareRequest(request()).then(() => { advanced = true; });
    await tick(); assert.equal(advanced, false);
    m.complete(child.id, "REAL_CHILD_RESULT"); await bounded(waiting);
    assert.equal(child.assignment.delivery, "consumed"); assert.match(s.entries[0].content, /REAL_CHILD_RESULT/);
    assert.equal((await invoke(ts, "Agent", spawn())).isError, true);
    const liveChild = m.getRecord("child-2"); ts.dispose();
    assert.equal(liveChild.abortController.signal.aborted, true, "The live child remains owned for owner disposal");
    assert.equal(liveChild.status, "stopped"); assert.equal(cleaned, 0);
  } finally { ts.dispose(); }
});

test("background joins at the owner request gate; sibling task state and records are inaccessible", async () => {
  const m = manager(), ts = tools(m), session = mockSession(); ts.install(session);
  const sibling = tools(m, { parentAgentId: "sibling" }); const other = mockSession(); sibling.install(other);
  await invoke(ts, "Agent", spawn({ task_key: "owned", scope: ["local-file"], input_version: "local-v1" }));
  const record = m.getRecord("child-1"); assert.equal(record.assignment.required, true); assert.equal(m.calls[0].options.depth, 2);
  assert.equal(m.calls[0].options.parentAgentId, "owner"); assert.equal(m.calls[0].options.maxSubagentDepth, 3);
  assert.ok(m.calls[0].options.structuredOutput);
  let advanced = false; const wait = session.agent.prepareRequest(request()).then(() => { advanced = true; });
  await tick(); assert.equal(advanced, false); assert.equal((await other.agent.prepareRequest(request())).context.messages.length, 0);
  for (const [name, params] of [["get_subagent_result", { agent_id: "child-1" }], ["steer_subagent", { agent_id: "child-1", message: "forged" }], ["Agent", spawn({ resume: "child-1" })]]) assert.equal((await invoke(sibling, name, params)).isError, true);
  m.complete("child-1"); await bounded(wait);
  assert.equal(session.entries.filter(e => e.customType === "subagent-notification").length, 1);
  assert.equal(record.assignment.delivery, "consumed"); ts.dispose(); sibling.dispose();
});

test("independent authorizes one batch and terminal response forces real join", async () => {
  const m = manager(), ts = tools(m), s = mockSession(); ts.install(s);
  await invoke(ts, "Agent", spawn({ independent_work: ["Independent local observation"] }));
  await s.agent.prepareRequest(request());
  assert.deepEqual(await s.agent.finishTurn({ message: { content: [{ type: "text", text: "premature answer" }] } }), { action: "continue" });
  assert.equal((await invoke(ts, "subagent_tasks", { action: "finish" })).isError, true);
  let advanced = false; const wait = s.agent.prepareRequest(request()).then(() => { advanced = true; }); await tick(); assert.equal(advanced, false);
  m.complete("child-1"); await bounded(wait);
  assert.equal((await invoke(ts, "subagent_tasks", { action: "finish" })).isError, false); ts.dispose();
});

test("optional late work never restarts a settled owner; abort cancels wait only; disposal restores hooks", async () => {
  const m = manager(), ts = tools(m), s = mockSession(); const before = s.agent.prepareRequest; ts.install(s);
  await invoke(ts, "Agent", spawn({ required: false })); await s.agent.prepareRequest(request());
  assert.equal(await s.agent.finishTurn({ message: { content: [] } }), undefined);
  s.emit({ type: "agent_settled" }); m.complete("child-1"); await s.agent.prepareRequest(request()); assert.equal(s.entries.length, 0);
  await invoke(ts, "Agent", spawn()); const abort = new AbortController(); const wait = s.agent.prepareRequest(request(), abort.signal);
  abort.abort(new Error("Local cancellation")); await assert.rejects(wait, /Local cancellation/);
  assert.equal(m.getRecord("child-2").abortController.signal.aborted, false);
  const waiting = s.agent.prepareRequest(request()); ts.dispose(); await assert.rejects(waiting, /closed|disposed/i);
  assert.equal(s.agent.prepareRequest, before); assert.equal(s.listeners.size, 0);
});

test("explicit foreground structured contract, result views, resume format and metadata validation", async () => {
  const m = manager(); m.autoComplete = true; const ts = tools(m);
  const result = await invoke(ts, "Agent", spawn({ result_format: "structured" })); assert.equal(result.isError, false);
  assert.ok(m.calls[0].options.structuredOutput); assert.equal(m.getRecord("child-1").assignment.delivery, "consumed");
  assert.equal((await invoke(ts, "Agent", spawn({ resume: "child-1", result_format: "text" }))).isError, true);
  assert.match((await invoke(ts, "get_subagent_result", { agent_id: "child-1", view: "full" })).content[0].text, /LOCAL_RESULT/);
  assert.equal((await invoke(ts, "Agent", spawn({ task_key: "x".repeat(161) }))).isError, true);
  assert.equal((await invoke(tools(m, { allowedSubagents: ["scout"] }), "Agent", spawn())).isError, true);
  ts.dispose();
});

test("workflow uses actual runtime and same manager; depth/allowlist/unsafe gates remain enforced", async () => {
  const m = manager(); m.autoComplete = true; const ts = tools(m);
  const script = "export const meta={name:'local-flow',description:'Local workflow'}; const result=await agent('local',{agentType:'fixture'}); return result;";
  const result = await bounded(invoke(ts, "SubagentWorkflow", { script })); assert.equal(result.isError, false); assert.match(result.content[0].text, /LOCAL_RESULT/);
  assert.equal(m.calls.length, 1); assert.equal(m.calls[0].options.parentAgentId, "owner"); assert.equal(m.calls[0].options.depth, 2); assert.ok(m.calls[0].options.workflowId.startsWith("wf_"));
  const forbidden = tools(m, { allowedSubagents: ["scout"] });
  const refused = await bounded(invoke(forbidden, "SubagentWorkflow", { script })); assert.equal(m.calls.length, 1); assert.match(refused.content[0].text, /not allowed/);
  const noGate = await bounded(invoke(ts, "SubagentWorkflow", { script: script.replace("agentType:'fixture'", "agentType:'fixture',gate:'unsafe-command'") })); assert.equal(m.calls.length, 2); assert.match(noGate.content[0].text, /no guarded executeTool/);
  const host = createWorkflowHost({ pi, ctx, manager: m, nested: { parentAgentId: "owner", depth: 3, maxSubagentDepth: 3, allowedSubagents: "all", configCwd: dir } });
  assert.equal((await host.spawnAgent({ agentId: "x", agentType: "fixture", prompt: "x", label: "x", index: 0 })).ok, false);
  ts.dispose(); forbidden.dispose();
});

test("workflow owner background joins; cross-owner resume is rejected and disposal stops worker children", async () => {
  const m = manager(), ts = tools(m), s = mockSession(); ts.install(s);
  const script = "export const meta={name:'blocked-flow',description:'Local workflow'}; return await agent('local',{agentType:'fixture'});";
  const result = await invoke(ts, "SubagentWorkflow", { script }); const id = result.content[0].text.match(/Agent ID: (wf_[a-z0-9-]+)/)[1];
  for (let i = 0; i < 100 && !m.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(m.calls.length, 1);
  const sibling = tools(m, { parentAgentId: "sibling" });
  assert.equal((await invoke(sibling, "SubagentWorkflow", { resumeFromRunId: id })).isError, true);
  let advanced = false; const wait = s.agent.prepareRequest(request()).then(() => { advanced = true; }); await tick(); assert.equal(advanced, false);
  ts.dispose(); await assert.rejects(wait, /closed|disposed/i);
  for (let i = 0; i < 100 && m.getRecord("child-1").status !== "stopped"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(m.getRecord("child-1").status, "stopped"); sibling.dispose();
});

test("safe gate callback, saved script resolution and replay use real runtime without a root shell escape", async () => {
  const m = manager(); m.autoComplete = true; const checked = [];
  const ts = tools(m, { executeWorkflowGate: async (command, cwd) => { checked.push({ command, cwd }); return { ok: true, output: "LOCAL_GATE_PASSED" }; } });
  const s = mockSession(); ts.install(s);
  const script = "export const meta={name:'saved-fixture',description:'Local saved workflow'}; return await agent('local',{agentType:'fixture',gate:'local-check'});";
  await mkdir(join(dir, ".pi", "workflows"), { recursive: true }); await writeFile(join(dir, ".pi", "workflows", "saved-fixture.js"), script);
  const started = await invoke(ts, "SubagentWorkflow", { name: "saved-fixture" });
  const id = started.content[0].text.match(/Agent ID: (wf_[a-z0-9-]+)/)[1];
  const result = await bounded(invoke(ts, "get_subagent_result", { agent_id: id, wait: true }));
  assert.match(result.content[0].text, /LOCAL_RESULT/); assert.equal(checked.length, 1); assert.equal(checked[0].command, "local-check"); assert.equal(checked[0].cwd, dir);
  const replay = await invoke(ts, "SubagentWorkflow", { resumeFromRunId: id });
  const replayId = replay.content[0].text.match(/Agent ID: (wf_[a-z0-9-]+)/)[1];
  await bounded(invoke(ts, "get_subagent_result", { agent_id: replayId, wait: true }));
  assert.equal(m.calls.length, 1); assert.equal(checked.length, 1); ts.dispose();
});

test("settlement wait and same-owner steering preserve cleanup boundaries", async () => {
  const m = manager(), ts = tools(m); await invoke(ts, "Agent", spawn({ run_in_background: true }));
  const r = m.getRecord("child-1");
  assert.match((await invoke(ts, "steer_subagent", { agent_id: r.id, message: "Local guidance" })).content[0].text, /queued/);
  assert.deepEqual(r.pendingSteers, ["Local guidance"]);
  r.status = "completed"; r.result = "PROVISIONAL";
  let adopted = false; const wait = invoke(ts, "get_subagent_result", { agent_id: r.id, wait: true }).then(result => { adopted = true; return result; });
  await tick(); assert.equal(adopted, false); assert.equal(r.assignment.delivery, "pending");
  m.complete(r.id, "AFTER_CLEANUP"); const result = await bounded(wait); assert.match(result.content[0].text, /AFTER_CLEANUP/); assert.equal(r.assignment.delivery, "consumed");
  ts.dispose();
});

test("default gate quotes cwd for Git Bash and propagates the owner signal through executeTool", async () => {
  const seen = [], signal = new AbortController().signal;
  const owner = { executeTool: async (...args) => { seen.push(args); return { isError: false, result: { content: [{ type: "text", text: "CHECKED" }], structuredContent: { exit_code: 0, output: "CHECKED" } } }; } };
  for (const [cwd, expected] of [
    ["C:\\Users\\O'Brien\\my project", "C:/Users/O'\\''Brien/my project"],
    ["\\\\server\\share\\quote' space", "//server/share/quote'\\'' space"],
    ["/tmp/posix\\backslash/quote' space", "/tmp/posix\\backslash/quote'\\'' space"],
  ]) {
    assert.equal((await executeNestedWorkflowGate(owner, "printf 'visible gate'", cwd, signal)).ok, true);
    assert.deepEqual(seen.at(-1), ["bash", { command: `cd -- '${expected}' && printf 'visible gate'`, timeout: 600 }, { signal }]);
  }
});

test("default gate fails closed on unknown exit code, error outcome, missing tool and thrown denial", async () => {
  for (const [structuredContent, isError, explanation] of [
    [{ exit_code: 0 }, false, "PASS"], [{ exit_code: 7 }, true, "NONZERO"],
    [{ exit_code: 0 }, true, "DENIED"], [{ exit_code: "0" }, false, "STRING_EXIT"],
    [{ output: "looks successful" }, false, "NO_EXIT"], [undefined, true, "Unknown tool: bash"],
  ]) {
    const outcome = await executeNestedWorkflowGate({ executeTool: async () => ({ isError, result: { content: [{ type: "text", text: explanation }], structuredContent } }) }, "local-check", dir);
    assert.equal(outcome.ok, structuredContent?.exit_code === 0 && !isError); assert.match(outcome.output, new RegExp(explanation));
  }
  assert.match((await executeNestedWorkflowGate({}, "local-check", dir)).output, /no guarded executeTool/);
  assert.match((await executeNestedWorkflowGate({ executeTool: async () => { throw new Error("STALE_OR_DENIED"); } }, "local-check", dir)).output, /STALE_OR_DENIED/);
  const abort = new AbortController(); abort.abort(new Error("OWNER_STOPPED"));
  const cancelled = await executeNestedWorkflowGate({ executeTool: async () => { assert.fail("An aborted gate must not execute"); } }, "local-check", dir, abort.signal);
  assert.equal(cancelled.ok, false); assert.match(cancelled.output, /OWNER_STOPPED/);
});

async function sdkGateFixture(mode) {
  const cwd = join(dir, `shell quote's ${mode}`); await mkdir(cwd, { recursive: true });
  const m = manager(); m.autoComplete = true; const ts = tools(m); const observations = [], classified = [], events = [];
  const command = mode === "nonzero" ? "printf 'EXPECTED_FAILURE'; exit 7"
    : mode === "denied" ? "printf 'MUST_NOT_RUN' > deny-marker.txt" : "printf 'SAFE_GATE_OK'; exit 0";
  const script = `export const meta={name:'gate-${mode}',description:'Local SDK gate'}; return await agent('local',{agentType:'fixture',gate:${JSON.stringify(command)}});`;
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const providerUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const loader = new DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true,
    extensionFactories: [api => {
      api.registerProvider(`gate-${mode}`, {
        api: "openai-completions", baseUrl: "https://invalid.example", apiKey: "local-only",
        models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
        streamSimple(model, context) {
          observations.push(JSON.stringify(context.messages)); const stream = new AssistantMessageEventStream(); const first = observations.length === 1;
          queueMicrotask(() => {
            const content = first ? [{ type: "toolCall", id: "workflow-sdk", name: "SubagentWorkflow", arguments: { script } }] : [{ type: "text", text: "Local gate adopted" }];
            stream.push({ type: "done", reason: first ? "toolUse" : "stop", message: { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: providerUsage, timestamp: Date.now(), content, stopReason: first ? "toolUse" : "stop" } }); stream.end();
          }); return stream;
        },
      });
    }, createPiAutomode({
      // Real enforcement handler; only its classifier is mocked, and config is
      // in memory so migration/read/write never touches the user's settings.
      loadConfig: () => buildEffectiveConfigFromSources(),
      classifyAction: async (_ctx, _config, action) => {
        const parsed = JSON.parse(action); classified.push(parsed);
        return parsed.toolName === "bash" && mode === "denied"
          ? { decision: "deny", reason: "FIXTURE_AUTOMODE_DENIAL" }
          : { decision: "allow", reason: "Local fixture action" };
      },
      logRoot: join(dir, "fixture-observability"),
    })],
  });
  await loader.reload(); const { session } = await createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(cwd), customTools: ts, ...(mode === "disallowed" ? { excludeTools: ["bash"] } : {}) });
  try {
    await session.setModel(session.modelRuntime.getModel(`gate-${mode}`, "mock")); await session.bindExtensions({ mode: "rpc" }); ts.install(session);
    session.subscribe(event => events.push(event)); await bounded(session.prompt("Use the local fixture workflow and its gate"), `SDK ${mode} gate`);
    assert.equal(observations.length, 2); assert.equal(m.calls.length, 1);
    const nested = events.find(e => e.type === "tool_execution_end" && e.toolName === "bash"); assert.ok(nested, "Gate went through the SDK nested tool pipeline");
    if (mode === "success") {
      assert.equal(nested.isError, false); assert.equal(nested.result.structuredContent.exit_code, 0);
      assert.match(observations[1], /LOCAL_RESULT/); assert.doesNotMatch(observations[1], /failed child call/);
    } else if (mode === "nonzero") {
      assert.equal(nested.isError, true); assert.equal(nested.result.structuredContent.exit_code, 7);
      assert.match(observations[1], /EXPECTED_FAILURE/); assert.match(observations[1], /exit_code=7/);
    } else if (mode === "disallowed") {
      assert.equal(nested.isError, true); assert.match(nested.result.content[0].text, /Tool bash not found/); assert.match(observations[1], /Tool bash not found/);
      assert.equal(classified.some(action => action.toolName === "bash"), false, "Excluded bash never executes or reaches classifier");
    } else {
      assert.equal(nested.isError, true); assert.match(observations[1], /FIXTURE_AUTOMODE_DENIAL/);
      await assert.rejects(access(join(cwd, "deny-marker.txt")), /ENOENT/);
    }
    if (mode !== "disallowed") {
      const bashAction = classified.find(action => action.toolName === "bash"); assert.ok(bashAction);
      assert.ok(bashAction.input.command.endsWith(`&& ${command}`)); assert.match(bashAction.input.command, /shell quote/);
    }
  } finally { ts.dispose(); await session.abort(); session.dispose(); }
}
for (const mode of ["success", "nonzero", "disallowed", "denied"]) test(`real SDK default gate + real automode handler (${mode})`, () => sdkGateFixture(mode));

test("dispose cancels an active guarded gate, cleans owner controls, and cannot touch foreign records", async () => {
  const m = manager(); m.autoComplete = true; const ts = tools(m), s = mockSession(); const originalRequest = s.agent.prepareRequest; ts.install(s);
  const started = Promise.withResolvers(), cancelled = Promise.withResolvers();
  const owner = { ...ctx, executeTool: async (_name, _args, { signal }) => {
    started.resolve();
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });
    cancelled.resolve(); return { isError: true, result: { content: [{ type: "text", text: "OWNER_GATE_CANCELLED" }] } };
  } };
  m.records.set("foreign", { id: "foreign", parentAgentId: "other-owner", status: "running", abortController: new AbortController() });
  const result = await invoke(ts, "SubagentWorkflow", { script: "export const meta={name:'cancel-gate',description:'Local cancel'}; return await agent('local',{agentType:'fixture',gate:'local-check'});" }, undefined, owner);
  await bounded(started.promise); ts.dispose(); await bounded(cancelled.promise);
  assert.equal(s.agent.prepareRequest, originalRequest); assert.equal(s.listeners.size, 0);
  assert.equal(m.getRecord("foreign").status, "running"); assert.equal(m.getRecord("foreign").abortController.signal.aborted, false);
  assert.throws(() => ts.install(s), /closed/); assert.equal((await invoke(ts, "get_subagent_result", { agent_id: result.content[0].text.match(/Agent ID: (wf_[a-z0-9-]+)/)[1] })).isError, true);
});

test("real manager worktree startup failure returns through the SDK tool and does not block the next provider request", async () => {
  const m = new AgentManager(), executions = [], observations = [], events = []; let failedRecord;
  const originalSpawn = m.spawn.bind(m);
  m.spawn = (...args) => { const id = originalSpawn(...args); failedRecord = m.getRecord(id); return id; };
  const startupPi = { exec: async (command, args) => { executions.push({ command, args }); return { code: 1, stdout: "", stderr: "FIXTURE_NOT_A_GIT_REPO", killed: false }; } };
  const ts = tools(m, { pi: startupPi });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const providerUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true,
    extensionFactories: [api => api.registerProvider("startup-local", {
      api: "openai-completions", baseUrl: "https://invalid.example", apiKey: "local-only",
      models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
      streamSimple(model, context) {
        observations.push(JSON.stringify(context.messages)); const stream = new AssistantMessageEventStream(); const first = observations.length === 1;
        queueMicrotask(() => {
          const content = first ? [{ type: "toolCall", id: "startup-call", name: "Agent", arguments: spawn({ isolation: "worktree" }) }]
            : [{ type: "text", text: "Startup error handled" }];
          stream.push({ type: "done", reason: first ? "toolUse" : "stop", message: { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: providerUsage, timestamp: Date.now(), content, stopReason: first ? "toolUse" : "stop" } }); stream.end();
        }); return stream;
      },
    })],
  });
  await loader.reload(); const { session } = await createAgentSession({ cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(dir), customTools: ts });
  try {
    await session.setModel(session.modelRuntime.getModel("startup-local", "mock")); await session.bindExtensions({ mode: "rpc" }); ts.install(session);
    session.subscribe(event => events.push(event));
    await bounded(session.prompt("Local SDK startup failure fixture"), "SDK request after worktree startup failure");
    assert.equal(observations.length, 2); assert.match(observations[1], /Cannot run with isolation/);
    assert.deepEqual(executions, [{ command: "git", args: ["rev-parse", "--is-inside-work-tree"] }]);
    assert.equal(events.find(e => e.type === "tool_execution_end" && e.toolName === "Agent").isError, true);
    assert.equal(m.getRecord(failedRecord.id), undefined, "Real manager deleted the failed startup record");
    assert.equal(failedRecord.status, "error"); assert.equal(failedRecord.runSettled, true);
    assert.equal(failedRecord.assignment.delivery, "consumed"); assert.equal(failedRecord.resultConsumed, true);
    assert.equal(session.sessionManager.getEntries().filter(e => e.type === "custom_message" && e.customType === "subagent-notification").length, 0);
  } finally { ts.dispose(); await session.abort(); session.dispose(); await m.dispose(); }
});

test("real SDK session adopts required evidence before the next mocked provider request", async () => {
  const m = manager(), ts = tools(m); let requests = 0; const reached = Promise.withResolvers(); const observations = [];
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const providerUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true,
    extensionFactories: [api => api.registerProvider("nested-local", {
      api: "openai-completions", baseUrl: "https://invalid.example", apiKey: "local-only",
      models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
      streamSimple(model, context) {
        observations.push(JSON.stringify(context.messages)); const stream = new AssistantMessageEventStream(); const number = ++requests;
        queueMicrotask(() => {
          const content = number === 1 ? [{ type: "toolCall", id: "nested-call", name: "Agent", arguments: spawn({ independent_work: ["Separate observation"] }) }]
            : [{ type: "text", text: number === 2 ? "premature answer" : "Adopted local result" }];
          stream.push({ type: "done", reason: number === 1 ? "toolUse" : "stop", message: { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: providerUsage, timestamp: Date.now(), content, stopReason: number === 1 ? "toolUse" : "stop" } }); stream.end();
          if (number === 2) reached.resolve();
        }); return stream;
      },
    })],
  });
  await loader.reload(); const { session } = await createAgentSession({ cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(dir), customTools: ts });
  try {
    await session.setModel(session.modelRuntime.getModel("nested-local", "mock")); await session.bindExtensions({ mode: "rpc" }); ts.install(session);
    const run = session.prompt("Local SDK fixture"); await bounded(reached.promise); await tick(); assert.equal(requests, 2);
    m.complete("child-1", "SDK_ADOPTED_RESULT"); await bounded(run);
    assert.equal(requests, 3); assert.match(observations[2], /SDK_ADOPTED_RESULT/);
    assert.equal(session.sessionManager.getEntries().filter(e => e.type === "custom_message" && e.customType === "subagent-notification").length, 1);
  } finally { ts.dispose(); await session.abort(); session.dispose(); }
});
