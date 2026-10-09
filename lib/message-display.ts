import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent, ToolResultMessage } from "./types";
import { isSubagentControlBlock, isSubagentInternalMessage } from "./subagent-display";

export interface DisplayOptions {
  isStreaming?: boolean;
  hideSubagentActivity?: boolean;
  toolResults?: ReadonlyMap<string, ToolResultMessage>;
}

export function isDisplayableAssistantBlock(block: AssistantContentBlock, options: DisplayOptions = {}): boolean {
  return !(block.type === "text" && block.text.trim() === "")
    && !isEmptyThinkingBlock(block, options)
    && !(options.hideSubagentActivity && isSubagentControlBlock(block, options.toolResults));
}

/** A display projection only; never remove internal results from model context. */
export function isDisplayableMessage(message: AgentMessage, options: DisplayOptions = {}): boolean {
  if (options.hideSubagentActivity && isSubagentInternalMessage(message)) return false;
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message, options).length > 0 || !!getAssistantErrorMessage(message, options);
  }
  return message.role !== "toolResult";
}

export function getThinkingPreview(thinking: string): string {
  return thinking.trimStart().match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

export function isMessageGroupAnchor(message: { role?: AgentMessage["role"]; customType?: string }): boolean {
  return message.role === "user"
    || (message.role === "custom" && message.customType === "compaction");
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => isDisplayableAssistantBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

// A live turn with an Agent call should show its process group immediately,
// rather than waiting for the parent agent's final answer. Use the last
// assistant entry: an earlier commentary message is not the final answer.
export function findLiveSubagentProcessEnd(messages: AgentMessage[], startIdx: number, endIdx: number, options: DisplayOptions = {}): number {
  let lastAssistantIdx = -1;
  let hasAgentCall = false;
  for (let i = startIdx + 1; i < endIdx; i++) {
    const message = messages[i];
    if (message.role !== "assistant" || !isDisplayableMessage(message, options)) continue;
    lastAssistantIdx = i;
    hasAgentCall ||= getDisplayableAssistantBlocks(message, options).some((block) => block.type === "toolCall" && block.toolName === "Agent");
  }
  return hasAgentCall ? lastAssistantIdx : -1;
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}
