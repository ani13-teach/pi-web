export type AuthContextDrafts = Record<string, Record<string, string>>;

export function isValidAuthContext(value: string): boolean {
  return value === "" || (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0);
}

/** Apply only edited context fields. Never replace a provider or its other metadata. */
export function applyAuthContextDrafts<T extends { providers?: Record<string, { modelOverrides?: Record<string, unknown> }> }>(
  config: T, drafts: AuthContextDrafts,
): T {
  const next = structuredClone(config);
  next.providers ??= {};
  for (const [providerId, models] of Object.entries(drafts)) {
    const provider = next.providers[providerId] ??= {};
    const overrides = { ...(provider.modelOverrides ?? {}) };
    for (const [id, raw] of Object.entries(models)) {
      if (!isValidAuthContext(raw)) throw new Error(`Invalid context length: ${providerId}/${id}`);
      const previous = overrides[id];
      const override = previous && typeof previous === "object" && !Array.isArray(previous)
        ? { ...previous } as Record<string, unknown> : {};
      if (raw === "") delete override.contextWindow;
      else override.contextWindow = Number(raw);
      if (Object.keys(override).length) overrides[id] = override;
      else delete overrides[id];
    }
    if (Object.keys(overrides).length) provider.modelOverrides = overrides;
    else delete provider.modelOverrides;
    if (Object.keys(provider).length === 0) delete next.providers[providerId];
  }
  return next;
}

export function authContextValue(
  overrides: Record<string, unknown> | undefined, id: string,
): string {
  const override = overrides?.[id];
  if (!override || typeof override !== "object" || !("contextWindow" in override)) return "";
  const value = override.contextWindow;
  return typeof value === "number" ? String(value) : "";
}
