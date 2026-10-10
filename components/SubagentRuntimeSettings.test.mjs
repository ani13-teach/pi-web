import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source = await readFile(new URL("./SubagentRuntimeSettings.tsx", import.meta.url), "utf8");
// Execute the actual helpers and component handlers with a small hook harness.
// This is a state/handler test, not a browser, DOM, or desktop-window test.
const harnessKey = "__subagentRuntimeSettingsTestHarness";
const result = await build({
  stdin: { contents: `${source}\nexport { DEFAULT_SUBAGENT_RUNTIME_SETTINGS, RUNTIME_SETTING_FIELDS };`, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic",
  plugins: [{
    name: "runtime-settings-hook-harness",
    setup(plugin) {
      plugin.onResolve({ filter: /^(react(?:\/jsx-runtime)?|@\/hooks\/useI18n|@\/hooks\/useIsMobile|\.\/SettingsUi)$/ }, ({ path }) => ({ path, namespace: "harness" }));
      plugin.onResolve({ filter: /^@\/lib\/subagent-runtime-schema$/ }, () => ({ path: fileURLToPath(new URL("../lib/subagent-runtime-schema.ts", import.meta.url)) }));
      plugin.onLoad({ filter: /.*/, namespace: "harness" }, ({ path }) => {
        if (path === "react") return { contents: ["useState", "useEffect", "useRef"].map((name) => `export const ${name} = (...args) => globalThis.${harnessKey}.${name}(...args);`).join("\n") };
        if (path === "react/jsx-runtime") return { contents: "export const jsx = (type, props) => ({type, props}); export const jsxs = jsx; export const Fragment = 'Fragment';" };
        if (path === "@/hooks/useI18n") return { contents: "export const useI18n = () => ({ t: (key, params) => params ? key + JSON.stringify(params) : key });" };
        if (path === "@/hooks/useIsMobile") return { contents: "export const useIsMobile = () => false;" };
        return { contents: ["ConfigButton", "ConfigDetailStack", "ConfigDetailTitle", "ConfigField", "ConfigFooter"].map((name) => `export const ${name} = '${name}';`).join("\n") };
      });
    },
  }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const { buildRuntimePatch, updateRuntimeDraft, runtimeFieldState, runtimeInheritedValue, readRuntimeSettings, saveRuntimeSettings, SubagentRuntimeSettings, DEFAULT_SUBAGENT_RUNTIME_SETTINGS: defaults, RUNTIME_SETTING_FIELDS: fields } = api;

function response(scope = "global", global = {}, project = {}, extra = {}) {
  return { scope, filePath: scope === "global" ? "C:/Users/test/.pi/agent/subagents.json" : "C:/project/.pi/subagents.json", values: scope === "global" ? global : project, effective: { ...defaults, ...global, ...(scope === "project" ? project : {}) }, global, project, ...extra };
}
function json(data, status = 200) { return { ok: status < 400, status, json: async () => data }; }
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function mockFetch(t, fn) { const original = globalThis.fetch; globalThis.fetch = fn; t.after(() => { globalThis.fetch = original; }); }

function createHarness(props) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let tree;
  let currentProps = props;
  const harness = {
    useState(initial) {
      const index = cursor++;
      const slot = slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slot.value, (next) => { slot.value = typeof next === "function" ? next(slot.value) : next; }];
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
      effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
    },
    render(nextProps = currentProps) {
      currentProps = nextProps;
      globalThis[harnessKey] = harness;
      cursor = 0;
      tree = SubagentRuntimeSettings(currentProps);
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
      return tree;
    },
    async settle() { await new Promise((resolve) => setImmediate(resolve)); return harness.render(); },
    nodes(type) {
      const found = [];
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        if (node.type === type) found.push(node);
        walk(node.props?.children);
      };
      walk(tree);
      return found;
    },
    control(key) { return [...harness.nodes("input"), ...harness.nodes("select")].find((node) => node.props.id?.endsWith(`-${key}`)); },
    scope() { return harness.nodes("select").find((node) => node.props["aria-label"] === "agents.runtime.scope"); },
    save() { return harness.nodes("ConfigButton").find((node) => ["agents.runtime.save", "agents.runtime.saving"].includes(node.props.children)); },
    change(key, value) { harness.control(key).props.onChange({ target: { value } }); harness.render(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); delete globalThis[harnessKey]; },
  };
  harness.render();
  return harness;
}

test("schema drives exactly the 18 requested fields and inheritance keeps zero/false", () => {
  assert.equal(fields.length, 18);
  assert.equal(new Set(fields.map((field) => field.key)).size, 18);
  assert.deepEqual(buildRuntimePatch(response(), {}), { patch: {}, errors: {} });
  const data = response("project", { maxConcurrentForeground: 0, reportUsage: false }, { maxConcurrentForeground: 8 });
  assert.deepEqual(runtimeInheritedValue(data, "maxConcurrentForeground"), { value: 0, source: "global" });
  assert.deepEqual(runtimeFieldState(data, { maxConcurrentForeground: null }, "maxConcurrentForeground"), { local: null, source: "global", value: 0, automatic: false });
  assert.equal(runtimeFieldState(data, {}, "reportUsage").value, false);
  assert.deepEqual(runtimeInheritedValue(response("global", {}, {}, { legacyMaxConcurrent: 7 }), "maxConcurrent"), { value: 7, source: "legacy" });
  assert.equal(runtimeFieldState(response(), {}, "workflowsEnabled").automatic, true);
  assert.equal(runtimeFieldState(response("project", { workflowsEnabled: true }), {}, "workflowsEnabled").automatic, false);
});

test("drafts save only changed layer keys, retain explicit zero and false, and undo edits", () => {
  const data = response("project", { maxConcurrent: 9 }, { defaultMaxTurns: 4, reportUsage: true });
  let draft = updateRuntimeDraft({}, data, "defaultMaxTurns", "0");
  draft = updateRuntimeDraft(draft, data, "reportUsage", "false");
  assert.deepEqual(buildRuntimePatch(data, draft), { patch: { defaultMaxTurns: 0, reportUsage: false }, errors: {} });
  draft = updateRuntimeDraft(draft, data, "defaultMaxTurns", "4");
  draft = updateRuntimeDraft(draft, data, "reportUsage", "true");
  assert.deepEqual(draft, {});
  assert.deepEqual(updateRuntimeDraft({}, data, "maxConcurrent", ""), {});
  assert.deepEqual(buildRuntimePatch(data, { defaultMaxTurns: "", reportUsage: null }), { patch: { defaultMaxTurns: null, reportUsage: null }, errors: {} });
  assert.deepEqual(buildRuntimePatch(data, { defaultMaxTurns: "004" }).patch, {});
  assert.deepEqual(buildRuntimePatch(data, { fallbackSubagent: " none " }).patch, { fallbackSubagent: "none" });
});

test("every integer field checks schema bounds and rejects malformed input instead of converting it to zero/null", () => {
  for (const field of fields.filter((field) => field.type === "number")) {
    for (const value of ["garbage", " ", "1.5", "NaN", "Infinity", "1e2", "0x10", String(field.min - 1), String(field.max + 1)]) {
      const result = buildRuntimePatch(response(), { [field.key]: value });
      assert.equal(result.errors[field.key], "number", `${field.key}: ${value}`);
      assert.deepEqual(result.patch, {});
    }
    for (const value of [field.min, field.max]) assert.equal(buildRuntimePatch(response(), { [field.key]: String(value) }).patch[field.key], value);
  }
  assert.equal(buildRuntimePatch(response(), { fallbackSubagent: "   " }).errors.fallbackSubagent, "text");
  assert.equal(buildRuntimePatch(response(), { defaultJoinMode: "invalid" }).errors.defaultJoinMode, "select");
  assert.equal(buildRuntimePatch(response(), { reportUsage: "invalid" }).errors.reportUsage, "boolean");
});

test("real request helpers encode scope/cwd, forward cancellation and PUT only the patch", async (t) => {
  const calls = [];
  const saved = response("project", { maxConcurrent: 5 }, { defaultMaxTurns: 0 });
  mockFetch(t, async (...args) => { calls.push(args); return json(saved); });
  const controller = new AbortController();
  assert.deepEqual(await readRuntimeSettings("C:/project & test", "project", controller.signal), saved);
  assert.equal(calls[0][0], "/api/subagents/runtime-settings?cwd=C%3A%2Fproject%20%26%20test&scope=project");
  assert.equal(calls[0][1].signal, controller.signal);
  assert.deepEqual(await saveRuntimeSettings("C:/project", "project", response("project", { maxConcurrent: 5 }, { defaultMaxTurns: 3 }), { defaultMaxTurns: "0" }), saved);
  assert.equal(calls[1][1].method, "PUT");
  assert.deepEqual(JSON.parse(calls[1][1].body), { cwd: "C:/project", scope: "project", patch: { defaultMaxTurns: 0 } });
  await assert.rejects(saveRuntimeSettings("C:/project", "project", saved, { defaultMaxTurns: "bad" }), /Invalid/);
  await saveRuntimeSettings("C:/project", "project", saved, {});
  assert.equal(calls.length, 2, "invalid and unchanged data must not issue writes");
});

test("request errors and scope mismatches reject without treating them as successful saves", async (t) => {
  mockFetch(t, async () => json({ error: "permission denied" }, 403));
  await assert.rejects(readRuntimeSettings("A", "global", new AbortController().signal), /permission denied/);
  await assert.rejects(saveRuntimeSettings("A", "global", response(), { maxConcurrent: "3" }), /permission denied/);
  globalThis.fetch = async () => json(response("project"));
  await assert.rejects(readRuntimeSettings("A", "global", new AbortController().signal), /scope/);
});

test("actual component handlers save tri-state/deletions, lock controls, sync response and notify once", async (t) => {
  const pendingSave = deferred();
  const calls = [];
  const initial = response("global", { reportUsage: true, defaultMaxTurns: 5 });
  mockFetch(t, async (url, options) => {
    calls.push([url, options]);
    return options?.method === "PUT" ? pendingSave.promise : json(initial);
  });
  let notified = 0;
  const harness = createHarness({ cwd: "A", onSaved: () => notified++ });
  t.after(() => harness.unmount());
  assert.equal(harness.save().props.disabled, true);
  await harness.settle();
  const booleanOptions = harness.control("reportUsage").props.children.flat().filter(Boolean).flatMap((node) => node.type === "Fragment" ? node.props.children : node);
  assert.deepEqual(booleanOptions.map((node) => node.props.value), ["", "true", "false"]);
  harness.change("reportUsage", "false");
  harness.change("defaultMaxTurns", "");
  assert.equal(harness.save().props.disabled, false);
  harness.save().props.onClick();
  harness.render();
  assert.equal(harness.scope().props.disabled, true);
  assert.ok([...harness.nodes("input"), ...harness.nodes("select")].every((node) => node.props.disabled));
  assert.deepEqual(JSON.parse(calls[1][1].body), { cwd: "A", scope: "global", patch: { defaultMaxTurns: null, reportUsage: false } });
  harness.save().props.onClick();
  assert.equal(calls.length, 2, "double clicks must not duplicate writes");
  pendingSave.resolve(json(response("global", { reportUsage: false })));
  await harness.settle();
  assert.equal(notified, 1);
  assert.equal(harness.control("defaultMaxTurns").props.value, "");
  assert.equal(harness.control("reportUsage").props.value, "false");
  assert.equal(harness.save().props.disabled, true);
});

test("actual component blocks invalid drafts and failed reads, and supports retry", async (t) => {
  let calls = 0;
  mockFetch(t, async () => { calls++; return calls === 1 ? json({ error: "broken JSON" }, 500) : json(response()); });
  const harness = createHarness({ cwd: "A", onSaved: () => assert.fail("must not notify") });
  t.after(() => harness.unmount());
  await harness.settle();
  assert.equal(harness.save().props.disabled, true);
  assert.ok(harness.nodes("div").some((node) => node.props.role === "alert"));
  harness.nodes("ConfigButton").find((node) => node.props.children === "agents.runtime.retry").props.onClick();
  harness.render();
  await harness.settle();
  harness.change("defaultMaxTurns", "1.5");
  assert.equal(harness.control("defaultMaxTurns").props.value, "1.5");
  assert.equal(harness.control("defaultMaxTurns").props["aria-invalid"], true);
  assert.equal(harness.save().props.disabled, true);
  harness.save().props.onClick();
  await harness.settle();
  assert.equal(calls, 2);
});

test("scope/cwd changes clear edits and abort GETs; slow results never replace the latest project", async (t) => {
  const reads = [];
  mockFetch(t, (url, options) => { const pending = deferred(); reads.push({ url, options, pending }); return pending.promise; });
  const props = { cwd: "A", onSaved: () => {} };
  const harness = createHarness(props);
  t.after(() => harness.unmount());
  harness.render({ ...props, cwd: "B" });
  assert.equal(reads[0].options.signal.aborted, true);
  reads[1].pending.resolve(json(response("global", { maxConcurrent: 11 })));
  await harness.settle();
  reads[0].pending.resolve(json(response("global", { maxConcurrent: 99 })));
  await harness.settle();
  assert.equal(harness.control("maxConcurrent").props.value, "11");
  harness.change("maxConcurrent", "7");
  harness.scope().props.onChange({ target: { value: "project" } });
  harness.render();
  assert.equal(harness.save().props.disabled, true);
  reads[2].pending.resolve(json(response("project", { maxConcurrent: 11 })));
  await harness.settle();
  assert.equal(harness.control("maxConcurrent").props.value, "");
  assert.equal(harness.control("maxConcurrent").props.placeholder, "11");
  assert.equal(harness.save().props.disabled, true);
});

test("late save responses cannot cross cwd boundaries or notify after unmount", async (t) => {
  const pending = [];
  mockFetch(t, async (_url, options) => {
    if (options?.method !== "PUT") return json(response());
    const request = deferred(); pending.push(request); return request.promise;
  });
  let notified = 0;
  const props = { cwd: "A", onSaved: () => notified++ };
  const harness = createHarness(props);
  t.after(() => harness.unmount());
  await harness.settle();
  harness.change("maxConcurrent", "8");
  harness.save().props.onClick();
  harness.render({ ...props, cwd: "B" });
  await harness.settle();
  pending[0].resolve(json(response("global", { maxConcurrent: 8 })));
  await harness.settle();
  assert.equal(harness.control("maxConcurrent").props.value, "");
  assert.equal(notified, 0);
  harness.change("maxConcurrent", "6");
  harness.save().props.onClick();
  harness.unmount();
  pending[1].resolve(json(response("global", { maxConcurrent: 6 })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notified, 0);
});

test("failed saves preserve drafts for retry and do not notify", async (t) => {
  let puts = 0;
  mockFetch(t, async (_url, options) => options?.method === "PUT" ? (puts++, json({ error: "disk read-only" }, 500)) : json(response()));
  const harness = createHarness({ cwd: "A", onSaved: () => assert.fail("must not notify") });
  t.after(() => harness.unmount());
  await harness.settle();
  harness.change("maxConcurrent", "6");
  harness.save().props.onClick();
  await harness.settle();
  assert.equal(puts, 1);
  assert.equal(harness.control("maxConcurrent").props.value, "6");
  assert.equal(harness.save().props.disabled, false);
  assert.ok(harness.nodes("p").some((node) => node.props.role === "alert"));
});

test("source uses the shared fill layout/footer, mobile columns and cancellation without another ConfigDetail", () => {
  assert.match(source, /export function SubagentRuntimeSettings\(\{ cwd, onSaved \}: \{ cwd: string; onSaved: \(\) => void \}\)/);
  assert.match(source, /<ConfigDetailStack className="is-fill"/);
  assert.match(source, /<ConfigFooter/);
  assert.match(source, /<ConfigButton variant="primary" disabled=\{disabled \|\| invalid \|\| !dirty\}/);
  assert.match(source, /gridTemplateColumns: isMobile \? "1fr"/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /selectionRef\.current === selectionKey/);
  assert.doesNotMatch(source, /<ConfigDetail[\s>]|fleetView|widgetMode|agentMentions|showCost|viewerMarkdown/);
});

test("all three locales contain every runtime field, hint and shared UI key", async () => {
  const expected = new Set([...source.matchAll(/t\("(agents\.runtime\.[^"]+)"/g)].map((match) => match[1]));
  for (const key of ["save", "saving", "saved", "reloadHint", "automatic", "value", "source", "scope.global", "scope.project", "source.global", "source.project", "source.legacy", "source.default", "validation.number", "validation.text", "validation.select", "validation.boolean"]) expected.add(`agents.runtime.${key}`);
  for (const field of fields) {
    expected.add(`agents.runtime.field.${field.key}`);
    expected.add(`agents.runtime.hint.${field.key}`);
    for (const option of field.options ?? []) expected.add(`agents.runtime.option.${option}`);
  }
  let baseline;
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const contents = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    const keys = [...contents.matchAll(/"(agents\.runtime\.[^"]+)":/g)].map((match) => match[1]);
    assert.equal(new Set(keys).size, keys.length, `${locale}: duplicate keys`);
    for (const key of expected) assert.ok(keys.includes(key), `${locale}: missing ${key}`);
    if (baseline) assert.deepEqual([...keys].sort(), baseline, `${locale}: key parity`);
    baseline = [...keys].sort();
    const output = await build({
      stdin: { contents, resolveDir: fileURLToPath(new URL("../lib/i18n/messages/", import.meta.url)), loader: "ts" },
      bundle: true, write: false, platform: "node", format: "esm",
    });
    const messages = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
    const map = Object.values(messages)[0].messages;
    for (const key of expected) assert.ok(map[key]?.trim(), `${locale}: empty ${key}`);
  }
});
