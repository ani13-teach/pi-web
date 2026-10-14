import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { isValidAuthContext, applyAuthContextDrafts, authContextValue } = await jiti.import("./auth-model-drafts.ts");

test("context input accepts only positive safe integers and blank", () => {
  for (const value of ["", "1", "128000", "1000000"]) assert.equal(isValidAuthContext(value), true, value);
  for (const value of ["0", "-1", "NaN", "1.2", "12abc", "1e5", " 12", "9007199254740992"]) assert.equal(isValidAuthContext(value), false, value);
});

test("context edits preserve providers, other overrides and desktop selections", () => {
  const config = { providers: { oauth: { modelOverrides: { model: { contextWindow: 999, headers: { hello: "world" }, maxTokens: 500 }, other: { reasoning: true } } }, custom: { api: "fixture" } }, desktopModelSelections: { oauth: ["model"] } };
  const result = applyAuthContextDrafts(config, { oauth: { model: "128000" } });
  assert.equal(result.providers.oauth.modelOverrides.model.contextWindow, 128000);
  assert.equal(config.providers.oauth.modelOverrides.model.contextWindow, 999);
  assert.deepEqual(result.providers.oauth.modelOverrides.model.headers, { hello: "world" });
  assert.equal(result.providers.oauth.modelOverrides.model.maxTokens, 500);
  assert.deepEqual(result.providers.oauth.modelOverrides.other, config.providers.oauth.modelOverrides.other);
  assert.deepEqual(result.providers.custom, config.providers.custom);
  assert.deepEqual(result.desktopModelSelections, config.desktopModelSelections);
});

test("blank restores context only and prunes empty overrides without invalid empty providers", () => {
  const config = { providers: { oauth: { modelOverrides: { m: { contextWindow: 100, maxTokens: 50 }, n: { contextWindow: 200 } } } } };
  const reset = applyAuthContextDrafts(config, { oauth: { m: "", n: "" } });
  assert.deepEqual(reset.providers.oauth.modelOverrides, { m: { maxTokens: 50 } });
  assert.deepEqual(applyAuthContextDrafts({ providers: { oauth: { modelOverrides: { m: { contextWindow: 100 } } } } }, { oauth: { m: "" } }), { providers: {} });
});

test("unconfigured providers get only context overrides", () => {
  assert.deepEqual(applyAuthContextDrafts({}, { oauth: { m: "200000" } }), { providers: { oauth: { modelOverrides: { m: { contextWindow: 200000 } } } } });
  assert.throws(() => applyAuthContextDrafts({}, { oauth: { m: "3garbage" } }));
});

test("context draft baseline reads only numeric context values", () => {
  assert.equal(authContextValue({ m: { contextWindow: 200000 } }, "m"), "200000");
  assert.equal(authContextValue({ m: { maxTokens: 100 } }, "m"), "");
  assert.equal(authContextValue(undefined, "m"), "");
});
