import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { filterOrdinarySessions, listSessionFamilies } = await jiti.import("./session-family.ts");
const { listSessionsIncremental, resetSessionScanIndexForTests } = await jiti.import("./session-list-scanner.ts");
const { listAllSessions, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const timestamp = "2026-01-01T00:00:00.000Z";
const line = (entry) => JSON.stringify(entry) + "\n";
const message = (id, role, content, time = timestamp) => ({
  type: "message", id, parentId: null, timestamp: time, message: { role, content },
});

function fixture(t) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-scanner-"));
  const dir = join(root, "sessions", "project");
  fs.mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = root;
  resetSessionScanIndexForTests();
  invalidateSessionListCache();
  t.after(() => {
    resetSessionScanIndexForTests();
    invalidateSessionListCache();
    globalThis.__piSessionPathCache = undefined;
    globalThis.__piPathToSessionIdCache = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function write(id, entries = [], extraHeader = {}) {
    const path = join(dir, `${id}.jsonl`);
    fs.writeFileSync(path, line({ type: "session", version: 3, id, cwd: root, timestamp, ...extraHeader }) + entries.map(line).join(""));
    return path;
  }
  return { root, dir, write, indexPath: join(root, "pi-web-session-index.json") };
}

async function sdkMetadata() {
  return (await SessionManager.listAll()).map((session) => {
    const info = { ...session };
    delete info.allMessagesText;
    return info;
  });
}

test("matches SDK metadata and tie ordering across cache hits, mutations, and restarts", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [
    message("a1", "user", [{ type: "image", data: "ignored", mimeType: "image/png" }, { type: "text", text: "first" }, { type: "text", text: "request" }]),
    message("a2", "assistant", [{ type: "text", text: "answer" }]),
    message("a3", "toolResult", [{ type: "text", text: "output" }], "2026-01-03T00:00:00.000Z"),
    { type: "custom", data: "x".repeat(256 * 1024) },
  ]);
  const b = write("b", [message("b1", "user", "forked request")], { parentSession: a });
  const c = write("c");
  const opened = [];
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (path, ...args) => {
    opened.push(path);
    return createReadStream(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  async function check(label, expectedReads) {
    const expected = await sdkMetadata();
    opened.length = 0;
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    assert.deepEqual([...opened].sort(), [...expectedReads].sort(), `${label}: scanned files`);
  }

  await check("cold", [a, b, c]);
  await check("warm", []);
  if (process.platform !== "win32") assert.equal(fs.statSync(indexPath).mode & 0o777, 0o600);
  resetSessionScanIndexForTests();
  await check("persisted cache", []);

  fs.appendFileSync(a, line({ type: "session_info", name: "  Renamed  " }));
  await check("rename preserves equal-time order", [a]);
  fs.appendFileSync(a, line({ type: "session_info", name: " " }));
  await check("explicit name clear", [a]);
  fs.appendFileSync(b, line(message("b2", "assistant", "new activity", "2026-01-02T00:00:00.000Z")));
  await check("append", [b]);
  write("a", [message("replacement", "user", "rewritten")]);
  await check("whole-file rewrite", [a]);
  const d = write("d", [message("d1", "user", "new session")]);
  fs.rmSync(c);
  await check("create and delete", [d]);

  resetSessionScanIndexForTests();
  fs.appendFileSync(a, line({ type: "session_info", name: "changed while stopped" }));
  fs.rmSync(b);
  await check("restart revalidates changed and deleted files", [a]);
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.deepEqual(Object.keys(persisted.entries).sort(), [a, d].sort());
});

test("discards malformed persisted entries and rebuilds the list from valid session files", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [message("a1", "user", "healthy")]);
  write("b", [message("b1", "user", "also healthy")]);
  const expected = await listSessionsIncremental();
  const pristine = fs.readFileSync(indexPath, "utf8");
  const corruptions = [
    ["missing fingerprint", (entry) => { delete entry.fp; }],
    ["null fingerprint", (entry) => { entry.fp = null; }],
    ["string size", (entry) => { entry.fp.size = String(entry.fp.size); }],
    ["negative size", (entry) => { entry.fp.size = -1; }],
    ["invalid mtime", (entry) => { entry.fp.mtimeMs = null; }],
    ["missing metadata", (entry) => { delete entry.info; }],
    ["mismatched path", (entry) => { entry.info.path = "/elsewhere/session.jsonl"; }],
    ["invalid id", (entry) => { entry.info.id = null; }],
    ["invalid cwd", (entry) => { entry.info.cwd = []; }],
    ["invalid first message", (entry) => { entry.info.firstMessage = 1; }],
    ["invalid name", (entry) => { entry.info.name = {}; }],
    ["invalid parent", (entry) => { entry.info.parentSessionPath = []; }],
    ["invalid count", (entry) => { entry.info.messageCount = -1; }],
    ["invalid created", (entry) => { entry.info.created = "not a date"; }],
    ["invalid modified", (entry) => { entry.info.modified = "not a date"; }],
    ["null date", (entry) => { entry.info.created = null; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const index = JSON.parse(pristine);
    corrupt(index.entries[a]);
    fs.writeFileSync(indexPath, JSON.stringify(index));
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    const sessions = await listAllSessions({ force: true });
    assert.deepEqual(sessions.map((s) => s.id), expected.map((s) => s.id), label);
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, `${label}: repaired cache survives restart`);
  }
  for (const source of ["{", "null", '{"version":2,"entries":{}}', '{"version":1,"entries":[]}', '{"version":1,"entries":{"broken":null}}']) {
    fs.writeFileSync(indexPath, source);
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, source);
  }
});

test("retains SDK handling of partial lines, activity timestamps, and empty sessions", async (t) => {
  const { dir, write } = fixture(t);
  const a = write("a", [
    message("a1", "assistant", "not the first user message"),
    message("a2", "user", []),
    { ...message("a3", "user", "user message"), message: { role: "user", content: "user message", timestamp: Date.parse("2026-01-04T00:00:00.000Z") } },
  ]);
  fs.appendFileSync(a, '{"unfinished":');
  const b = write("b");
  fs.writeFileSync(b, "\nnot json\n" + fs.readFileSync(b, "utf8"));
  fs.writeFileSync(join(dir, "invalid.jsonl"), line(message("invalid", "user", "no header")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});

test("indexes running subagent identity beyond setup entries and large payloads, without retaining prompts", async (t) => {
  const { write, indexPath } = fixture(t);
  const parent = write("parent", [message("p1", "user", "parent request")]);
  const child = write("child", [
    { type: "model_change", provider: "mock", modelId: "mock" },
    { type: "thinking_level_change", thinkingLevel: "high" },
    { type: "session_info", name: "scout#12345678" },
    message("setup", "user", "x".repeat(300 * 1024)),
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1, parentSessionId: "parent", parentSessionPath: parent,
      profile: "scout", description: "held child", task: "SECRET_TASK_" + "y".repeat(300 * 1024),
      resourceSnapshot: { exactSystemPrompt: "SECRET_PROMPT" },
    } },
    { type: "custom", customType: "pi-web:subagent-status", data: { version: 1, status: "running" } },
  ], { parentSession: parent });
  const relation = { kind: "subagent", parentSessionId: "parent", profile: "scout", description: "held child", status: "running" };

  const cold = await listSessionsIncremental();
  assert.deepEqual(cold.find(s => s.id === "child").subagentRelation, relation);
  assert.equal(JSON.stringify(cold).includes("SECRET_TASK_"), false);
  assert.equal(JSON.stringify(cold).includes("SECRET_PROMPT"), false);
  assert.equal(fs.readFileSync(indexPath, "utf8").includes("SECRET_TASK_"), false);
  resetSessionScanIndexForTests();
  const restored = await listSessionsIncremental();
  assert.deepEqual(restored.find(s => s.id === "child").subagentRelation, relation);
  const sessions = await listAllSessions({ force: true });
  assert.deepEqual(sessions.find(s => s.id === "child").relation, relation);
  assert.deepEqual(filterOrdinarySessions(sessions).map(s => s.id), ["parent"]);
  assert.equal(listSessionFamilies(sessions).find(f => f.root.id === "parent").subagents[0].id, "child");
  assert.equal((await listSessionsIncremental()).find(s => s.id === "child"), restored.find(s => s.id === "child"), "listing reuses the cached summary object");
  sessions.find(s => s.id === "child").relation.status = "failed";
  assert.equal((await listAllSessions({ force: true })).find(s => s.id === "child").relation.status, "running", "UI projection does not expose the scanner's mutable relation");

  fs.appendFileSync(child, line({ type: "custom", customType: "pi-web:subagent-result", data: { version: 1, status: "completed", result: "SECRET_RESULT" } }));
  assert.equal((await listAllSessions({ force: true })).find(s => s.id === "child").relation.status, "completed");
  assert.equal(fs.readFileSync(indexPath, "utf8").includes("SECRET_RESULT"), false);
  fs.appendFileSync(child, line({ type: "custom", customType: "pi-web:subagent-status", data: { version: 1, status: "running" } }));
  assert.equal((await listAllSessions({ force: true })).find(s => s.id === "child").relation.status, "running", "resume supersedes terminal state");
});

test("copied subagent metadata cannot hide an ordinary fork or confuse similarly named sessions", async (t) => {
  const { write } = fixture(t);
  const parent = write("parent");
  const metadata = { type: "custom", customType: "pi-web:subagent", data: {
    version: 1, parentSessionId: "parent", parentSessionPath: parent, profile: "scout", description: "child",
  } };
  const child = write("child", [metadata], { parentSession: parent });
  write("fork", [{ type: "session_info", name: "scout#deadbeef" }, metadata], { parentSession: child });
  write("named", [{ type: "session_info", name: "scout#deadbeef" }], { parentSession: parent });
  write("malformed", [{ ...metadata, data: { ...metadata.data, version: 2 } }], { parentSession: parent });
  const sessions = await listAllSessions({ force: true });
  assert.equal(sessions.find(s => s.id === "child").relation.kind, "subagent");
  for (const id of ["fork", "named", "malformed"]) assert.equal(sessions.find(s => s.id === id).relation.kind, "fork", id);
  assert.deepEqual(new Set(filterOrdinarySessions(sessions).map(s => s.id)), new Set(["parent", "fork", "named", "malformed"]));
});

test("partial and invalid lifecycle entries preserve the last valid subagent status and rescan on completion", async (t) => {
  const { write } = fixture(t);
  const parent = write("parent");
  const child = write("child", [
    { type: "custom", customType: "pi-web:subagent", data: { version: 1, parentSessionId: "parent", parentSessionPath: parent, profile: "scout", description: "child" } },
    { type: "custom", customType: "pi-web:subagent-status", data: { version: 1, status: "running" } },
  ], { parentSession: parent });
  const terminal = line({ type: "custom", customType: "pi-web:subagent-result", data: { version: 1, status: "failed" } });
  fs.appendFileSync(child, terminal.slice(0, -8));
  assert.equal((await listAllSessions({ force: true })).find(s => s.id === "child").relation.status, "running");
  fs.appendFileSync(child, terminal.slice(-8));
  assert.equal((await listAllSessions({ force: true })).find(s => s.id === "child").relation.status, "failed");
  fs.appendFileSync(child, line({ type: "custom", customType: "pi-web:subagent-status", data: { version: 2, status: "running" } }) + line({ type: "custom", customType: "pi-web:subagent-result", data: { version: 1, status: "unknown" } }));
  assert.equal((await listAllSessions({ force: true })).find(s => s.id === "child").relation.status, "failed");
});

test("old scanner indexes are rebuilt and invalid relation summaries are not trusted", async (t) => {
  const { write, indexPath } = fixture(t);
  const parent = write("parent");
  write("child", [{ type: "custom", customType: "pi-web:subagent", data: { version: 1, parentSessionId: "parent", parentSessionPath: parent, profile: "scout", description: "child" } }], { parentSession: parent });
  const expected = await listSessionsIncremental();
  const pristine = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(pristine.version, 3);
  const old = structuredClone(pristine);
  old.version = 2;
  for (const entry of Object.values(old.entries)) delete entry.info.subagentRelation;
  fs.writeFileSync(indexPath, JSON.stringify(old));
  resetSessionScanIndexForTests();
  assert.deepEqual(await listSessionsIncremental(), expected, "version 2 must be rescanned");
  for (const corrupt of [
    r => { r.kind = "fork"; }, r => { r.parentSessionId = 1; },
    r => { r.profile = []; }, r => { r.description = {}; }, r => { r.status = "unknown"; },
  ]) {
    const index = structuredClone(pristine);
    const entry = Object.values(index.entries).find(e => e.info.id === "child");
    corrupt(entry.info.subagentRelation);
    fs.writeFileSync(indexPath, JSON.stringify(index));
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, "invalid summaries force a rescan");
  }
});

test("upgrades an already loaded v2 in-memory index instead of persisting stale summaries as v3", async (t) => {
  const { write, indexPath } = fixture(t);
  const parent = write("parent");
  write("child", [{ type: "custom", customType: "pi-web:subagent", data: { version: 1, parentSessionId: "parent", parentSessionPath: parent, profile: "scout", description: "child" } }], { parentSession: parent });
  const expected = await listSessionsIncremental();
  const old = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  old.version = 2;
  for (const entry of Object.values(old.entries)) delete entry.info.subagentRelation;
  fs.writeFileSync(indexPath, JSON.stringify(old));
  for (const entry of globalThis.__piWebScanIndex.values()) delete entry.info.subagentRelation;
  globalThis.__piWebScanIndexLoaded = true;
  globalThis.__piWebScanIndexVersion = 2;
  write("new", [message("n1", "user", "new file triggers index persistence")]);
  const upgraded = await listSessionsIncremental();
  assert.equal(globalThis.__piWebScanIndexVersion, 3);
  assert.deepEqual(upgraded.find(s => s.id === "child").subagentRelation, { kind: "subagent", parentSessionId: "parent", profile: "scout", description: "child", status: "interrupted" });
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(persisted.version, 3);
  assert.equal(Object.values(persisted.entries).find(e => e.info.id === "child").info.subagentRelation.kind, "subagent");
  resetSessionScanIndexForTests();
  assert.deepEqual(await listSessionsIncremental(), upgraded, "upgrade stays correct after restart");
  assert.equal(upgraded.length, expected.length + 1);

  // Previous builds had no in-memory version marker at all.
  for (const entry of globalThis.__piWebScanIndex.values()) delete entry.info.subagentRelation;
  globalThis.__piWebScanIndexVersion = undefined;
  assert.deepEqual(await listSessionsIncremental(), upgraded, "missing version also invalidates retained globals");
});

test("discovers sessions through project directory symlinks", { skip: process.platform === "win32" }, async (t) => {
  const { root, dir, write } = fixture(t);
  write("a", [message("a1", "user", "linked")]);
  const external = join(root, "external-project");
  fs.renameSync(dir, external);
  fs.symlinkSync(external, dir, "dir");
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});
