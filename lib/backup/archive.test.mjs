import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { ARCHIVE_LIMITS, readArchive, validateManifest, writeArchive } from "./archive.ts";

const password = "synthetic-password-not-a-user-secret";
const hash = (data) => createHash("sha256").update(data).digest("hex");
const derive = (salt) => scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
const frame = (v) => { const body = Buffer.from(JSON.stringify(v)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); return Buffer.concat([prefix, body]); };
const clone = (v) => JSON.parse(JSON.stringify(v));
function collection(data = Buffer.from('{"secret":"synthetic credential ONLY"}')) {
  const entry = { path: "agent/settings.json", rootId: "agent", resourceId: "settings", relativePath: "settings.json", size: data.length, sha256: hash(data), kind: "settings" };
  const manifest = { formatVersion: 2, archiveId: "test-archive", appVersion: "test", sdkVersion: "test", createdAt: "2026-01-01T00:00:00.000Z",
    roots: [{ id: "agent", kind: "agent", label: "Synthetic agent", originalPath: "C:\\synthetic\\agent" }],
    resources: [{ id: "settings", rootId: "agent", relativePath: "settings.json", label: "Settings", kind: "settings", executable: true, sensitive: true, availability: "offlineReady" }],
    entries: [entry], warnings: [], uiState: { "pi-theme": "dark" } };
  return { manifest, entries: [{ ...entry, data }], preview: { entries: 1, bytes: data.length, kinds: { settings: 1 }, warnings: [], blockers: [], roots: manifest.roots, resources: manifest.resources, fingerprint: "synthetic" } };
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-archive-synthetic-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const archivePath = path.join(dir, "test.pibak"), stageDir = path.join(dir, "stage"); await fs.mkdir(stageDir, { mode: 0o700 });
  return { dir, archivePath, stageDir };
}
async function seal(file, manifest, bodies, { legacy = false, head, suffix = Buffer.alloc(0), frames, tail } = {}) {
  const header = Buffer.alloc(legacy ? 36 : 48); Buffer.from(legacy ? "PIDESK01" : "PIDESK02").copy(header);
  if (!legacy) { header.writeUInt32BE(16384, 8); header.writeUInt32BE(8, 12); header.writeUInt32BE(1, 16); }
  const saltStart = legacy ? 8 : 20, nonceStart = legacy ? 24 : 36;
  randomBytes(16).copy(header, saltStart); randomBytes(12).copy(header, nonceStart);
  const key = derive(header.subarray(saltStart, saltStart + 16)), cipher = createCipheriv("aes-256-gcm", key, header.subarray(nonceStart)); cipher.setAAD(header);
  const parts = [frame(head ?? { formatVersion: 2, count: manifest.entries.length })];
  for (const [i, e] of manifest.entries.entries()) parts.push(frame(frames?.[i] ?? e), bodies[i]);
  if (!legacy) parts.push(tail ?? frame(manifest)); parts.push(suffix);
  await fs.writeFile(file, Buffer.concat([header, cipher.update(Buffer.concat(parts)), cipher.final(), cipher.getAuthTag()])); key.fill(0);
}

test("v2 single encryption roundtrip, entry/whole archive hashes, staging and short-lived key", async (t) => {
  const f = await fixture(t), c = collection();
  const written = await writeArchive({ outputPath: f.archivePath, password, collection: c });
  const bytes = await fs.readFile(f.archivePath);
  assert.equal(written.entries, 1); assert.equal(written.bytes, bytes.length);
  assert.equal(bytes.subarray(0, 8).toString(), "PIDESK02");
  assert.equal(bytes.includes(c.entries[0].data), false); assert.equal(bytes.includes(Buffer.from(c.manifest.roots[0].originalPath)), false);
  const inspected = await readArchive({ archivePath: f.archivePath, password });
  assert.deepEqual(inspected.manifest, c.manifest); assert.equal(inspected.archiveHash, hash(bytes)); assert.equal(inspected.legacy, false);
  const result = await readArchive({ archivePath: f.archivePath, key: inspected.key, stageDir: f.stageDir });
  assert.deepEqual(await fs.readFile(path.join(f.stageDir, "0")), c.entries[0].data);
  assert.deepEqual(result.manifest, inspected.manifest); assert.equal(inspected.key.length, 32); result.key.fill(0); inspected.key.fill(0);
});
for (const variant of ["wrong password", "tampered body", "tampered tag", "truncated", "unbounded KDF", "future magic"]) {
  test(`${variant} is rejected and leaves no staged plaintext`, async (t) => {
    const f = await fixture(t), c = collection(); await writeArchive({ outputPath: f.archivePath, password, collection: c });
    let bytes = await fs.readFile(f.archivePath);
    if (variant === "tampered body") bytes[bytes.length - 20] ^= 1;
    if (variant === "tampered tag") bytes[bytes.length - 1] ^= 1;
    if (variant === "truncated") bytes = bytes.subarray(0, bytes.length - 3);
    if (variant === "unbounded KDF") bytes.writeUInt32BE(0xffffffff, 8);
    if (variant === "future magic") Buffer.from("PIDESK03").copy(bytes);
    await fs.writeFile(f.archivePath, bytes);
    await assert.rejects(readArchive({ archivePath: f.archivePath, password: variant === "wrong password" ? "wrong" : password, stageDir: f.stageDir }), /Invalid backup or password/);
    assert.deepEqual(await fs.readdir(f.stageDir), []);
  });
}
test("manifest hash disagreement, record mismatch and trailing authenticated data fail closed", async (t) => {
  const f = await fixture(t), c = collection();
  for (const mode of ["hash", "manifest", "tail"]) {
    const m = clone(c.manifest), options = {};
    if (mode === "hash") m.entries[0].sha256 = "0".repeat(64);
    if (mode === "manifest") options.frames = [{ ...m.entries[0], resourceId: "other" }];
    if (mode === "tail") options.suffix = Buffer.from("garbage");
    await seal(f.archivePath, m, [c.entries[0].data], options);
    await assert.rejects(readArchive({ archivePath: f.archivePath, password, stageDir: f.stageDir }), /Invalid backup or password/);
    assert.deepEqual(await fs.readdir(f.stageDir), []);
  }
});
test("empty archive with UI preferences is authenticated", async (t) => {
  const f = await fixture(t), c = collection(); c.manifest.roots = []; c.manifest.resources = []; c.manifest.entries = []; c.entries = [];
  await writeArchive({ outputPath: f.archivePath, password, collection: c });
  const result = await readArchive({ archivePath: f.archivePath, password }); assert.deepEqual(result.manifest.uiState, { "pi-theme": "dark" }); result.key.fill(0);
  await assert.rejects(readArchive({ archivePath: f.archivePath, password: "wrong" }), /Invalid/);
});
test("reject missing password, invalid derived keys and scan blockers", async (t) => {
  const f = await fixture(t), c = collection();
  await assert.rejects(writeArchive({ outputPath: f.archivePath, password: "", collection: c }), /password/);
  c.preview.blockers.push("synthetic missing source"); await assert.rejects(writeArchive({ outputPath: f.archivePath, password, collection: c }), /blockers/);
  for (const key of [Buffer.alloc(31), Buffer.alloc(33), "not a key"]) await assert.rejects(readArchive({ archivePath: f.archivePath, key }), /32-byte/);
});
test("same-size source mutation fails even when scan stat metadata is unavailable", async (t) => {
  const f = await fixture(t), c = collection(Buffer.from("AAAA")), source = path.join(f.dir, "source.json");
  await fs.writeFile(source, "AAAA"); c.entries[0].source = source; delete c.entries[0].data;
  await fs.writeFile(source, "BBBB");
  await assert.rejects(writeArchive({ outputPath: f.archivePath, password, collection: c }), /Source changed/);
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ["source.json", "stage"]);
});
test("named handle identity and scan inode are checked", async (t) => {
  const f = await fixture(t), c = collection(Buffer.from("AAAA")), source = path.join(f.dir, "source.json");
  await fs.writeFile(source, "AAAA"); const stat = await fs.stat(source);
  c.entries[0] = { ...c.entries[0], source, data: undefined, dev: stat.dev, ino: stat.ino };
  await fs.rename(source, path.join(f.dir, "old.json")); await fs.writeFile(source, "AAAA");
  await assert.rejects(writeArchive({ outputPath: f.archivePath, password, collection: c }), /Source changed/);
});
test("destination exists is never overwritten", async (t) => {
  const f = await fixture(t); await fs.writeFile(f.archivePath, "old archive sentinel");
  await assert.rejects(writeArchive({ outputPath: f.archivePath, password, collection: collection() }), /destination already exists/);
  assert.equal(await fs.readFile(f.archivePath, "utf8"), "old archive sentinel");
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ["stage", "test.pibak"]);
});
test("atomic publication does not depend on hardlinks and never uses a visible copy fallback", async (t) => {
  const f = await fixture(t), original = fs.link;
  fs.link = async () => { throw Object.assign(new Error("synthetic filesystem"), { code: "ENOTSUP" }); };
  try { await writeArchive({ outputPath: f.archivePath, password, collection: collection() }); }
  finally { fs.link = original; }
  assert.equal((await readArchive({ archivePath: f.archivePath, password })).manifest.entries.length, collection().entries.length);
  assert.deepEqual((await fs.readdir(f.dir)).sort(), [path.basename(f.archivePath), "stage"].sort());
});
test("export and read cancellation close handles and clean only their own files", async (t) => {
  const f = await fixture(t), c = collection(), exporting = new AbortController();
  await assert.rejects(writeArchive({ outputPath: f.archivePath, password, collection: c, signal: exporting.signal, progress: () => exporting.abort() }), /cancelled/);
  assert.deepEqual(await fs.readdir(f.dir), ["stage"]);
  await writeArchive({ outputPath: f.archivePath, password, collection: c });
  await fs.writeFile(path.join(f.stageDir, "sentinel"), "keep"); const reading = new AbortController();
  await assert.rejects(readArchive({ archivePath: f.archivePath, password, stageDir: f.stageDir, signal: reading.signal, progress: () => reading.abort() }), /cancelled/);
  assert.deepEqual(await fs.readdir(f.stageDir), ["sentinel"]);
  await fs.unlink(f.archivePath); // Windows handle closure is needed for this to succeed.
});
test("preexisting numeric stage files are not replaced or deleted", async (t) => {
  const f = await fixture(t); await writeArchive({ outputPath: f.archivePath, password, collection: collection() });
  await fs.writeFile(path.join(f.stageDir, "0"), "sentinel");
  await assert.rejects(readArchive({ archivePath: f.archivePath, password, stageDir: f.stageDir }), /Invalid/);
  assert.equal(await fs.readFile(path.join(f.stageDir, "0"), "utf8"), "sentinel");
});
const maliciousCases = {
  "intrinsic script flag downgrade": (m) => { m.resources[0].relativePath = "extensions/test.js"; m.resources[0].executable = false; m.entries[0].relativePath = "extensions/test.js"; m.entries[0].path = "agent/extensions/test.js"; },
  "policy flag downgrade": (m) => { m.resources[0].relativePath = "automode.json"; m.entries[0].relativePath = "automode.json"; m.entries[0].path = "agent/automode.json"; },
  "noncanonical calendar date": (m) => { m.createdAt = "2026-02-30T00:00:00.000Z"; },
  "overlapping resource": (m) => { m.resources[0].relativePath = "skills"; m.resources.push({ ...m.resources[0], id: "nested", relativePath: "skills/test" }); },
  "file-backed package": (m) => { m.roots[0].kind = "external"; m.resources[0].kind = "package"; m.entries[0].kind = "package"; },
  "excessive path depth": (m) => { m.entries[0].relativePath = "skills/" + "a/".repeat(65) + "b"; },
  "sdk root": (m) => { m.roots[0].kind = "sdk"; },
  "app root": (m) => { m.roots[0].kind = "app"; },
  "agent arbitrary source": (m) => { m.resources[0].relativePath = "node_modules/runtime.js"; },
  "home arbitrary source": (m) => { m.roots[0].kind = "home"; },
  "home workflows excluded": (m) => { m.roots[0].kind = "home"; m.resources[0].relativePath = ".agents/workflows/x"; },
  "project business file": (m) => { m.roots[0].kind = "project"; m.resources[0].relativePath = "src/main.ts"; },
  "root escape": (m) => { m.entries[0].rootId = "elsewhere"; },
  "resource escape": (m) => { m.entries[0].relativePath = "auth.json"; },
  "kind mismatch": (m) => { m.entries[0].kind = "auth"; },
  "resource unknown kind": (m) => { m.resources[0].kind = "sdk"; },
  "single file subtree": (m) => { m.entries[0].relativePath = "settings.json/body"; m.entries[0].path = "agent/settings.json/body"; },
  "traversal": (m) => { m.entries[0].relativePath = "../auth.json"; },
  "absolute": (m) => { m.entries[0].relativePath = "/auth.json"; },
  "UNC": (m) => { m.entries[0].relativePath = "\\\\host\\share"; },
  "ADS": (m) => { m.entries[0].relativePath = "settings.json:stream"; },
  "reserved Windows name": (m) => { m.entries[0].relativePath = "nul.json"; },
  "unknown preference": (m) => { m.uiState["api-key"] = "bad"; },
  "oversized preference": (m) => { m.uiState["pi-theme"] = "x".repeat(1024 * 1024 + 1); },
  "future manifest": (m) => { m.formatVersion = 3; },
  "extra schema field": (m) => { m.trusted = true; },
  "illegal id": (m) => { m.roots[0].id = "../root"; },
  "unsafe external multiple resources": (m) => { m.roots[0].kind = "external"; m.resources.push({ ...m.resources[0], id: "another", relativePath: "another.json" }); },
};
for (const [name, mutate] of Object.entries(maliciousCases)) test(`authenticated malicious schema: ${name}`, async (t) => {
  const f = await fixture(t), c = collection(); mutate(c.manifest);
  await seal(f.archivePath, c.manifest, [c.entries[0].data]);
  await assert.rejects(readArchive({ archivePath: f.archivePath, password, stageDir: f.stageDir }), /Invalid/);
  assert.deepEqual(await fs.readdir(f.stageDir), []);
});
test("case collisions include directory components and file/dir prefixes", () => {
  for (const mode of ["complete", "directory", "prefix"]) {
    const m = collection().manifest; m.resources[0].relativePath = "skills";
    m.entries[0].relativePath = mode === "prefix" ? "skills/a" : "skills/Foo/a"; m.entries[0].path = `agent/${m.entries[0].relativePath}`;
    const relativePath = mode === "complete" ? "skills/foo/A" : mode === "directory" ? "skills/foo/b" : "skills/a/b";
    m.entries.push({ ...m.entries[0], path: `agent/${relativePath}`, relativePath });
    assert.throws(() => validateManifest(m), /Invalid/);
  }
});
test("strict finite limits reject oversized file, total, frame and entry count", async (t) => {
  const f = await fixture(t), c = collection();
  for (const size of [ARCHIVE_LIMITS.file + 1, -1, 0.5]) { const m = clone(c.manifest); m.entries[0].size = size; assert.throws(() => validateManifest(m), /Invalid/); }
  await seal(f.archivePath, c.manifest, [c.entries[0].data], { head: { formatVersion: 2, count: ARCHIVE_LIMITS.entries + 1 } });
  await assert.rejects(readArchive({ archivePath: f.archivePath, password }), /Invalid/);
  const m = clone(c.manifest); m.entries = Array.from({ length: 3 }, (_, i) => ({ ...m.entries[0], relativePath: `skills/${i}`, path: `agent/skills/${i}`, size: ARCHIVE_LIMITS.file })); m.resources[0].relativePath = "skills";
  assert.throws(() => validateManifest(m), /Invalid/);
  // A count of zero followed by an oversized manifest length must fail before allocation.
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(ARCHIVE_LIMITS.manifest + 1);
  const empty = { ...c.manifest, entries: [] };
  await seal(f.archivePath, empty, [], { tail: oversized });
  await assert.rejects(readArchive({ archivePath: f.archivePath, password }), /Invalid/);
});
for (const privateMode of [false, true]) test(`v1 ${privateMode ? "private" : "public"} authenticated conversion and stage import`, async (t) => {
  const f = await fixture(t), bodies = privateMode ? [Buffer.from('{"token":"synthetic"}'), Buffer.from("# synthetic agent"), Buffer.from("# project skill")] : [Buffer.from('{"theme":"dark","defaultThinkingLevel":"high","enabledModelsSync":"on"}')];
  const entries = privateMode ? [{ path: "agent/auth.json", kind: "auth", size: bodies[0].length }, { path: "agent/agents/test.md", kind: "custom", size: bodies[1].length }, { path: "project/.pi/skills/test/SKILL.md", kind: "project", size: bodies[2].length }] : [{ path: "agent/settings.json", kind: "settings", size: bodies[0].length }];
  await seal(f.archivePath, { entries }, bodies, { legacy: true, head: { version: 1, includePrivate: privateMode, count: entries.length } });
  const result = await readArchive({ archivePath: f.archivePath, password, stageDir: f.stageDir });
  assert.equal(result.legacy, true); assert.equal(result.archiveHash, hash(await fs.readFile(f.archivePath)));
  assert.equal(result.manifest.entries.length, entries.length); assert.equal(result.manifest.roots[0].originalPath, "");
  for (let i = 0; i < entries.length; i++) { assert.equal(result.manifest.entries[i].sha256, hash(bodies[i])); assert.deepEqual(await fs.readFile(path.join(f.stageDir, String(i))), bodies[i]); }
  if (privateMode) assert.equal(result.manifest.resources.every((r) => r.executable), true);
  else assert.match(result.warnings.join(" "), /only the historical/);
  result.key.fill(0);
});
test("v1 public cannot smuggle credentials or unsupported settings", async (t) => {
  const f = await fixture(t);
  for (const body of ['{"token":"not allowed"}', '{"theme":"evil"}']) {
    const data = Buffer.from(body), entries = [{ path: "agent/settings.json", kind: "settings", size: data.length }];
    await seal(f.archivePath, { entries }, [data], { legacy: true, head: { version: 1, includePrivate: false, count: 1 } });
    await assert.rejects(readArchive({ archivePath: f.archivePath, password, stageDir: f.stageDir }), /Invalid/);
    assert.deepEqual(await fs.readdir(f.stageDir), []);
  }
});
test("invalid JSON and UTF-8 errors do not retain plaintext in exception causes", async (t) => {
  const f = await fixture(t), m = collection().manifest; m.entries = [];
  for (const body of [Buffer.from('SECRET_SYNTHETIC_JSON_EXCEPTION'), Buffer.from([0xff, 0xff])]) {
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
    await seal(f.archivePath, m, [], { tail: Buffer.concat([prefix, body]) });
    await assert.rejects(readArchive({ archivePath: f.archivePath, password }), (error) => {
      assert.equal(error.message, "Invalid backup or password"); assert.equal(error.cause, undefined); assert.equal(error.stack.includes("SECRET_SYNTHETIC"), false); return true;
    });
  }
});
test("injected encrypted read error closes the source handle", async (t) => {
  const f = await fixture(t); await writeArchive({ outputPath: f.archivePath, password, collection: collection() });
  const original = fs.open; let closed = false;
  fs.open = async (...args) => {
    const h = await original(...args);
    if (args[0] !== f.archivePath) return h;
    const read = h.read.bind(h), close = h.close.bind(h);
    h.read = async (...params) => { if (params[3] === 48) throw new Error("synthetic read error"); return read(...params); };
    h.close = async () => { closed = true; return close(); }; return h;
  };
  try { await assert.rejects(readArchive({ archivePath: f.archivePath, password, stageDir: f.stageDir }), /Invalid/); }
  finally { fs.open = original; }
  assert.equal(closed, true); assert.deepEqual(await fs.readdir(f.stageDir), []); await fs.unlink(f.archivePath);
});
test("metadata-only package descriptors have no body records", async (t) => {
  const f = await fixture(t), c = collection(); c.manifest.entries = []; c.entries = [];
  c.manifest.roots = [{ id: "pkg", kind: "external", label: "Synthetic dependency", originalPath: "" }];
  c.manifest.resources = [{ id: "dependency", rootId: "pkg", relativePath: "package-test", label: "Synthetic dependency", kind: "package", executable: true, sensitive: false, availability: "requiresReinstall", source: "npm:synthetic-package@0.0.0" }];
  await writeArchive({ outputPath: f.archivePath, password, collection: c });
  const result = await readArchive({ archivePath: f.archivePath, password }); assert.equal(result.manifest.resources[0].kind, "package"); result.key.fill(0);
});
