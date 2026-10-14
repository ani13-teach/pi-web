import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveModelScopeWithDiagnostics, type ModelRuntime, type ScopedModel } from "@earendil-works/pi-coding-agent";
import type { AuthModelSelections } from "./auth-model-types";
import type { ModelScopeResult } from "./model-scope";
import { readModelsConfig } from "./models-config-store";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Missing entry means legacy scope; [] means deliberately hide every model. */
export function getDesktopModelSelections(config = readModelsConfig()): AuthModelSelections {
  const value = config.desktopModelSelections;
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([provider, ids]) => (
    Array.isArray(ids) && ids.every((id) => typeof id === "string")
      ? [[provider, [...new Set(ids as string[])]]]
      : []
  )));
}

export function isDesktopModelEnabled(
  provider: string,
  id: string,
  selections = getDesktopModelSelections(),
): boolean {
  return !Object.hasOwn(selections, provider) || selections[provider].includes(id);
}

/** Override membership, not credentials or subagent policy. Catalog must be available chat models. */
export function applyDesktopModelSelections(
  scope: ModelScopeResult,
  selections: AuthModelSelections,
  catalog: readonly Model<Api>[] = scope.visible,
): ModelScopeResult {
  if (Object.keys(selections).length === 0) return scope;
  const visible = scope.visible.filter((m) => isDesktopModelEnabled(m.provider, m.id, selections));
  const seen = new Set(visible.map((m) => `${m.provider}/${m.id}`));
  for (const model of catalog) {
    const ref = `${model.provider}/${model.id}`;
    if (Object.hasOwn(selections, model.provider) && isDesktopModelEnabled(model.provider, model.id, selections) && !seen.has(ref)) {
      visible.push(model);
      seen.add(ref);
    }
  }
  const thinkingLevelPins = Object.fromEntries(Object.entries(scope.thinkingLevelPins).filter(([ref]) => seen.has(ref)));
  // With managed providers an empty SDK scope would re-enable its fallback. Always
  // materialize all visible models, retaining legacy pins and resolver order.
  const scopedModels: ScopedModel[] = visible.map((model) => {
    const previous = scope.scopedModels.find((sm) => sm.model.provider === model.provider && sm.model.id === model.id);
    return previous ? { ...previous, model } : { model };
  });
  return { ...scope, visible, scopedModels, thinkingLevelPins };
}

/** Resolve against one complete catalog snapshot, never auth-filtered getAvailable(). */
export async function resolveCatalogPatterns(patterns: readonly string[], catalog: readonly Model<Api>[]) {
  return resolveModelScopeWithDiagnostics([...patterns], { getAvailable: async () => catalog } as ModelRuntime);
}

/**
 * Rewrite only patterns touching edited providers. A shared glob is replaced by
 * exact matches for its OTHER providers, with its thinking pin intact. Unmatched
 * unrelated patterns survive; explicit selections are never pruned by availability.
 */
export async function planAuthModelEnabledPatterns(
  patterns: readonly string[],
  selections: AuthModelSelections,
  catalog: readonly Model<Api>[],
  existingSelections: AuthModelSelections = {},
): Promise<string[]> {
  const edited = new Set(Object.keys(selections));
  if (edited.size === 0) return [...patterns];
  const result: string[] = [];
  const pins = new Map<string, string>();
  // Resolve the original list together: SDK uses the FIRST matching pattern's
  // thinking pin, including an unpinned first match followed by a pinned one.
  const original = await resolveCatalogPatterns(patterns, catalog);
  for (const scoped of original.scopedModels) {
    if (scoped.thinkingLevel) pins.set(`${scoped.model.provider}/${scoped.model.id}`, scoped.thinkingLevel);
  }
  // Keep original pattern order when materializing OTHER providers. A later
  // overlapping pinned reference must remain after the first unpinned reference;
  // SDK deduplicates by model on first match, not by the last suffix encountered.
  const materialize = ({ model, thinkingLevel }: ScopedModel) => `${model.provider}/${model.id}${thinkingLevel ? `:${thinkingLevel}` : ""}`;
  if (patterns.length === 0) {
    for (const provider of new Set([...catalog.map((m) => m.provider), ...Object.keys(existingSelections)])) {
      if (edited.has(provider)) continue;
      if (Object.hasOwn(existingSelections, provider)) {
        result.push(...existingSelections[provider].map((id) => `${provider}/${id}`));
      } else result.push(`${provider}/*`);
    }
  } else {
    for (const pattern of patterns) {
      const { scopedModels } = await resolveCatalogPatterns([pattern], catalog);
      // Also remove a dead exact provider reference instead of keeping a future
      // wildcard that could re-enable models the user has explicitly hidden.
      const slash = pattern.indexOf("/");
      const qualifier = slash >= 0 ? pattern.slice(0, slash) : undefined;
      const touches = (qualifier !== undefined && edited.has(qualifier)) || scopedModels.some(({ model }) => edited.has(model.provider));
      if (!touches) result.push(pattern);
      else result.push(...scopedModels.filter(({ model }) => !edited.has(model.provider)).map(materialize));
    }
  }
  for (const [provider, ids] of Object.entries(selections)) {
    for (const id of ids) {
      const ref = `${provider}/${id}`;
      const pin = pins.get(ref);
      result.push(`${ref}${pin ? `:${pin}` : ""}`);
    }
  }
  return [...new Set(result)];
}

export function validateAuthModelSelections(value: unknown, catalog: readonly Model<Api>[]): AuthModelSelections {
  if (!isRecord(value)) throw new Error("authModelSelections must be an object");
  const providers = new Map<string, Set<string>>();
  for (const model of catalog) {
    if (!providers.has(model.provider)) providers.set(model.provider, new Set());
    providers.get(model.provider)!.add(model.id);
  }
  for (const [provider, ids] of Object.entries(value)) {
    if (!providers.has(provider)) throw new Error(`Unknown provider: ${provider}`);
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new Error(`Selection for ${provider} must be a string array`);
    for (const id of ids) {
      if (!providers.get(provider)!.has(id)) throw new Error(`Unknown model: ${provider}/${id}`);
    }
  }
  return Object.fromEntries(Object.entries(value).map(([provider, ids]) => [provider, [...new Set(ids as string[])]]));
}

/** Only validate new/changed overrides; preserve unrelated legacy provider config. */
export function validateAuthModelOverrides(
  config: Record<string, unknown>,
  previous: Record<string, unknown>,
  catalog: readonly Model<Api>[],
): void {
  if (!isRecord(config.providers)) return;
  const oldProviders = isRecord(previous.providers) ? previous.providers : {};
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider) || !isRecord(provider.modelOverrides)) continue;
    const oldProvider = oldProviders[providerId];
    const oldOverrides = isRecord(oldProvider) && isRecord(oldProvider.modelOverrides) ? oldProvider.modelOverrides : {};
    for (const [id, override] of Object.entries(provider.modelOverrides)) {
      if (JSON.stringify(override) === JSON.stringify(oldOverrides[id])) continue;
      if (!catalog.some((m) => m.provider === providerId && m.id === id)) throw new Error(`Unknown model override: ${providerId}/${id}`);
      if (!isRecord(override)) throw new Error(`Invalid model override: ${providerId}/${id}`);
      if (Object.hasOwn(override, "contextWindow") && (!Number.isSafeInteger(override.contextWindow) || (override.contextWindow as number) <= 0)) {
        throw new Error(`contextWindow must be a positive safe integer: ${providerId}/${id}`);
      }
    }
  }
}
