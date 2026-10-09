import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AgentsConfig.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const modelSelectorSource = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");

test("keeps same-name profiles selectable and groups built-ins before project, workspace and global", () => {
  assert.match(source, /return `\$\{profile\.scope\}:\$\{profile\.filePath \?\? profile\.name\}`/);
  assert.match(source, /\["builtin", "project", "workspace", "global"\] as const/);
  assert.match(source, /profile\.scope === scope/);
});

test("uses the shared enabled status treatment", () => {
  assert.match(source, /<ConfigStatusDot active=\{profile\.enabled\}/);
  assert.match(source, /className=\{`is-grow\$\{profile\.enabled \? "" : " is-muted"\}`\}/);
  assert.match(cssSource, /\.config-sidebar-text\.is-muted \{[\s\S]*?color: var\(--text-dim\)/);
});

test("offers a persisted built-in sub-agent switch with explicit session reload", () => {
  assert.match(source, /fetch\("\/api\/subagents\/settings"/);
  assert.match(source, /JSON\.stringify\(\{ enabled \}\)/);
  assert.match(source, /<ConfigSwitch[\s\S]*?checked=\{builtInEnabled\}[\s\S]*?t\("agents\.builtInTitle"\)/);
  assert.match(source, /sendAgentCommand\(sessionId, \{ type: "reload" \}\)/);
  assert.match(source, /reloadNeeded && sessionId/);
  assert.match(source, /<SubagentRuntimeSettings cwd=\{cwd\}/);
  assert.doesNotMatch(source, /onBlur=\{\(\) => void updateMaxConcurrent/);
  assert.equal((source.match(/className="agents-feature-setting"/g) ?? []).length, 1);
  assert.match(cssSource, /\.agents-feature-setting \{[\s\S]*?border-bottom: 1px solid var\(--border\)/);
  assert.match(cssSource, /\.agents-concurrency-control \{[\s\S]*?white-space: nowrap;/);
});

test("marks profiles shadowed by a higher-precedence source", () => {
  assert.match(source, /isSubagentProfileOverridden\(profile, profiles\)/);
  assert.match(source, /overridden && <span className="agents-overridden-label">\{t\("agents\.overridden"\)\}<\/span>/);
  assert.match(cssSource, /\.agents-overridden-label \{[\s\S]*?white-space: nowrap;/);
});

test("treats built-in, global and project profiles as directly editable", () => {
  assert.match(source, /scope === "builtin" \|\| scope === "global" \|\| scope === "project"/);
  assert.match(source, /return isWritableScope\(profile\.scope\)/);
  assert.match(source, /setMode\(isEditableProfile\(profile\) \? "edit" : "view"\)/);
  assert.match(source, /selected && isWritableScope\(selected\.scope\) && mode === "edit"/);
});

test("offers three save scopes only when creating or duplicating a profile", () => {
  assert.match(source, /\{creating && \(\s*<Field label=\{t\("agents\.saveScope"\)\}/);
  assert.match(source, /\["builtin", "global", "project"\] as const/);
  assert.match(source, /aria-pressed=\{targetScope === scope\}/);
  assert.match(source, /onClick=\{\(\) => changeTargetScope\(scope\)\}/);
  assert.doesNotMatch(source, /beginOverride|mode === "override"|agents\.readOnly|agents\.override/);
});

test("uses the shared sidebar action for new profiles", () => {
  assert.match(source, /<ConfigListAction[\s\S]*?active=\{creating && !runtimeSettingsOpen\}[\s\S]*?onClick=\{beginCreate\}/);
  assert.match(source, /t\("agents\.new"\)[\s\S]*?<\/ConfigListAction>/);
});

test("sends the selected scope for saves and the source scope for deletes", () => {
  assert.match(source, /scope: targetScope,\s*profile: draft,\s*originalName: !creating && selected\?\.scope === targetScope \? selected\.name : undefined,\s*createOnly: creating/);
  assert.match(source, /JSON\.stringify\(\{ cwd, scope: selected\.scope, name: selected\.name, filePath: selected\.filePath \}\)/);
});

test("shows a Skills-style path row with the same switch in editable and readonly modes", () => {
  assert.match(source, /function displayProfilePath\(profile: SubagentProfile, cwd: string\)/);
  assert.match(source, /profile\.scope === "project" \|\| profile\.scope === "workspace"/);
  assert.match(source, /`~\/\.pi\/agent\/desktop-agents\/\$\{draft\.name \|\| "\.\.\."\}\.md`/);
  assert.match(source, /`~\/\.pi\/agent\/agents\/\$\{draft\.name \|\| "\.\.\."\}\.md`/);
  assert.match(source, /<ConfigSwitch checked=\{draft\.enabled\} disabled=\{disabled\}/);
  assert.doesNotMatch(source, /agents-readonly-status/);
  assert.doesNotMatch(source, /<Toggle label=\{t\("agents\.enabled"\)\}/);
});

test("persists existing profile toggles immediately without submitting unsaved fields", () => {
  assert.match(source, /const toggleEnabled = async \(enabled: boolean\)/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /JSON\.stringify\(\{ cwd, scope: targetScope, profile: \{ \.\.\.editableProfile\(source\), enabled \} \}\)/);
  assert.match(source, /setDraft\(\(current\) => \(\{ \.\.\.current, enabled: saved\.enabled, filePath: saved\.filePath \}\)\)/);
  const toggle = source.slice(source.indexOf("const toggleEnabled ="), source.indexOf("const toggleBuiltInSubagents ="));
  assert.doesNotMatch(toggle, /profile: draft/);
  assert.match(source, /filePath: profile\.filePath/);
});

test("reuses the ChatInput model selector with scoped models", () => {
  assert.match(source, /fetch\(`\/api\/models\?cwd=\$\{encodeURIComponent\(cwd\)\}`/);
  assert.match(source, /import \{ ModelSelector \} from "\.\/ModelSelector"/);
  assert.match(chatInputSource, /import \{ ModelSelector, type ModelSelectorOption \} from "\.\/ModelSelector"/);
  assert.match(source, /<ModelSelector[\s\S]*?options=\{modelSelectorOptions\}[\s\S]*?variant="field"/);
  assert.match(chatInputSource, /<ModelSelector[\s\S]*?options=\{modelOptions\}/);
  assert.match(modelSelectorSource, /filterModelOptions\(sortedOptions, filter\)/);
  assert.match(modelSelectorSource, /modelsByProvider\.map/);
  assert.match(modelSelectorSource, /event\.key !== "Escape" \|\| !open[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(source, /agents\.modelUnavailable/);
  assert.doesNotMatch(source, /placeholder="provider\/modelId"/);
});

test("fallback model picker is beside the primary, uses scoped options and explicitly clears", () => {
  const fields = source.slice(source.indexOf('<Field label={t("agents.model")}'), source.indexOf('<Field label={t("agents.thinking")}'));
  assert.match(fields, /<Field label=\{t\("agents\.fallbackModel"\)\}/);
  const fallback = fields.slice(fields.indexOf('<Field label={t("agents.fallbackModel")}'));
  assert.match(fallback, /options=\{modelSelectorOptions\}/);
  assert.match(fallback, /value=\{selectedFallbackModel\}/);
  assert.match(fallback, /onChange=\{\(provider, modelId\) => update\("fallbackModel", `\$\{provider\}\/\$\{modelId\}`\)\}/);
  assert.match(fallback, /onClear=\{\(\) => update\("fallbackModel", ""\)\}/);
  assert.match(fallback, /disabled=\{disabled \|\| modelsLoading/);
  assert.match(fallback, /!fallbackModelAvailable.*agents\.modelUnavailable/);
  assert.match(source, /gridTemplateColumns: isMobile \? "1fr" : "repeat\(2, minmax\(0, 1fr\)\)"/);
});

test("editor serialization preserves configured fallback and includes an explicit empty default", async () => {
  const { transform } = await import("esbuild");
  const helpers = source.slice(source.indexOf("function editableProfile("), source.indexOf("function profileKey("));
  const { code } = await transform(`${helpers}\nexport { editableProfile, modelSelectorValue };`, { loader: "tsx", format: "esm" });
  const { editableProfile, modelSelectorValue } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const profile = { name: "test", tools: [], fallbackModel: "backup/models/id" };
  assert.equal(JSON.parse(JSON.stringify(editableProfile(profile))).fallbackModel, profile.fallbackModel);
  assert.equal(JSON.parse(JSON.stringify(editableProfile({ ...profile, fallbackModel: undefined }))).fallbackModel, "");
  assert.deepEqual(modelSelectorValue(profile.fallbackModel), { provider: "backup", modelId: "models/id" });
  assert.deepEqual(modelSelectorValue("short-id"), { provider: "", modelId: "short-id" });
  assert.equal(modelSelectorValue(""), null);
});

test("fallback picker labels exist in all three locales", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of ["agents.fallbackModel", "agents.noFallback", "agents.fallbackHint"]) {
      assert.ok(messages.includes(`"${key}":`), `${locale}: ${key}`);
    }
  }
});

test("renders the agent ID as an input disabled only for readonly profiles or busy operations", () => {
  assert.match(source, /<input aria-label=\{t\("agents\.name"\)\}[^\n]*value=\{draft\.name\} disabled=\{disabled\}[^\n]*onChange=\{\(event\) => update\("name", event\.target\.value\)\}[^\n]*style=\{controlStyle\}/);
  assert.match(source, /const disabled = !editing \|\| saving \|\| toggling/);
  assert.doesNotMatch(source, /<code|disabled=\{disabled \|\| !creating\}/);
});

test("uses the same form controls for editable and readonly profiles", () => {
  assert.match(source, /<input aria-label=\{t\("agents\.displayName"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<input aria-label=\{t\("agents\.description"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<textarea className="agents-system-prompt"[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<Toggle key=\{tool\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<select aria-label=\{t\("agents\.thinking"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<input aria-label=\{t\("agents\.maxTurns"\)[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<Toggle label=\{t\("agents\.inheritContext"\)\} disabled=\{disabled\}/);
  assert.match(source, /<Toggle label=\{t\("agents\.background"\)\} disabled=\{disabled\}/);
  assert.match(source, /<Toggle label=\{t\("agents\.loadSkills"\)\} disabled=\{disabled\}/);
  assert.match(source, /<Toggle label=\{t\("agents\.loadExtensions"\)\} disabled=\{disabled\}/);
  assert.doesNotMatch(source, /ReadonlyValue|readonlyPromptStyle|agents-readonly/);
});

test("shows disabled controls with a gray background", () => {
  const disabledStyle = source.match(/const disabledInputStyle: CSSProperties = \{([\s\S]*?)\n\};/)?.[1] ?? "";
  assert.match(source, /<textarea[^>]*aria-label=\{t\("agents\.prompt"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /height: 195,[\s\S]*?minHeight: 195,[\s\S]*?maxHeight: "60vh"[\s\S]*?resize: disabled \? "none" : "vertical"/);
  assert.doesNotMatch(source, /agents-system-prompt[^\n]*fontFamily/);
  assert.match(disabledStyle, /background: "var\(--bg-panel\)"/);
  assert.match(disabledStyle, /color: "var\(--text-dim\)"/);
  assert.match(modelSelectorSource, /background: locked \? "var\(--bg-panel\)" : "var\(--bg\)"/);
});

test("keeps a larger resize corner when system instructions need a scrollbar", () => {
  assert.match(source, /<textarea className="agents-system-prompt" aria-label=\{t\("agents\.prompt"\)\}/);
  assert.match(cssSource, /.agents-system-prompt \{[\s\S]*?scrollbar-width: auto;/);
  assert.match(cssSource, /\.agents-system-prompt::-webkit-scrollbar \{[\s\S]*?width: 14px;[\s\S]*?height: 14px;/);
  assert.match(cssSource, /\.agents-system-prompt::-webkit-scrollbar-thumb \{[\s\S]*?border: 5px solid transparent;/);
});

test("duplicates any selected profile through the existing create flow", () => {
  assert.match(source, /function duplicateProfileName\(name: string, profiles: readonly SubagentProfile\[\]\)/);
  assert.match(source, /while \(existing\.has\(candidate\.toLowerCase\(\)\)\) candidate = `\$\{base\}-\$\{suffix\+\+\}`/);
  assert.match(source, /const beginDuplicate = \(\) =>/);
  assert.match(source, /\.\.\.editableProfile\(selected\),[\s\S]*?name,[\s\S]*?displayName: t\("agents\.copyName"/);
  assert.match(source, /setMode\("create"\)/);
  assert.match(source, /setTargetScope\(isWritableScope\(selected\.scope\) \? selected\.scope : "builtin"\)/);
  assert.match(source, /onClick=\{beginDuplicate\}[^>]*>[\s\S]*?t\("agents\.duplicate"\)/);
});

test("places duplicate and delete immediately before the enabled switch", () => {
  assert.match(source, /onClick=\{beginDuplicate\}[\s\S]*?onClick=\{\(\) => void remove\(\)\}[\s\S]*?<ConfigSwitch checked=\{draft\.enabled\}/);
});

test("confirms deletion and limits it to writable profiles", () => {
  assert.match(source, /window\.confirm\(t\("agents\.deleteConfirm", \{ name: selected\.displayName \}\)\)/);
  assert.match(source, /selected && isWritableScope\(selected\.scope\) && mode === "edit"/);
  assert.match(source, /method: "DELETE"/);
});

test("new profiles use native resources, background and prompt defaults", () => {
  const defaults = source.match(/const EMPTY_PROFILE: EditableProfile = \{([\s\S]*?)\n\};/)?.[1] ?? "";
  assert.match(defaults, /loadSkills: true/);
  assert.match(defaults, /loadExtensions: true/);
  assert.match(defaults, /runInBackground: true/);
  assert.match(defaults, /promptMode: "replace"/);
  assert.match(source, /\[builtInEnabled, setBuiltInEnabled\] = useState\(true\)/);
  assert.match(source, /t\("agents\.nameRules"\)/);
  assert.match(source, /filePath: undefined,[\s\S]*?displayName: t\("agents\.copyName"/);
});

test("conflict badges use exact identities and native source order, not case folding", async () => {
  const { transform } = await import("esbuild");
  const helper = source.match(/function isSubagentProfileOverridden\([\s\S]*?\n\}/)?.[0];
  assert.ok(helper);
  const { code } = await transform(`${helper}\nexport { isSubagentProfileOverridden };`, { loader: "ts", format: "esm" });
  const { isSubagentProfileOverridden: overridden } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const builtin = { name: "scout", scope: "builtin" };
  const global = { name: "scout", scope: "global" };
  const variant = { name: "Scout", scope: "workspace" };
  const first = { name: "scout", scope: "project", filePath: "a.md" };
  const last = { name: "scout", scope: "project", filePath: "z.md" };
  const profiles = [global, variant, first, last, builtin];
  assert.equal(overridden(builtin, profiles), false);
  assert.equal(overridden(global, profiles), true);
  assert.equal(overridden(variant, profiles), false);
  assert.equal(overridden(first, profiles), true);
  assert.equal(overridden(last, profiles), true);
  assert.equal(overridden(last, [global, variant, first, last]), false);
  assert.equal(overridden({ ...global, effective: true }, profiles), false, "runtime winner beats UI source order");
  assert.equal(overridden({ ...builtin, effective: false }, profiles), true, "suppressed factory preset is not shown as active");
});

test("shows the actual winning source and default mode without presenting the draft as runtime state", async () => {
  assert.match(source, /profile\.name === selected\.name && profile\.effective === true/);
  assert.match(source, /t\("agents\.effectiveSource"/);
  assert.match(source, /effectiveProfile\.runInBackground/);
  assert.match(source, /t\("agents\.callModeOverride"\)/);
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of ["effectiveSource", "noEffectiveSource", "modeBackground", "modeForeground", "modeDisabled", "callModeOverride"]) {
      assert.ok(messages.includes(`"agents.${key}":`));
    }
  }
});

test("built-in editing keeps the selected source without hijacking a same-name global profile", async () => {
  const { transform } = await import("esbuild");
  const helper = source.slice(source.indexOf("function isEditableProfile("), source.indexOf("function shortenPath("));
  const { code } = await transform(`${helper}\nexport { isEditableProfile, profileEditTarget };`, { loader: "ts", format: "esm" });
  const { isEditableProfile, profileEditTarget } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const builtin = { name: "Explore", scope: "builtin", model: "default/model" };
  const global = { name: "Explore", scope: "global", filePath: "global/scout.md", model: "global/model" };
  const workspace = { name: "Explore", scope: "workspace", filePath: "workspace/scout.md" };
  const project = { name: "Explore", scope: "project", filePath: "project/scout.md", model: "project/model" };
  assert.equal(isEditableProfile(builtin), true);
  assert.equal(isEditableProfile(global), true);
  assert.equal(isEditableProfile(project), true);
  assert.equal(isEditableProfile(workspace), false);
  assert.equal(isEditableProfile({ name: "../escape", scope: "builtin" }), false);
  assert.deepEqual(profileEditTarget(builtin), { profile: builtin, scope: "builtin" });
  const targetSource = helper.slice(helper.indexOf("function profileEditTarget("), helper.indexOf("function duplicateProfileName("));
  assert.doesNotMatch(targetSource, /findLast|toLowerCase/);
  // Selecting a lower-precedence source explicitly must continue to edit that file.
  assert.deepEqual(profileEditTarget(global), { profile: global, scope: "global" });
  assert.deepEqual(profileEditTarget(project), { profile: project, scope: "project" });
  assert.equal(builtin.model, "default/model");
  assert.equal(builtin.filePath, undefined);
});

test("built-in edits and toggles share the existing profiles API and reload flow", () => {
  const select = source.slice(source.indexOf("const selectProfile ="), source.indexOf("const beginCreate ="));
  assert.match(select, /profileEditTarget\(profile\)/);
  assert.match(select, /setDraft\(editableProfile\(target\.profile\)\)/);
  const scopeChange = source.slice(source.indexOf("const changeTargetScope ="), source.indexOf("const save ="));
  assert.match(scopeChange, /filePath: undefined/);
  const toggle = source.slice(source.indexOf("const toggleEnabled ="), source.indexOf("const toggleBuiltInSubagents ="));
  assert.match(toggle, /profileEditTarget\(selected\)\.profile/);
  assert.match(toggle, /setSelectedKey\(profileKey\(saved\)\)/);
  assert.match(toggle, /setReloadNeeded\(Boolean\(sessionId\)\)/);
  const save = source.slice(source.indexOf("const save ="), source.indexOf("const remove ="));
  assert.match(save, /setReloadNeeded\(Boolean\(sessionId\)\)/);
  assert.match(source, /t\("agents\.builtinEditHint"\)/);
  assert.doesNotMatch(source, /fetch\([^\n]*builtin/);
});

test("translations identify native pi-subagents and warn against duplicate loading", async () => {
  for (const locale of ["zh-CN", "zh-TW", "en"]) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    assert.ok(messages.includes('"agents.builtinEditHint":'), locale);
    assert.match(messages, /"agents\.builtInTitle": "[^"]*pi-subagents"/);
    assert.match(messages, /"agents\.builtInDescription": "[^"\n]*(?:重载|重新載入|reloading)[^"\n]*"/);
    assert.match(messages, /(?:禁止重复加载同源插件|禁止重複載入同源外掛|Do not load another copy of the same plugin)/);
    assert.match(messages, /"agents\.builtinEditHint": "[^"\n]*~\/\.pi\/agent\/desktop-agents\/<id>\.md/);
    assert.match(messages, /(?:不会恢复预设|不會恢復預設|does not restore the preset)/);
    assert.match(messages, /(?:优先于|優先於|take priority over)/);
  }
});

// Exercise the component's real event handlers with local state and a fake API.
// No renderer, live endpoint or user configuration is involved in these tests.
const { transform } = await import("esbuild");
const helperSource = source.slice(source.indexOf("function editableProfile("), source.indexOf("function Field("));
const defaultsSource = source.match(/const EMPTY_PROFILE: EditableProfile = \{[\s\S]*?\n\};/)?.[0];
const editingHandlers = source.slice(source.indexOf("const selectProfile ="), source.indexOf("const editing ="));
const toggleHandler = source.slice(source.indexOf("const toggleEnabled ="), source.indexOf("const toggleBuiltInSubagents ="));
const { code: handlerCode } = await transform(`
  ${helperSource}
  ${defaultsSource}
  export function handlers(context) {
    const {
      cwd, sessionId, selected, profiles, draft, targetScope, creating, loading, profilesReady,
      fetch, window, t, setTimeout, loadProfiles, update,
      setSelectedKey, setDraft, setMode, setTargetScope, setError, setSavedOk,
      setSaving, setReloadNeeded, setToggling, setProfiles, setRuntimeSettingsOpen,
    } = context;
    ${editingHandlers}
    ${toggleHandler}
    return { selectProfile, beginCreate, beginDuplicate, changeTargetScope, save, remove, toggleEnabled };
  }
`, { loader: "tsx", format: "esm" });
const { handlers } = await import(`data:text/javascript;base64,${Buffer.from(handlerCode).toString("base64")}`);

function editorHarness({ selected = null, profiles = selected ? [selected] : [], draft = selected, mode = "edit", targetScope = selected?.scope ?? "builtin", response } = {}) {
  const state = { selected, profiles, draft: { ...draft }, mode, targetScope, profilesReady: true, loading: false };
  const requests = [];
  const loads = [];
  let confirmations = 0;
  const context = {
    cwd: "C:/test-project", sessionId: "parent-session",
    t: (key) => key,
    window: { confirm: () => { confirmations++; return true; } },
    setTimeout: () => {},
    loadProfiles: async (key) => { loads.push(key); return true; },
    update: (key, value) => { state.draft = { ...state.draft, [key]: value }; },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, method: options.method, body });
      const data = response ?? (options.method === "DELETE" ? {} : {
        profile: { ...body.profile, scope: body.scope, filePath: `saved/${body.scope}/${body.profile.name}.md` },
      });
      return { ok: !data.error, status: data.error ? 409 : 200, json: async () => data };
    },
  };
  for (const key of ["selectedKey", "draft", "mode", "targetScope", "error", "savedOk", "saving", "reloadNeeded", "toggling", "profiles", "runtimeSettingsOpen"]) {
    context[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value) => {
      state[key] = typeof value === "function" ? value(state[key]) : value;
    };
  }
  return {
    state, requests, loads,
    render: () => handlers({ ...context, ...state, creating: state.mode === "create" }),
    confirmations: () => confirmations,
  };
}

const preset = { name: "scout", displayName: "Scout", scope: "builtin", description: "preset", systemPrompt: "builtin prompt", tools: ["read"], enabled: true };

test("first selection prefers built-in profiles while remembered selections remain available", () => {
  const load = source.slice(source.indexOf("const loadProfiles ="), source.indexOf("useEffect(() =>"));
  assert.match(load, /profileKey\(profile\) === rememberedKey\)[\s\S]*?scope === "builtin"[\s\S]*?scope === "project"[\s\S]*?scope === "workspace"[\s\S]*?scope === "global"/);
});

test("selecting and saving a preset never reads or writes a same-name global source", async () => {
  const global = { ...preset, scope: "global", systemPrompt: "global prompt", filePath: "global/scout.md" };
  const editor = editorHarness({ selected: global, profiles: [global, preset] });
  editor.render().selectProfile(preset);
  assert.equal(editor.state.draft.systemPrompt, preset.systemPrompt);
  assert.equal(editor.state.draft.filePath, undefined);
  assert.equal(editor.state.targetScope, "builtin");
  editor.state.selected = preset; // The selectedKey update resolves this profile on render.
  await editor.render().save();
  assert.equal(editor.requests[0].body.scope, "builtin");
  assert.equal(editor.requests[0].body.originalName, preset.name);
  assert.equal(editor.requests[0].body.profile.filePath, undefined);
});

test("creating defaults to builtin, carries createOnly and clears source paths across all scopes", async () => {
  const editor = editorHarness({ selected: preset });
  editor.render().beginCreate();
  editor.state.selected = null;
  assert.equal(editor.state.mode, "create");
  assert.equal(editor.state.targetScope, "builtin");
  assert.equal(editor.state.draft.name, "custom-agent");
  await editor.render().save();
  assert.equal(editor.requests[0].body.scope, "builtin");
  assert.equal(editor.requests[0].body.createOnly, true);
  assert.equal(editor.requests[0].body.originalName, undefined);
  for (const scope of ["global", "project", "builtin"]) {
    editor.state.draft.filePath = "must-not-be-saved.md";
    editor.render().changeTargetScope(scope);
    assert.equal(editor.state.targetScope, scope);
    assert.equal(editor.state.draft.filePath, undefined);
  }
});

test("creation conflicts surface the backend error without loading a successful result", async () => {
  const editor = editorHarness({ mode: "create", draft: { ...preset }, response: { error: "Agent already exists" } });
  await editor.render().save();
  assert.equal(editor.requests[0].body.createOnly, true);
  assert.equal(editor.state.error, "Agent already exists");
  assert.deepEqual(editor.loads, []);
  assert.equal(editor.state.saving, false);
});

test("editing IDs saves originalName and the original filePath in each writable scope", async () => {
  for (const scope of ["builtin", "global", "project"]) {
    const selected = { ...preset, scope, filePath: `old/${scope}/custom-file.md` };
    const editor = editorHarness({ selected, draft: { ...selected, name: "renamed-scout" } });
    await editor.render().save();
    const body = editor.requests[0].body;
    assert.equal(body.scope, scope);
    assert.equal(body.originalName, "scout");
    assert.equal(body.createOnly, false);
    assert.equal(body.profile.name, "renamed-scout");
    assert.equal(body.profile.filePath, selected.filePath);
    assert.deepEqual(editor.loads, [`${scope}:saved/${scope}/renamed-scout.md`]);
    assert.equal(editor.state.reloadNeeded, true);
  }
});

test("deleting a preset or stored builtin uses the selected ID and exact source, ignoring unsaved ID edits", async () => {
  for (const selected of [preset, { ...preset, filePath: "desktop-agents/custom-file.md" }]) {
    const editor = editorHarness({ selected, draft: { ...selected, name: "unsaved-scout" } });
    await editor.render().remove();
    assert.equal(editor.confirmations(), 1);
    assert.deepEqual(editor.requests, [{
      url: "/api/subagents/profiles", method: "DELETE",
      body: { cwd: "C:/test-project", scope: "builtin", name: "scout", ...(selected.filePath ? { filePath: selected.filePath } : {}) },
    }]);
    assert.equal(editor.state.reloadNeeded, true);
    assert.equal(editor.loads.length, 1);
  }
});

test("advanced editor controls expose prompt, file isolation, session persistence and extension selectors", async () => {
  for (const key of ["promptMode", "isolation", "persistSession", "extensionTools", "color"]) {
    assert.ok(source.includes(`aria-label={t("agents.${key}")}`), key);
  }
  assert.match(source, /update\("persistSession", event\.target\.value === "" \? undefined : event\.target\.value === "true"\)/);
  assert.match(source, /update\("extensionTools", event\.target\.value\.split\(","\)\)/);
  const editor = editorHarness({ selected: preset, draft: { ...preset, promptMode: "append", isolation: "worktree", persistSession: false, extensionTools: [], color: "cyan" } });
  await editor.render().save();
  const saved = editor.requests[0].body.profile;
  assert.equal(saved.promptMode, "append");
  assert.equal(saved.isolation, "worktree");
  assert.equal(saved.persistSession, false);
  assert.deepEqual(saved.extensionTools, []);
  assert.equal(saved.color, "cyan");
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of ["advanced", "promptMode", "promptAppend", "promptReplace", "isolation", "isolationHint", "persistSession", "extensionTools", "color"]) assert.ok(messages.includes(`"agents.${key}":`));
  }
});

test("saving runtime defaults refreshes the actual profile projection before later profile saves", async () => {
  const load = source.slice(source.indexOf("const loadProfiles ="), source.indexOf("useEffect(() =>"));
  const callback = source.match(/onSaved=\{(\(\) => \{\s*setReloadNeeded[\s\S]*?\n\s*\})\} \/>/)?.[1];
  assert.ok(callback);
  const { code } = await transform(`
    ${helperSource}
    export function projection(context) {
      const { cwd, selectedKey, sessionId, fetch, setLoading, setError, setProfiles,
        setSelectedKey, setDraft, setMode, setTargetScope, setReloadNeeded, setProfilesReady } = context;
      const getLastSettingsSelection = () => selectedKey;
      const useCallback = fn => fn;
      ${load}
      return ${callback};
    }
  `, { loader: "tsx", format: "esm" });
  const { projection } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const updated = { ...preset, runInBackground: false, effective: false };
  const state = { draft: { ...preset, runInBackground: true }, profiles: [preset] };
  const done = Promise.withResolvers();
  const context = {
    cwd: "C:/fixture", selectedKey: "builtin:scout", sessionId: "parent",
    fetch: async () => ({ ok: true, json: async () => ({ profiles: [updated] }) }),
    setLoading: value => { if (!value) done.resolve(); },
  };
  for (const key of ["error", "profiles", "selectedKey", "draft", "mode", "targetScope", "reloadNeeded", "profilesReady"]) context[`set${key[0].toUpperCase()}${key.slice(1)}`] = value => { state[key] = value; };
  projection(context)();
  await done.promise;
  assert.equal(state.reloadNeeded, true);
  assert.equal(state.draft.runInBackground, false);
  assert.equal(state.profiles[0].effective, false);
  const editor = editorHarness({ selected: updated, draft: { ...state.draft, description: "new description" } });
  await editor.render().save();
  assert.equal(editor.requests[0].body.profile.runInBackground, false, "later edits cannot pin the obsolete background default");
});

test("failed refresh blocks stale profile saves, supports retry and does not clear reload notices", async () => {
  const load = source.slice(source.indexOf("const loadProfiles ="), source.indexOf("useEffect(() =>"));
  const reload = source.slice(source.indexOf("const reloadSession ="), source.indexOf("  return (\n    <ConfigPanelShell"));
  const callback = source.match(/onSaved=\{(\(\) => \{\s*setReloadNeeded[\s\S]*?\n\s*\})\} \/>/)?.[1];
  const { code } = await transform(`
    ${helperSource}
    export function projection(context) {
      const { cwd, selectedKey, sessionId, fetch, setLoading, setError, setProfiles,
        setSelectedKey, setDraft, setMode, setTargetScope, setReloadNeeded, setProfilesReady,
        setReloading, setSettingsError, sendAgentCommand, onReloaded, t } = context;
      const getLastSettingsSelection = () => selectedKey;
      const useCallback = fn => fn;
      ${load}
      ${reload}
      return { loadProfiles, reloadSession, onSaved: ${callback} };
    }
  `, { loader: "tsx", format: "esm" });
  const { projection } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const state = { draft: { ...preset, runInBackground: true }, profiles: [preset], profilesReady: true, reloadNeeded: true };
  let fail = true;
  let reloaded = 0;
  let done = Promise.withResolvers();
  const context = {
    cwd: "C:/fixture", selectedKey: "builtin:scout", sessionId: "parent", t: key => key,
    fetch: async () => fail ? { ok: false, status: 500, json: async () => ({ error: "Refresh unavailable" }) }
      : { ok: true, json: async () => ({ profiles: [{ ...preset, runInBackground: false }] }) },
    sendAgentCommand: async () => {}, onReloaded: () => reloaded++,
    setLoading: value => { state.loading = value; if (!value) done.resolve(); },
  };
  for (const key of ["error", "profiles", "selectedKey", "draft", "mode", "targetScope", "reloadNeeded", "profilesReady", "reloading", "settingsError"]) context[`set${key[0].toUpperCase()}${key.slice(1)}`] = value => { state[key] = value; };
  const callbacks = projection(context);
  callbacks.onSaved();
  await done.promise;
  assert.equal(state.profilesReady, false);
  assert.equal(state.error, "Refresh unavailable");
  assert.equal(state.draft.runInBackground, true, "old values remain visible but cannot be saved");
  const editor = editorHarness({ selected: preset, draft: state.draft });
  editor.state.profilesReady = false;
  await editor.render().save();
  assert.equal(editor.requests.length, 0);
  await callbacks.reloadSession();
  assert.equal(state.reloadNeeded, true);
  assert.equal(state.settingsError, "agents.refreshFailed");
  assert.equal(reloaded, 0);
  fail = false;
  done = Promise.withResolvers();
  assert.equal(await callbacks.loadProfiles("builtin:scout"), true);
  assert.equal(state.profilesReady, true);
  assert.equal(state.draft.runInBackground, false);
  await callbacks.reloadSession();
  assert.equal(state.reloadNeeded, false);
  assert.equal(reloaded, 1);
  assert.match(source, /disabled=\{saving \|\| savedOk \|\| toggling \|\| loading \|\| !profilesReady/);
  assert.match(source, /!profilesReady && !loading && <ConfigButton/);
});

test("runtime settings share the sidebar and do not submit profiles when open", () => {
  assert.match(source, /<ConfigSidebarItem active=\{runtimeSettingsOpen\}/);
  assert.match(source, /runtimeSettingsOpen \? \(\s*<SubagentRuntimeSettings cwd=\{cwd\} onSaved=\{\(\) => \{\s*setReloadNeeded\(Boolean\(sessionId\)\);\s*void loadProfiles\(selectedKey \?\? undefined\)/);
  assert.match(source, /!runtimeSettingsOpen && <ConfigFooter/);
  const editor = editorHarness({ selected: preset });
  editor.state.runtimeSettingsOpen = true;
  editor.render().selectProfile(preset);
  assert.equal(editor.state.runtimeSettingsOpen, false);
  editor.state.runtimeSettingsOpen = true;
  editor.render().beginCreate();
  assert.equal(editor.state.runtimeSettingsOpen, false);
});

test("toggling a preset saves its original ID, preserves draft edits and replaces the preset source without duplicates", async () => {
  const active = { ...preset, effective: true };
  const global = { ...preset, scope: "global", filePath: "global/scout.md", description: "global description" };
  const editor = editorHarness({ selected: active, profiles: [global, active], draft: { ...active, name: "unsaved-id", description: "unsaved description" } });
  await editor.render().toggleEnabled(false);
  const body = editor.requests[0].body;
  assert.equal(body.scope, "builtin");
  assert.equal(body.profile.name, preset.name);
  assert.equal(body.profile.description, preset.description);
  assert.equal(body.profile.enabled, false);
  assert.equal(editor.state.draft.name, "unsaved-id");
  assert.equal(editor.state.draft.description, "unsaved description");
  assert.equal(editor.state.draft.enabled, false);
  assert.equal(editor.state.draft.filePath, "saved/builtin/scout.md");
  assert.equal(editor.state.profiles.length, 2);
  assert.equal(editor.state.profiles[0], global);
  assert.equal(editor.state.profiles[1].filePath, "saved/builtin/scout.md");
  assert.equal(editor.state.profiles[1].effective, true, "toggling preserves winner provenance, including disabled winners");
  assert.equal(editor.state.selectedKey, "builtin:saved/builtin/scout.md");
});
