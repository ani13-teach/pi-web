import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { AgentSessionWrapper, getStartingRpcSession } = await jiti.import("./rpc-manager.ts");
const { createAgentEventStream } = await jiti.import("./agent-event-stream.ts");
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const IDLE = 10 * 60 * 1000;
function inner() {
  return {
    sessionId: "demand-test", sessionManager: { getSessionFile: () => "", getCwd: () => "/tmp" },
    isStreaming: false, isBashRunning: false, isCompacting: false,
    agent: { state: {} }, extensionRunner: {}, getAllTools: () => [],
    subscribe: () => () => {}, dispose() {},
  };
}

test("extension binding and unfinished mutations protect an idle runtime, observers do not", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finishBinding;
  const sdk = inner();
  sdk.bindExtensions = () => new Promise(resolve => { finishBinding = resolve; });
  const wrapper = new AgentSessionWrapper(sdk);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.beginExtensionBinding();
  t.mock.timers.tick(IDLE);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  finishBinding();
  await wrapper.waitUntilReady();
  let finishMutation;
  sdk.steer = () => new Promise(resolve => { finishMutation = resolve; });
  const mutation = wrapper.send({ type: "steer", message: "not a real model call" });
  await nextTurn();
  assert.equal(wrapper.isRunning(), false);
  t.mock.timers.tick(IDLE);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  finishMutation();
  await mutation;
  const reader = createAgentEventStream(new Request("http://localhost/events"), sdk.sessionId, Promise.resolve(wrapper)).getReader();
  await reader.read();
  await reader.read();
  t.mock.timers.tick(IDLE);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"dormant"/);
  assert.equal((await reader.read()).done, true);
  assert.equal(wrapper.listeners.length, 0);
});

test("explicit activation readiness errors dispose initialization and release registry references", async t => {
  const sdk = inner();
  sdk.bindExtensions = async () => { throw new Error("binding failed"); };
  let disposed = 0;
  let removed = 0;
  sdk.dispose = () => { disposed++; };
  const wrapper = new AgentSessionWrapper(sdk);
  t.after(() => wrapper.destroy());
  wrapper.onDestroy(() => { removed++; });
  wrapper.beginExtensionBinding();
  await assert.rejects(wrapper.ensureReadyAndTouch(), /binding failed/);
  assert.equal(wrapper.isAlive(), false);
  assert.equal(disposed, 1);
  assert.equal(removed, 1);
  assert.equal(wrapper.extensionBindingPromise, null);
  assert.equal(wrapper.extensionBindingError, null);
});

test("commands cannot enter a closing wrapper, even after waiting on binding", async t => {
  const sdk = inner();
  let finishShutdown;
  sdk.extensionRunner.emit = () => new Promise(resolve => { finishShutdown = resolve; });
  let entered = 0;
  sdk.steer = async () => { entered++; };
  const wrapper = new AgentSessionWrapper(sdk);
  t.after(() => wrapper.destroy());
  const shuttingDown = wrapper.shutdown();
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
  await assert.rejects(wrapper.send({ type: "steer", message: "late" }), /closing/);
  finishShutdown();
  await shuttingDown;
  assert.equal(entered, 0);
});

test("late old disposal does not delete a newly registered wrapper", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function registerRpcWrapper("), source.indexOf("const SUBAGENT_HOST_DEPENDENCIES"));
  const compiled = ts.transpileModule(body + "\nmodule.exports = registerRpcWrapper;", { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const registry = new Map();
  const module = { exports: {} };
  new Function("getRegistry", "cacheSessionPath", "module", compiled)(() => registry, () => {}, module);
  const callbacks = [];
  const make = () => ({ sessionId: "same-id", onDestroy: callback => callbacks.push(callback), start() {}, isChatOnly: () => true });
  const old = make(), replacement = make();
  module.exports(old);
  module.exports(replacement);
  callbacks[0]();
  assert.equal(registry.get("same-id"), replacement);
  callbacks[1]();
  assert.equal(registry.size, 0);
});

test("startup getter is read-only and returns only an existing lock", t => {
  const previous = globalThis.__piStartLocks;
  t.after(() => { globalThis.__piStartLocks = previous; });
  globalThis.__piStartLocks = undefined;
  assert.equal(getStartingRpcSession("id"), undefined);
  assert.equal(globalThis.__piStartLocks, undefined);
  const promise = Promise.resolve({});
  globalThis.__piStartLocks = new Map([["id", promise]]);
  assert.equal(getStartingRpcSession("id"), promise);
});
