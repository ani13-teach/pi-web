import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ModelLabel } = await jiti.import("../components/ModelLabel.tsx");
const { getUsageBucketModelName } = await jiti.import("../components/ProviderUsageSummary.tsx");
const { formatModelSpecLabel } = await jiti.import("../lib/model-label.ts");
const { modelSpecOf } = await jiti.import("../components/automode-model-options.ts");
const files = await Promise.all(["ModelsConfig", "AgentsConfig", "AutomodeConfig", "ProviderUsageSummary"].map(async (name) => {
  const source = await readFile(new URL(`../components/${name}.tsx`, import.meta.url), "utf8");
  return [name, ts.createSourceFile(`${name}.tsx`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)];
}));
const sources = Object.fromEntries(files);

// Execute the actual display expressions and field callbacks from the source.
// This covers these branches without a built app or access to user settings.
function nodes(file, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(sources[file]);
  return found;
}
function one(file, predicate) {
  const found = nodes(file, predicate);
  assert.equal(found.length, 1, `expected one matching node in ${file}`);
  return found[0];
}
function evaluate(node, bindings = {}) {
  if (ts.isJsxExpression(node)) node = node.expression;
  const scope = { React, ModelLabel, getUsageBucketModelName, formatModelSpecLabel, modelSpecOf, t, ...bindings };
  const { outputText } = ts.transpileModule(`(${node.getText()})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
  });
  return new Function(...Object.keys(scope), `return ${outputText}`)(...Object.values(scope));
}
const t = (key, params) => params?.model ? `${params.model} [${key}]` : key;
const render = (node, bindings) => renderToStaticMarkup(evaluate(node, bindings));
const attr = (name) => (node) => ts.isJsxAttribute(node) && node.name.getText() === name;
const labelExpr = (file) => one(file, attr("selectedLabel")).initializer.expression;
const translation = (file, key) => one(file, (node) => ts.isCallExpression(node)
  && node.expression.getText() === "t" && node.arguments[0]?.getText() === JSON.stringify(key));

const discovered = one("ModelsConfig", (node) => ts.isJsxSelfClosingElement(node)
  && node.tagName.getText() === "ModelLabel" && node.getText().includes("model.name"));
const configured = one("ModelsConfig", (node) => ts.isJsxExpression(node)
  && node.expression?.getText().startsWith("m.id ?"));

test("discovered and configured models show their own channel without mutating the entries", () => {
  for (const provider of ["哈尔", "openai-codex"]) {
    const model = Object.freeze({ id: "vendor/shared-id", name: "Shared Model" });
    const html = render(discovered, { model, name: provider });
    assert.ok(html.includes(`title="Shared Model (${provider})"`));
    assert.ok(html.includes(`>(${provider})</span>`));
    const configuredHtml = render(configured, { m: model, pName: provider });
    assert.ok(configuredHtml.includes(`title="vendor/shared-id (${provider})"`));
    assert.deepEqual(model, { id: "vendor/shared-id", name: "Shared Model" });
  }
  for (const name of [undefined, ""]) {
    assert.match(render(discovered, { model: { id: "raw-id", name }, name: "relay" }), /title="raw-id \(relay\)"/);
  }
  assert.equal(render(configured, { m: { id: "" }, pName: "relay" }), "i18n.newModel");
  const idLine = one("ModelsConfig", (node) => ts.isJsxExpression(node)
    && node.expression?.getText().startsWith("model.name && <code"));
  assert.match(render(idLine, { model: { name: "Display name", id: "raw-id" } }), />raw-id<\/code>/);
});

test("model ID and name inputs keep raw values and raw edit callbacks", () => {
  for (const [valueText, input, expectedValue, expectedWrite] of [
    ["model.id", "vendor/new-id", "vendor/original-id", ["id", "vendor/new-id"]],
    ['model.name ?? ""', "New name", "Original name", ["name", "New name"]],
  ]) {
    const field = one("ModelsConfig", (node) => ts.isJsxSelfClosingElement(node)
      && node.tagName.getText() === "TextInput" && node.attributes.properties.some((property) =>
        attr("value")(property) && property.initializer.expression.getText() === valueText));
    const value = field.attributes.properties.find(attr("value")).initializer.expression;
    const onChange = field.attributes.properties.find(attr("onChange")).initializer.expression;
    const writes = [];
    const bindings = { model: { id: "vendor/original-id", name: "Original name" }, set: (...args) => writes.push(args) };
    assert.equal(evaluate(value, bindings), expectedValue);
    evaluate(onChange, bindings)(input);
    assert.deepEqual(writes, [expectedWrite]);
  }
});

test("unavailable agent labels use the channel while selection and saves retain the original spec", () => {
  const draft = Object.freeze({ model: "relay/vendor/missing-id" });
  assert.equal(evaluate(labelExpr("AgentsConfig"), { draft, selectedModelAvailable: false }),
    "vendor/missing-id (relay) [agents.modelUnavailable]");
  assert.equal(evaluate(labelExpr("AgentsConfig"), { draft, selectedModelAvailable: true }), undefined);
  assert.equal(evaluate(labelExpr("AgentsConfig"), { draft: {}, selectedModelAvailable: false }), undefined);
  assert.equal(evaluate(labelExpr("AgentsConfig"), { draft: { model: "legacy-id" }, selectedModelAvailable: false }),
    "legacy-id [agents.modelUnavailable]");
  const source = sources.AgentsConfig.text;
  assert.match(source, /onChange=\{\(provider, modelId\) => update\("model", `\$\{provider\}\/\$\{modelId\}`\)\}/);
  assert.match(source, /JSON\.stringify\(\{ cwd, scope: targetScope, profile: draft \}\)/);
  assert.equal(draft.model, "relay/vendor/missing-id");
});

test("automode inheritance and unavailable selections format only their display values", () => {
  const inherited = translation("AutomodeConfig", "automode.inheritedModel");
  for (const [spec, expected] of [["relay/vendor/id", "vendor/id (relay)"], ["default", "default"], ["legacy-id", "legacy-id"]]) {
    const effective = Object.freeze({ classifierModel: spec });
    assert.equal(evaluate(inherited, { effective }), `${expected} [automode.inheritedModel]`);
    assert.equal(effective.classifierModel, spec);
  }
  const unavailable = one("AutomodeConfig", (node) => ts.isVariableDeclaration(node)
    && node.name.getText() === "selectedLabel").initializer;
  const bindings = { current: "relay/vendor/missing", loading: false, options: [] };
  assert.equal(evaluate(unavailable, bindings), "vendor/missing (relay) [automode.modelUnavailable]");
  assert.equal(evaluate(unavailable, { ...bindings, loading: true }), undefined);
  assert.equal(evaluate(unavailable, { ...bindings, current: "" }), undefined);
  assert.equal(evaluate(unavailable, { ...bindings, current: "default" }), "default [automode.modelUnavailable]");
  assert.equal(evaluate(unavailable, { ...bindings, options: [{ provider: "relay", modelId: "vendor/missing" }] }), undefined);
  const source = sources.AutomodeConfig.text;
  assert.match(source, /value=\{value\}[\s\S]*?onChange=\{\(event\) => onChange\(event.target.value\)\}/);
  assert.match(source, /onChange=\{\(provider, modelId\) => onChange\(modelSpecOf\(provider, modelId\)\)\}/);
  assert.match(source, /patch: buildPatch\(draft, baseline\)/);
});

test("usage rows label explicit models and old MiniMax cache without relabeling quota groups", () => {
  const expression = one("ProviderUsageSummary", (node) => ts.isJsxExpression(node)
    && node.expression && ts.isConditionalExpression(node.expression)
    && node.expression.getText().startsWith("getUsageBucketModelName(bucket, providerId)")).expression;
  for (const providerId of ["minimax", "minimax-cn"]) {
    const bucket = Object.freeze({ modelName: "MiniMax-M2", groupLabel: "MiniMax-M2", label: "Rolling" });
    const html = render(expression, { bucket, providerId });
    assert.ok(html.includes(`title="MiniMax-M2 (${providerId})"`));
    assert.ok(html.endsWith(" / Rolling"));
    assert.equal((html.match(/font-size:10px/g) ?? []).length, 1);
    assert.equal(bucket.modelName, "MiniMax-M2");
    const cached = Object.freeze({ groupLabel: "MiniMax-M2", label: "Weekly" });
    assert.ok(render(expression, { bucket: cached, providerId }).includes(`title="MiniMax-M2 (${providerId})"`));
    assert.equal(Object.hasOwn(cached, "modelName"), false);
    assert.equal(render(expression, { bucket: { groupLabel: "Quota 1", label: "Rolling" }, providerId }), "Quota 1 / Rolling");
  }
  for (const [bucket, expected] of [
    [{ groupLabel: "Codex", label: "Weekly" }, "Codex / Weekly"],
    [{ groupLabel: "Quota 1", label: "Rolling" }, "Quota 1 / Rolling"],
    [{ groupLabel: "MiniMax-M2", label: "Weekly" }, "MiniMax-M2 / Weekly"],
    [{ label: "5h" }, "5h"],
  ]) {
    assert.equal(render(expression, { bucket, providerId: "openai-codex" }), expected);
  }
});
