import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../desktop/smoke-probe.js", import.meta.url), "utf8");
const start = source.indexOf("    for (const [providerId, provider] of Object.entries(providers)) {");
const end = source.indexOf("    if (missing.length > 0)", start);
assert.ok(start >= 0 && end > start, "the actual picker verification loop must exist");
const missingModels = new Function("providers", "options", `const missing = [];\n${source.slice(start, end)}\nreturn missing;`);
const providers = { a: { models: [{ id: "shared-id", name: "Shared Model" }] }, b: { models: [{ id: "shared-id", name: "Shared Model" }] } };
const option = (provider, visible = `(${provider})`) => ({
  querySelector: () => ({ title: `Shared Model (${provider})`, lastElementChild: visible === null ? null : { textContent: visible } }),
});

test("window probe recognizes model names together with each distinct channel", () => {
  assert.deepEqual(missingModels(providers, [option("a"), option("b")]), []);
});

test("same-name model in another channel cannot satisfy the missing model check", () => {
  assert.deepEqual(missingModels(providers, [option("b"), option("b")]), ["a/shared-id"]);
});

test("a complete tooltip cannot hide a missing or wrong visible channel", () => {
  for (const visible of [null, "(b)", ""]) {
    assert.deepEqual(missingModels(providers, [option("a", visible), option("b")]), ["a/shared-id"]);
  }
});

test("a name-less model falls back to its ID while placeholder models are skipped", () => {
  const providers = { relay: { models: [{ id: "raw-id" }, { id: "" }] } };
  const options = [{ querySelector: () => ({ title: "raw-id (relay)", lastElementChild: { textContent: "(relay)" } }) }];
  assert.deepEqual(missingModels(providers, options), []);
});
