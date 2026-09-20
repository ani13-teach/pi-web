/**
 * What the auto-mode model picker offers, and how a saved spec is read back.
 *
 * The classifier resolves `provider/modelId` through pi's model registry, which
 * is fed by `models.json` (custom gateways) *and* the built-in provider catalog.
 * Only the first of those is in `models.json`, so both have to be merged, and a
 * spec has to be split at the first slash (`Free/openrouter/free`), the same way
 * the extension splits it.
 *
 * Run with: node --experimental-strip-types --test tests/automode-model-options.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { collectModelOptions, modelSpecOf, splitModelSpec } =
  await import("../components/automode-model-options.ts");

/** Roughly what a hand-written `models.json` looks like. */
const modelsConfig = {
  providers: {
    KBQ: {
      baseUrl: "https://example.invalid/v1",
      api: "openai-responses",
      models: [
        { id: "[0.2]glm-5.3-flash", name: "[0.2]glm-5.3-flash" },
        { id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
      ],
    },
    Free: { api: "openai-completions", models: [{ id: "openrouter/free" }] },
    TT: { api: "openai-responses", models: [{ id: "gpt-6-astra", name: "TT-6 Astra" }] },
    broken: { models: "not an array" },
    emptyModels: { models: [{ name: "no id here" }, "junk"] },
  },
};

/** The `GET /api/models` body: whitelisted models, built-in providers included. */
const modelsResponse = {
  modelList: [
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai-codex" },
    // Same spec as the `models.json` entry above: it must not appear twice.
    { id: "gpt-6-astra", name: "renamed", provider: "TT" },
    { id: "", name: "no id", provider: "openai-codex" },
    "junk",
  ],
};

const spec = (option) => modelSpecOf(option.provider, option.modelId);

test("models.json and the registry are merged, models.json first, without duplicates", () => {
  assert.deepEqual(collectModelOptions(modelsConfig, modelsResponse).map(spec), [
    "KBQ/[0.2]glm-5.3-flash",
    "KBQ/deepseek-flash",
    "Free/openrouter/free",
    "TT/gpt-6-astra",
    "openai-codex/gpt-5.6-luna",
  ]);
});

test("a model name falls back to its id when models.json does not name it", () => {
  const options = collectModelOptions(modelsConfig, null);
  assert.equal(options.find((option) => option.modelId === "openrouter/free").name, "openrouter/free");
  assert.equal(options.find((option) => option.modelId === "deepseek-flash").name, "DeepSeek V4.1 Flash");
});

test("a malformed entry is dropped instead of emptying the picker", () => {
  assert.deepEqual(collectModelOptions({ providers: { broken: { models: "nope" } } }, null), []);
  assert.equal(collectModelOptions(modelsConfig, { modelList: "nope" }).length, 4);
  assert.deepEqual(collectModelOptions(undefined, undefined), []);
});

test("a spec is split at the first slash, the way the extension splits it", () => {
  assert.deepEqual(splitModelSpec("KBQ/[0.2]glm-5.3-flash"), { provider: "KBQ", modelId: "[0.2]glm-5.3-flash" });
  assert.deepEqual(splitModelSpec("Free/openrouter/free"), { provider: "Free", modelId: "openrouter/free" });
  // Half-typed values, an empty field, and a bare model id mean "nothing chosen".
  assert.equal(splitModelSpec(""), null);
  assert.equal(splitModelSpec("gemini-3-pro"), null);
  assert.equal(splitModelSpec("/leading"), null);
  assert.equal(splitModelSpec("trailing/"), null);
  // Only the outer whitespace goes away; the id keeps its meaning.
  assert.deepEqual(splitModelSpec(" KBQ/deepseek-flash "), { provider: "KBQ", modelId: "deepseek-flash" });
});

test("a picked option round-trips into the spec the config file stores", () => {
  const options = collectModelOptions(modelsConfig, modelsResponse);
  for (const option of options) {
    assert.deepEqual(splitModelSpec(modelSpecOf(option.provider, option.modelId)), {
      provider: option.provider,
      modelId: option.modelId,
    });
  }
});
