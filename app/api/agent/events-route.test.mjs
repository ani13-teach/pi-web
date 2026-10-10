import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const source = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const streamSource = await readFile(new URL("../../../lib/agent-event-stream.ts", import.meta.url), "utf8");
const { createAgentEventStream } = await createJiti(import.meta.url).import("../../../lib/agent-event-stream.ts");
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function harness({ session, starting, path = "/history.jsonl", resolvePath } = {}) {
  const calls = { start: 0, resolve: 0 };
  const modules = {
    "@/lib/agent-event-stream": { createAgentEventStream },
    "@/lib/session-reader": { resolveSessionPath: async () => { calls.resolve++; return resolvePath ? resolvePath() : path; } },
    "@/lib/rpc-manager": {
      getRpcSession: () => session,
      getStartingRpcSession: () => starting,
      startRpcSession: () => { calls.start++; throw new Error("Cold start forbidden"); },
    },
  };
  const module = { exports: {} };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "module", "exports", compiled)(id => modules[id], module, module.exports);
  return { get: (request = new Request("http://localhost/events")) => module.exports.GET(request, { params: Promise.resolve({ id: "history" }) }), calls };
}
function active(ready = Promise.resolve()) {
  return { isAlive: () => true, waitUntilReady: () => ready, isStreaming: false, streamingMessage: null, onEvent: () => () => {} };
}

test("cold history returns a finite dormant SSE without creating services", async () => {
  const h = harness();
  const response = await h.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(await response.text(), 'data: {"type":"dormant","sessionId":"history"}\n\n');
  assert.equal(h.calls.start, 0);
});

for (const mode of ["active", "starting"]) {
  test(`${mode} session waits for readiness before connected, without starting`, async () => {
    let ready;
    const session = active(new Promise(resolve => { ready = resolve; }));
    let finishStart;
    const starting = new Promise(resolve => { finishStart = resolve; });
    const h = harness(mode === "active" ? { session } : { starting, path: null });
    const response = await h.get();
    assert.equal(response.headers.get("X-Accel-Buffering"), "no");
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), ":\n\n");
    let connected = false;
    const frame = reader.read().then(result => { connected = true; return result; });
    finishStart({ session });
    await nextTurn();
    assert.equal(connected, false);
    ready();
    assert.match(new TextDecoder().decode((await frame).value), /"type":"connected"/);
    assert.equal(h.calls.start, 0);
    assert.equal(h.calls.resolve, 0);
    await reader.cancel();
  });
}

test("missing history is 404 and aborted requests are 204, including during path lookup", async () => {
  assert.equal((await harness({ path: null }).get()).status, 404);
  const controller = new AbortController();
  controller.abort();
  const h = harness();
  assert.equal((await h.get(new Request("http://localhost/events", { signal: controller.signal }))).status, 204);
  assert.equal(h.calls.resolve, 0);
  const during = new AbortController();
  const pending = harness({ resolvePath: () => { during.abort(); return "/history"; } });
  assert.equal((await pending.get(new Request("http://localhost/events", { signal: during.signal }))).status, 204);
});

test("agent SSE reuses one TextEncoder per stream", () => {
  assert.equal((streamSource.match(/new TextEncoder\(\)/g) ?? []).length, 1);
  assert.match(streamSource, /controller\.enqueue\(encoder\.encode\(/);
  assert.doesNotMatch(source, /startRpcSession/);
});
