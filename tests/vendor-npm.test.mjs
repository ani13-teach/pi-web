import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dirDigest, syncDir } from "../scripts/vendor-npm.mjs";

// A miniature stand-in for the vendored npm tree: same shape, a few files.
function makeSource(name = "src") {
  const dir = mkdtempSync(join(tmpdir(), `vendor-npm-${name}-`));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "npm", version: "1.2.3" }));
  writeFileSync(join(dir, "index.js"), "module.exports = 1;\n");
  writeFileSync(join(dir, "bin", "npx-cli.js"), "#!/usr/bin/env node\n");
  return dir;
}

const mtimeOf = (path) => statSync(path).mtimeMs;

test("keeps a target that already matches, without touching it", (t) => {
  const source = makeSource("identical");
  const target = makeSource("target");
  t.after(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  // Normal cache hit: same version and same contents.
  const before = mtimeOf(join(target, "index.js"));
  const result = syncDir(source, target);

  assert.equal(result.action, "kept");
  assert.equal(result.hash, dirDigest(source).hash);
  assert.equal(mtimeOf(join(target, "index.js")), before);
});

test("repairs a same-version target that is missing files", (t) => {
  const source = makeSource("missing");
  const target = makeSource("target");
  t.after(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  // Version still matches, so the old version-only check would have skipped it.
  rmSync(join(target, "bin", "npx-cli.js"));

  const result = syncDir(source, target);

  assert.equal(result.action, "copied");
  assert.ok(existsSync(join(target, "bin", "npx-cli.js")));
  assert.equal(dirDigest(target).hash, dirDigest(source).hash);
});

test("repairs a same-version target whose contents changed", (t) => {
  const source = makeSource("changed");
  const target = makeSource("target");
  t.after(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  writeFileSync(join(target, "index.js"), "module.exports = 2;\n");

  const result = syncDir(source, target);

  assert.equal(result.action, "copied");
  assert.equal(readFileSync(join(target, "index.js"), "utf8"), "module.exports = 1;\n");
  assert.equal(dirDigest(target).hash, dirDigest(source).hash);
});

test("re-copies on demand with force", (t) => {
  const source = makeSource("force");
  const target = makeSource("target");
  t.after(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  const result = syncDir(source, target, { force: true });

  assert.equal(result.action, "copied");
  assert.equal(dirDigest(target).hash, dirDigest(source).hash);
});

test("leaves the old target in place when the copy fails", (t) => {
  const target = makeSource("target");
  const parent = join(target, "..");
  t.after(() => rmSync(target, { recursive: true, force: true }));

  const missing = join(tmpdir(), `vendor-npm-absent-${process.pid}`);
  rmSync(missing, { recursive: true, force: true });

  assert.throws(() => syncDir(missing, target), /ENOENT/);

  assert.equal(readFileSync(join(target, "index.js"), "utf8"), "module.exports = 1;\n");
  // No staging leftovers next to the target.
  const leftovers = readdirSync(parent).filter((entry) => entry.includes(".staging-"));
  assert.deepEqual(leftovers, []);
});
