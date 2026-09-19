import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { watchRouteFixture, routerFixture } from "./watch-fixture.mjs";
import { EventEmitter } from "node:events";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const webGlobals = { Response, Request, Headers, ReadableStream, AbortController, DOMException,
  Blob, File, FormData, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
  crypto: globalThis.crypto, btoa, atob, console, setTimeout, clearTimeout, EventTarget, Event };

async function renderer(invoke) {
  const { code } = await build({ entryPoints: ["renderer/shims/desktop-http.ts"], bundle: true,
    write: false, format: "cjs", platform: "browser" }).then(r => ({ code: r.outputFiles[0].text }));
  const context = { ...webGlobals, exports: {}, module: { exports: {} },
    window: { location: { href: "pi-app://app/index.html" }, piDesktop: { invoke } } };
  vm.runInNewContext(code, context);
  return context.module.exports;
}

const buffered = { status: 200, statusText: "", headers: [], bodyBase64: btoa("answer"), streamed: false };

test("abort rejects a pending request immediately and cancels its backend id", async () => {
  const pending = deferred();
  const calls = [];
  const { bridgeRequest } = await renderer((method, params) => {
    calls.push([method, params]);
    return method === "http.request" ? pending.promise : Promise.resolve({ cancelled: true });
  });
  const controller = new AbortController();
  const response = bridgeRequest("/api/models", { signal: controller.signal });
  await tick();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(response, { name: "AbortError" });
  assert.equal(calls[0][0], "http.request");
  assert.ok(calls.some(([method, params]) => method === "http.cancel" && params.streamId === calls[0][1].streamId));
  pending.resolve(buffered);
});

test("abort after headers rejects a buffered response body", async () => {
  const { bridgeRequest } = await renderer(async () => buffered);
  const controller = new AbortController();
  const response = await bridgeRequest("/api/models", { signal: controller.signal });
  controller.abort();
  await assert.rejects(response.text(), { name: "AbortError" });
});

test("abort releases a pending SSE read without waiting for a chunk", async () => {
  const pending = deferred();
  const calls = [];
  const { bridgeRequest } = await renderer((method) => {
    calls.push(method);
    if (method === "http.request") return Promise.resolve({ ...buffered, streamed: true });
    if (method === "http.pull") return pending.promise;
    return Promise.resolve({ cancelled: true });
  });
  const controller = new AbortController();
  const response = await bridgeRequest("/api/events", { signal: controller.signal });
  const reader = response.body.getReader();
  const reading = reader.read();
  await tick();
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.ok(calls.includes("http.cancel"));
  pending.resolve({ done: true });
});

test("oversized uploads are rejected before a Blob is read or IPC sent", async () => {
  let reads = 0, sends = 0;
  const { bridgeRequest } = await renderer(async () => { sends++; return buffered; });
  const form = new FormData();
  form.append("files", new File(["small"], "large.bin"));
  const file = form.get("files");
  Object.defineProperty(file, "size", { value: 26 * 1024 * 1024 });
  file.arrayBuffer = async () => { reads++; throw new Error("must not read"); };
  const response = await bridgeRequest("/api/files/work?type=upload", { method: "POST", body: form });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /25MB/);
  assert.equal(reads, 0);
  assert.equal(sends, 0);
});

test("XHR property and listener receive only actual body start/completion", async () => {
  const result = await build({ entryPoints: ["renderer/shims/desktop-xhr.ts"], bundle: true,
    write: false, format: "cjs", platform: "browser" });
  let sentBytes;
  const window = { location: { href: "pi-app://app/index.html" }, piDesktop: { invoke: async (method, params) => {
    if (method === "http.request") sentBytes = Buffer.from(params.bodyBase64, "base64").length;
    return buffered;
  } } };
  const context = { ...webGlobals, window, module: { exports: {} }, exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, context);
  context.module.exports.installDesktopXhr();
  const xhr = new window.XMLHttpRequest();
  const property = [], listener = [];
  xhr.upload.onprogress = e => property.push([e.loaded, e.total]);
  xhr.upload.addEventListener("progress", e => listener.push([e.loaded, e.total]));
  xhr.open("POST", "/api/upload");
  await xhr.send("real request body");
  assert.deepEqual(property, [[0, sentBytes], [sentBytes, sentBytes]]);
  assert.deepEqual(listener, property);
  assert.notEqual(sentBytes, "answer".length);
});

async function backend(route, overrides = {}) {
  const source = await readFile("desktop/backend.ts", "utf8");
  const result = await build({ stdin: { contents: source + "\nglobalThis.fixture = { handlers, requests };", loader: "ts", resolveDir: process.cwd() },
    bundle: true, write: false, platform: "node", format: "esm", plugins: [{ name: "fixtures", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => ({ path: args.path, namespace: "fixtures" }));
      builder.onLoad({ filter: /.*/, namespace: "fixtures" }, args => {
        if (args.path.includes("http-router")) return { contents: "export const handleRequest = globalThis.route;" };
        if (args.path.includes("http-dispatcher")) return { contents: "export const configureHttpDispatcher = () => {};" };
        if (args.path.includes("session-reader")) return { contents: 'export const getAgentDir = () => "fixture";' };
        if (args.path.includes("terminal-manager")) return { contents: "export const killTerminal = (id) => globalThis.killed.push(id);" };
        if (args.path === "node:crypto") return { contents: "export const randomUUID = () => crypto.randomUUID();" };
        return { contents: "export const runNpx = async () => ({ stdout: 'fixture' });" };
      });
    } }] });
  const processMock = new EventEmitter();
  processMock.send = () => {};
  const context = { ...webGlobals, Buffer, process: processMock, route, killed: [], ...overrides };
  await vm.runInNewContext(`(async () => { ${result.outputFiles[0].text} })()`, context);
  return { ...context.fixture, context };
}
const streamResult = body => ({ kind: "stream", status: 200, statusText: "", headers: [], body });

test("backend cancel aborts route and cancels its source even during pending read", async () => {
  let closed = 0, signal;
  const fixture = await backend(async input => {
    signal = input.signal;
    return streamResult(new ReadableStream({ cancel() { closed++; } }));
  });
  await fixture.handlers["http.request"]({ url: "/watch", method: "GET", streamId: "watch" });
  const reading = fixture.handlers["http.pull"]({ streamId: "watch" });
  await fixture.handlers["http.cancel"]({ streamId: "watch" });
  assert.equal((await reading).done, true);
  assert.equal(closed, 1);
  assert.equal(signal.aborted, true);
  assert.equal(fixture.requests.size, 0);
});

test("cancel before headers also disposes a response arriving later", async () => {
  const pending = deferred();
  let closed = 0;
  const fixture = await backend(() => pending.promise);
  const request = fixture.handlers["http.request"]({ url: "/watch", method: "GET", streamId: "pending" });
  await fixture.handlers["http.cancel"]({ streamId: "pending" });
  pending.resolve(streamResult(new ReadableStream({ cancel() { closed++; } })));
  await assert.rejects(request, /cancelled/);
  assert.equal(closed, 1);
  assert.equal(fixture.requests.size, 0);
});

test("read error and unsupported native SSE leave no registered streams", async () => {
  const fixture = await backend(async () => streamResult(new ReadableStream({ start(c) { c.error(new Error("broken")); } })));
  await fixture.handlers["http.request"]({ url: "/watch", method: "GET", streamId: "error" });
  await assert.rejects(fixture.handlers["http.pull"]({ streamId: "error" }), /broken/);
  assert.equal(fixture.requests.size, 0);
  let closed = 0;
  const unsupported = await backend(async () => streamResult(new ReadableStream({ cancel() { closed++; } })));
  await assert.rejects(unsupported.handlers["http.request"]({ url: "/watch", method: "GET" }), /streamId/);
  assert.equal(closed, 1);
  assert.equal(unsupported.requests.size, 0);
});

test("closing a renderer file watch reaches the actual upstream watcher.close", async () => {
  const watch = await watchRouteFixture();
  const router = await routerFixture(watch.handle);
  const fixture = await backend(router);
  const { bridgeRequest } = await renderer((method, params) => Promise.resolve(fixture.handlers[method](params)));
  const response = await bridgeRequest("/api/watch");
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: connected/);
  assert.equal(watch.counts.opened, 1);
  await reader.cancel();
  await tick();
  assert.equal(watch.counts.closed, 1);
  assert.equal(fixture.requests.size, 0);
});

test("buffered download cancellation stops the router source reader", async () => {
  let closed = 0;
  const router = await routerFixture(() => new Response(new ReadableStream({ cancel() { closed++; } })));
  const controller = new AbortController();
  const loading = router({ url: "/api/watch", method: "GET", signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(loading, { name: "AbortError" });
  assert.equal(closed, 1);
});

test("a quiet OAuth-style stream stays alive without losing its pending event", async () => {
  const timers = new Map();
  let source;
  let closed = 0;
  const fixture = await backend(async () => streamResult(new ReadableStream({
    start(controller) { source = controller; }, cancel() { closed++; },
  })), {
    setTimeout(callback, ms) { const id = { unref() {} }; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  await fixture.handlers["http.request"]({ url: "/oauth", method: "GET", streamId: "login" });
  // Six quiet pulls represent 150 seconds, beyond the old 120-second timeout.
  for (let i = 0; i < 6; i++) {
    const reading = fixture.handlers["http.pull"]({ streamId: "login" });
    const heartbeat = [...timers.values()].find(timer => timer.ms === 25_000);
    assert.ok(heartbeat);
    heartbeat.callback();
    const chunk = await reading;
    assert.equal(Buffer.from(chunk.chunkBase64, "base64").toString(), ": keepalive\n\n");
    assert.equal(fixture.requests.size, 1);
  }
  const reading = fixture.handlers["http.pull"]({ streamId: "login" });
  source.enqueue(new TextEncoder().encode('data: {"authorized":true}\n\n'));
  assert.match(Buffer.from((await reading).chunkBase64, "base64").toString(), /authorized/);
  await fixture.handlers["http.cancel"]({ streamId: "login" });
  assert.equal(closed, 1);
  assert.equal(timers.size, 0);
});

test("shutdown waits for extension cleanup and closes live terminals once", async () => {
  const fixture = await backend(async () => ({ kind: "buffered", ...buffered }));
  const closing = deferred();
  let calls = 0, finished = false;
  fixture.context.__piSessions = new Map([["session", { shutdown() { calls++; return closing.promise; } }]]);
  fixture.context.__piWebTerminals = new Map([["terminal", {}]]);
  const first = fixture.handlers["backend.shutdown"]();
  first.then(() => { finished = true; });
  const second = fixture.handlers["backend.shutdown"]();
  await tick();
  assert.equal(finished, false);
  assert.equal(calls, 1);
  assert.deepEqual(fixture.context.killed, ["terminal"]);
  closing.resolve();
  await Promise.all([first, second]);
  assert.equal(finished, true);
});
