import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { AgentReadinessTimeoutError, runWithAgentReadinessDeadline, sendAgentCommand } = await jiti.import("./agent-client.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("readiness timeout rejects even when a bridge ignores cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  let cleaned = 0;
  const ready = runWithAgentReadinessDeadline(async (value) => {
    signal = value;
    return new Promise(() => {});
  }, 20, () => { cleaned++; });
  const rejected = assert.rejects(ready, (error) => error instanceof AgentReadinessTimeoutError);
  await nextTurn();
  t.mock.timers.tick(19);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(cleaned, 1);
});

test("activation and handshake consume one shared readiness budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let releaseActivation;
  let signal;
  const stages = [];
  const ready = runWithAgentReadinessDeadline(async (value) => {
    signal = value;
    stages.push("activation");
    await new Promise((resolve) => { releaseActivation = resolve; });
    stages.push("handshake");
    return new Promise(() => {});
  }, 20);
  const rejected = assert.rejects(ready, (error) => error instanceof AgentReadinessTimeoutError);
  await nextTurn();
  t.mock.timers.tick(15);
  releaseActivation();
  await nextTurn();
  assert.deepEqual(stages, ["activation", "handshake"]);
  t.mock.timers.tick(4);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
});

test("successful readiness clears its deadline and does not run timeout cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  let cleaned = 0;
  assert.equal(await runWithAgentReadinessDeadline(async (value) => { signal = value; return "ready"; }, 20, () => { cleaned++; }), "ready");
  t.mock.timers.tick(1000);
  assert.equal(signal.aborted, false);
  assert.equal(cleaned, 0);
});

test("readiness failures preserve their original error and clear the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = new Error("startup failed");
  let cleaned = 0;
  await assert.rejects(runWithAgentReadinessDeadline(async () => { throw original; }, 20, () => { cleaned++; }), (error) => error === original);
  t.mock.timers.tick(1000);
  assert.equal(cleaned, 0);
});

test("invalid readiness deadlines reject before dispatching an operation", async () => {
  let calls = 0;
  for (const value of [NaN, Infinity, -1]) await assert.rejects(runWithAgentReadinessDeadline(async () => { calls++; }, value), RangeError);
  assert.equal(calls, 0);
});

test("agent commands pass the activation cancellation signal to fetch", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.signal, controller.signal);
    assert.equal(JSON.parse(init.body).type, "ensure_session");
    return Response.json({ success: true, data: { sessionId: "session" } });
  };
  assert.deepEqual(await sendAgentCommand("session", { type: "ensure_session" }, { signal: controller.signal }), { sessionId: "session" });
});

test("parent cancellation rejects ignored IO and releases its listener and timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = new AbortController();
  const reason = new Error("outer deadline expired");
  let child;
  let cleaned = 0;
  const ready = runWithAgentReadinessDeadline(async (signal) => { child = signal; return new Promise(() => {}); }, 100, () => { cleaned++; }, parent.signal);
  const rejected = assert.rejects(ready, (error) => error === reason);
  await nextTurn();
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  parent.abort(reason);
  await rejected;
  assert.equal(child.aborted, true);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  t.mock.timers.tick(100);
  assert.equal(cleaned, 0);
});

test("already-cancelled parent dispatches no operation", async () => {
  const parent = new AbortController();
  const reason = new Error("cancelled");
  parent.abort(reason);
  let calls = 0;
  await assert.rejects(runWithAgentReadinessDeadline(async () => { calls++; }, 100, undefined, parent.signal), (error) => error === reason);
  assert.equal(calls, 0);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("successful preparation releases its parent listener before the parent can later abort", async () => {
  const parent = new AbortController();
  let child;
  await runWithAgentReadinessDeadline(async (signal) => { child = signal; }, 100, undefined, parent.signal);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  parent.abort();
  assert.equal(child.aborted, false);
});
