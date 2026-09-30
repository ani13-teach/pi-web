import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { encodeFilePathForApi } from "../../../lib/file-paths.ts";

const project = fileURLToPath(new URL("../../../", import.meta.url));
const securityPath = path.join(project, "lib/path-security.ts");
const result = await build({
  absWorkingDir: project,
  entryPoints: [path.join(project, "app/api/files/[...path]/route.ts")],
  bundle: true, write: false, platform: "node", format: "cjs",
  plugins: [{
    name: "files-route-test-adapter",
    setup(builder) {
      builder.onResolve({ filter: /^(next\/server|@\/lib\/file-access|@\/lib\/session-file-references)$/ }, (args) => ({ path: args.path, namespace: "adapter" }));
      builder.onLoad({ filter: /.*/, namespace: "adapter" }, (args) => {
        if (args.path === "next/server") return { contents: "export class NextResponse { static json(body, options) { return Response.json(body, options); } }" };
        if (args.path.endsWith("file-access")) return {
          contents: `export async function getAllowedFileRoots() { return globalThis.testRoots; }
            export { isPathWithinRoots as isFilePathAllowed, isExistingPathWithinRoots as isExistingFilePathAllowed } from ${JSON.stringify(securityPath)};`,
          resolveDir: project,
        };
        return { contents: `export async function isFilePathReferencedBySession(filePath, sessionId) {
          return sessionId === "session-1" && globalThis.testReferences.has(filePath);
        }` };
      });
    },
  }],
});

async function fixture(t) {
  const temp = await mkdtemp(path.join(tmpdir(), "pi-files-meta-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const allowed = path.join(temp, "allowed");
  const outside = path.join(temp, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  const context = {
    module: { exports: {} }, require: createRequire(import.meta.url),
    process, Buffer, Response, ReadableStream, TextEncoder, URL, URLSearchParams,
    testRoots: new Set([allowed]), testReferences: new Set(),
  };
  vm.runInNewContext(result.outputFiles[0].text, context);
  const get = async (target, type = "meta", sessionId) => {
    const encoded = encodeFilePathForApi(target);
    const url = new URL(`http://localhost/api/files/${encoded}?type=${type}`);
    if (sessionId) url.searchParams.set("sessionId", sessionId);
    const segments = encoded.split("/").map(decodeURIComponent);
    return context.module.exports.GET({ nextUrl: url, headers: new Headers() }, { params: Promise.resolve({ path: segments }) });
  };
  const reference = (target) => context.testReferences.add(target.replace(/\\/g, "/"));
  return { allowed, outside, get, reference };
}

test("directory metadata and lists support ordinary, dotted and encoded Chinese/space/percent names", async (t) => {
  const { allowed, get } = await fixture(t);
  for (const name of ["ordinary", "project.v2", "\u4e2d\u6587 space%20%2F%25", "bad%escape"]) {
    const directory = path.join(allowed, name);
    await mkdir(directory);
    await mkdir(path.join(directory, "child.dir"));
    await writeFile(path.join(directory, "README"), "content");
    const meta = await get(directory);
    assert.equal(meta.status, 200, name);
    assert.deepEqual(await meta.json(), { isDir: true });
    const list = await get(directory, "list");
    assert.equal(list.status, 200, name);
    const body = await list.json();
    assert.equal(body.path, directory.replace(/\\/g, "/"));
    assert.deepEqual(body.entries.map(({ name, isDir }) => ({ name, isDir })), [
      { name: "child.dir", isDir: true }, { name: "README", isDir: false },
    ]);
    const read = await get(directory, "read");
    assert.equal(read.status, 400, name);
    assert.equal((await read.json()).error, "Not a file");
  }
});

test("metadata identifies extensionless and encoded files without changing file preview fields", async (t) => {
  const { allowed, get } = await fixture(t);
  for (const name of ["README", "\u4e2d\u6587 space%.txt", "literal%2F%25%20name.md", "tool.exe"]) {
    const file = path.join(allowed, name);
    await writeFile(file, "hello");
    const meta = await get(file);
    assert.equal(meta.status, 200, name);
    const body = await meta.json();
    assert.equal(body.isDir, false);
    assert.equal(body.size, 5);
    assert.equal(body.language, name.endsWith(".md") ? "markdown" : "text");
    assert.equal(body.mime, "text/plain");
    assert.ok(Object.hasOwn(body, "previewKind"));
    assert.equal((await get(file, "list")).status, 400);
  }
});

test("out-of-root directories are denied even with an exact session reference", async (t) => {
  const { outside, get, reference } = await fixture(t);
  assert.equal((await get(outside)).status, 403);
  reference(outside);
  assert.equal((await get(outside, "meta", "session-1")).status, 403);
  assert.equal((await get(outside, "list", "session-1")).status, 403);
});

test("a session file reference preserves file access but cannot authorize its parent or siblings", async (t) => {
  const { outside, get, reference } = await fixture(t);
  const file = path.join(outside, "mentioned.txt");
  const sibling = path.join(outside, "secret.txt");
  await writeFile(file, "mentioned");
  await writeFile(sibling, "secret");
  reference(file);
  assert.equal((await get(file)).status, 403);
  const meta = await get(file, "meta", "session-1");
  assert.equal(meta.status, 200);
  assert.equal((await meta.json()).isDir, false);
  const read = await get(file, "read", "session-1");
  assert.equal(read.status, 200);
  assert.equal((await read.json()).content, "mentioned");
  assert.equal((await get(file, "meta", "other-session")).status, 403);
  assert.equal((await get(outside, "meta", "session-1")).status, 403);
  assert.equal((await get(outside, "list", "session-1")).status, 403);
  assert.equal((await get(sibling, "meta", "session-1")).status, 403);
});

test("directory symlink/junction escape fails metadata and list realpath authorization", async (t) => {
  const { allowed, outside, get, reference } = await fixture(t);
  const alias = path.join(allowed, "escape.v2");
  fs.symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await get(alias)).status, 403);
  assert.equal((await get(alias, "list")).status, 403);
  reference(alias);
  assert.equal((await get(alias, "meta", "session-1")).status, 403);
  assert.equal((await get(alias, "list", "session-1")).status, 403);
  reference(outside);
  assert.equal((await get(outside, "meta", "session-1")).status, 403);
});

test("authorized directory aliases within roots retain metadata and list access", async (t) => {
  const { allowed, get } = await fixture(t);
  const target = path.join(allowed, "target");
  const alias = path.join(allowed, "alias");
  await mkdir(target);
  await writeFile(path.join(target, "README"), "ok");
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  const meta = await get(alias);
  assert.equal(meta.status, 200);
  assert.deepEqual(await meta.json(), { isDir: true });
  const list = await get(alias, "list");
  assert.equal(list.status, 200);
  assert.equal((await list.json()).entries[0].name, "README");
});

test("nonexistent authorized paths return 404 and unknown request types return 400", async (t) => {
  const { allowed, get } = await fixture(t);
  const missing = path.join(allowed, "missing\u4e2d\u6587 %20");
  assert.equal((await get(missing)).status, 404);
  assert.equal((await get(missing, "list")).status, 404);
  assert.equal((await get(allowed, "invalid")).status, 400);
});
