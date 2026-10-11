import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { getRpcSessionInfos } = await jiti.import("./rpc-manager.ts");

function makeRuntimeSession({ id, filePath, running, entries, parentSession }) {
  const timestamp = "2026-08-12T01:02:03.000Z";
  const manager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp/runtime-cwd", timestamp, parentSession }),
    getEntries: () => entries,
    getSessionFile: () => filePath,
    getSessionName: () => undefined,
  };
  return {
    isAlive: () => true,
    isRunning: () => running,
    inner: { sessionManager: manager },
    get sessionId() { return id; },
    get sessionFile() { return filePath; },
    get cwd() { return "/tmp/runtime-cwd"; },
  };
}

test("lists an accepted new prompt before its session file exists", (t) => {
  const previousRegistry = globalThis.__piSessions;
  const timestamp = "2026-08-12T01:02:04.000Z";
  const visible = makeRuntimeSession({
    id: "visible-runtime",
    filePath: join(tmpdir(), "pi-web-missing-runtime-session.jsonl"),
    running: true,
    entries: [{
      type: "message",
      id: "u1",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: "first" }, { type: "text", text: "prompt" }],
      },
    }],
  });
  const emptyEnsureSession = makeRuntimeSession({
    id: "empty-runtime",
    filePath: join(tmpdir(), "pi-web-missing-empty-session.jsonl"),
    running: false,
    entries: [],
  });
  globalThis.__piSessions = new Map([
    ["visible-runtime", visible],
    ["empty-runtime", emptyEnsureSession],
  ]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const infos = getRpcSessionInfos();

  assert.equal(infos.length, 1);
  assert.equal(infos[0].id, "visible-runtime");
  assert.equal(infos[0].firstMessage, "first prompt");
  assert.equal(infos[0].messageCount, 1);
  assert.equal(infos[0].transient, true);
});

test("runtime subagent identity follows the header parent, not metadata inherited by a fork", (t) => {
  const previousRegistry = globalThis.__piSessions;
  t.after(() => { globalThis.__piSessions = previousRegistry; });
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: { version: 1, parentSessionId: "parent", parentSessionPath: "/tmp/parent.jsonl", profile: "scout", description: "held" } },
    { type: "custom", customType: "pi-web:subagent-status", data: { version: 1, status: "running" } },
    { type: "message", timestamp: "2026-08-12T01:02:04.000Z", message: { role: "user", content: "held prompt" } },
  ];
  const child = makeRuntimeSession({ id: "child", filePath: "/tmp/child.jsonl", running: true, entries, parentSession: "/tmp/parent.jsonl" });
  const fork = makeRuntimeSession({ id: "fork", filePath: "/tmp/fork.jsonl", running: true, entries, parentSession: "/tmp/child.jsonl" });
  const ephemeral = makeRuntimeSession({ id: "ephemeral", filePath: undefined, running: true, entries });
  globalThis.__piSessions = new Map([["child", child], ["fork", fork], ["ephemeral", ephemeral]]);
  const infos = getRpcSessionInfos();
  assert.equal(infos.find(s => s.id === "child").relation.kind, "subagent");
  assert.equal(infos.find(s => s.id === "fork").relation, undefined);
  assert.equal(infos.find(s => s.id === "ephemeral").relation.kind, "subagent", "in-memory children have no persisted header parent");
});

test("keeps an idle runtime visible once its JSONL file exists", (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-runtime-session-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, "persisted\n");
  globalThis.__piSessions = new Map([["persisted-runtime", makeRuntimeSession({
    id: "persisted-runtime",
    filePath,
    running: false,
    entries: [{ type: "custom", customType: "pi-web:subagent", data: { version: 1, parentSessionId: "source-parent", parentSessionPath: "/tmp/source-parent.jsonl", profile: "scout", description: "copied metadata" } }],
  })]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
    rmSync(dir, { recursive: true, force: true });
  });

  const infos = getRpcSessionInfos();

  assert.equal(infos.length, 1);
  assert.equal(infos[0].transient, false);
  assert.equal(infos[0].relation, undefined, "persisted sessions without a header parent cannot inherit subagent identity");
});
