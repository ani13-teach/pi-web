/** Isolated real-backend IPC checks. Build first: npm run build:desktop.
 * Uses only a throwaway agent/home/workspace and fake auth; outbound sockets and
 * fetch are blocked in the child. Never prompts a model or reads real credentials.
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
const root = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tests$/, "");
const backendPath = join(root, "dist/main/backend.mjs");
assert.ok(existsSync(backendPath), "run npm run build:desktop first");
const dir = mkdtempSync(join(tmpdir(), "pi-auth-model-ipc-"));
const agentDir = join(dir, "agent");
const cwd = join(dir, "workspace");
mkdirSync(agentDir); mkdirSync(cwd);
mkdirSync(join(cwd, ".pi"));
const projectSettingsPath = join(cwd, ".pi", "settings.json");
const projectSettingsText = JSON.stringify({ enabledModels: ["ipc-other/*:low"], customProjectSetting: "untouched" });
writeFileSync(projectSettingsPath, projectSettingsText);
const modelsPath = join(agentDir, "models.json");
const settingsPath = join(agentDir, "settings.json");
const networkLog = join(dir, "network-attempts.log");
const guardPath = join(dir, "network-guard.mjs");
writeFileSync(guardPath, `import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const block = () => { appendFileSync(${JSON.stringify(networkLog)}, "blocked\\n"); throw new Error("Network forbidden in isolated auth-model IPC test"); };
net.connect = block; net.createConnection = block; net.Socket.prototype.connect = block;
http.request = block; http.get = block; https.request = block; https.get = block; tls.connect = block;
globalThis.fetch = block; syncBuiltinESMExports();
`);
const secret = "fake-isolated-auth-key-never-use-for-requests";
const initial = { providers: {
  "ipc-auth": { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: secret,
    models: [{ id: "one", name: "One", contextWindow: 8192, maxTokens: 2048 }, { id: "two", name: "Two" }],
    modelOverrides: { one: { contextWindow: 8192, headers: { "x-isolated-test": "retained" }, maxTokens: 2048, reasoning: true } },
  },
  "ipc-other": { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: secret,
    models: [{ id: "same", name: "Other" }] },
} };
const settings = { theme: "dark", defaultProvider: "ipc-auth", defaultModel: "two", enabledModels: ["ipc-*/*:high", "unrelated/dead"],
  packages: [], extensions: [], skills: [], cacheWarming: "off", enableInstallTelemetry: false, enableAnalytics: false };
writeFileSync(modelsPath, JSON.stringify(initial));
writeFileSync(settingsPath, JSON.stringify(settings));
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: secret } }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|TOKEN|CREDENTIAL|SECRET|AUTH|NODE_OPTIONS/i.test(key)));
Object.assign(env, { PI_CODING_AGENT_DIR: agentDir, HOME: dir, USERPROFILE: dir, ELECTRON_RUN_AS_NODE: "", OPENAI_API_KEY: secret });
const child = fork(backendPath, [], { cwd, execArgv: ["--import", pathToFileURL(guardPath).href], stdio: ["ignore", "pipe", "pipe", "ipc"], env });
let stderr = "";
child.stderr.on("data", (data) => { stderr += String(data); });
child.stdout.on("data", () => {});
const pending = new Map();
child.on("message", (message) => {
  if (message?.kind === "proxy.query") {
    child.send({ kind: "proxy.result", id: message.id, ok: true, value: "DIRECT" }); return;
  }
  if (message?.kind !== "response") return;
  const entry = pending.get(message.envelope.id);
  if (!entry) return;
  pending.delete(message.envelope.id); clearTimeout(entry.timer);
  if (message.envelope.ok) entry.resolve(message.envelope.result);
  else entry.reject(new Error(message.envelope.error));
});
child.on("exit", (code) => {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`backend exited ${code}: ${stderr}`)); }
  pending.clear();
});
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`IPC timeout: ${method}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.send({ kind: "request", envelope: { id, method, params } });
  });
}
async function request(url, body, method = body === undefined ? "GET" : "PUT") {
  const result = await call("http.request", { url, method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    bodyBase64: body === undefined ? undefined : Buffer.from(JSON.stringify(body)).toString("base64") });
  const text = Buffer.from(result.bodyBase64 ?? "", "base64").toString("utf8");
  return { status: result.status, text, json: text ? JSON.parse(text) : undefined };
}
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const diskConfig = () => read(modelsPath);
const put = (config, authModelSelections) => request("/api/models-config", { config, ...(authModelSelections === undefined ? {} : { authModelSelections }) });
let count = 0;
async function check(name, fn) { await fn(); count++; console.log(`PASS ${name}`); }
let sessionId;
let builtinBaseline;
let failure;
try {
  await check("catalog is sanitized, uses full chat catalog and global SDK resolver", async () => {
    const response = await request("/api/models-config/auth-models");
    assert.equal(response.status, 200, response.text);
    assert.ok(response.json.providers.openai.models.length > 0, "built-in authenticated API-key provider listed");
    assert.deepEqual(response.json.providers["ipc-auth"].selectedIds, ["one", "two"]);
    assert.equal(response.json.providers["ipc-auth"].models[0].contextWindow, 8192);
    assert.ok(!response.text.includes(secret));
    assert.deepEqual(Object.keys(response.json), ["providers"]);
    for (const provider of Object.values(response.json.providers)) {
      assert.deepEqual(Object.keys(provider).sort(), ["models", "selectedIds"]);
      for (const model of provider.models) assert.deepEqual(Object.keys(model).sort(), ["contextWindow", "enabled", "id", "maxTokens", "name"]);
    }
  });
  await request("/api/cwd/validate", { cwd }, "POST");
  await check("managed overrides update models.json and the real global enabledModels, preserving other settings/pins", async () => {
    const config = diskConfig();
    config.providers["ipc-auth"].modelOverrides.one.contextWindow = 123456;
    const saved = await put(config, { "ipc-auth": ["one"] });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.success, true);
    assert.deepEqual(diskConfig().desktopModelSelections, { "ipc-auth": ["one"] });
    assert.deepEqual(diskConfig().providers["ipc-auth"].modelOverrides.one, { contextWindow: 123456, headers: { "x-isolated-test": "retained" }, maxTokens: 2048, reasoning: true });
    const written = read(settingsPath);
    assert.deepEqual(written.enabledModels, ["ipc-other/same:high", "unrelated/dead", "ipc-auth/one:high"]);
    assert.deepEqual({ ...written, enabledModels: settings.enabledModels }, settings);
    assert.equal(readFileSync(projectSettingsPath, "utf8"), projectSettingsText);
    const catalog = await request("/api/models-config/auth-models");
    assert.equal(catalog.json.providers["ipc-auth"].models.find((m) => m.id === "one").contextWindow, 123456);
    assert.deepEqual(catalog.json.providers["ipc-auth"].selectedIds, ["one"]);
    const picker = await request(`/api/models?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(picker.json.modelList.map((m) => `${m.provider}/${m.id}`).sort(), ["ipc-auth/one", "ipc-other/same"]);
  });
  await check("builtin context-only override does not widen enabledModels or erase other model fields", async () => {
    const catalog = await request("/api/models-config/auth-models");
    const builtin = catalog.json.providers.openai.models[0];
    builtinBaseline = builtin;
    const config = diskConfig();
    config.providers.openai = { modelOverrides: { [builtin.id]: { contextWindow: 333333 } } };
    const beforePatterns = read(settingsPath).enabledModels;
    // A stale client-side marker must not turn a context-only save into sync.
    config.desktopModelSyncPending = true;
    const saved = await put(config); assert.equal(saved.status, 200, saved.text);
    assert.equal(Object.hasOwn(diskConfig(), "desktopModelSyncPending"), false);
    assert.deepEqual(read(settingsPath).enabledModels, beforePatterns);
    assert.equal(diskConfig().desktopModelSelections.openai, undefined);
    const after = await request("/api/models-config/auth-models");
    const changed = after.json.providers.openai.models.find((m) => m.id === builtin.id);
    assert.equal(changed.contextWindow, 333333); assert.equal(changed.maxTokens, builtin.maxTokens); assert.equal(changed.enabled, false);
  });
  await check("new session honors managed initial scope and pinned thinking without invoking a model", async () => {
    const response = await request("/api/agent/new", { cwd, type: "ensure_session", toolNames: [] }, "POST");
    assert.equal(response.status, 200, response.text);
    assert.notEqual(response.json.model.modelId, "two", "saved hidden default must not win");
    sessionId = response.json.sessionId;
    assert.ok(sessionId);
  });
  await check("context-only builtin and custom providers without managed lists refresh existing models and reset defaults", async () => {
    const catalog = await request("/api/models-config/auth-models");
    const targets = [
      { provider: "openai", id: builtinBaseline.id, baseline: builtinBaseline.contextWindow },
      { provider: "ipc-other", id: "same", baseline: catalog.json.providers["ipc-other"].models[0].contextWindow },
    ];
    for (const { provider, id, baseline } of targets) {
      assert.equal(diskConfig().desktopModelSelections[provider], undefined);
      const select = () => request(`/api/agent/${sessionId}`, { type: "set_model", provider, modelId: id }, "POST");
      const before = await select(); assert.equal(before.status, 200, before.text);
      const config = diskConfig();
      config.providers[provider].modelOverrides ??= {};
      config.providers[provider].modelOverrides[id] = { contextWindow: 444444 };
      const patterns = read(settingsPath).enabledModels;
      const saved = await put(config); assert.equal(saved.status, 200, saved.text);
      assert.deepEqual(read(settingsPath).enabledModels, patterns);
      assert.equal(Object.hasOwn(diskConfig(), "desktopModelSyncPending"), false);
      const selected = await select(); assert.equal(selected.status, 200, selected.text);
      const state = await request(`/api/agent/${sessionId}`, { type: "get_state" }, "POST");
      assert.equal(state.json.data.contextUsage.contextWindow, 444444, state.text);
      const resetConfig = diskConfig(); delete resetConfig.providers[provider].modelOverrides[id].contextWindow;
      const reset = await put(resetConfig); assert.equal(reset.status, 200, reset.text);
      assert.deepEqual(read(settingsPath).enabledModels, patterns);
      const reselected = await select(); assert.equal(reselected.status, 200, reselected.text);
      const resetState = await request(`/api/agent/${sessionId}`, { type: "get_state" }, "POST");
      assert.equal(resetState.json.data.contextUsage.contextWindow, baseline, resetState.text);
    }
  });
  await check("PUT validates unknown provider/model and context before writing either file", async () => {
    const beforeModels = readFileSync(modelsPath, "utf8"); const beforeSettings = readFileSync(settingsPath, "utf8");
    const cases = [
      { config: diskConfig(), authModelSelections: { "not-known": [] } },
      { config: diskConfig(), authModelSelections: { "ipc-auth": ["not-known"] } },
      ...[0, -1, 1.2, "4096", Number.MAX_SAFE_INTEGER + 1].map((contextWindow) => {
        const config = diskConfig(); config.providers["ipc-auth"].modelOverrides.one.contextWindow = contextWindow;
        return { config, authModelSelections: { "ipc-auth": ["one"] } };
      }),
    ];
    for (const body of cases) {
      const result = await request("/api/models-config", body);
      assert.ok(result.status >= 400, result.text); assert.notEqual(result.json.success, true);
      assert.equal(readFileSync(modelsPath, "utf8"), beforeModels);
      assert.equal(readFileSync(settingsPath, "utf8"), beforeSettings);
    }
  });
  await check("set_model refreshes context for managed provider before selecting, and rejects hidden models", async () => {
    const config = diskConfig(); config.providers["ipc-auth"].modelOverrides.one.contextWindow = 222222;
    const saved = await put(config, { "ipc-auth": ["one"] }); assert.equal(saved.status, 200, saved.text);
    const changed = await request(`/api/agent/${sessionId}`, { type: "set_model", provider: "ipc-auth", modelId: "one" }, "POST");
    assert.equal(changed.status, 200, changed.text);
    const state = await request(`/api/agent/${sessionId}`, { type: "get_state" }, "POST");
    assert.equal(state.json.data.contextUsage.contextWindow, 222222, state.text);
    const hidden = await request(`/api/agent/${sessionId}`, { type: "set_model", provider: "ipc-auth", modelId: "two" }, "POST");
    assert.ok(hidden.status >= 400, hidden.text); assert.match(hidden.json.error, /hidden by desktop selection/);
  });
  await check("complete envelope draft resets context to default while preserving submitted headers and maxTokens", async () => {
    const config = diskConfig();
    const override = config.providers["ipc-auth"].modelOverrides.one;
    assert.equal(override.contextWindow, 222222);
    assert.deepEqual(override.headers, { "x-isolated-test": "retained" });
    assert.equal(override.maxTokens, 2048);
    delete override.contextWindow;
    const saved = await put(config); assert.equal(saved.status, 200, saved.text);
    const written = diskConfig().providers["ipc-auth"].modelOverrides.one;
    assert.equal(Object.hasOwn(written, "contextWindow"), false);
    assert.deepEqual(written, { headers: { "x-isolated-test": "retained" }, maxTokens: 2048, reasoning: true });
    const catalog = await request("/api/models-config/auth-models");
    const model = catalog.json.providers["ipc-auth"].models.find((m) => m.id === "one");
    assert.equal(model.contextWindow, 8192, "runtime must restore the model definition's default context");
    assert.equal(model.maxTokens, 2048);
    const selected = await request(`/api/agent/${sessionId}`, { type: "set_model", provider: "ipc-auth", modelId: "one" }, "POST");
    assert.equal(selected.status, 200, selected.text);
    const state = await request(`/api/agent/${sessionId}`, { type: "get_state" }, "POST");
    assert.equal(state.json.data.contextUsage.contextWindow, 8192, state.text);
  });
  await check("deleting the last builtin override preserves submitted provider headers and respects whole-provider deletion", async () => {
    const withHeaders = diskConfig();
    withHeaders.providers.openai.headers = { "x-provider-test": "retained" };
    const added = await put(withHeaders); assert.equal(added.status, 200, added.text);
    const config = diskConfig(); delete config.providers.openai.modelOverrides;
    const beforePatterns = read(settingsPath).enabledModels;
    const reset = await put(config); assert.equal(reset.status, 200, reset.text);
    assert.deepEqual(diskConfig().providers.openai, { headers: { "x-provider-test": "retained" } });
    assert.deepEqual(read(settingsPath).enabledModels, beforePatterns);
    const catalog = await request("/api/models-config/auth-models");
    assert.equal(catalog.json.providers.openai.models.find((m) => m.id === builtinBaseline.id).contextWindow, builtinBaseline.contextWindow);
    const removed = diskConfig(); delete removed.providers.openai;
    const saved = await put(removed); assert.equal(saved.status, 200, saved.text);
    assert.equal(Object.hasOwn(diskConfig().providers, "openai"), false);
    const after = await request("/api/models-config/auth-models");
    assert.equal(after.json.providers.openai.models.find((m) => m.id === builtinBaseline.id).contextWindow, builtinBaseline.contextWindow);
  });
  await check("legacy naked config preserves managed metadata and never auto-adds explicitly hidden models", async () => {
    const config = diskConfig(); delete config.desktopModelSelections;
    config.providers["ipc-auth"].models.push({ id: "" }, { id: "   " });
    const saved = await request("/api/models-config", config);
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(diskConfig().desktopModelSelections, { "ipc-auth": ["one"] });
    assert.deepEqual(diskConfig().providers["ipc-auth"].models.map((m) => m.id), ["one", "two"]);
    assert.ok(!read(settingsPath).enabledModels.includes("ipc-auth/two"));
  });
  await check("concurrent envelope saves merge provider-list metadata rather than replacing another edit", async () => {
    const stale = diskConfig();
    const results = await Promise.all([put(stale, { "ipc-auth": ["one"] }), put(stale, { "ipc-other": [] })]);
    for (const result of results) assert.equal(result.status, 200, result.text);
    assert.deepEqual(diskConfig().desktopModelSelections, { "ipc-auth": ["one"], "ipc-other": [] });
  });
  await check("envelope only edits supplied provider lists, ignoring stale metadata from a loaded config", async () => {
    const stale = diskConfig(); stale.desktopModelSelections["ipc-auth"] = ["two"];
    const saved = await put(stale, { "ipc-other": [] }); assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(diskConfig().desktopModelSelections, { "ipc-auth": ["one"], "ipc-other": [] });
  });
  await check("combined explicit selections and new custom provider/model save synchronizes both without enabling hidden models", async () => {
    const config = diskConfig();
    config.providers["ipc-combined"] = { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: secret, models: [{ id: "new-model" }] };
    config.providers["ipc-auth"].models.push({ id: "new-hidden" });
    const saved = await put(config, { "ipc-auth": ["two"], "ipc-other": [] });
    assert.equal(saved.status, 200, saved.text); assert.equal(saved.json.success, true);
    assert.ok(saved.json.enabledModelsSync.added.includes("ipc-combined/new-model"), saved.text);
    assert.ok(saved.json.enabledModelsSync.added.includes("ipc-auth/two"), saved.text);
    assert.ok(saved.json.enabledModelsSync.removed.includes("ipc-auth/one:high"), saved.text);
    const patterns = read(settingsPath).enabledModels;
    assert.ok(patterns.includes("ipc-auth/two"));
    assert.ok(patterns.includes("ipc-combined/new-model"));
    assert.ok(!patterns.some((p) => /ipc-auth\/(one|new-hidden)|ipc-other\//.test(p)));
    assert.ok(!patterns.some((p) => p.startsWith("openai/")), "builtin context-only provider must not auto-append");
    assert.equal(Object.hasOwn(diskConfig(), "desktopModelSyncPending"), false);
    const picker = await request(`/api/models?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(picker.json.modelList.map((m) => `${m.provider}/${m.id}`).sort(), ["ipc-auth/two", "ipc-combined/new-model"]);
    const cleanup = diskConfig(); delete cleanup.providers["ipc-combined"];
    cleanup.providers["ipc-auth"].models = cleanup.providers["ipc-auth"].models.filter((m) => m.id !== "new-hidden");
    const removed = await put(cleanup, { "ipc-auth": ["one"] }); assert.equal(removed.status, 200, removed.text);
  });
  await check("custom-only partial save on read-only settings retries the identical envelope and completes sync", async () => {
    const config = diskConfig();
    config.providers["ipc-retry"] = { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: secret, models: [{ id: "retried" }] };
    // Client metadata must not erase the server's pending obligation on retry.
    config.desktopModelSyncPending = false;
    const envelope = { config };
    const beforeSettings = readFileSync(settingsPath, "utf8");
    chmodSync(settingsPath, 0o444);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const saved = await request("/api/models-config", envelope);
        assert.equal(saved.status, 500, saved.text); assert.equal(saved.json.partialSave, true);
        assert.notEqual(saved.json.success, true);
        assert.equal(diskConfig().desktopModelSyncPending, true);
        assert.equal(readFileSync(settingsPath, "utf8"), beforeSettings);
      }
    } finally { chmodSync(settingsPath, 0o644); }
    const retry = await request("/api/models-config", envelope);
    assert.equal(retry.status, 200, retry.text); assert.equal(retry.json.success, true);
    assert.ok(retry.json.enabledModelsSync.added.includes("ipc-retry/retried"), retry.text);
    assert.ok(read(settingsPath).enabledModels.includes("ipc-retry/retried"));
    assert.equal(Object.hasOwn(diskConfig(), "desktopModelSyncPending"), false);
    const picker = await request(`/api/models?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(picker.json.modelList.some((m) => m.provider === "ipc-retry" && m.id === "retried"), picker.text);
    const cleanup = diskConfig(); delete cleanup.providers["ipc-retry"];
    const removed = await put(cleanup); assert.equal(removed.status, 200, removed.text);
  });
  await check("all-hidden with an unmatched legacy pattern filters desktop fallback and new session reports no models", async () => {
    const global = read(settingsPath); global.enabledModels.push("unrelated/dead"); writeFileSync(settingsPath, JSON.stringify(global));
    const config = diskConfig();
    // openai is authenticated by the fake key, so explicitly hide it too.
    const saved = await put(config, { "ipc-auth": [], "ipc-other": [], openai: [] }); assert.equal(saved.status, 200, saved.text);
    const picker = await request(`/api/models?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(picker.json.modelList, [], picker.text);
    const created = await request("/api/agent/new", { cwd, type: "ensure_session", toolNames: [] }, "POST");
    assert.ok(created.status >= 400, created.text); assert.match(created.json.error, /No enabled models are available/);
    // Existing idle session is not force-switched by a settings save.
    const state = await request(`/api/agent/${sessionId}`, { type: "get_state" }, "POST");
    assert.equal(state.json.data.model.id, "one", state.text);
    const history = SessionManager.create(cwd, dirname(state.json.data.sessionFile));
    history.appendModelChange("ipc-auth", "one");
    history.appendMessage({ role: "user", content: "Offline historical session fixture", timestamp: Date.now() });
    const historicalId = history.getSessionId();
    const reopened = await request(`/api/agent/${historicalId}`, { type: "ensure_session", toolNames: [] }, "POST");
    assert.equal(reopened.status, 200, reopened.text);
    const historicalState = await request(`/api/agent/${historicalId}`, { type: "get_state" }, "POST");
    assert.equal(historicalState.json.data.model.id, "one", historicalState.text);
    assert.ok(historicalState.json.data.contextUsage.tokens > 0, historicalState.text);
    assert.ok(readFileSync(history.getSessionFile(), "utf8").includes("Offline historical session fixture"));
  });
  await check("empty legacy whitelist preserves other unmanaged provider globs without re-enabling managed hidden providers", async () => {
    const current = read(settingsPath); current.enabledModels = []; writeFileSync(settingsPath, JSON.stringify(current));
    const saved = await put(diskConfig(), { "ipc-auth": ["one"] }); assert.equal(saved.status, 200, saved.text);
    const patterns = read(settingsPath).enabledModels;
    assert.ok(patterns.includes("anthropic/*"));
    assert.ok(!patterns.includes("openai/*")); assert.ok(!patterns.includes("ipc-other/*"));
    assert.ok(patterns.includes("ipc-auth/one")); assert.ok(!patterns.includes("ipc-auth/*"));
    // The other managed, hidden provider stays hidden despite the legacy glob.
    const picker = await request(`/api/models?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(picker.json.modelList.map((m) => `${m.provider}/${m.id}`), ["ipc-auth/one"]);
  });
  await check("unreadable global settings fail preflight without modifying models.json", async () => {
    const beforeModels = readFileSync(modelsPath, "utf8"); const beforeSettings = readFileSync(settingsPath, "utf8");
    writeFileSync(settingsPath, "{ invalid json");
    try {
      const saved = await put(diskConfig(), { "ipc-auth": [] }); assert.equal(saved.status, 500, saved.text);
      assert.equal(saved.json.partialSave, undefined); assert.equal(readFileSync(modelsPath, "utf8"), beforeModels);
    } finally { writeFileSync(settingsPath, beforeSettings); }
  });
  await check("settings write failure is explicit partial save and never reports success or damages files", async () => {
    const beforeSettings = readFileSync(settingsPath, "utf8"); chmodSync(settingsPath, 0o444);
    try {
      const saved = await put(diskConfig(), { "ipc-auth": [] });
      assert.equal(saved.status, 500, saved.text); assert.equal(saved.json.partialSave, true);
      assert.notEqual(saved.json.success, true); assert.deepEqual(saved.json.saved, ["config"]);
      assert.deepEqual(diskConfig().desktopModelSelections["ipc-auth"], []);
      assert.equal(readFileSync(settingsPath, "utf8"), beforeSettings);
    } finally { chmodSync(settingsPath, 0o644); }
  });
  await check("models write failure is not success and leaves original files intact", async () => {
    // Windows atomic replacement honors the read-only destination attribute.
    const beforeModels = readFileSync(modelsPath, "utf8"); const beforeSettings = readFileSync(settingsPath, "utf8");
    chmodSync(modelsPath, 0o444);
    try {
      const saved = await put(diskConfig(), { "ipc-auth": ["one"] });
      assert.equal(saved.status, 500, saved.text); assert.notEqual(saved.json.success, true); assert.equal(saved.json.partialSave, undefined);
      assert.equal(readFileSync(modelsPath, "utf8"), beforeModels); assert.equal(readFileSync(settingsPath, "utf8"), beforeSettings);
    } finally { chmodSync(modelsPath, 0o644); }
  });
  await check("invalid SDK model configuration returns an actual catalog error, not a successful fallback", async () => {
    const before = readFileSync(modelsPath, "utf8"); writeFileSync(modelsPath, "{ invalid json");
    try {
      const result = await request("/api/models-config/auth-models"); assert.equal(result.status, 422, result.text); assert.ok(result.json.error);
      assert.ok(!result.text.includes(secret));
    } finally { writeFileSync(modelsPath, before); }
  });
  await call("backend.shutdown");
  await check("no outbound network or model request was attempted", async () => { assert.equal(existsSync(networkLog), false); });
} catch (error) { failure = error; console.error(error); console.error(stderr.slice(-4000)); }
finally {
  child.kill();
  await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", resolve); });
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${count} isolated IPC checks passed`);
if (failure) process.exitCode = 1;
