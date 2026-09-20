/**
 * Which models the auto-mode page can offer.
 *
 * The classifier resolves a `provider/modelId` spec through pi's model registry,
 * and that registry is built from two very different places, so the picker has to
 * merge both to be complete:
 *
 * - `models.json` (read through `GET /api/models-config`) — the custom gateways
 *   someone adds by hand, e.g. `KBQ/[0.2]glm-5.3-flash`;
 * - `GET /api/models` — the registry's visible models, which is where built-in
 *   providers such as `openai-codex` come from. They never appear in
 *   `models.json`.
 *
 * Both responses are parsed defensively: a malformed entry is dropped instead of
 * emptying the picker. `GET /api/models` also applies the `enabledModels`
 * whitelist, which is why `models.json` is read separately — the classifier
 * resolves specs through the registry and ignores that whitelist.
 */

/** One pickable model. Structurally the same as `ModelSelectorOption`. */
export interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionFrom(provider: string, modelId: unknown, name: unknown): ModelOption | null {
  const id = text(modelId);
  if (!provider || !id) return null;
  return { provider, modelId: id, name: text(name) || id };
}

/** `models.json` providers, in file order. */
function modelsConfigOptions(modelsConfig: unknown): ModelOption[] {
  const providers = isRecord(modelsConfig) && isRecord(modelsConfig.providers)
    ? modelsConfig.providers
    : {};
  const options: ModelOption[] = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      const option = isRecord(model) ? optionFrom(providerId, model.id, model.name) : null;
      if (option) options.push(option);
    }
  }
  return options;
}

/** The `modelList` of a `GET /api/models` response. */
function registryOptions(modelsResponse: unknown): ModelOption[] {
  const list = isRecord(modelsResponse) && Array.isArray(modelsResponse.modelList)
    ? modelsResponse.modelList
    : [];
  const options: ModelOption[] = [];
  for (const model of list) {
    const option = isRecord(model) ? optionFrom(text(model.provider), model.id, model.name) : null;
    if (option) options.push(option);
  }
  return options;
}

/**
 * Both sources in one list, `models.json` first, duplicates by
 * `provider/modelId` keeping the entry that came first.
 */
export function collectModelOptions(modelsConfig: unknown, modelsResponse: unknown): ModelOption[] {
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const option of [...modelsConfigOptions(modelsConfig), ...registryOptions(modelsResponse)]) {
    const key = modelSpecOf(option.provider, option.modelId);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  return options;
}

/**
 * Split a saved spec the way the extension does: at the *first* slash. So
 * `Free/openrouter/free` is provider `Free` with model `openrouter/free`;
 * splitting anywhere else would mark the wrong entry as selected.
 *
 * `null` means "nothing is chosen here", which is the state an empty field has.
 */
export function splitModelSpec(spec: string): { provider: string; modelId: string } | null {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

export function modelSpecOf(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}
