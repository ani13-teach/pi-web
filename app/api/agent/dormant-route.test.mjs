import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
function harness(existing, { path = "/history", readyError } = {}) {
  const calls = [];
  const wrapper = existing ?? {
    isAlive: () => true,
    sessionId: "real-id",
    ensureReadyAndTouch: async () => { calls.push("ready"); if (readyError) throw readyError; },
    send: async command => { calls.push(command.type); return {}; },
  };
  const modules = {
    "next/server": { NextResponse: { json: (data, init) => Response.json(data, init) } },
    "@/lib/session-reader": { resolveSessionPath: async () => path },
    "@/lib/rpc-manager": {
      getRpcSession: () => existing,
      startRpcSession: async () => { calls.push("start"); return { session: wrapper, realSessionId: wrapper.sessionId }; },
    },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(id => modules[id], module, module.exports);
  return {
    calls,
    get: () => module.exports.GET(new Request("http://localhost/agent"), { params: Promise.resolve({ id: "history" }) }),
    post: type => module.exports.POST(new Request("http://localhost/agent", { method: "POST", body: JSON.stringify({ type }) }), { params: Promise.resolve({ id: "history" }) }),
  };
}

test("ensure_session is explicit readiness/touch activation and returns the real id, not an SDK command", async () => {
  const h = harness();
  const response = await h.post("ensure_session");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, data: { sessionId: "real-id" } });
  assert.deepEqual(h.calls, ["start", "ready"]);
});

for (const type of ["get_state", "get_tools", "get_commands"]) {
  test(`${type} does not cold-start dormant history`, async () => {
    const h = harness();
    const response = await h.post(type);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "session_dormant");
    assert.deepEqual(h.calls, []);
  });
}

test("GET distinguishes dormant runtime from an existing background-active runtime without activation", async () => {
  const dormant = harness();
  assert.deepEqual(await (await dormant.get()).json(), { running: false, runtimeActive: false, backgroundActive: false });
  assert.deepEqual(dormant.calls, []);
  const active = harness({ isAlive: () => true, isBackgroundActive: () => true, send: async () => ({ isStreaming: false }) });
  assert.deepEqual(await (await active.get()).json(), { running: true, runtimeActive: true, backgroundActive: true, state: { isStreaming: false } });
});

test("activation reports missing sessions and readiness errors", async () => {
  assert.equal((await harness(undefined, { path: null }).post("ensure_session")).status, 404);
  const response = await harness(undefined, { readyError: new Error("broken binding") }).post("ensure_session");
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "broken binding");
});
