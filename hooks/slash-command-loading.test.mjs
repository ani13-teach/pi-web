import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const source = ts.createSourceFile("useAgentSession.ts", readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function findCallback(node, name = "loadSlashCommands") {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) return node.initializer.arguments[0];
  return ts.forEachChild(node, (child) => findCallback(child, name));
}
// Execute the production callback, not a parallel implementation of its logic.
const script = new Script(ts.transpileModule(findCallback(source).getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText);
const { runWithAgentReadinessDeadline } = await createJiti(import.meta.url).import("../lib/agent-client.ts");
const commands = [{ name: "custom-command", source: "extension" }, { name: "skill:example", source: "skill" }];
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides = {}) {
  const events = [], updates = [], loading = [];
  const context = {
    sessionIdRef: { current: null }, sessionHookMountedRef: { current: true },
    slashCommandsRequestRef: { current: 0 }, EVENT_STREAM_READY_TIMEOUT_MS: 60_000,
    console: { error() {} },
    setSlashCommands(value) { updates.push(value); },
    setSlashCommandsLoading(value) { loading.push(value); },
    async runWithAgentReadinessDeadline(operation) { return operation(new AbortController().signal); },
    async ensureNewSession(signal) {
      if (context.sessionIdRef.current) return context.sessionIdRef.current;
      events.push(["create", signal]);
      context.sessionIdRef.current = "new-session";
      return "new-session";
    },
    async ensureRuntimeActive(sid, signal) { events.push(["activate", sid, signal]); },
    async sendAgentCommand(sid, command, options) {
      events.push([command.type, sid, options.signal]);
      return { commands };
    },
    ...overrides,
  };
  return { context, events, updates, loading, load: script.runInNewContext(context) };
}

test("first palette open creates and activates resources before discovering commands, with no prompt", async () => {
  const h = harness();
  assert.equal(await h.load(), commands);
  assert.deepEqual(h.events.map(([type]) => type), ["create", "activate", "get_commands"]);
  assert.equal(h.events[0][1], h.events[1][2]);
  assert.equal(h.events[1][2], h.events[2][2]);
  assert.deepEqual(h.updates, [commands]);
  assert.deepEqual(h.loading, [true, false]);
});

test("a historical or active session is ensured without creating another session", async () => {
  const h = harness({ sessionIdRef: { current: "history" } });
  await h.load();
  assert.deepEqual(h.events.map(([type, sid]) => [type, sid]), [["activate", "history"], ["get_commands", "history"]]);
});

test("loading includes the wait for new-session creation", async () => {
  const pending = deferred();
  const h = harness({ ensureNewSession: () => pending.promise });
  const result = h.load();
  assert.deepEqual(h.loading, [true]);
  h.context.sessionIdRef.current = "created";
  pending.resolve("created");
  await result;
  assert.deepEqual(h.loading, [true, false]);
});

for (const stage of ["ensureNewSession", "ensureRuntimeActive", "sendAgentCommand"]) {
  test(stage + " failures propagate for retry and always finish loading", async () => {
    const error = new Error("temporary failure");
    const h = harness({ [stage]: async () => { throw error; } });
    await assert.rejects(h.load(), (caught) => caught === error);
    assert.equal(h.updates.length, 1);
    assert.equal(h.updates[0].length, 0);
    assert.deepEqual(h.loading, [true, false]);
  });
}

test("empty command lists remain a successful result (including chat-only sessions)", async () => {
  const h = harness({ sendAgentCommand: async () => ({ commands: [] }) });
  assert.equal((await h.load()).length, 0);
  assert.deepEqual(h.updates, [[]]);
  assert.deepEqual(h.loading, [true, false]);
});

for (const change of ["navigate", "unmount"]) {
  test("late discovery does not publish after " + change, async () => {
    const pending = deferred(), started = deferred();
    const h = harness({
      sessionIdRef: { current: "original" },
      sendAgentCommand: () => { started.resolve(); return pending.promise; },
    });
    const result = h.load();
    await started.promise;
    if (change === "navigate") h.context.sessionIdRef.current = "different";
    else h.context.sessionHookMountedRef.current = false;
    pending.resolve({ commands });
    await result;
    assert.deepEqual(h.updates, []);
    assert.deepEqual(h.loading, change === "navigate" ? [true, false] : [true]);
  });
}

test("an older overlapping request cannot replace newer commands or stop its loading state", async () => {
  const pending = deferred(), started = deferred();
  let count = 0;
  const h = harness({
    sessionIdRef: { current: "same" },
    sendAgentCommand: () => {
      if (++count === 1) { started.resolve(); return pending.promise; }
      return Promise.resolve({ commands });
    },
  });
  const older = h.load();
  await started.promise;
  await h.load();
  pending.resolve({ commands: [{ name: "stale" }] });
  await older;
  assert.deepEqual(h.updates, [commands]);
  assert.deepEqual(h.loading, [true, true, false]);
});

test("a timed-out bridge response cannot publish commands and a later open can retry", async () => {
  const pending = deferred(), started = deferred();
  let count = 0;
  const h = harness({
    sessionIdRef: { current: "same" },
    EVENT_STREAM_READY_TIMEOUT_MS: 5,
    runWithAgentReadinessDeadline,
    sendAgentCommand: () => {
      if (++count === 1) { started.resolve(); return pending.promise; }
      return Promise.resolve({ commands });
    },
  });
  const first = h.load();
  await started.promise;
  await assert.rejects(first, { name: "AgentReadinessTimeoutError" });
  await h.load();
  pending.resolve({ commands: [{ name: "stale" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.updates[0].length, 0);
  assert.equal(h.updates[1], commands);
  assert.equal(h.updates.length, 2);
  assert.deepEqual(h.loading, [true, false, true, false]);
});

const ensureScript = new Script(ts.transpileModule(findCallback(source, "ensureNewSession").getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText);
function provisionalHarness(preset) {
  const live = new Set(), requests = [];
  const h = harness({
    isNew: true, newSessionCwd: "C:/original-project", toolPreset: preset,
    newSessionPromotedRef: { current: false }, ensuringNewSessionRef: { current: null },
    newSessionModelOverrideRef: { current: { provider: "chosen", modelId: "model" } },
    thinkingLevelOverrideRef: { current: "high" }, runtimeActiveRef: { current: false },
    runtimeActivityRevisionRef: { current: 0 },
    getToolNamesForPreset: (value) => value === "none" ? [] : ["read", "bash", "edit", "write"],
    setPendingModel() {}, setNewSessionDefaultModel() {}, setThinkingLevel() {},
    async fetch(url, options) {
      if (options.method !== "POST") {
        requests.push({ type: "probe", url });
        return { ok: true, json: async () => ({ runtimeActive: live.has(h.context.sessionIdRef.current) }) };
      }
      const body = JSON.parse(options.body);
      requests.push(body);
      const sessionId = "provisional-" + requests.length;
      live.add(sessionId);
      return { ok: true, json: async () => ({ sessionId, model: body.provider ? { provider: body.provider, modelId: body.modelId } : null, thinkingLevel: body.thinkingLevel }) };
    },
    async ensureRuntimeActive(sid) {
      assert.ok(live.has(sid), "must not activate a reclaimed provisional ID");
    },
  });
  h.context.ensureNewSession = ensureScript.runInNewContext(h.context);
  return { ...h, live, requests };
}

for (const preset of ["default", "none"]) {
  test(preset + " provisional sessions recover after idle reclamation with original settings", async () => {
    const h = provisionalHarness(preset);
    await h.load();
    const originalId = h.context.sessionIdRef.current;
    h.live.delete(originalId);
    await h.load();
    assert.notEqual(h.context.sessionIdRef.current, originalId);
    const creations = h.requests.filter((request) => request.type === "ensure_session");
    assert.equal(creations.length, 2);
    assert.deepEqual(creations[0], creations[1]);
    assert.equal(creations[1].cwd, "C:/original-project");
    assert.deepEqual(creations[1].toolNames, preset === "none" ? [] : ["read", "bash", "edit", "write"]);
    assert.equal(creations[1].provider, "chosen");
    assert.equal(creations[1].modelId, "model");
    assert.equal(creations[1].thinkingLevel, "high");
    // First send uses this same ensureNewSession callback even if an ID exists.
    h.live.delete(h.context.sessionIdRef.current);
    const readyId = await h.context.ensureNewSession();
    assert.ok(h.live.has(readyId));
    assert.equal(h.requests.filter((request) => request.type === "ensure_session").length, 3);
  });
}

test("opening commands and sending concurrently share new-session creation", async () => {
  const h = provisionalHarness("default");
  const [first, second] = await Promise.all([h.context.ensureNewSession(), h.context.ensureNewSession()]);
  assert.equal(first, second);
  assert.equal(h.requests.length, 1);
  assert.equal(h.context.ensuringNewSessionRef.current, null);
});

test("promoted and historical sessions never get recreated as provisional ones", async () => {
  for (const state of [{ isNew: false }, { newSessionPromotedRef: { current: true } }]) {
    const h = provisionalHarness("default");
    Object.assign(h.context, state);
    h.context.sessionIdRef.current = "persisted";
    assert.equal(await h.context.ensureNewSession(), "persisted");
    assert.equal(h.requests.length, 0);
  }
});

test("failed provisional probes leave the original ID intact", async () => {
  const h = provisionalHarness("default");
  h.context.sessionIdRef.current = "original";
  h.context.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(h.context.ensureNewSession(), /HTTP 503/);
  assert.equal(h.context.sessionIdRef.current, "original");
  assert.equal(h.context.ensuringNewSessionRef.current, null);
});

for (const failure of ["HTTP error", "timeout"]) {
  test("failed recreation after reclamation finishes loading: " + failure, async () => {
    const h = provisionalHarness("default");
    await h.load();
    h.live.clear();
    const originalFetch = h.context.fetch;
    h.context.fetch = async (url, options) => {
      if (options.method === "POST") {
        if (failure === "HTTP error") return { ok: false, status: 503 };
        return new Promise(() => {});
      }
      return originalFetch(url, options);
    };
    h.context.runWithAgentReadinessDeadline = runWithAgentReadinessDeadline;
    h.context.EVENT_STREAM_READY_TIMEOUT_MS = 10;
    await assert.rejects(h.load());
    assert.equal(h.context.sessionIdRef.current, null);
    assert.deepEqual(h.loading, [true, false, true, false]);
    assert.equal(h.updates.at(-1).length, 0);
    h.context.fetch = originalFetch;
    await h.load();
    assert.ok(h.live.has(h.context.sessionIdRef.current));
    assert.equal(h.updates.at(-1), commands);
    assert.equal(h.loading.at(-1), false);
  });
}

test("first sends revalidate provisional IDs before activating the event stream", () => {
  const send = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8").split("  const handleSend = useCallback")[1].split("  const executeBash = useCallback")[0];
  assert.match(send, /readySessionId = await ensureNewSession\(signal\)/);
  assert.doesNotMatch(send, /readySessionId = existingSid \?\?/);
});

test("the composer clears its request flag on failure and retries on the next open", async () => {
  const input = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findEffect(node) {
    if (ts.isCallExpression(node) && node.expression.getText(input) === "useEffect" && node.arguments[0]?.getText(input).includes("slashCommandsRequestedRef.current = true")) return node.arguments[0];
    return ts.forEachChild(node, findEffect);
  }
  const effect = new Script(ts.transpileModule(findEffect(input).getText(input), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  let calls = 0;
  const context = {
    slashQuery: "", slashCommandsRequestedRef: { current: false },
    setSlashMenuOpen() {}, setSlashActiveIndex() {},
    onLoadSlashCommands: async () => { if (++calls === 1) throw new Error("temporary"); return commands; },
  };
  const run = effect.runInNewContext(context);
  run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.slashCommandsRequestedRef.current, false);
  context.slashQuery = null;
  run();
  context.slashQuery = "";
  run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(context.slashCommandsRequestedRef.current, true);
});
