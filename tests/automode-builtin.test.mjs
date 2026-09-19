/**
 * The rule that decides which copy of auto mode survives.
 *
 * Two copies would register the same commands and the same `automode_inspect`
 * tool twice and run two classifiers, so the copy compiled into this build wins
 * and an installed plugin copy is dropped. These cases are the whole rule; the
 * extension itself is never imported by anything else in the test suite.
 *
 * Run with: node --experimental-strip-types --test tests/automode-builtin.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { BUILTIN_AUTOMODE_PATH, preferBuiltinAutomode } = await import("../lib/automode-builtin.ts");

const INLINE = BUILTIN_AUTOMODE_PATH;
const GLOBAL_COPY = "C:/Users/jch/.pi/agent/extensions/pi-automode/extensions/index.ts";
const PROJECT_COPY = "C:/work/repo/.pi/extensions/pi-automode/extensions/index.ts";
const UNRELATED = "C:/Users/jch/.pi/agent/extensions/pi-usage-monitor/index.ts";

function extension(path) {
  return { path, tools: new Map([["automode_inspect", {}]]) };
}

function result(extensions, errors = []) {
  return { extensions, errors, runtime: {} };
}

test("keeps the built-in copy and drops an installed plugin copy", () => {
  const base = result(
    [extension(GLOBAL_COPY), extension(INLINE)],
    [{ path: INLINE, error: `Tool "automode_inspect" conflicts with ${GLOBAL_COPY}` }],
  );

  const out = preferBuiltinAutomode(base);

  assert.deepEqual(out.extensions.map((entry) => entry.path), [INLINE]);
  assert.deepEqual(out.errors, []);
});

test("drops a project-local copy too", () => {
  const out = preferBuiltinAutomode(result([extension(PROJECT_COPY), extension(INLINE)]));

  assert.deepEqual(out.extensions.map((entry) => entry.path), [INLINE]);
});

test("leaves unrelated extensions alone", () => {
  const out = preferBuiltinAutomode(result([extension(UNRELATED), extension(INLINE)]));

  assert.deepEqual(out.extensions.map((entry) => entry.path), [UNRELATED, INLINE]);
});

test("keeps the plugin copy when the built-in one is not loaded", () => {
  // Chat-only and no-extension sessions never get the inline factory, so
  // dropping the plugin copy there would remove the guardrail entirely.
  const base = result([extension(GLOBAL_COPY)]);

  assert.equal(preferBuiltinAutomode(base), base);
});

test("a build without a duplicate is left untouched", () => {
  const base = result([extension(INLINE)], [{ path: "x", error: "kept" }]);

  assert.equal(preferBuiltinAutomode(base), base);
});
