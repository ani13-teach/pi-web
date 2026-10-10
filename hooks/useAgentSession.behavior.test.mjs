/** Execute real hook callbacks with a minimal React dispatcher and fake IO.
 * Browser/UI effects are not mounted; the loader wiring is mounted explicitly.
 * Full window coverage is separate. Only timer constants are shortened.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const hookPath = resolve(root, "hooks/useAgentSession.ts");
const dispatcher = `
export let states = [];
export let actions = [];
export let effects = [];
export function reset() { states = []; actions = []; effects = []; }
export function useState(init) {
  const initial = typeof init === 'function' ? init() : init;
  const record = { initial, value: initial };
  record.set = (next) => { record.value = typeof next === 'function' ? next(record.value) : next; };
  states.push(record);
  return [initial, record.set];
}
export function useReducer(reducer, initial) {
  let state = initial;
  return [initial, (action) => { actions.push(action); state = reducer(state, action); }];
}
export const useRef = (current) => ({ current });
export const useCallback = (fn) => fn;
export const useMemo = (fn) => fn();
export const useEffect = (fn) => { effects.push(fn); };
export const useLayoutEffect = () => {};
export const useSyncExternalStore = (_subscribe, snapshot) => snapshot();
`;
const built = await build({
  stdin: { contents: 'export { useAgentSession } from "./hooks/useAgentSession.ts"; export * as debug from "react";', resolveDir: root, loader: "ts" },
  alias: { "@": root }, bundle: true, write: false, platform: "node", format: "esm", target: "node24",
  plugins: [{
    name: "hook-dispatcher",
    setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: dispatcher, loader: "js" }));
      builder.onLoad({ filter: /useAgentSession\.ts$/ }, async ({ path }) => {
        assert.equal(path, hookPath);
        const source = await readFile(path, "utf8");
        const contents = source.replace("const EVENT_STREAM_READY_TIMEOUT_MS = 60_000;", "const EVENT_STREAM_READY_TIMEOUT_MS = 20;")
          .replace("const EVENT_STREAM_IDLE_GRACE_MS = 30_000;", "const EVENT_STREAM_IDLE_GRACE_MS = 20;");
        return { contents, loader: "ts", resolveDir: resolve(root, "hooks") };
      });
    },
  }],
});
const { useAgentSession, debug } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const nextTurn = () => new Promise((done) => setImmediate(done));

function fixture(t, { autoReady = true, isNew = false } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = { fetch: globalThis.fetch, EventSource: globalThis.EventSource, error: console.error };
  const sources = [];
  const requests = [];
  const restorations = [];
  const promotions = [];
  const rekeys = [];
  let backgroundActive = false;
  let activation;
  let creation;
  let systemLoader;
  console.error = () => {};
  globalThis.EventSource = class {
    readyState = 0;
    closeCount = 0;
    onmessage = null;
    onerror = null;
    constructor() {
      sources.push(this);
      if (autoReady) queueMicrotask(() => {
        if (this.closeCount) return;
        this.readyState = 1;
        this.message({ type: "connected" });
      });
    }
    message(event) { if (!this.closeCount) this.onmessage?.({ data: JSON.stringify(event) }); }
    close() { this.readyState = 2; this.closeCount++; }
  };
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, body, signal: init?.signal, readyStates: sources.map((source) => source.readyState) });
    if (url === "/api/agent/new") return creation ? creation() : Response.json({ success: true, sessionId: "session-a" });
    if (body?.type === "ensure_session") return activation ? activation() : Response.json({ success: true, data: { sessionId: "session-a" } });
    if (body?.type === "prompt") return Response.json({ success: true, data: null });
    if (String(url).startsWith("/api/sessions/session-a")) return Response.json({
      sessionId: "session-a", filePath: "fixture.jsonl", tree: [], leafId: null,
      context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null },
    });
    if (url === "/api/agent/session-a" && !body) return Response.json({
      running: true, runtimeActive: true, backgroundActive,
      state: { isStreaming: false, isPromptRunning: false, isCompacting: false },
    });
    throw new Error(`Unexpected request ${url} ${body?.type ?? "GET"}`);
  };
  debug.reset();
  const hook = useAgentSession({
    session: isNew ? null : { id: "session-a", name: "Fixture" }, newSessionCwd: isNew ? "/fixture" : null,
    newSessionDraftKey: isNew ? "draft-a" : undefined,
    onSessionCreated: (...args) => promotions.push(args),
    chatInputRef: { current: { restoreSubmission: (...args) => restorations.push(args), rekeyDraft: (...args) => rekeys.push(args) } },
    onSystemInfoLoaderChange: (loader) => { systemLoader = loader; },
  });
  t.after(() => {
    for (const source of sources) source.close();
    globalThis.fetch = original.fetch;
    globalThis.EventSource = original.EventSource;
    console.error = original.error;
  });
  return {
    hook, sources, requests, restorations, promotions, rekeys,
    setActivation(value) { activation = value; },
    setCreation(value) { creation = value; },
    setBackground(value) { backgroundActive = value; },
    mountSystemInfoLoader() {
      // Mount only the real loader-registration effect, not window/UI effects.
      const effect = debug.effects.find((fn) => fn.toString().includes("onSystemInfoLoaderChange"));
      assert.ok(effect);
      t.after(effect());
      assert.equal(typeof systemLoader, "function");
      return systemLoader;
    },
    running: () => debug.states.find((state) => state.set === hook.setAgentRunning).value,
    value: (initial) => debug.states.find((state) => state.initial === initial).value,
  };
}

test("first-session creation has a deadline, ignores a late ID and can retry without sending the old draft", async (t) => {
  const f = fixture(t, { isNew: true });
  let resolveLate;
  f.setCreation(() => new Promise((done) => { resolveLate = done; }));
  const send = f.hook.handleSend("original unsent draft");
  await nextTurn();
  t.mock.timers.tick(20);
  await send;
  assert.equal(f.running(), false);
  assert.deepEqual(f.restorations, [["original unsent draft", undefined, "draft-a"]]);
  assert.equal(f.hook.sessionIdRef.current, null);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/api/agent/new");
  assert.equal(f.requests[0].signal.aborted, true);
  resolveLate(Response.json({ success: true, sessionId: "abandoned-id" }));
  await nextTurn();
  assert.equal(f.hook.sessionIdRef.current, null);
  assert.equal(f.sources.length, 0);
  assert.equal(f.promotions.length, 0);
  f.setCreation(undefined);
  await f.hook.handleSend("retry draft");
  assert.equal(f.requests.filter((entry) => entry.body?.type === "prompt").length, 1);
  assert.equal(f.requests.find((entry) => entry.body?.type === "prompt").body.message, "retry draft");
  assert.equal(f.hook.sessionIdRef.current, "session-a");
  assert.equal(f.promotions.length, 1);
  assert.deepEqual(f.rekeys, [["draft-a", "session-a"]]);
});

test("new-session creation and subsequent activation share the total pre-prompt deadline", async (t) => {
  const f = fixture(t, { isNew: true });
  let created;
  f.setCreation(() => new Promise((done) => { created = done; }));
  f.setActivation(() => new Promise(() => {}));
  const send = f.hook.handleSend("unsent");
  await nextTurn();
  t.mock.timers.tick(15);
  created(Response.json({ success: true, sessionId: "session-a" }));
  await nextTurn();
  assert.equal(f.requests.length, 2);
  t.mock.timers.tick(5);
  await send;
  assert.equal(f.running(), false);
  assert.equal(f.requests.some((entry) => entry.body?.type === "prompt"), false);
  assert.equal(f.sources.length, 0);
});

test("a first prompt is dispatched only after creation, activation and an event-ready source", async (t) => {
  const f = fixture(t, { isNew: true });
  await f.hook.handleSend("hello");
  assert.deepEqual(f.requests.map((entry) => `${entry.url}:${entry.body.type}`), [
    "/api/agent/new:ensure_session", "/api/agent/session-a:ensure_session", "/api/agent/session-a:prompt",
  ]);
  assert.deepEqual(f.requests[2].readyStates, [1]);
  assert.equal(f.promotions[0][0].id, "session-a");
});

test("opening a new System panel bounds creation and never publishes a late session ID", async (t) => {
  const f = fixture(t, { isNew: true });
  let resolveLate;
  f.setCreation(() => new Promise((done) => { resolveLate = done; }));
  const loaded = f.mountSystemInfoLoader()();
  const rejected = assert.rejects(loaded, /Timed out starting the agent session/);
  await nextTurn();
  t.mock.timers.tick(20);
  await rejected;
  resolveLate(Response.json({ success: true, sessionId: "abandoned-id" }));
  await nextTurn();
  assert.equal(f.hook.sessionIdRef.current, null);
  assert.equal(f.requests.length, 1);
  assert.equal(f.sources.length, 0);
});

test("hung activation restores the draft and ends the local stage without querying hung state", async (t) => {
  const f = fixture(t);
  let resolveLate;
  f.setActivation(() => new Promise((done) => { resolveLate = done; }));
  const send = f.hook.handleSend("keep this draft");
  await nextTurn();
  assert.equal(f.running(), true);
  t.mock.timers.tick(20);
  await send;
  assert.equal(f.running(), false);
  assert.deepEqual(f.restorations, [["keep this draft", undefined, "session-a"]]);
  assert.equal(f.value(f.hook.messages).length, 0);
  assert.deepEqual(f.requests.map((entry) => entry.body?.type ?? "GET"), ["ensure_session"]);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.sources.length, 0);
  // The fake bridge ignores abort. Its late reply must not open SSE or send.
  resolveLate(Response.json({ success: true, data: { sessionId: "session-a" } }));
  await nextTurn();
  assert.equal(f.sources.length, 0);
  assert.equal(f.running(), false);
});

test("pre-dispatch activation timeout preserves a different SDK run already observed in this view", async (t) => {
  const f = fixture(t);
  f.setActivation(() => new Promise(() => {}));
  const send = f.hook.handleSend("unsent submission");
  await nextTurn();
  f.hook.handleAgentEventRef.current({ type: "agent_start" });
  t.mock.timers.tick(20);
  await send;
  assert.equal(f.running(), true);
  assert.equal(f.restorations[0][0], "unsent submission");
  assert.deepEqual(f.requests.map((entry) => entry.body?.type ?? "GET"), ["ensure_session"]);
});

test("opening System or Tools also times out activation without reading live state or sending a prompt", async (t) => {
  const f = fixture(t);
  let resolveLate;
  f.setActivation(() => new Promise((done) => { resolveLate = done; }));
  const loader = f.mountSystemInfoLoader();
  const loaded = loader();
  const rejected = assert.rejects(loaded, /Timed out starting the agent session/);
  await nextTurn();
  t.mock.timers.tick(20);
  await rejected;
  assert.deepEqual(f.requests.map((entry) => entry.body?.type ?? "GET"), ["ensure_session"]);
  assert.equal(f.sources.length, 0);
  resolveLate(Response.json({ success: true, data: { sessionId: "session-a" } }));
  await nextTurn();
  assert.equal(f.requests.length, 1);
});

test("a stalled handshake uses the same deadline and sends no prompt", async (t) => {
  const f = fixture(t, { autoReady: false });
  const send = f.hook.handleSend("unsent");
  await nextTurn();
  assert.equal(f.sources.length, 1);
  t.mock.timers.tick(20);
  await send;
  assert.equal(f.running(), false);
  assert.equal(f.sources[0].closeCount, 1);
  assert.deepEqual(f.requests.map((entry) => entry.body?.type ?? "GET"), ["ensure_session"]);
  assert.equal(f.restorations[0][0], "unsent");
});

test("background activity retains the observer after prompt grace and delivers widget/status updates", async (t) => {
  const f = fixture(t);
  f.setBackground(true);
  await f.hook.handleSend("hello");
  assert.deepEqual(f.requests.filter((entry) => entry.body).map((entry) => entry.body.type), ["ensure_session", "prompt"]);
  f.sources[0].message({ type: "prompt_done" });
  t.mock.timers.tick(20);
  await nextTurn();
  assert.equal(f.sources[0].closeCount, 0);
  f.sources[0].message({ type: "extension_ui_request", method: "setStatus", statusKey: "background", statusText: "still working" });
  assert.deepEqual(f.value(f.hook.extensionStatuses), [{ key: "background", text: "still working" }]);
  f.sources[0].message({ type: "dormant", sessionId: "session-a" });
  assert.equal(f.sources[0].closeCount, 1);
  t.mock.timers.tick(1000);
  await nextTurn();
  assert.equal(f.sources.length, 1);
});

test("an ordinary idle prompt closes its observer after grace without any lease request", async (t) => {
  const f = fixture(t);
  await f.hook.handleSend("hello");
  f.sources[0].message({ type: "prompt_done" });
  t.mock.timers.tick(20);
  await nextTurn();
  assert.equal(f.sources[0].closeCount, 1);
  assert.equal(f.requests.some((entry) => String(entry.url).includes("/lease")), false);
});
