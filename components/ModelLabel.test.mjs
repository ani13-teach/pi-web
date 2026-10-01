import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ModelLabel } = await jiti.import("./ModelLabel.tsx");
const { ModelSelector } = await jiti.import("./ModelSelector.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { formatModelLabel, formatModelSpecLabel, getModelName } = await jiti.import("@/lib/model-label.ts");

const render = (element) => renderToStaticMarkup(React.createElement(I18nProvider, null, element));
const options = [
  { provider: "哈尔", modelId: "shared-id", name: "Shared Model" },
  { provider: "openai-codex", modelId: "shared-id", name: "Shared Model" },
];

test("model label renders a subdued channel and a complete tooltip", () => {
  const html = render(React.createElement(ModelLabel, { name: "Shared Model", provider: "哈尔" }));
  assert.match(html, /title="Shared Model \(哈尔\)"/);
  assert.match(html, /font-size:10px[^>]*>\(哈尔\)<\/span>/);
  assert.match(html, /text-overflow:ellipsis/);
});

test("closed toolbar and settings selectors disambiguate the same model by channel", () => {
  for (const variant of ["toolbar", "field"]) {
    for (const option of options) {
      const html = render(React.createElement(ModelSelector, {
        options, value: { provider: option.provider, modelId: option.modelId }, variant, onChange() {},
      }));
      assert.ok(html.includes(`title="Shared Model (${option.provider})"`));
      assert.ok(html.includes(`>(${option.provider})</span>`));
      assert.equal((html.match(new RegExp(`>\\(${option.provider}\\)</span>`, "g")) ?? []).length, 1);
    }
  }
});

test("empty and legacy selectors do not invent a channel", () => {
  for (const value of [null, { provider: "", modelId: "legacy-id" }]) {
    const html = render(React.createElement(ModelSelector, { options, value, emptyLabel: "Inherit", onChange() {} }));
    assert.ok(html.includes(value ? "legacy-id" : "Inherit"));
    assert.doesNotMatch(html, /\(undefined\)|\(unknown\)|\(哈尔\)|\(openai-codex\)/);
  }
});

test("unavailable notices already containing a channel are not labeled twice", () => {
  const html = render(React.createElement(ModelSelector, {
    options, value: { provider: "哈尔", modelId: "missing-id" },
    selectedLabel: "missing-id (哈尔) (unavailable)", onChange() {}, variant: "field",
  }));
  assert.match(html, /title="missing-id \(哈尔\) \(unavailable\)"/);
  assert.doesNotMatch(html, /\(unavailable\) \(哈尔\)/);
  assert.doesNotMatch(html, />\(哈尔\)<\/span>/);
});

test("display helpers preserve raw specs and keep slashes inside model IDs", () => {
  const spec = "哈尔/vendor/model-id";
  assert.equal(formatModelSpecLabel(spec), "vendor/model-id (哈尔)");
  assert.equal(spec, "哈尔/vendor/model-id");
  assert.equal(formatModelSpecLabel("legacy-id"), "legacy-id");
  assert.equal(formatModelLabel("Inherit"), "Inherit");
  assert.equal(formatModelSpecLabel("openai-codex/shared-id", { "openai-codex:shared-id": "Shared Model" }), "Shared Model (openai-codex)");
});

test("model names resolve against their own channel, including response aliases", () => {
  const names = { "a:shared-id": "Model A", "b:shared-id": "Model B", "a:vendor/id": "Alias" };
  assert.equal(getModelName("a", "shared-id", names), "Model A");
  assert.equal(getModelName("b", "shared-id", names), "Model B");
  assert.equal(getModelName("a", "prefix/vendor/id", names), "Alias");
  assert.equal(getModelName("a", "missing", names), "missing");
});
