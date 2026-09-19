/**
 * System-proxy checks.
 *
 * The backend cannot read Chromium's proxy settings itself, so it asks the main
 * process and then connects accordingly. These checks cover the two halves that
 * can be exercised without Electron: how a decision is read, and whether a
 * request really follows it.
 *
 * The last check wires the real `configureOutboundNetworking` and answers its
 * lookups through a stand-in `process.send`, so it proves the production path —
 * including that globally installed fetch *and* WebSocket go through the
 * decision, which is what the ChatGPT transport needs.
 *
 * Run with:  node --experimental-strip-types --test tests/system-proxy.test.mjs
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSystemProxyDispatcher, handleProxyMessage, hasProxyEnvironment, parseProxyChoice } =
  await jiti.import("../desktop/system-proxy.ts");
const { fetch: undiciFetch, WebSocket: UndiciWebSocket, setGlobalDispatcher, Agent } = await import("undici");

/** fetch wraps a dispatch failure, so the reason lives on `cause`. */
function rejectsWith(promise, pattern) {
  return assert.rejects(promise, (error) => {
    assert.match(`${error.message} ${error.cause?.message ?? ""}`, pattern);
    return true;
  });
}

test("reads Chromium's proxy decision", () => {
  assert.deepEqual(parseProxyChoice("DIRECT"), { kind: "direct" });
  assert.deepEqual(parseProxyChoice("  direct  "), { kind: "direct" });
  assert.deepEqual(parseProxyChoice("PROXY 127.0.0.1:7890"), {
    kind: "proxy",
    uri: "http://127.0.0.1:7890",
  });
  assert.deepEqual(parseProxyChoice("HTTPS proxy.local:8443"), {
    kind: "proxy",
    uri: "https://proxy.local:8443",
  });

  // A PAC script may return fallbacks. Only the first is used: trying a second
  // proxy would mean repeating the request somewhere else.
  assert.deepEqual(parseProxyChoice("PROXY first.local:1; PROXY second.local:2; DIRECT"), {
    kind: "proxy",
    uri: "http://first.local:1",
  });

  // Anything not understood is reported, never silently treated as DIRECT.
  assert.equal(parseProxyChoice("SOCKS5 127.0.0.1:1080").kind, "unsupported");
  assert.equal(parseProxyChoice("").kind, "unsupported");
  assert.equal(parseProxyChoice("127.0.0.1:7890").kind, "unsupported");
});

test("only counts the proxy variables undici's env agent honours", () => {
  assert.equal(hasProxyEnvironment({}), false);
  assert.equal(hasProxyEnvironment({ NO_PROXY: "example.com" }), false);
  assert.equal(hasProxyEnvironment({ HTTPS_PROXY: "http://127.0.0.1:7890" }), true);
  assert.equal(hasProxyEnvironment({ http_proxy: "http://127.0.0.1:7890" }), true);
});

/** A proxy that answers plain requests and refuses tunnels, recording both. */
async function startRecordingProxy() {
  const forwarded = [];
  const tunnels = [];
  const proxy = createServer((request, response) => {
    forwarded.push(`${request.method} ${request.url}`);
    response.writeHead(204, { Connection: "close" });
    response.end();
  });
  proxy.on("connect", (request, socket) => {
    tunnels.push(request.url);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  return { forwarded, tunnels, port: address.port, close: () => new Promise((resolve) => proxy.close(resolve)) };
}

test("sends each target where the system pointed it", async (t) => {
  const proxy = await startRecordingProxy();
  t.after(() => proxy.close());

  const asked = [];
  const dispatcher = createSystemProxyDispatcher(async (url) => {
    asked.push(url);
    if (url.startsWith("https://bypass.")) return "DIRECT";
    if (url.startsWith("https://socks.")) return "SOCKS5 127.0.0.1:1080";
    if (url.startsWith("https://broken.")) throw new Error("lookup is down");
    if (url.startsWith("https://malformed.")) return "PROXY 127.0.0.1:not-a-port";
    return `PROXY 127.0.0.1:${proxy.port}`;
  });
  t.after(() => dispatcher.close());
  const fetchThrough = (url) => undiciFetch(url, { dispatcher, signal: AbortSignal.timeout(3_000) });

  assert.equal((await fetchThrough("http://plain.invalid/list")).status, 204);
  assert.deepEqual(proxy.forwarded, ["GET http://plain.invalid/list"]);

  await assert.rejects(fetchThrough("https://secure.invalid/tunnel"));
  assert.deepEqual(proxy.tunnels, ["secure.invalid:443"]);

  // The same decision is not reused: a bypassed target never reaches the proxy.
  await assert.rejects(fetchThrough("https://bypass.invalid/"));
  assert.deepEqual(proxy.tunnels, ["secure.invalid:443"], "a bypassed target must not be tunnelled");

  // An unsupported proxy type fails where the user can see it.
  await rejectsWith(fetchThrough("https://socks.invalid/"), /unsupported proxy/);
  assert.deepEqual(proxy.tunnels, ["secure.invalid:443"], "an unsupported proxy must not fall back");

  // A failed lookup is a failure, not permission to connect directly.
  await rejectsWith(fetchThrough("https://broken.invalid/"), /lookup is down/);

  // A decision that cannot be turned into a connection must be reported too.
  // It used to leave the request waiting forever, which is the worst outcome
  // available: no answer, no error.
  await rejectsWith(fetchThrough("https://malformed.invalid/"), /Invalid|URL|port/i);

  assert.deepEqual(asked, [
    "http://plain.invalid/list",
    "https://secure.invalid/tunnel",
    "https://bypass.invalid/",
    "https://socks.invalid/",
    "https://broken.invalid/",
    "https://malformed.invalid/",
  ]);
});

test("points the installed global fetch and WebSocket at the decision", async (t) => {
  const proxy = await startRecordingProxy();
  t.after(() => proxy.close());

  const asked = [];
  const originalSend = process.send;
  // Stand in for the main process: this is the real lookup path, only the
  // Electron half is replaced.
  process.send = (message) => {
    assert.equal(message.kind, "proxy.query");
    asked.push(message.url);
    const value = message.url.startsWith("http://")
      ? "DIRECT"
      : `PROXY 127.0.0.1:${proxy.port}`;
    process.nextTick(() =>
      handleProxyMessage({ kind: "proxy.result", id: message.id, ok: true, value }),
    );
  };
  t.after(() => {
    process.send = originalSend;
    // Tests run one file per process, but leaving a swapped global dispatcher
    // behind would confuse anything added later.
    setGlobalDispatcher(new Agent());
  });

  const { configureOutboundNetworking } = await jiti.import("../desktop/system-proxy.ts");
  configureOutboundNetworking(3_000);

  const response = await fetch("https://secure.invalid/installed", { signal: AbortSignal.timeout(3_000) }).catch(
    (error) => error,
  );
  assert.ok(response instanceof Error, "the tunnel is refused by the test proxy");
  assert.deepEqual(proxy.tunnels, ["secure.invalid:443"], "global fetch must use the decision");

  // The ChatGPT transport opens a WebSocket, and a WebSocket handshake is a
  // dispatch of its own. If install() did not cover it, this would connect
  // directly and the proxy would see nothing.
  const socket = new UndiciWebSocket("wss://codex.invalid/backend-api/codex/responses");
  const closed = once(socket, "close");
  socket.onerror = () => {};
  await closed;
  assert.deepEqual(proxy.tunnels, ["secure.invalid:443", "codex.invalid:443"]);
  assert.ok(
    asked.includes("https://codex.invalid/backend-api/codex/responses"),
    `the handshake must be looked up by its own URL, got ${JSON.stringify(asked)}`,
  );
});
