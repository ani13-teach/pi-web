import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { nativeSubagentToolNames, markSubagentToolCallsForDisplay } = await jiti.import("@/lib/subagent-display");
const { getDisplayableAssistantBlocks, isDisplayableMessage, splitFinalAssistantBlocks, findLiveSubagentProcessEnd } = await jiti.import("@/lib/message-display");
const { toClientAgentEvent } = await jiti.import("@/lib/agent-event-wire");
const { streamReducer, INITIAL_STREAMING_STATE } = await jiti.import("@/lib/streaming-message");
const { normalizeToolCalls } = await jiti.import("@/lib/normalize");
const assistant = (content) => ({ role: "assistant", content, provider: "test", model: "fixture" });
const call = (name = "Agent", origin = true) => ({ type: "toolCall", toolCallId: "child-call", toolName: name, input: {}, ...(origin ? { displayOrigin: "pi-subagents" } : {}) });
const notification = { role: "custom", customType: "subagent-notification", content: "CHILD_RESULT_MARK", display: true, details: { displayOrigin: "pi-subagents" } };
function render(message, props = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MessageView, { message, ...props })));
}
const quiet = { hideSubagentActivity: true };

test("native provenance requires the host extension source, not just a familiar name", () => {
  assert.deepEqual(nativeSubagentToolNames([
    { name: "Agent", sourceInfo: { path: "<inline:pi-subagents>" } },
    { name: "get_subagent_result", sourceInfo: { path: "<inline:other>" } },
    { name: "steer_subagent" },
    { name: "read", sourceInfo: { path: "<inline:pi-subagents>" } },
  ]), ["Agent"]);
});

test("main chat hides all native control cards even before execution or result arrival", () => {
  for (const name of ["Agent", "SubagentWorkflow", "get_subagent_result", "steer_subagent"]) {
    const message = assistant([call(name)]);
    assert.equal(render(message, quiet), "");
    assert.equal(render(message, { ...quiet, isStreaming: true }), "");
    assert.equal(isDisplayableMessage(message, quiet), false);
    assert.match(render(message), new RegExp(name));
  }
});

test("same-name third-party tools and unrelated custom messages remain visible", () => {
  assert.match(render(assistant([call("Agent", false)]), quiet), /Agent/);
  assert.match(render({ ...notification, customType: "other-notification" }, quiet), /CHILD_RESULT_MARK/);
  assert.match(render({ ...notification, details: { origin: "third-party" } }, quiet), /CHILD_RESULT_MARK/);
  assert.match(render(assistant([call("read", false)]), quiet), /read/);
});

test("empty text around hidden controls leaves no header, copy button or process entry", () => {
  for (const text of ["", " \n\t "]) {
    const message = assistant([{ type: "text", text }, call()]);
    assert.equal(render(message, quiet), "");
    assert.equal(render(message, { ...quiet, isStreaming: true }), "");
    assert.equal(isDisplayableMessage(message, quiet), false);
    assert.deepEqual(splitFinalAssistantBlocks(message, quiet), { answerBlocks: [], processBlocks: [] });
  }
});

test("internal notices are hidden only in main chat, without changing the original message", () => {
  const before = JSON.stringify(notification);
  assert.equal(render(notification, quiet), "");
  assert.equal(isDisplayableMessage(notification, quiet), false);
  assert.match(render(notification), /CHILD_RESULT_MARK/);
  assert.equal(JSON.stringify(notification), before);
});

test("persisted result provenance hides old native cards after reload, including failures", () => {
  for (const kind of ["pi-subagents", "pi-web-subagent"]) {
    const message = assistant([call("Agent", false)]);
    const result = { role: "toolResult", toolCallId: "child-call", toolName: "Agent", content: [{ type: "text", text: "CHILD_FAILED_MARK" }], isError: true, details: { kind } };
    const snapshot = JSON.parse(JSON.stringify([message, result]));
    const options = { ...quiet, toolResults: new Map([[snapshot[1].toolCallId, snapshot[1]]]) };
    assert.equal(render(snapshot[0], options), "");
    assert.equal(getDisplayableAssistantBlocks(snapshot[0], options).length, 0);
    assert.match(render(snapshot[0], { toolResults: options.toolResults }), /Agent/);
    assert.equal(snapshot[1].isError, true);
    assert.equal(snapshot[1].content[0].text, "CHILD_FAILED_MARK");
  }
});

test("mixed messages preserve text, reasoning and ordinary tools with original block indices", () => {
  const message = assistant([
    call(),
    { type: "thinking", thinking: "VISIBLE_REASONING" },
    { type: "toolCall", toolCallId: "read-1", toolName: "read", input: { path: "test.txt" } },
    { type: "text", text: "VISIBLE_ANSWER" },
  ]);
  const html = render(message, quiet);
  assert.match(html, /VISIBLE_REASONING/);
  assert.match(html, /VISIBLE_ANSWER/);
  assert.match(html, /read/);
  assert.doesNotMatch(html, /SubagentCard|>Agent</);
  assert.deepEqual(getDisplayableAssistantBlocks(message, quiet), message.content.slice(1));
  assert.deepEqual(splitFinalAssistantBlocks(message, quiet).answerBlocks, [message.content[3]]);
  assert.match(render(message, { ...quiet, searchBlock: message.content[3] }), /data-search-target="true"/);
});

test("provider failures still render when all control blocks have been hidden", () => {
  const message = { ...assistant([call()]), stopReason: "error", errorMessage: "PROVIDER_FAILURE_MARK" };
  assert.equal(isDisplayableMessage(message, quiet), true);
  assert.match(render(message, quiet), /PROVIDER_FAILURE_MARK/);
});

test("hidden controls do not create a live process group or affect its tool count", () => {
  const messages = [{ role: "user", content: "test" }, assistant([call()]), notification];
  assert.equal(findLiveSubagentProcessEnd(messages, 0, messages.length, quiet), -1);
  assert.equal(findLiveSubagentProcessEnd(messages, 0, messages.length), 1);
  assert.deepEqual(splitFinalAssistantBlocks(messages[1], quiet), { answerBlocks: [], processBlocks: [] });
});

test("transport projection leaves SDK messages intact and normalization retains UI provenance", () => {
  const raw = assistant([{ type: "toolCall", id: "child-call", name: "Agent", arguments: {} }]);
  const before = JSON.stringify(raw);
  const marked = markSubagentToolCallsForDisplay(raw, ["Agent"]);
  assert.notEqual(marked, raw);
  const completed = toClientAgentEvent({ type: "message_end", message: raw, nativeSubagentToolNames: ["Agent"] });
  assert.equal(normalizeToolCalls(completed.message).content[0].displayOrigin, "pi-subagents");
  assert.equal(JSON.stringify(raw), before);
  assert.equal(Object.hasOwn(completed, "nativeSubagentToolNames"), false);
  assert.equal(markSubagentToolCallsForDisplay(raw, []), raw);
});

test("stream start, deltas, end and reconnect snapshots all stay quiet without a card flash", () => {
  const partial = assistant([{ type: "toolCall", id: "child-call", name: "Agent", arguments: {} }]);
  let state = streamReducer(INITIAL_STREAMING_STATE, { type: "snapshot", message: assistant([]) });
  for (const event of [
    { type: "toolcall_start", contentIndex: 0, partial },
    { type: "toolcall_delta", contentIndex: 0, delta: '{"prompt":', partial },
    { type: "toolcall_end", contentIndex: 0, toolCall: partial.content[0], partial },
  ]) {
    const wire = toClientAgentEvent({ type: "message_update", assistantMessageEvent: event, nativeSubagentToolNames: ["Agent"] });
    state = streamReducer(state, { type: "delta", event: wire.assistantMessageEvent });
    assert.equal(render(state.streamingMessage, { ...quiet, isStreaming: true }), "");
  }
  const snapshot = toClientAgentEvent({ type: "message_start", message: partial, nativeSubagentToolNames: ["Agent"] });
  state = streamReducer(state, { type: "snapshot", message: snapshot.message });
  assert.equal(render(state.streamingMessage, { ...quiet, isStreaming: true }), "");
});

test("memo responds to mode changes and newly arrived historical tool provenance", () => {
  const message = assistant([call("Agent", false)]);
  const props = { message, ...quiet };
  assert.equal(MessageView.compare(props, { ...props, hideSubagentActivity: false }), false);
  assert.equal(MessageView.compare(props, { ...props, toolResults: new Map([["child-call", { details: { kind: "pi-subagents" } }]]) }), false);
});

test("chat routes every rendering path through the same quiet display projection", async () => {
  const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(source, /hideSubagentActivity = session\?\.relation\?\.kind !== "subagent"/);
  assert.match(source, /if \(!isDisplayableMessage\(msg, displayOptions\)\) return null/);
  assert.match(source, /if \(!isDisplayableMessage\(processMessage, displayOptions\)\) continue/);
  assert.match(source, /getDisplayableAssistantBlocks\(message, displayOptions\)/);
  assert.match(source, /if \(blocks\.length === 0 && \(processIdx === finalAssistantIdx \|\| !getAssistantErrorMessage\(message\)\)\) continue/);
  assert.match(source, /visibleRendered = rendered\.filter/);
  assert.equal((source.match(/hideSubagentActivity=\{hideSubagentActivity\}/g) ?? []).length, 3);
});
