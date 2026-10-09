import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { markSubagentToolCallsForDisplay } from "./subagent-display";

export interface AgentEventLike {
  type: string;
  [key: string]: unknown;
}

type JsonMessageUpdateEvent = Extract<
  JsonAgentSessionEvent,
  { type: "message_update" }
>;

type JsonAssistantMessageEvent = JsonMessageUpdateEvent["assistantMessageEvent"];
type JsonToolCallStartEvent = Extract<JsonAssistantMessageEvent, { type: "toolcall_start" }>;
type JsonToolCallDeltaEvent = Extract<JsonAssistantMessageEvent, { type: "toolcall_delta" }>;

export type ClientAssistantMessageEvent = (
  | Exclude<JsonAssistantMessageEvent, { type: "toolcall_start" | "toolcall_delta" }>
  | (JsonToolCallStartEvent & { id?: string; toolName?: string })
  | (JsonToolCallDeltaEvent & { id?: string; toolName?: string })
) & { displayOrigin?: "pi-subagents" };

export type ClientMessageUpdateEvent = Omit<JsonMessageUpdateEvent, "assistantMessageEvent"> & {
  assistantMessageEvent: ClientAssistantMessageEvent;
};

const OMITTED_EVENT_TYPES = new Set([
  "turn_start",
  "turn_end",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolCallMetadata(
  event: Record<string, unknown>,
): { id: string; toolName: string } | null {
  if (
    (event.type !== "toolcall_start" && event.type !== "toolcall_delta")
    || !isObject(event.partial)
  ) return null;
  const content = event.partial.content;
  const contentIndex = event.contentIndex;
  if (!Array.isArray(content) || typeof contentIndex !== "number") return null;

  const block = content[contentIndex];
  if (!isObject(block) || block.type !== "toolCall") return null;
  const id = typeof block.id === "string"
    ? block.id
    : (typeof block.toolCallId === "string" ? block.toolCallId : null);
  const toolName = typeof block.name === "string"
    ? block.name
    : (typeof block.toolName === "string" ? block.toolName : null);
  return id !== null && toolName !== null ? { id, toolName } : null;
}

/** Apply pi-web's event filters plus Pi 0.84's message_update projection. */
export function toClientAgentEvent(
  event: AgentEventLike,
): AgentEventLike | ClientMessageUpdateEvent | null {
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;
  const names = Array.isArray(event.nativeSubagentToolNames)
    ? event.nativeSubagentToolNames.filter((name): name is string => typeof name === "string")
    : [];

  if ((event.type === "message_start" || event.type === "message_end") && names.length > 0) {
    const { nativeSubagentToolNames: _names, ...rest } = event;
    void _names;
    return { ...rest, message: markSubagentToolCallsForDisplay(event.message, names) };
  }

  if (event.type === "message_update") {
    const assistantMessageEvent = event.assistantMessageEvent;
    if (
      typeof assistantMessageEvent !== "object"
      || assistantMessageEvent === null
      || Array.isArray(assistantMessageEvent)
    ) return null;

    const metadata = toolCallMetadata(assistantMessageEvent as Record<string, unknown>);
    const { partial: _partial, ...deltaEvent } = assistantMessageEvent as Record<string, unknown>;
    void _partial;
    const toolName = metadata?.toolName
      ?? (isObject(deltaEvent.toolCall) ? deltaEvent.toolCall.name : deltaEvent.toolName);
    return {
      type: "message_update",
      assistantMessageEvent: {
        ...deltaEvent,
        ...(metadata ?? {}),
        ...(typeof toolName === "string" && names.includes(toolName) ? { displayOrigin: "pi-subagents" } : {}),
      },
    } as ClientMessageUpdateEvent;
  }

  if (event.type === "tool_execution_update") {
    return {
      type: "tool_execution_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      partialResult: event.partialResult,
      ...(event.displayOrigin === "pi-subagents" ? { displayOrigin: event.displayOrigin } : {}),
    };
  }

  if (event.type === "agent_end") return { type: "agent_end" };
  return event;
}

export function isEventIncludedInSnapshot(
  event: AgentEventLike,
  snapshot: unknown,
): boolean {
  return snapshot !== undefined
    && (event.type === "message_start" || event.type === "message_update")
    && event.message === snapshot;
}
