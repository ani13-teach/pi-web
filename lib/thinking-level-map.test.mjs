import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { getSupportedThinkingLevels } from "../node_modules/@earendil-works/pi-ai/dist/models.js";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_THINKING_LEVEL_MAP,
  resolveThinkingLevelMap,
  withDefaultThinkingLevelMap,
} = await jiti.import("./thinking-level-map.ts");

test("defaults mapless reasoning models to custom low through max", () => {
  assert.deepEqual(DEFAULT_THINKING_LEVEL_MAP, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
  const resolved = withDefaultThinkingLevelMap(undefined);
  assert.deepEqual(resolved, DEFAULT_THINKING_LEVEL_MAP);
  assert.notEqual(resolved, DEFAULT_THINKING_LEVEL_MAP);
});

test("exposes only low through max for the product default", () => {
  const map = resolveThinkingLevelMap(true, undefined);
  assert.deepEqual(
    getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: map }),
    ["low", "medium", "high", "xhigh", "max"],
  );
});

test("keeps custom low-through-max entries but always removes off and minimal", () => {
  const explicit = { off: "none", minimal: "low", low: "tiny", high: null };
  assert.deepEqual(resolveThinkingLevelMap(true, explicit), {
    off: null,
    minimal: null,
    low: "tiny",
    medium: "medium",
    high: null,
    xhigh: "xhigh",
    max: "max",
  });
  assert.equal(resolveThinkingLevelMap(false, undefined), undefined);
});

test("does not expose a mutable shared default", () => {
  const first = withDefaultThinkingLevelMap(undefined);
  delete first.low;

  assert.equal(DEFAULT_THINKING_LEVEL_MAP.low, "low");
  assert.equal(withDefaultThinkingLevelMap(undefined).low, "low");
});
