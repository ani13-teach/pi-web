export type ThinkingLevelMap = Record<string, string | null>;

/**
 * Pi Desktop's reasoning-level policy: off/minimal stay hidden, low through
 * max default to same-name custom values, and explicit low-through-max entries
 * may override or disable those defaults.
 */
export const DEFAULT_THINKING_LEVEL_MAP: Readonly<ThinkingLevelMap> = Object.freeze({
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
});

export function withDefaultThinkingLevelMap(
  value: ThinkingLevelMap | undefined,
): ThinkingLevelMap {
  return {
    ...DEFAULT_THINKING_LEVEL_MAP,
    ...(value ?? {}),
    off: null,
    minimal: null,
  };
}

export function resolveThinkingLevelMap(
  reasoning: boolean,
  value: ThinkingLevelMap | undefined,
): ThinkingLevelMap | undefined {
  return reasoning ? withDefaultThinkingLevelMap(value) : value;
}
