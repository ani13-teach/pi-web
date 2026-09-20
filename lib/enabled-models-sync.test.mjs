import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./enabled-models-sync.ts");
  } catch {
    return import("./enabled-models-sync.ts");
  }
}

const { collectDefinedModels, planEnabledModelsSync, syncEnabledModelsWithModelsConfig } =
  await loadSubject();

const AVAILABLE = [
  { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5" },
  { id: "claude-sonnet-5", provider: "anthropic", name: "Claude Sonnet 5" },
  { id: "deepseek-v4-flash", provider: "deepseek", name: "DeepSeek V4 Flash" },
  { id: "gpt-5.6-sol", provider: "虎妞", name: "GPT-5.6 Sol" },
  { id: "b-model", provider: "KBQ", name: "KBQ B" },
  { id: "[0.2]glm-5.3-flash", provider: "KBQ", name: "KBQ GLM" },
];

/**
 * What `models.json` declares; the only providers and models this sync may add
 * or drop. `ghost-gateway` is declared but has no available model, as when its
 * credentials are missing right now.
 */
const DEFINED = {
  deepseek: ["deepseek-v4-flash"],
  虎妞: ["gpt-5.6-sol"],
  KBQ: ["b-model", "[0.2]glm-5.3-flash"],
  "ghost-gateway": ["old-model"],
  "new-provider": [],
};

/** Built-in providers the runtime knows without models.json, plus the declared ones. */
const KNOWN = ["anthropic", "openai-codex", ...Object.keys(DEFINED)];

/** The declared-and-available models no listed pattern covers, in resolver order. */
const UNCOVERED = ["deepseek/deepseek-v4-flash", "虎妞/gpt-5.6-sol", "KBQ/b-model", "KBQ/[0.2]glm-5.3-flash"];

const plan = (patterns, options = {}) => planEnabledModelsSync({
  patterns,
  availableModels: options.availableModels ?? AVAILABLE,
  definedModels: options.definedModels ?? DEFINED,
  knownProviderIds: options.knownProviderIds ?? KNOWN,
});

test("appends models.json models that no pattern covers, after the kept patterns", async () => {
  const result = await plan(["anthropic/claude-opus-5", "deepseek/deepseek-v4-flash"]);

  assert.deepEqual(result.patterns, [
    "anthropic/claude-opus-5",
    "deepseek/deepseek-v4-flash",
    "虎妞/gpt-5.6-sol",
    "KBQ/b-model",
    "KBQ/[0.2]glm-5.3-flash",
  ]);
  assert.deepEqual(result.added, ["虎妞/gpt-5.6-sol", "KBQ/b-model", "KBQ/[0.2]glm-5.3-flash"]);
  assert.deepEqual(result.removed, []);
});

test("leaves built-in providers alone instead of widening or pruning them", async () => {
  // `anthropic/ghost-4` matches nothing and `anthropic/claude-sonnet-5` is not
  // listed, but models.json does not declare anthropic: the user's list decides.
  const result = await plan(["anthropic/claude-opus-5", "anthropic/ghost-4"]);

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.added, UNCOVERED);
  assert.ok(result.patterns.includes("anthropic/ghost-4"));
  assert.ok(!result.patterns.includes("anthropic/claude-sonnet-5"));
});

test("drops a pattern whose model is gone from models.json", async () => {
  const result = await plan(["KBQ/retired-model", "KBQ/b-model"]);

  assert.deepEqual(result.removed, ["KBQ/retired-model"]);
  assert.deepEqual(result.patterns[0], "KBQ/b-model");
});

test("drops a pinned pattern only when the pinned model is gone too", async () => {
  const result = await plan(["KBQ/retired-model:high", "KBQ/b-model:low"]);

  assert.deepEqual(result.removed, ["KBQ/retired-model:high"]);
  assert.equal(result.patterns[0], "KBQ/b-model:low");
  assert.ok(!result.patterns.includes("KBQ/retired-model:high"));
});

test("keeps a dead pattern while models.json still declares the model", async () => {
  // A model that is declared but currently unavailable (no credentials, provider
  // error) must not lose its whitelist entry.
  const result = await plan(["ghost-gateway/old-model", "ghost-gateway/old-model:high"]);

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.patterns, [
    "ghost-gateway/old-model",
    "ghost-gateway/old-model:high",
    ...UNCOVERED,
  ]);
});

test("drops patterns of a provider that was deleted or renamed on the page", async () => {
  // The real shape of a rename: the old name is gone from models.json and the
  // runtime has never heard of it, while the new name is declared and available.
  const defined = { "77-grok": ["grok-4.6"], ...DEFINED };
  const available = [...AVAILABLE, { id: "grok-4.6", provider: "77-grok", name: "Grok 4.6" }];
  const result = await plan([
    "虎妞-grok/grok-4.6",
    "虎妞/gpt-6-astra",
    "new-provider/deepseek-flash",
    "77-grok/grok-4.6",
  ], { definedModels: defined, availableModels: available, knownProviderIds: ["anthropic", ...Object.keys(defined)] });

  assert.deepEqual(result.removed, [
    "虎妞-grok/grok-4.6",
    "虎妞/gpt-6-astra",
    "new-provider/deepseek-flash",
  ]);
  assert.equal(result.patterns[0], "77-grok/grok-4.6");
});

test("keeps a dead pattern for a provider the runtime knows", async () => {
  // `anthropic` is a built-in: the run-time knows it even though models.json does
  // not declare it, so a hand-curated entry stays.
  const result = await plan(["anthropic/claude-ghost-4", "anthropic/claude-opus-5"]);

  assert.deepEqual(result.removed, []);
  assert.ok(result.patterns.includes("anthropic/claude-ghost-4"));
});

test("does not drop patterns it cannot attribute to exactly one model", async () => {
  // Bare ids and real globs range over more than one model, so they stay.
  const result = await plan([
    "typo-model",
    "*sonnet*",
    "*gateway/old-*",
    "KBQ/retired-*",
  ]);

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.patterns.slice(0, 4), [
    "typo-model",
    "*sonnet*",
    "*gateway/old-*",
    "KBQ/retired-*",
  ]);
});

test("drops a bracketed id that the provider no longer declares", async () => {
  // `[0.2]glm-5.3` is a literal model name, not a character class, so a stale one
  // is cleanable — the shape custom providers use for priced variants.
  const result = await plan(["KBQ/[0.2]glm-5.3-flash", "KBQ/[0.12]deepseek-v4-flash-0731"]);

  assert.deepEqual(result.removed, ["KBQ/[0.12]deepseek-v4-flash-0731"]);
  assert.ok(result.patterns.includes("KBQ/[0.2]glm-5.3-flash"));
});

test("matches with the resolver, so an aliased or glob-covered model is not duplicated", async () => {
  const result = await plan(["gpt-5.6-sol", "KBQ/*", "deepseek/*:high"]);

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.patterns, ["gpt-5.6-sol", "KBQ/*", "deepseek/*:high"]);
});

test("keeps thinking-level pins and does not add a suffixed duplicate", async () => {
  const result = await plan(["deepseek/deepseek-v4-flash:high", "KBQ/b-model"]);

  assert.deepEqual(result.patterns, [
    "deepseek/deepseek-v4-flash:high",
    "KBQ/b-model",
    "虎妞/gpt-5.6-sol",
    "KBQ/[0.2]glm-5.3-flash",
  ]);
});

test("leaves an empty whitelist empty because it means no filter", async () => {
  const result = await plan([]);

  assert.deepEqual(result, { patterns: [], added: [], removed: [] });
});

test("leaves the whitelist alone when models.json defines no providers", async () => {
  const result = await plan(["KBQ/retired-model"], { definedModels: {}, knownProviderIds: ["anthropic"] });

  assert.deepEqual(result, { patterns: ["KBQ/retired-model"], added: [], removed: [] });
});

test("is idempotent", async () => {
  const first = await plan(["anthropic/claude-opus-5", "deepseek/retired"]);
  const second = await plan(first.patterns);

  assert.deepEqual(second.added, []);
  assert.deepEqual(second.removed, []);
  assert.deepEqual(second.patterns, first.patterns);
});

test("reads declared providers and model ids out of a hand-edited models.json", () => {
  assert.deepEqual(collectDefinedModels({
    providers: {
      good: { models: [{ id: "a" }, { id: " b " }, { id: "" }, {}, { id: 7 }, "nope"] },
      empty: {},
      "no-models-key": { baseUrl: "http://localhost:1/v1" },
      broken: "not-an-object",
    },
    unrelated: true,
  }), {
    good: ["a", " b "],
    empty: [],
    "no-models-key": [],
    broken: [],
  });

  for (const config of [{}, { providers: [] }, { providers: null }, { providers: "x" }]) {
    assert.deepEqual(collectDefinedModels(config), {});
  }
});

// --- settings.json side ------------------------------------------------------

function makeAgentDir({ settings, models }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-enabled-models-"));
  if (settings !== undefined) {
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  }
  writeFileSync(join(dir, "models.json"), JSON.stringify(models, null, 2));
  return dir;
}

const readSettings = (dir) => readFileSync(join(dir, "settings.json"), "utf8");
const settingsPath = (dir) => join(dir, "settings.json");

const SYNC_TEST_PROVIDER = {
  providers: {
    "sync-test": {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      apiKey: "sync-test-key",
      models: [{ id: "kept-model" }, { id: "fresh-model" }],
    },
  },
};

test("writes the reconciled whitelist next to the other settings", async () => {
  const dir = makeAgentDir({
    settings: { theme: "dark", defaultModel: "untouched", enabledModels: ["sync-test/kept-model"] },
    models: SYNC_TEST_PROVIDER,
  });

  const outcome = await syncEnabledModelsWithModelsConfig({ agentDir: dir });

  assert.equal(outcome.status, "updated");
  assert.deepEqual(outcome.added, ["sync-test/fresh-model"]);
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(JSON.parse(readSettings(dir)), {
    theme: "dark",
    defaultModel: "untouched",
    enabledModels: ["sync-test/kept-model", "sync-test/fresh-model"],
  });

  const second = await syncEnabledModelsWithModelsConfig({ agentDir: dir });
  assert.deepEqual(second, { status: "unchanged", added: [], removed: [] });
});

test("prunes a deleted model and keeps the rest of settings.json byte-stable", async () => {
  const dir = makeAgentDir({
    settings: { theme: "dark", enabledModels: ["sync-test/kept-model", "sync-test/deleted-model"] },
    models: SYNC_TEST_PROVIDER,
  });

  const outcome = await syncEnabledModelsWithModelsConfig({ agentDir: dir });

  assert.equal(outcome.status, "updated");
  assert.deepEqual(outcome.removed, ["sync-test/deleted-model"]);
  assert.deepEqual(outcome.added, ["sync-test/fresh-model"]);
  assert.deepEqual(JSON.parse(readSettings(dir)).enabledModels, [
    "sync-test/kept-model",
    "sync-test/fresh-model",
  ]);
});

test("leaves settings.json untouched for every skip reason", async () => {
  const cases = [
    { name: "opt-out", settings: { enabledModels: ["sync-test/kept-model"], enabledModelsSync: "off" }, status: "disabled" },
    { name: "empty whitelist", settings: { enabledModels: [] }, status: "skipped" },
    { name: "no whitelist key", settings: { theme: "dark" }, status: "skipped" },
    { name: "unreadable settings", settings: undefined, status: "skipped" },
  ];

  for (const { name, settings, status } of cases) {
    const dir = makeAgentDir({ settings, models: SYNC_TEST_PROVIDER });
    if (name === "unreadable settings") writeFileSync(settingsPath(dir), "{ not json");
    const before = readSettings(dir);

    const outcome = await syncEnabledModelsWithModelsConfig({ agentDir: dir });

    assert.equal(outcome.status, status, name);
    assert.deepEqual(outcome.added, [], name);
    assert.deepEqual(outcome.removed, [], name);
    assert.match(outcome.reason, /./, name);
    assert.equal(readSettings(dir), before, name);
  }
});

test("never reports an update it could not write", async () => {
  const dir = makeAgentDir({
    settings: { theme: "dark", enabledModels: ["sync-test/kept-model"] },
    models: SYNC_TEST_PROVIDER,
  });
  // A read-only settings.json makes the write fail; the outcome must say so
  // instead of claiming the whitelist was reconciled.
  chmodSync(settingsPath(dir), 0o444);
  try {
    const outcome = await syncEnabledModelsWithModelsConfig({ agentDir: dir });

    assert.equal(outcome.status, "skipped");
    assert.match(outcome.reason, /settings\.json/);
    assert.deepEqual(outcome.added, []);
    assert.deepEqual(JSON.parse(readSettings(dir)).enabledModels, ["sync-test/kept-model"]);
  } finally {
    chmodSync(settingsPath(dir), 0o644);
  }
});

test("degrades quietly when models.json cannot be read as providers", async () => {
  const dir = makeAgentDir({
    settings: { enabledModels: ["sync-test/kept-model"] },
    models: { providers: {} },
  });
  const before = readSettings(dir);

  const outcome = await syncEnabledModelsWithModelsConfig({ agentDir: dir });

  assert.equal(outcome.status, "skipped");
  assert.match(outcome.reason, /models\.json defines no providers/);
  assert.equal(readSettings(dir), before);
});

test("concurrent saves converge on the same whitelist", async () => {
  const dir = makeAgentDir({
    settings: { theme: "dark", enabledModels: ["sync-test/kept-model"] },
    models: SYNC_TEST_PROVIDER,
  });

  const outcomes = await Promise.all([
    syncEnabledModelsWithModelsConfig({ agentDir: dir }),
    syncEnabledModelsWithModelsConfig({ agentDir: dir }),
  ]);

  // Both calls plan the same additions from the same models.json, so the second
  // write repeats the first instead of dropping it; the file must not end up with
  // duplicates or a torn merge.
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["updated", "updated"]);
  assert.deepEqual(JSON.parse(readSettings(dir)).enabledModels, [
    "sync-test/kept-model",
    "sync-test/fresh-model",
  ]);
});
