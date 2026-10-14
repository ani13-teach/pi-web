import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AuthModelCatalog } from "./auth-model-types";
import { getDesktopModelSelections, isDesktopModelEnabled, isRecord, resolveCatalogPatterns } from "./auth-model-settings";
import { getModelsConfigPath, normalizeModelsConfigCosts, readModelsConfig } from "./models-config-store";

const TIMEOUT_MS = 15_000;

export class AuthModelConfigError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

/** Actual deadline as well as cancellation: SDK/local IO must not hang a route. */
export async function withAuthModelTimeout<T>(operation: () => Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AuthModelConfigError("Model catalog timed out; no model request was made", 504)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function loadAuthModelRuntime(modelsPath = getModelsConfigPath(), agentDir = getAgentDir()) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let runtime: ModelRuntime;
  try {
    runtime = await withAuthModelTimeout(() => ModelRuntime.create({
      modelsPath,
      authPath: join(agentDir, "auth.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
      signal,
    }));
  } catch (error) {
    if (signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
      throw new AuthModelConfigError("Model catalog timed out; no model request was made", 504);
    }
    throw error;
  }
  // SDK returns a usable builtin fallback plus getError() on invalid config.
  // Do not disguise that as a successful empty catalog or expose secret config.
  if (runtime.getError()) throw new AuthModelConfigError("Model configuration could not be loaded; check models.json", 422);
  return runtime;
}

/** Validate candidate through the real SDK without writing the user's models.json. */
export async function loadCandidateAuthModelRuntime(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-auth-model-config-"));
  try {
    const path = join(dir, "models.json");
    const normalized = normalizeModelsConfigCosts(config);
    // Match the existing store's blank-draft-row cleanup before SDK validation,
    // so the legacy settings form can still save while it has an empty new row.
    if (isRecord(normalized.providers)) {
      for (const provider of Object.values(normalized.providers)) {
        if (isRecord(provider) && Array.isArray(provider.models)) {
          provider.models = provider.models.filter((model) => !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0);
        }
      }
    }
    writeFileSync(path, JSON.stringify(normalized), { mode: 0o600 });
    return await loadAuthModelRuntime(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function loadGlobalModelSettings() {
  const settings = SettingsManager.create(process.cwd(), getAgentDir());
  if (settings.drainErrors().length) throw new AuthModelConfigError("Global settings could not be read; settings.json was not changed", 500);
  const patterns: unknown = settings.getGlobalSettings().enabledModels;
  if (patterns !== undefined && (!Array.isArray(patterns) || !patterns.every((pattern) => typeof pattern === "string"))) {
    throw new AuthModelConfigError("Global enabledModels must be a string array; settings.json was not changed", 500);
  }
  return settings;
}

export async function getAuthModelCatalog(): Promise<AuthModelCatalog> {
  const runtime = await loadAuthModelRuntime();
  const catalog = runtime.getModels();
  const globalSettings = loadGlobalModelSettings().getGlobalSettings();
  const patterns = globalSettings.enabledModels ?? [];
  const { scopedModels } = await resolveCatalogPatterns(patterns, catalog);
  const legacy = new Set(scopedModels.map(({ model }) => `${model.provider}/${model.id}`));
  const selections = getDesktopModelSelections(readModelsConfig());
  const providers: AuthModelCatalog["providers"] = Object.create(null);
  for (const model of catalog) {
    const enabled = Object.hasOwn(selections, model.provider)
      ? isDesktopModelEnabled(model.provider, model.id, selections)
      : patterns.length === 0 || legacy.has(`${model.provider}/${model.id}`);
    const provider = providers[model.provider] ??= { models: [], selectedIds: [] };
    provider.models.push({ id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, enabled });
    if (enabled) provider.selectedIds.push(model.id);
  }
  // Retain explicit selections in the response, even if the local catalog later
  // loses one. Catalog refresh must not silently prune a user's selection.
  for (const [provider, ids] of Object.entries(selections)) {
    if (providers[provider]) providers[provider].selectedIds = [...ids];
  }
  return { providers };
}
