import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { Readable } from "node:stream";
import { createBackup, inspectBackup, restoreBackup, scanBackup } from "./index.ts";

const importRoot = (agent, archive) =>
  path.join(agent, "backup-imports", readFileSync(archive).subarray(8, 24).toString("hex"));

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-backup-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const agentDir = path.join(home, "agent"), projectDir = path.join(home, "project");
  await fs.mkdir(path.join(agentDir, "sessions", "--fixture--"), { recursive: true });
  await fs.mkdir(path.join(agentDir, "sessions", "workspace.v2"));
  await fs.mkdir(path.join(agentDir, "extensions"));
  await fs.mkdir(path.join(projectDir, ".pi"), { recursive: true });
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", defaultThinkingLevel: "high", apiKey: "SECRET", customID: "PERSONAL" }));
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { privateProvider: { baseUrl: "https://private.test", apiKey: "SECRET", headers: { Authorization: "SECRET" }, models: [{ id: "personal-id" }] } } }));
  await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ privateProvider: { key: "SECRET" }, unrelated: { key: "OTHER-PROVIDER-SECRET" } }));
  await fs.writeFile(path.join(agentDir, "sessions", "--fixture--", "session.jsonl"), '{"text":"PRIVATE-CONVERSATION"}\n');
  await fs.writeFile(path.join(agentDir, "sessions", "workspace.v2", "chat.jsonl"), '{"text":"DOTTED-SESSION"}\n');
  await fs.writeFile(path.join(agentDir, "sessions", "workspace.v2", "ignored.txt"), "not a session");
  await fs.writeFile(path.join(agentDir, "extensions", "custom.ts"), "private extension");
  await fs.writeFile(path.join(projectDir, ".pi", "settings.json"), '{"custom":"project secret"}');
  await fs.writeFile(path.join(projectDir, ".pi", "SYSTEM.md"), "project system instruction");
  await fs.writeFile(path.join(agentDir, "trust.json"), "TRUST-NEVER-INCLUDED");
  return { home, agentDir, projectDir, outputPath: path.join(home, "archive.pid"), password: "test-only-password" };
}

test("preflight scan reports only counts and kinds and matches the export", async (t) => {
  const o = await fixture(t);
  const publicScan = await scanBackup({ agentDir: o.agentDir, includePrivate: false });
  assert.equal(publicScan.entries, 1);
  assert.deepEqual(publicScan.kinds, { settings: 1 });
  assert.ok(!JSON.stringify(publicScan).includes("SECRET"));
  const exported = await createBackup({ ...o, includePrivate: false });
  assert.equal(exported.entries, publicScan.entries);
  assert.ok(exported.bytes > publicScan.bytes, "encrypted archive includes framing and authentication overhead");
  const privateScan = await scanBackup({ agentDir: o.agentDir, includePrivate: true, includeSessions: false });
  assert.equal(privateScan.kinds.models, 1);
  assert.equal(privateScan.kinds.auth, 1);
  assert.ok(!JSON.stringify(privateScan).includes("OTHER-PROVIDER-SECRET"));
});

test("private archive authenticates all bytes and isolates executable resources", async (t) => {
  const o = await fixture(t);
  let linked = true;
  try { await fs.symlink(o.agentDir, path.join(o.agentDir, "extensions", "leak"), "junction"); }
  catch (e) { if (e.code === "EPERM") linked = false; else throw e; }
  const result = await createBackup({ ...o, includePrivate: true, includeCustomizations: true, includeSessions: true });
  if (linked) assert.ok(result.warnings.some((w) => w.includes("link")));
  assert.ok(result.warnings.some((w) => w.includes("authentication credentials")));
  const encrypted = await fs.readFile(o.outputPath);
  for (const text of ["SECRET", "PRIVATE-CONVERSATION", "private extension", "https://private.test", "TRUST-NEVER-INCLUDED"])
    assert.equal(encrypted.includes(Buffer.from(text)), false);
  const info = await inspectBackup({ archivePath: o.outputPath, password: o.password });
  assert.equal(info.includePrivate, true);
  assert.ok(info.entries.some((e) => e.path === "agent/sessions/--fixture--/session.jsonl"));
  assert.ok(info.entries.some((e) => e.path === "agent/sessions/workspace.v2/chat.jsonl"));
  assert.ok(!info.entries.some((e) => e.path.endsWith("ignored.txt")));
  assert.ok(!info.entries.some((e) => e.path.includes("trust.json") || e.path.includes("leak/")));
  await assert.rejects(inspectBackup({ archivePath: o.outputPath, password: "wrong" }), /Invalid backup or password/);
  const tampered = path.join(o.home, "tampered.pid");
  encrypted[encrypted.length - 25] ^= 1;
  await fs.writeFile(tampered, encrypted);
  await assert.rejects(restoreBackup({ agentDir: o.agentDir, archivePath: tampered, password: o.password }), /Invalid backup or password/);
  assert.deepEqual((await fs.readdir(o.agentDir)).filter((name) => name.startsWith(".backup-restore-")), []);
  const dest = path.join(o.home, "new-agent");
  await fs.mkdir(dest);
  const restored = await restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password, projectDir: o.projectDir });
  assert.ok(restored.restored > 4);
  assert.ok(restored.warnings.some((w) => w.includes("review and migrate manually")));
  assert.equal(JSON.parse(await fs.readFile(path.join(importRoot(dest, o.outputPath), "agent", "settings.json"), "utf8")).apiKey, "SECRET");
  assert.equal(JSON.parse(await fs.readFile(path.join(importRoot(dest, o.outputPath), "agent", "models.json"), "utf8")).providers.privateProvider.apiKey, "SECRET");
  await assert.rejects(fs.stat(path.join(dest, "settings.json")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(dest, "models.json")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(importRoot(dest, o.outputPath), "project", ".pi", "settings.json"), "utf8"), '{"custom":"project secret"}');
  assert.equal(await fs.readFile(path.join(importRoot(dest, o.outputPath), "project", ".pi", "SYSTEM.md"), "utf8"), "project system instruction");
  assert.equal(await fs.readFile(path.join(o.projectDir, ".pi", "settings.json"), "utf8"), '{"custom":"project secret"}');
  assert.equal(await fs.readFile(path.join(dest, "sessions", "workspace.v2", "chat.jsonl"), "utf8"), '{"text":"DOTTED-SESSION"}\n');
  assert.equal(await fs.readFile(path.join(importRoot(dest, o.outputPath), "agent", "extensions", "custom.ts"), "utf8"), "private extension");
  await assert.rejects(fs.stat(path.join(dest, "extensions", "custom.ts")));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(importRoot(dest, o.outputPath), "agent", "auth.json"), "utf8")),
    { privateProvider: { key: "SECRET" }, unrelated: { key: "OTHER-PROVIDER-SECRET" } });
  await assert.rejects(fs.stat(path.join(dest, "auth.json")), { code: "ENOENT" });
  assert.equal((await restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password })).restored, 0);
});

test("command-like model configuration stays isolated on restore", async (t) => {
  const o = await fixture(t);
  await fs.writeFile(path.join(o.agentDir, "models.json"), JSON.stringify({ providers: {
    example: { apiKey: "!echo SYNTHETIC_ONLY", baseUrl: "https://example.invalid/v1", models: [{ id: "test" }] },
  } }));
  await createBackup({ ...o, includePrivate: true, includeSessions: false });
  const dest = path.join(o.home, "new-agent"); await fs.mkdir(dest);
  const restored = await restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password });
  assert.ok(restored.warnings.some((warning) => warning.includes("Provider configuration isolated")));
  await assert.rejects(fs.stat(path.join(dest, "models.json")), { code: "ENOENT" });
  assert.equal(JSON.parse(await fs.readFile(path.join(importRoot(dest, o.outputPath), "agent", "models.json"), "utf8"))
    .providers.example.apiKey, "!echo SYNTHETIC_ONLY");
});

test("command-like credentials stay isolated on restore", async (t) => {
  const o = await fixture(t);
  await fs.writeFile(path.join(o.agentDir, "auth.json"), JSON.stringify({ example: { type: "api_key", key: "!echo SYNTHETIC_ONLY" } }));
  await createBackup({ ...o, includePrivate: true, includeSessions: false });
  const dest = path.join(o.home, "new-agent"); await fs.mkdir(dest);
  const restored = await restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password });
  assert.ok(restored.warnings.some((warning) => warning.includes("Credentials isolated")));
  await assert.rejects(fs.stat(path.join(dest, "auth.json")), { code: "ENOENT" });
  assert.equal(JSON.parse(await fs.readFile(path.join(importRoot(dest, o.outputPath), "agent", "auth.json"), "utf8"))
    .example.key, "!echo SYNTHETIC_ONLY");
});

test("separate imports preserve existing credentials and each other's quarantined copies", async (t) => {
  const o = await fixture(t);
  await createBackup({ ...o, includePrivate: true, includeSessions: false });
  const dest = path.join(o.home, "restored"); await fs.mkdir(dest);
  await fs.writeFile(path.join(dest, "auth.json"), JSON.stringify({ existing: { key: "DO_NOT_REPLACE" } }));
  await restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password });
  const first = importRoot(dest, o.outputPath);
  await fs.writeFile(path.join(o.agentDir, "auth.json"), JSON.stringify({ newAccount: { key: "SECOND_SYNTHETIC" } }));
  const secondArchive = path.join(o.home, "second.pibak");
  await createBackup({ ...o, outputPath: secondArchive, includePrivate: true, includeSessions: false });
  const second = importRoot(dest, secondArchive);
  assert.notEqual(second, first);
  await restoreBackup({ agentDir: dest, archivePath: secondArchive, password: o.password });
  assert.equal(JSON.parse(await fs.readFile(path.join(dest, "auth.json"), "utf8")).existing.key, "DO_NOT_REPLACE");
  assert.equal(JSON.parse(await fs.readFile(path.join(first, "agent", "auth.json"), "utf8")).unrelated.key, "OTHER-PROVIDER-SECRET");
  assert.equal(JSON.parse(await fs.readFile(path.join(second, "agent", "auth.json"), "utf8")).newAccount.key, "SECOND_SYNTHETIC");
});

test("private auth is backed up without models.json", async (t) => {
  const o = await fixture(t);
  await fs.rm(path.join(o.agentDir, "models.json"));
  await createBackup({ ...o, includePrivate: true, includeSessions: false });
  const dest = path.join(o.home, "restored"); await fs.mkdir(dest);
  await restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password });
  assert.equal(JSON.parse(await fs.readFile(path.join(importRoot(dest, o.outputPath), "agent", "auth.json"), "utf8")).unrelated.key,
    "OTHER-PROVIDER-SECRET");
  await assert.rejects(fs.stat(path.join(dest, "auth.json")), { code: "ENOENT" });
});

test("project resources remain isolated without projectDir", async (t) => {
  const o = await fixture(t);
  await createBackup({ ...o, includePrivate: true, includeSessions: false });
  const dest = path.join(o.home, "restored"); await fs.mkdir(dest);
  const result = await restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password });
  assert.ok(result.warnings.some((w) => w.includes("review and migrate manually")));
  assert.equal(await fs.readFile(path.join(importRoot(dest, o.outputPath), "project", ".pi", "SYSTEM.md"), "utf8"),
    "project system instruction");
  await assert.rejects(fs.stat(path.join(dest, ".pi")), { code: "ENOENT" });
});

test("unsupported hard links fall back to exclusive encrypted copy", async (t) => {
  const o = await fixture(t);
  const originalLink = fs.link;
  fs.link = async () => { const error = new Error("link unavailable"); error.code = "ENOTSUP"; throw error; };
  try {
    const output = await createBackup({ ...o, includePrivate: true, includeSessions: false });
    assert.ok(output.warnings.some((warning) => warning.includes("atomic backup publishing")));
    assert.equal((await inspectBackup({ archivePath: o.outputPath, password: o.password })).includePrivate, true);
    const before = await fs.readFile(o.outputPath);
    await assert.rejects(createBackup({ ...o, includePrivate: false }), /Backup destination already exists/);
    assert.deepEqual(await fs.readFile(o.outputPath), before);
    assert.deepEqual((await fs.readdir(o.home)).filter((name) => name.endsWith(".tmp")), []);
  } finally { fs.link = originalLink; }
});

test("exclusive-copy failure removes only its own incomplete encrypted archive", async (t) => {
  const o = await fixture(t);
  const originalLink = fs.link, originalOpen = fs.open;
  fs.link = async () => { const error = new Error("link unavailable"); error.code = "ENOTSUP"; throw error; };
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === o.outputPath && args[1] === "wx")
      handle.write = async () => { throw new Error("synthetic disk error"); };
    return handle;
  };
  try {
    await assert.rejects(createBackup({ ...o, includePrivate: false }), /synthetic disk error/);
    await assert.rejects(fs.stat(o.outputPath), { code: "ENOENT" });
    assert.deepEqual((await fs.readdir(o.home)).filter((name) => name.endsWith(".tmp")), []);
  } finally { fs.link = originalLink; fs.open = originalOpen; }
});

test("destination appearing at commit cannot replace an existing archive", async (t) => {
  const o = await fixture(t);
  const originalLink = fs.link;
  fs.link = async (from, to) => {
    await fs.writeFile(to, "competing writer");
    return originalLink(from, to);
  };
  try {
    await assert.rejects(createBackup({ ...o, includePrivate: false }), /Backup destination already exists/);
  } finally { fs.link = originalLink; }
  assert.equal(await fs.readFile(o.outputPath, "utf8"), "competing writer");
  assert.deepEqual((await fs.readdir(o.home)).filter((name) => name.endsWith(".tmp")), []);
});

test("same-size source modification after collection aborts backup", async (t) => {
  const o = await fixture(t);
  const source = path.join(o.agentDir, "settings.json"), originalOpen = fs.open;
  fs.open = async (file, flags, ...rest) => {
    if (flags === "wx") {
      const contents = await fs.readFile(source);
      contents[0] = contents[0] === 123 ? 91 : 123;
      await fs.writeFile(source, contents);
    }
    return originalOpen(file, flags, ...rest);
  };
  try {
    await assert.rejects(createBackup({ ...o, includePrivate: true, includeSessions: false }), /Source changed during backup/);
  } finally { fs.open = originalOpen; }
  await assert.rejects(fs.stat(o.outputPath), { code: "ENOENT" });
});

test("same-size source modification during streaming aborts backup", async (t) => {
  const o = await fixture(t);
  const source = path.join(o.agentDir, "settings.json"), originalOpen = fs.open;
  fs.open = async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (file === source) {
      const createStream = handle.createReadStream.bind(handle);
      handle.createReadStream = (...options) => Readable.from((async function* () {
        for await (const chunk of createStream(...options)) yield chunk;
        const content = await fs.readFile(source);
        content[0] = content[0] === 123 ? 91 : 123;
        await fs.writeFile(source, content);
      })());
    }
    return handle;
  };
  try {
    await assert.rejects(createBackup({ ...o, includePrivate: true, includeSessions: false }), /Source changed during backup/);
  } finally { fs.open = originalOpen; }
  await assert.rejects(fs.stat(o.outputPath), { code: "ENOENT" });
});

test("public archive only contains reviewed settings values", async (t) => {
  const o = await fixture(t);
  await createBackup({ ...o, includePrivate: false, includeSessions: true, includeCustomizations: true, projectDir: o.projectDir });
  const info = await inspectBackup({ archivePath: o.outputPath, password: o.password });
  assert.deepEqual(info.entries.map((e) => e.path), ["agent/settings.json"]);
  const dest = path.join(o.home, "restored"); await fs.mkdir(dest);
  await restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dest, "settings.json"), "utf8")),
    { defaultThinkingLevel: "high", theme: "dark" });
});

test("conflicts skip by default and overwrite is rejected", async (t) => {
  const o = await fixture(t);
  await createBackup({ ...o, includePrivate: false });
  const dest = path.join(o.home, "destination"); await fs.mkdir(dest);
  await fs.writeFile(path.join(dest, "settings.json"), "previous");
  assert.equal((await restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password })).restored, 0);
  assert.equal(await fs.readFile(path.join(dest, "settings.json"), "utf8"), "previous");
  await assert.rejects(restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password, overwrite: true }),
    /does not support overwrite/);
  assert.equal(await fs.readFile(path.join(dest, "settings.json"), "utf8"), "previous");
  assert.deepEqual((await fs.readdir(dest)).filter((name) => name.startsWith(".backup-restore-")), []);
});

async function forged(file, entries, includePrivate = true) {
  const header = Buffer.concat([Buffer.from("PIDESK01"), randomBytes(16), randomBytes(12)]);
  const cipher = createCipheriv("aes-256-gcm", scryptSync("test-only-password", header.subarray(8, 24), 32,
    { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }), header.subarray(24));
  cipher.setAAD(header);
  function frame(obj) {
    const body = Buffer.from(JSON.stringify(obj)), length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, body]);
  }
  const content = Buffer.concat([frame({ version: 1, includePrivate, count: entries.length }),
    ...entries.flatMap((entry) => [frame({ path: entry.path, kind: entry.kind, size: entry.data.length }), Buffer.from(entry.data)])]);
  await fs.writeFile(file, Buffer.concat([header, cipher.update(content), cipher.final(), cipher.getAuthTag()]));
}

test("authenticated malicious paths, duplicate case and public fields are rejected", async (t) => {
  const o = await fixture(t);
  for (const entries of [
    [{ path: "agent/sessions/../../settings.json", kind: "session", data: Buffer.from("evil") }],
    [{ path: "agent/sessions/a.jsonl", kind: "session", data: Buffer.from("a") },
      { path: "agent/sessions/A.jsonl", kind: "session", data: Buffer.from("b") }],
  ]) {
    await forged(o.outputPath, entries);
    await assert.rejects(inspectBackup({ archivePath: o.outputPath, password: o.password }), /Invalid backup or password/);
  }
  await forged(o.outputPath, [{ path: "agent/settings.json", kind: "settings", data: Buffer.from('{"apiKey":"SECRET"}') }], false);
  await assert.rejects(inspectBackup({ archivePath: o.outputPath, password: o.password }), /Invalid backup or password/);
});

test("racing destination survives exclusive creation and is skipped", async (t) => {
  const o = await fixture(t);
  await createBackup({ ...o, includePrivate: false });
  const dest = path.join(o.home, "destination"); await fs.mkdir(dest);
  const originalLink = fs.link;
  fs.link = async (from, to) => {
    if (to === path.join(dest, "settings.json")) await fs.writeFile(to, "competing writer");
    return originalLink(from, to);
  };
  try {
    assert.deepEqual(await restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password }),
      { restored: 0, skipped: 1, warnings: ["Existing settings skipped: agent/settings.json"] });
  } finally { fs.link = originalLink; }
  assert.equal(await fs.readFile(path.join(dest, "settings.json"), "utf8"), "competing writer");
  assert.deepEqual((await fs.readdir(dest)).filter((name) => name.startsWith(".backup-restore-")), []);
});

test("rollback leaves a replaced target alone when identity changed", async (t) => {
  const o = await fixture(t);
  await createBackup({ ...o, includePrivate: true, includeSessions: false });
  const dest = path.join(o.home, "destination"); await fs.mkdir(dest);
  const first = path.join(importRoot(dest, o.outputPath), "agent", "settings.json");
  const originalLink = fs.link;
  fs.link = async (from, to) => {
    if (to === path.join(importRoot(dest, o.outputPath), "agent", "models.json")) {
      await fs.unlink(first);
      await fs.writeFile(first, "competing writer");
      throw new Error("injected failure");
    }
    return originalLink(from, to);
  };
  try {
    await assert.rejects(restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password }),
      /rollback was incomplete/);
  } finally { fs.link = originalLink; }
  assert.equal(await fs.readFile(first, "utf8"), "competing writer");
  const stages = (await fs.readdir(dest)).filter((name) => name.startsWith(".backup-restore-"));
  assert.equal(stages.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(dest, stages[0], "0"), "utf8")).apiKey, "SECRET");
});

test("early parse failure releases streams and permits stage cleanup", async (t) => {
  const o = await fixture(t);
  await createBackup({ ...o, includePrivate: false });
  const dest = path.join(o.home, "destination"); await fs.mkdir(dest);
  const originalMkdtemp = fs.mkdtemp;
  fs.mkdtemp = async (...args) => {
    const stage = await originalMkdtemp(...args);
    await forged(o.outputPath, [{ path: "agent/sessions/../bad.jsonl", kind: "session", data: Buffer.from("bad") }]);
    return stage;
  };
  try {
    await assert.rejects(restoreBackup({ agentDir: dest, archivePath: o.outputPath, password: o.password }),
      /Invalid backup or password/);
  } finally { fs.mkdtemp = originalMkdtemp; }
  assert.deepEqual((await fs.readdir(dest)).filter((name) => name.startsWith(".backup-restore-")), []);
  await fs.rm(o.outputPath);
});
