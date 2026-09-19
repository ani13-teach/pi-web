/**
 * Reconnection behaviour of the desktop EventSource shim.
 *
 * The real shim and the real `desktop-http` bridge run against a mocked
 * `window.piDesktop`, so headers, streaming pulls and cancellation are the
 * ones production uses — only the IPC transport is fake.
 *
 * Run with: node tests/eventsource.test.mjs
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

globalThis.window = {
  location: { href: "http://127.0.0.1:30141/" },
  piDesktop: null,
};

const { installDesktopEventSource } = await jiti.import("../renderer/shims/desktop-eventsource.ts");
installDesktopEventSource();
const EventSource = globalThis.window.EventSource;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base64 = (text) => Buffer.from(text, "utf8").toString("base64");

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(5);
  }
  throw new Error("timed out waiting for the condition");
}

/** Consumes the queued plans, then keeps answering with the last one. */
function sequence(...plans) {
  return () => (plans.length > 1 ? plans.shift() : plans[0]);
}

/**
 * The `http.request`/`http.pull`/`http.cancel` half of the bridge.
 *
 * A plan is `{ status, type, body }` for a plain response, or
 * `{ chunks, failure, hold }` for a stream: `chunks` are delivered in order,
 * `failure` makes the next pull blow up, and `hold` keeps the stream open.
 */
function createBridge(planFor) {
  const requests = [];
  const cancelled = [];
  const streams = new Map();

  const invoke = async (channel, payload) => {
    if (channel === "http.request") {
      requests.push({ ...payload, at: Date.now() });
      const plan = planFor(payload) ?? {};
      const type = plan.type ?? "text/event-stream";
      streams.set(payload.streamId, {
        chunks: (plan.chunks ?? []).map(base64),
        failure: plan.failure ?? null,
        hold: plan.hold ?? false,
        cancelled: false,
      });
      return {
        status: plan.status ?? 200,
        statusText: "",
        headers: [["content-type", type]],
        streamed: type.includes("text/event-stream"),
        bodyBase64: plan.body ? base64(plan.body) : "",
      };
    }
    if (channel === "http.pull") {
      const stream = streams.get(payload.streamId);
      if (!stream || stream.cancelled) return { done: true };
      if (stream.failure) {
        const message = stream.failure;
        stream.failure = null;
        throw new Error(message);
      }
      if (stream.chunks.length > 0) return { done: false, chunkBase64: stream.chunks.shift() };
      if (stream.hold) await new Promise(() => {});
      return { done: true };
    }
    if (channel === "http.cancel") {
      cancelled.push(payload.streamId);
      const stream = streams.get(payload.streamId);
      if (stream) stream.cancelled = true;
      return { cancelled: Boolean(stream) };
    }
    throw new Error(`unexpected bridge channel: ${channel}`);
  };

  return { requests, cancelled, streams, api: { invoke } };
}

const live = new Set();

/** Every source has to be closed: the mock bridge is swapped between tests. */
function useBridge(bridge) {
  globalThis.window.piDesktop = bridge.api;
  return (url) => {
    const source = new EventSource(url);
    live.add(source);
    return source;
  };
}

afterEach(() => {
  for (const source of live) source.close();
  live.clear();
});

test("reconnects after EOF and sends Last-Event-ID", async () => {
  const bridge = createBridge(sequence(
    { chunks: ["id: 41\ndata: first\n\n"] },
    { chunks: ["data: second\n\n"], hold: true },
  ));
  const spawn = useBridge(bridge);

  const events = [];
  const opens = [];
  const source = spawn("/api/agent/events");
  source.onopen = () => opens.push("open");
  source.onmessage = (message) => events.push({ data: message.data, lastEventId: message.lastEventId });

  await waitFor(() => events.length === 2);
  assert.deepEqual(events.map((event) => event.data), ["first", "second"]);
  assert.deepEqual(events.map((event) => event.lastEventId), ["41", "41"]);
  assert.equal(opens.length, 2, "every attempt that reaches a stream opens");
  assert.equal(source.readyState, OPEN);
  assert.equal(bridge.requests.length, 2);
  assert.equal(bridge.requests[0].headers["last-event-id"], undefined);
  assert.equal(bridge.requests[1].headers["last-event-id"], "41");
  assert.equal(bridge.requests[1].headers.accept, "text/event-stream");

  source.close();
});

test("retries a transport error", async () => {
  const bridge = createBridge(sequence(
    { failure: "socket reset" },
    { chunks: ["data: recovered\n\n"], hold: true },
  ));
  const spawn = useBridge(bridge);

  const messages = [];
  const errors = [];
  const source = spawn("/api/terminal/1/events");
  source.onerror = () => errors.push(Date.now());
  source.onmessage = (message) => messages.push(message.data);

  await waitFor(() => messages.length === 1, 3000);
  assert.deepEqual(messages, ["recovered"]);
  assert.equal(errors.length, 1);
  assert.equal(source.readyState, OPEN);
  assert.equal(bridge.requests.length, 2);

  source.close();
});

test("parses CRLF frames split across chunks", async () => {
  const bridge = createBridge(sequence({
    chunks: ["event: tick\r\ndata: a\r", "\n\r\nevent: tick\r", "\ndata: b\r\n\r\n"],
    hold: true,
  }));
  const spawn = useBridge(bridge);

  const ticks = [];
  const source = spawn("/api/files/watch");
  source.addEventListener("tick", (event) => ticks.push(event.data));

  await waitFor(() => ticks.length === 2);
  assert.deepEqual(ticks, ["a", "b"]);
  assert.equal(source.readyState, OPEN);

  source.close();
});

test("honours a numeric retry and ignores a non-numeric one", async () => {
  const bridge = createBridge(sequence(
    { chunks: ["retry: 120\ndata: first\n\n", "retry: soon\n\n"] },
    { chunks: ["data: second\n\n"], hold: true },
  ));
  const spawn = useBridge(bridge);

  const errors = [];
  const messages = [];
  const source = spawn("/api/files/watch");
  source.onerror = () => errors.push(Date.now());
  source.onmessage = (message) => messages.push(message.data);

  await waitFor(() => bridge.requests.length === 2);
  const delay = bridge.requests[1].at - errors[0];
  // 120ms, not the 1000ms default and not the 0ms a parsed "soon" would give.
  assert.ok(delay >= 90, `reconnected after ${delay}ms, expected about 120ms`);
  assert.ok(delay < 900, `reconnected after ${delay}ms, expected about 120ms`);
  assert.equal(source.readyState, OPEN);
  assert.ok(!messages.includes(""), "a retry-only frame is not an event");

  source.close();
});

test("close() cancels a pending retry", async () => {
  const bridge = createBridge(sequence({ chunks: ["retry: 300\ndata: first\n\n"] }));
  const spawn = useBridge(bridge);

  const errors = [];
  const source = spawn("/api/files/watch");
  source.onerror = () => errors.push(Date.now());

  await waitFor(() => errors.length === 1);
  await wait(20); // long enough for the reconnection timer to be armed
  source.close();
  await wait(400); // well past the 300ms the server asked for
  assert.equal(source.readyState, CLOSED);
  assert.equal(bridge.requests.length, 1);
});

test("a final response closes instead of retrying", async () => {
  const plans = {
    "/api/final/204": { status: 204 },
    "/api/final/404": { status: 404, type: "text/html", body: "nope" },
    "/api/final/mime": { status: 200, type: "application/json", body: "{}" },
  };
  const bridge = createBridge((request) => plans[request.url]);
  const spawn = useBridge(bridge);

  const errors = [];
  const sources = Object.keys(plans).map((url) => {
    const source = spawn(url);
    source.onerror = () => errors.push({ url, at: Date.now() });
    return source;
  });

  await waitFor(() => sources.every((source) => source.readyState === CLOSED));
  assert.deepEqual(errors.map((entry) => entry.url).sort(), Object.keys(plans).sort());
  await wait(1200); // longer than the default retry, so a timer would have fired
  assert.equal(bridge.requests.length, 3);
  assert.deepEqual(sources.map((source) => source.readyState), [CLOSED, CLOSED, CLOSED]);
});

test("a 5xx retries on the default reconnection time, then streams", async () => {
  const attempts = new Map();
  const bridge = createBridge((request) => {
    const seen = attempts.get(request.url) ?? 0;
    attempts.set(request.url, seen + 1);
    return seen === 0
      ? { status: 503, type: "text/plain", body: "starting" }
      : { chunks: ["data: back\n\n"], hold: true };
  });
  const spawn = useBridge(bridge);

  const messages = [];
  const errors = [];
  const opens = [];
  const source = spawn("/api/agent/events");
  source.onerror = () => errors.push(Date.now());
  source.onopen = () => opens.push(Date.now());
  source.onmessage = (message) => messages.push(message.data);

  await waitFor(() => messages.length === 1, 4000);
  const delay = bridge.requests[1].at - errors[0];
  assert.ok(delay >= 900, `reconnected after ${delay}ms, expected the default 1000ms`);
  assert.equal(opens.length, 1, "the failed attempt never opened");
  assert.deepEqual(messages, ["back"]);
  assert.equal(source.readyState, OPEN);

  source.close();
});

test("close() aborts the request, releases the reader and stays closed", async () => {
  const bridge = createBridge(sequence({ chunks: ["data: one\n\n"], hold: true }));
  const spawn = useBridge(bridge);

  const errors = [];
  const messages = [];
  const source = spawn("/api/terminal/1/events");
  source.onerror = () => errors.push("error");
  source.onmessage = (message) => messages.push(message.data);

  await waitFor(() => messages.length === 1);
  source.close();

  assert.equal(source.readyState, CLOSED);
  await wait(120);
  assert.deepEqual(errors, [], "close() is silent");
  assert.equal(bridge.requests.length, 1, "close() never reconnects");
  assert.ok(bridge.cancelled.length >= 1, "the backend stream was released");
});

test("a source replaced from onerror does not connect twice", async () => {
  const bridge = createBridge((request) => (
    request.url === "/api/dropping"
      ? { chunks: ["retry: 20\ndata: first\n\n"] }
      : { chunks: ["data: replacement\n\n"], hold: true }
  ));
  const spawn = useBridge(bridge);

  let errors = 0;
  let replacement = null;
  const source = spawn("/api/dropping");
  source.onerror = () => {
    errors += 1;
    source.close();
    replacement = spawn("/api/replacement");
  };

  await waitFor(() => errors === 1);
  await wait(150); // several 20ms retry windows
  assert.equal(source.readyState, CLOSED);
  assert.equal(errors, 1);
  assert.deepEqual(bridge.requests.map((request) => request.url), ["/api/dropping", "/api/replacement"]);

  replacement.close();
});
