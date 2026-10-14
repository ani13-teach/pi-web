import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url);
const { getDesktopModelSelections, isDesktopModelEnabled, applyDesktopModelSelections, planAuthModelEnabledPatterns,
  validateAuthModelSelections, validateAuthModelOverrides, resolveCatalogPatterns } = await jiti.import("./auth-model-settings.ts");
const { planEnabledModelsSync } = await jiti.import("./enabled-models-sync.ts");
const { withAuthModelTimeout } = await jiti.import("./auth-model-catalog.ts");
const catalog = [
  { provider: "a", id: "same", name: "A" },
  { provider: "a", id: "hidden", name: "Hidden" },
  { provider: "b", id: "same", name: "B" },
  { provider: "b", id: "other", name: "Other" },
];
const scope = {
  visible: catalog.slice(0, 3),
  scopedModels: catalog.slice(0, 3).map((model) => ({ model, thinkingLevel: "high" })),
  thinkingLevelPins: { "a/same": "high", "a/hidden": "high", "b/same": "high" }, warnings: ["legacy warning"],
};
const refs = (models) => models.map((m) => `${m.provider}/${m.id}`);

test("missing selection keeps legacy behavior; [] deliberately hides the provider", () => {
  assert.deepEqual(getDesktopModelSelections({}), {});
  const selections = getDesktopModelSelections({ desktopModelSelections: { a: [], b: ["same", "same"], bad: "no" } });
  assert.deepEqual(selections, { a: [], b: ["same"] });
  assert.equal(isDesktopModelEnabled("a", "same", selections), false);
  assert.equal(isDesktopModelEnabled("b", "same", selections), true);
  assert.equal(isDesktopModelEnabled("c", "anything", selections), true);
  assert.equal(applyDesktopModelSelections(scope, {}), scope);
});

test("explicit list overrides scope membership and preserves unedited models and thinking pins", () => {
  const result = applyDesktopModelSelections(scope, { a: [], b: ["other", "same"] }, catalog);
  assert.deepEqual(refs(result.visible), ["b/same", "b/other"]);
  assert.deepEqual(result.thinkingLevelPins, { "b/same": "high" });
  assert.equal(result.scopedModels[0].thinkingLevel, "high");
  assert.equal(result.scopedModels[1].thinkingLevel, undefined);
  assert.deepEqual(result.warnings, scope.warnings);
});

test("all explicitly hidden removes the legacy total-miss fallback and SDK scope", () => {
  const fallback = { visible: catalog, scopedModels: [], thinkingLevelPins: {}, warnings: ["no match"] };
  const result = applyDesktopModelSelections(fallback, { a: [], b: [] }, catalog);
  assert.deepEqual(result.visible, []);
  assert.deepEqual(result.scopedModels, []);
});

test("managed selections missing from old scope are included but unavailable models are not invented", () => {
  const legacy = { ...scope, visible: [catalog[2]], scopedModels: [scope.scopedModels[2]] };
  assert.deepEqual(refs(applyDesktopModelSelections(legacy, { a: ["hidden", "offline"] }, catalog).visible), ["b/same", "a/hidden"]);
});

test("shared wildcard is materialized for other providers with thinking suffix", async () => {
  assert.deepEqual(await planAuthModelEnabledPatterns(["*:high", "future/no-match"], { a: ["same"] }, catalog), [
    "b/same:high", "b/other:high", "future/no-match", "a/same:high",
  ]);
});

test("first-match thinking semantics and unrelated bare no-match patterns are preserved", async () => {
  assert.deepEqual(await planAuthModelEnabledPatterns(["a/same", "a/*:high", "ab"], { a: ["same"] }, catalog), ["ab", "a/same"]);
  assert.deepEqual(await planAuthModelEnabledPatterns(["a/*:low", "a/same:high"], { a: ["same"] }, catalog), ["a/same:low"]);
});

test("shared glob materialization preserves OTHER providers' effective first-match pins", async () => {
  const patternsCases = [
    ["*", "*:high"],
    ["b/*", "*:high"],
    ["*:low", "*:high"],
    ["*", "b/*:high"],
    ["b/same", "*:high"],
    ["b/same:off", "*:high"],
  ];
  const effectiveOthers = async (patterns) => {
    const { scopedModels } = await resolveCatalogPatterns(patterns, catalog);
    return scopedModels.filter(({ model }) => model.provider === "b")
      .map(({ model, thinkingLevel }) => [`${model.provider}/${model.id}`, thinkingLevel ?? null]);
  };
  for (const patterns of patternsCases) {
    for (const selection of [[], ["same"]]) {
      const rewritten = await planAuthModelEnabledPatterns(patterns, { a: selection }, catalog);
      assert.deepEqual(await effectiveOthers(rewritten), await effectiveOthers(patterns), JSON.stringify({ patterns, selection, rewritten }));
    }
  }
  const result = await planAuthModelEnabledPatterns(["*", "*:high"], { a: [] }, catalog);
  assert.deepEqual(await effectiveOthers(result), [["b/same", null], ["b/other", null]]);
});

test("bare and fuzzy IDs use SDK resolver, not string prefix matching", async () => {
  const unique = [...catalog, { provider: "a", id: "only-a", name: "Unique" }];
  assert.deepEqual(await planAuthModelEnabledPatterns(["only-a:low", "b/*"], { a: [] }, unique), ["b/*"]);
  assert.deepEqual(await planAuthModelEnabledPatterns(["hid"], { a: ["same"] }, catalog), ["a/same"]);
});

test("no old whitelist preserves other provider globs and selected exact refs", async () => {
  assert.deepEqual(await planAuthModelEnabledPatterns([], { a: ["hidden"] }, catalog), ["b/*", "a/hidden"]);
});

test("empty legacy whitelist does not re-add explicitly disabled or prune unavailable managed selections", async () => {
  assert.deepEqual(await planAuthModelEnabledPatterns([], { a: ["same"] }, catalog, { b: [] }), ["a/same"]);
  assert.deepEqual(await planAuthModelEnabledPatterns([], { a: ["same"] }, catalog, { b: ["offline"] }), ["b/offline", "a/same"]);
});

test("all hidden does not turn a previous whitelist into wildcard", async () => {
  assert.deepEqual(await planAuthModelEnabledPatterns(["*"], { a: [], b: [] }, catalog), []);
});

test("unrelated dead patterns and unedited provider remain byte-for-byte patterns", async () => {
  const patterns = ["b/*:max", "unrelated/dead", "a/deleted:high"];
  assert.deepEqual(await planAuthModelEnabledPatterns(patterns, { a: ["same"] }, catalog), ["b/*:max", "unrelated/dead", "a/same"]);
});

test("validation rejects unknown provider/model and non-array IDs", () => {
  assert.throws(() => validateAuthModelSelections({ unknown: [] }, catalog), /Unknown provider/);
  assert.throws(() => validateAuthModelSelections({ a: ["missing"] }, catalog), /Unknown model/);
  assert.throws(() => validateAuthModelSelections({ a: "same" }, catalog), /string array/);
  assert.deepEqual(validateAuthModelSelections({ a: ["same", "same"] }, catalog), { a: ["same"] });
});

test("new context-window override must be a positive safe integer and target a catalog model", () => {
  for (const contextWindow of [0, -1, 1.5, "4096", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateAuthModelOverrides({ providers: { a: { modelOverrides: { same: { contextWindow } } } } }, {}, catalog), /positive safe integer/);
  }
  assert.throws(() => validateAuthModelOverrides({ providers: { a: { modelOverrides: { missing: { contextWindow: 12 } } } } }, {}, catalog), /Unknown model override/);
  validateAuthModelOverrides({ providers: { a: { modelOverrides: { same: { contextWindow: 4096 } } } } }, {}, catalog);
});

test("legacy automatic reconciliation neither adds disabled managed models nor prunes explicit stale selections", async () => {
  const result = await planEnabledModelsSync({ patterns: ["a/offline", "b/same"], availableModels: catalog,
    definedModels: { a: ["same", "hidden"], b: ["same", "other"] }, knownProviderIds: ["a", "b"], managedProviderIds: ["a"] });
  assert.deepEqual(result, { patterns: ["a/offline", "b/same", "b/other"], added: ["b/other"], removed: [] });
});

test("SDK accepts desktop metadata and applies a built-in context override without removing other fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auth-model-sdk-"));
  try {
    const path = join(dir, "models.json");
    const baseline = await ModelRuntime.create({ modelsPath: null, authPath: join(dir, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
    const model = baseline.getModels().find((m) => m.provider === "openai");
    assert.ok(model);
    writeFileSync(path, JSON.stringify({ desktopModelSelections: { openai: [] }, providers: { openai: { modelOverrides: {
      [model.id]: { contextWindow: 123456, maxTokens: 1234 },
    } } } }));
    const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(dir, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
    assert.equal(runtime.getError(), undefined);
    assert.equal(runtime.getModel("openai", model.id).contextWindow, 123456);
    assert.equal(runtime.getModel("openai", model.id).maxTokens, 1234);
    assert.equal(runtime.getModel("openai", model.id).name, model.name);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("OAuth subscription context overrides survive credential projection and reset without inference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auth-model-oauth-"));
  try {
    const authPath = join(dir, "auth.json");
    const modelsPath = join(dir, "models.json");
    writeFileSync(authPath, JSON.stringify({ "openai-codex": {
      type: "oauth", access: "fixture-not-a-real-token", refresh: "fixture-not-for-refresh",
      expires: Date.now() + 86_400_000, accountId: "fixture",
    } }));
    writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
    const baseline = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false });
    assert.equal(baseline.isUsingOAuth("openai-codex"), true);
    const model = baseline.getModels("openai-codex")[0];
    assert.ok(model);
    writeFileSync(modelsPath, JSON.stringify({ desktopModelSelections: { "openai-codex": [model.id] }, providers: {
      "openai-codex": { modelOverrides: { [model.id]: { contextWindow: 777777 } } },
    } }));
    const runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false });
    assert.equal(runtime.isUsingOAuth("openai-codex"), true);
    assert.equal(runtime.getModel("openai-codex", model.id).contextWindow, 777777);
    assert.equal(runtime.getModel("openai-codex", model.id).maxTokens, model.maxTokens);
    writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.getModel("openai-codex", model.id).contextWindow, model.contextWindow);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("catalog deadline is real even if the underlying operation ignores cancellation", async () => {
  await assert.rejects(withAuthModelTimeout(() => new Promise(() => {}), 10), (e) => e.status === 504 && /timed out/.test(e.message));
});
