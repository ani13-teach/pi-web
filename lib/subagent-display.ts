import type { AssistantContentBlock, ToolResultMessage } from "./types";

export const SUBAGENT_DISPLAY_META_TYPE = "pi-web:subagent-display";
export const SUBAGENT_DISPLAY_ORIGIN = "pi-subagents" as const;
export const SUBAGENT_DISPLAY_TOOLS = new Set(["Agent", "SubagentWorkflow", "get_subagent_result", "steer_subagent"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Live provenance comes from the SDK registry, never just a tool's name. */
export function nativeSubagentToolNames(tools: readonly { name: string; sourceInfo?: unknown }[]): string[] {
  return tools.filter((tool) => SUBAGENT_DISPLAY_TOOLS.has(tool.name)
    && isRecord(tool.sourceInfo) && tool.sourceInfo.path === "<inline:pi-subagents>")
    .map((tool) => tool.name);
}

/** UI-only transport projection. Do not modify SDK messages or persisted model context. */
export function markSubagentToolCallsForDisplay(message: unknown, names: readonly string[]): unknown {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content) || names.length === 0) return message;
  let changed = false;
  const content = message.content.map((block) => {
    if (!isRecord(block) || block.type !== "toolCall") return block;
    const name = typeof block.name === "string" ? block.name : block.toolName;
    if (typeof name !== "string" || !names.includes(name)) return block;
    changed = true;
    return { ...block, displayOrigin: SUBAGENT_DISPLAY_ORIGIN };
  });
  return changed ? { ...message, content } : message;
}

/** Persisted results also identify historical calls, including older Desktop versions. */
export function isSubagentControlBlock(
  block: AssistantContentBlock,
  results?: ReadonlyMap<string, ToolResultMessage>,
): boolean {
  if (block.type !== "toolCall" || !SUBAGENT_DISPLAY_TOOLS.has(block.toolName)) return false;
  if (block.displayOrigin === SUBAGENT_DISPLAY_ORIGIN) return true;
  const details = results?.get(block.toolCallId)?.details;
  return isRecord(details) && (details.kind === "pi-subagents" || details.kind === "pi-web-subagent");
}

export function isSubagentInternalMessage(message: { role?: string; customType?: string; details?: unknown }): boolean {
  if (message.role !== "custom" || message.customType !== "subagent-notification" || !isRecord(message.details)) return false;
  const details = message.details;
  if (details.displayOrigin === SUBAGENT_DISPLAY_ORIGIN) return true;
  // Older native notifications had this structured payload, but no origin tag.
  // Never hide an arbitrary extension message just because its type matches.
  return typeof details.id === "string" && typeof details.description === "string"
    && typeof details.status === "string" && typeof details.toolUses === "number"
    && typeof details.durationMs === "number" && typeof details.resultPreview === "string";
}
