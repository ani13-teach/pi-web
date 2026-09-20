import { join } from "node:path";
import {
  getAgentDir,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModelsConfigPath, readModelsConfig } from "./models-config-store";
import { invalidateModelsCache } from "./models-cache";
import { hasGlob } from "./model-scope";

/**
 * Keep `settings.json`'s `enabledModels` in step with `models.json`.
 *
 * `enabledModels` is a hard whitelist: as soon as it holds one pattern, only the
 * models matching those patterns stay visible in pi and in this app's picker
 * (see lib/model-scope.ts). The model settings page only ever wrote
 * `models.json`, so a provider or model added there stayed invisible until the
 * whitelist was edited by hand, while a model deleted from `models.json` left a
 * pattern that matches nothing behind.
 *
 * The reconciliation is deliberately narrow:
 * - only providers declared in `models.json` are touched, so a hand-curated list
 *   of built-in providers (anthropic, openai-codex, …) keeps the user's intent;
 * - a pattern is only dropped when the very model it names is gone from
 *   `models.json`; a model that is merely unavailable right now (missing
 *   credentials, provider error) keeps its pattern;
 * - patterns that cannot be attributed to one `provider/modelId` — bare model
 *   ids, globs, or a provider missing from `models.json` — are never dropped;
 * - an empty `enabledModels` stays empty: it means "no filter", so filling it in
 *   would change what the user sees;
 * - a failing reconciliation never invalidates the saved `models.json` and never
 *   reports success it did not achieve.
 *
 * Two limits are worth knowing:
 * - entries are only added for models that are available (i.e. their provider has
 *   credentials), because pi resolves the whitelist against available models too.
 *   A provider declared here without credentials joins the whitelist on a later
 *   save, once the key exists.
 * - this page owns the global list. A project's `.pi/settings.json` may override
 *   `enabledModels` for its own cwd; that override is the project's business, and
 *   writing the merged value back into the global file would be wrong.
 *
 * Set `enabledModelsSync` to `"off"` in `settings.json` to opt out entirely.
 */

const MODEL_AVAILABILITY_TIMEOUT_MS = 15_000;

/** Same suffixes the resolver accepts as a `:level` pin (see lib/model-scope.ts). */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type EnabledModelsSyncStatus = "updated" | "unchanged" | "disabled" | "skipped";

/** Outcome reported to the settings page; also the shape of the PUT response field. */
export interface EnabledModelsSyncOutcome {
  status: EnabledModelsSyncStatus;
  /** References appended to the whitelist. */
  added: string[];
  /** Patterns dropped from the whitelist. */
  removed: string[];
  /** Why nothing was written, when the sync decided not to touch the whitelist. */
  reason?: string;
}

export interface EnabledModelsSyncPlan {
  /** Whitelist to persist: kept patterns in their original order, new references appended. */
  patterns: string[];
  added: string[];
  removed: string[];
}

export interface PlanEnabledModelsSyncOptions {
  /** The current `enabledModels` value, verbatim. */
  patterns: readonly string[];
  /** Models the resolver would consider available, i.e. `ModelRuntime.getAvailable()`. */
  availableModels: readonly Model<Api>[];
  /** Providers declared by `models.json` and the model ids each one lists. */
  definedModels: Readonly<Record<string, readonly string[]>>;
}

export interface SyncEnabledModelsOptions {
  /** Agent directory holding `settings.json`, `models.json` and `auth.json`. Defaults to pi's. */
  agentDir?: string;
}

/** Providers and model ids declared by a `models.json` object, however hand-edited it is. */
export function collectDefinedModels(config: Record<string, unknown>): Record<string, string[]> {
  const providers = config.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return {};

  const defined: Record<string, string[]> = {};
  for (const [providerId, provider] of Object.entries(providers)) {
    const models = provider !== null && typeof provider === "object"
      ? (provider as { models?: unknown }).models
      : undefined;
    defined[providerId] = Array.isArray(models)
      ? models.flatMap((model) => {
        const id = model !== null && typeof model === "object" ? (model as { id?: unknown }).id : undefined;
        return typeof id === "string" && id.trim().length > 0 ? [id] : [];
      })
      : [];
  }
  return defined;
}

/**
 * Split `provider/modelId` into a reference, or `undefined` when the pattern is
 * too globby (or too bare) to stand for exactly one model. Everything after the
 * first slash is the model id, because ids may contain slashes themselves.
 */
function patternReference(pattern: string): { provider: string; modelId: string } | undefined {
  const slashIndex = pattern.indexOf("/");
  if (slashIndex === -1) return undefined;
  const provider = pattern.slice(0, slashIndex).trim();
  const modelId = pattern.slice(slashIndex + 1).trim();
  if (!provider || !modelId || hasGlob(provider) || hasGlob(modelId)) return undefined;
  return { provider, modelId };
}

/**
 * Model ids a pattern could stand for: the id itself, plus the id without a
 * thinking-level suffix (`ref:high`). Both are checked before dropping a pattern,
 * because a model id may legitimately end in a colon segment (`llama3.1:8b`).
 */
function referenceCandidates(modelId: string): string[] {
  const colonIndex = modelId.lastIndexOf(":");
  if (colonIndex <= 0) return [modelId];
  const suffix = modelId.slice(colonIndex + 1);
  return THINKING_LEVELS.has(suffix) ? [modelId, modelId.slice(0, colonIndex)] : [modelId];
}

/**
 * Compute the reconciled whitelist.
 *
 * Patterns are matched with pi's own resolver rather than compared as strings,
 * because `enabledModels` supports globs and fuzzy ids (#307). Added references
 * are always `provider/modelId`: a bare id would make the resolver throw on an
 * ambiguous entry, and then the picker would be left without any model.
 */
export async function planEnabledModelsSync(
  options: PlanEnabledModelsSyncOptions,
): Promise<EnabledModelsSyncPlan> {
  const { patterns, availableModels, definedModels } = options;
  const plan: EnabledModelsSyncPlan = { patterns: [...patterns], added: [], removed: [] };
  const defined = new Map(
    Object.entries(definedModels).map(([providerId, ids]) => [providerId, new Set(ids)]),
  );
  if (patterns.length === 0 || defined.size === 0) return plan;

  const snapshotRuntime = {
    getAvailable: async () => availableModels,
  } as ModelRuntime;
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(
    [...patterns],
    snapshotRuntime,
  );

  const matched = new Set(scopedModels.map(({ model }) => `${model.provider}/${model.id}`));
  const deadPatterns = new Set(
    diagnostics.filter((diagnostic) => diagnostic.code === "no-match").map(({ pattern }) => pattern),
  );
  const isRemovable = (pattern: string): boolean => {
    if (!deadPatterns.has(pattern)) return false;
    const reference = patternReference(pattern);
    if (reference === undefined) return false;
    const declared = defined.get(reference.provider);
    if (declared === undefined) return false;
    return !referenceCandidates(reference.modelId).some((modelId) => declared.has(modelId));
  };

  const removed = patterns.filter(isRemovable);
  const kept = patterns.filter((pattern) => !isRemovable(pattern));
  const added = new Set<string>();
  for (const model of availableModels) {
    if (!defined.has(model.provider)) continue;
    const reference = `${model.provider}/${model.id}`;
    if (matched.has(reference) || kept.includes(reference)) continue;
    added.add(reference);
  }

  return {
    patterns: [...kept, ...added],
    added: [...added],
    removed,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const skipped = (reason: string): EnabledModelsSyncOutcome => ({
  status: "skipped",
  added: [],
  removed: [],
  reason,
});

/**
 * Reconcile `enabledModels` after `models.json` was written.
 *
 * Never throws: a failure here must not make an already saved `models.json` look
 * like a failed save.
 *
 * Overlapping saves do not need locking. The plan is a pure function of the
 * whitelist and `models.json`, and each call re-reads both, so two saves compute
 * the same result instead of racing on a delta. Writes to `settings.json` go
 * through SettingsManager's file lock and merge, which keeps every other field.
 * A pi CLI edit of `enabledModels` (the `/model` selector writes it too) landing
 * inside this call's window is still last-writer-wins, because `enabledModels` is
 * a single field and the SDK offers no read-plan-write transaction.
 */
export function syncEnabledModelsWithModelsConfig(
  options: SyncEnabledModelsOptions = {},
): Promise<EnabledModelsSyncOutcome> {
  return reconcileEnabledModels(options).catch((error) => (
    skipped(`enabledModels sync failed: ${describe(error)}`)
  ));
}

async function reconcileEnabledModels(
  options: SyncEnabledModelsOptions,
): Promise<EnabledModelsSyncOutcome> {
  const agentDir = options.agentDir ?? getAgentDir();
  const modelsPath = getModelsConfigPath(agentDir);
  const definedModels = collectDefinedModels(readModelsConfig(modelsPath));
  if (Object.keys(definedModels).length === 0) {
    return skipped("models.json defines no providers");
  }

  const settings = SettingsManager.create(process.cwd(), agentDir);
  // An unreadable settings.json makes every setter a silent no-op, so give up
  // before offering a plan that cannot be written.
  const [loadError] = settings.drainErrors();
  if (loadError) return skipped(`settings could not be read: ${describe(loadError.error)}`);

  const globalSettings = settings.getGlobalSettings() as Record<string, unknown>;
  if (globalSettings.enabledModelsSync === "off") {
    return { status: "disabled", added: [], removed: [], reason: 'enabledModelsSync is "off"' };
  }
  const current = Array.isArray(globalSettings.enabledModels)
    ? globalSettings.enabledModels.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (current.length === 0) {
    return skipped("enabledModels is empty, so every available model is visible");
  }

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath,
    signal: AbortSignal.timeout(MODEL_AVAILABILITY_TIMEOUT_MS),
  });
  const availableModels = await modelRuntime.getAvailable(undefined, {
    signal: AbortSignal.timeout(MODEL_AVAILABILITY_TIMEOUT_MS),
  });
  const plan = await planEnabledModelsSync({ patterns: current, availableModels, definedModels });
  if (plan.added.length === 0 && plan.removed.length === 0) {
    return { status: "unchanged", added: [], removed: [] };
  }

  // SettingsManager persists one field under a file lock and merges it into
  // whatever is on disk, so a concurrent pi CLI write to settings.json survives.
  settings.setEnabledModels(plan.patterns);
  await settings.flush();
  // flush() only awaits the queued write; a failed write lands in drainErrors()
  // instead of rejecting, and a settings file that failed to parse makes save() a
  // no-op. Never claim an update the file did not receive.
  const [writeError] = settings.drainErrors();
  if (writeError) return skipped(`settings could not be written: ${describe(writeError.error)}`);

  // The picker caches the resolved model list per cwd for a minute.
  invalidateModelsCache();
  return { status: "updated", added: plan.added, removed: plan.removed };
}
