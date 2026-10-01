export function getModelName(
  provider: string | undefined,
  responseModel: string,
  modelNames?: Record<string, string>,
): string {
  const normalizedProvider = provider?.toLowerCase();
  const normalizedResponse = responseModel.toLowerCase();
  const configured = Object.entries(modelNames ?? {}).flatMap(([key, name]) => {
    const separator = key.indexOf(":");
    return separator > 0 && key.slice(0, separator).toLowerCase() === normalizedProvider
      ? [{ id: key.slice(separator + 1).toLowerCase(), name }]
      : [];
  });
  return configured.find((model) => model.id === normalizedResponse)?.name
    ?? configured.find((model) => normalizedResponse.endsWith(`/${model.id}`))?.name
    ?? Object.entries(modelNames ?? {}).find(([key]) => key.toLowerCase() === normalizedResponse)?.[1]
    ?? responseModel;
}

/** Display only. Never write this label back to a model ID or configuration. */
export function formatModelLabel(name: string, provider?: string | null): string {
  return provider ? `${name} (${provider})` : name;
}

export function splitModelLabelSpec(spec: string): { name: string; provider?: string } {
  const separator = spec.indexOf("/");
  return separator > 0 && separator < spec.length - 1
    ? { provider: spec.slice(0, separator), name: spec.slice(separator + 1) }
    : { name: spec };
}

export function formatModelSpecLabel(spec: string, modelNames?: Record<string, string>): string {
  const { name, provider } = splitModelLabelSpec(spec);
  return formatModelLabel(getModelName(provider, name, modelNames), provider);
}
