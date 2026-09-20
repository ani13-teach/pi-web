/**
 * End-to-end checks for `PUT /api/models-config` and the `enabledModels` sync.
 *
 * `enabledModels` is a hard whitelist, so a provider or model saved in the model
 * settings page stays invisible in pi until the whitelist mentions it. These
 * checks drive the built backend against a throwaway agent directory
 * (`PI_CODING_AGENT_DIR`), so the user's real settings.json and models.json are
 * never touched. Replaces nothing: `tests/backend-ipc.mjs` keeps using the real
 * agent dir and must not write to it.
 *
 * Run after `npm run build:desktop`.
 */
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tests$/, "");
const backendPath = join(root, "dist", "main", "backend.mjs");

if (!existsSync(backendPath)) {
  console.error(`missing ${backendPath} — run: npm run build:desktop`);
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-models-sync-"));
const modelsPath = join(agentDir, "models.json");
const settingsPath = join(agentDir, "settings.json");
const keepModel = "e2e-provider/kept-model";

writeFileSync(modelsPath, JSON.stringify({
  providers: {
    "e2e-provider": {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      apiKey: "e2e-placeholder-key",
      models: [{ id: "kept-model" }, { id: "brand-new-model" }],
    },
  },
}, null, 2));
writeFileSync(settingsPath, JSON.stringify({
  theme: "dark",
  defaultModel: "untouched",
  enabledModels: [keepModel],
}, null, 2));

const child = fork(backendPath, [], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
});

let stderr = "";
child.stderr.on("data", (data) => { stderr += String(data); });

const pending = new Map();
child.on("message", (message) => {
  // The backend cannot read the system proxy itself, so it asks the host.
  if (message?.kind === "proxy.query") {
    child.send({ kind: "proxy.result", id: message.id, ok: true, value: "DIRECT" });
    return;
  }
  if (message?.kind === "response" && message.envelope) {
    const entry = pending.get(message.envelope.id);
    if (!entry) return;
    pending.delete(message.envelope.id);
    if (message.envelope.ok) entry.resolve(message.envelope.result);
    else entry.reject(new Error(message.envelope.error));
  }
});
child.on("exit", (code) => {
  for (const entry of pending.values()) entry.reject(new Error(`backend exited with ${code}\n${stderr}`));
  pending.clear();
});

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    child.send({ kind: "request", envelope: { id, method, params } });
  });
}

async function request(url, init = {}) {
  const bodyBase64 = init.body === undefined
    ? undefined
    : Buffer.from(JSON.stringify(init.body)).toString("base64");
  const result = await call("http.request", {
    url,
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    bodyBase64,
  });
  const text = Buffer.from(result.bodyBase64 ?? "", "base64").toString("utf8");
  return { status: result.status, text, json: text ? JSON.parse(text) : undefined };
}

const readSettings = () => JSON.parse(readFileSync(settingsPath, "utf8"));
const saveModelsConfig = (config) => request("/api/models-config", { method: "PUT", body: config });
const modelsConfig = () => JSON.parse(readFileSync(modelsPath, "utf8"));

try {
  const added = await saveModelsConfig(modelsConfig());
  check("PUT /api/models-config answers with the sync outcome",
    added.status === 200 && added.json?.success === true,
    JSON.stringify(added.json));
  check("a model defined in models.json joins the whitelist",
    JSON.stringify(added.json?.enabledModelsSync?.added) === JSON.stringify(["e2e-provider/brand-new-model"]),
    JSON.stringify(added.json?.enabledModelsSync));

  const written = readSettings();
  check("settings.json keeps the unrelated fields",
    written.theme === "dark" && written.defaultModel === "untouched" && written.enabledModels !== undefined,
    JSON.stringify(written));
  check("the reconciled whitelist is on disk",
    JSON.stringify(written.enabledModels) === JSON.stringify([keepModel, "e2e-provider/brand-new-model"]),
    JSON.stringify(written.enabledModels));

  const again = await saveModelsConfig(modelsConfig());
  check("saving twice changes nothing",
    again.json?.enabledModelsSync?.status === "unchanged" && again.json.enabledModelsSync.added.length === 0,
    JSON.stringify(again.json?.enabledModelsSync));

  // The point of the sync: the picker sees the model without a manual edit.
  // /api/models only accepts a cwd the interface has validated first.
  await request("/api/cwd/validate", { method: "POST", body: { cwd: root } });
  const models = await request(`/api/models?cwd=${encodeURIComponent(root)}`);
  const refs = (models.json?.modelList ?? []).map((model) => `${model.provider}/${model.id}`).sort();
  check("GET /api/models lists the synced model",
    JSON.stringify(refs) === JSON.stringify([keepModel, "e2e-provider/brand-new-model"].sort()),
    JSON.stringify(refs));
  check("GET /api/models reports no scope warnings",
    (models.json?.modelScopeWarnings ?? []).length === 0,
    JSON.stringify(models.json?.modelScopeWarnings));

  // A deleted model must not leave a pattern that matches nothing behind, and a
  // dead pattern for a provider the page does not own must survive.
  const shrunk = modelsConfig();
  shrunk.providers["e2e-provider"].models = [{ id: "kept-model" }];
  writeFileSync(modelsPath, JSON.stringify(shrunk, null, 2));
  const settingsBefore = readSettings();
  settingsBefore.enabledModels = [...settingsBefore.enabledModels, "anthropic/not-a-real-model"];
  writeFileSync(settingsPath, JSON.stringify(settingsBefore, null, 2));

  const pruned = await saveModelsConfig(modelsConfig());
  check("a deleted model is pruned from the whitelist",
    JSON.stringify(pruned.json?.enabledModelsSync?.removed) === JSON.stringify(["e2e-provider/brand-new-model"]),
    JSON.stringify(pruned.json?.enabledModelsSync));
  check("a dead built-in pattern is left alone",
    readSettings().enabledModels.includes("anthropic/not-a-real-model"),
    JSON.stringify(readSettings().enabledModels));

  // Declared but unusable right now (no credentials): the entry must survive, and
  // the picker is expected to warn about the pattern instead of guessing.
  const unkeyed = modelsConfig();
  unkeyed.providers["unkeyed-provider"] = {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    models: [{ id: "pending-model" }],
  };
  writeFileSync(modelsPath, JSON.stringify(unkeyed, null, 2));
  const withUnkeyed = readSettings();
  withUnkeyed.enabledModels = [...withUnkeyed.enabledModels, "unkeyed-provider/pending-model"];
  writeFileSync(settingsPath, JSON.stringify(withUnkeyed, null, 2));

  const kept = await saveModelsConfig(modelsConfig());
  check("a declared model without credentials keeps its entry",
    (kept.json?.enabledModelsSync?.removed ?? []).length === 0
      && readSettings().enabledModels.includes("unkeyed-provider/pending-model"),
    JSON.stringify(kept.json?.enabledModelsSync));

  const warned = await request(`/api/models?cwd=${encodeURIComponent(root)}`);
  check("the kept entry shows up as a scope warning",
    (warned.json?.modelScopeWarnings ?? []).some((warning) => warning.includes("unkeyed-provider/pending-model")),
    JSON.stringify(warned.json?.modelScopeWarnings));

  // Renaming or deleting a provider on the page leaves patterns naming a provider
  // the runtime no longer knows. They are leftovers, not user intent, so they must
  // go and the new name must take their place.
  const renamed = modelsConfig();
  delete renamed.providers["e2e-provider"];
  renamed.providers["renamed-provider"] = {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    apiKey: "e2e-placeholder-key",
    models: [{ id: "kept-model" }],
  };
  writeFileSync(modelsPath, JSON.stringify(renamed, null, 2));

  const afterRename = await saveModelsConfig(modelsConfig());
  const renameOutcome = afterRename.json?.enabledModelsSync ?? {};
  check("a renamed provider takes its old patterns with it",
    JSON.stringify(renameOutcome.removed) === JSON.stringify(["e2e-provider/kept-model"]),
    JSON.stringify(renameOutcome));
  check("the new provider name joins the whitelist",
    JSON.stringify(renameOutcome.added) === JSON.stringify(["renamed-provider/kept-model"]),
    JSON.stringify(renameOutcome));
  check("the untouched entries survive the rename",
    JSON.stringify(readSettings().enabledModels) === JSON.stringify([
      "anthropic/not-a-real-model",
      "unkeyed-provider/pending-model",
      "renamed-provider/kept-model",
    ]),
    JSON.stringify(readSettings().enabledModels));

  await call("backend.shutdown");
} catch (error) {
  check("the backend answered every request", false, error.message);
} finally {
  child.kill();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`} — agent dir: ${agentDir}`);
process.exit(failures === 0 ? 0 : 1);
