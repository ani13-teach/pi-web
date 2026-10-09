import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import { runAgentLoop } from "@earendil-works/pi-agent-core";

const jiti = createJiti(import.meta.url);
const { normalizeToolCalls } = await jiti.import("../lib/normalize.ts");
const { userMessageKey } = await jiti.import("../lib/prompt-recovery.ts");
const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const start = source.indexOf('      case "message_start":');
const end = source.indexOf('      case "tool_execution_start":', start);
assert.ok(start >= 0 && end > start, "must execute the hook's real message event branches");
// Execute production event handling, not a reimplementation of its dedup logic.
const { outputText, diagnostics } = ts.transpileModule(`
  function handle(event: any) {
    switch (event.type) { ${source.slice(start, end)} }
  }
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
assert.deepEqual(diagnostics, []);
const makeHandler = new Function("env", `
  const { agentRunningRef, optimisticUserMessageKeyRef, setMessages, dispatch,
    setAgentPhase, pendingScrollToUserRef, isNearBottomRef, liveFollowFrameRef,
    requestAnimationFrame, scrollToBottom, normalizeToolCalls, userMessageKey } = env;
  ${outputText}
  return handle;
`);

function harness(optimistic, { running = true, earlier = [] } = {}) {
  let messages = optimistic ? [...earlier, optimistic] : [...earlier];
  const actions = [];
  const phases = [];
  const frames = [];
  const env = {
    agentRunningRef: { current: running },
    optimisticUserMessageKeyRef: { current: optimistic ? userMessageKey(optimistic) : null },
    setMessages(update) { messages = update(messages); },
    dispatch(action) { actions.push(action); },
    setAgentPhase(phase) { phases.push(phase); },
    pendingScrollToUserRef: { current: false },
    isNearBottomRef: { current: true },
    liveFollowFrameRef: { current: null },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    scrollToBottom() {}, normalizeToolCalls, userMessageKey,
  };
  const handle = makeHandler(env);
  return {
    handle, env, actions, phases, frames,
    messages: () => messages,
    deliver(message) {
      handle({ type: "message_start", message });
      handle({ type: "message_end", message });
    },
  };
}

const user = (text = "one submission") => ({ role: "user", content: text, timestamp: 1 });
const system = { role: "system", content: "updated prompt and tools", timestamp: 2 };
const assistant = { role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: 3 };

test("Pi 1.1 system-before-user events reconcile to exactly one user bubble", async () => {
  const optimistic = user();
  const delivered = { ...optimistic, content: [{ type: "text", text: optimistic.content }] };
  const ui = harness(optimistic);
  const events = [];
  const stop = new Error("stop before any provider call");
  await assert.rejects(runAgentLoop(
    [system, delivered], { messages: [], tools: [] }, {},
    (event) => {
      events.push(event);
      ui.handle(event);
      if (event.type === "message_end" && event.message.role === "user") throw stop;
    }, undefined,
    () => { assert.fail("this regression must never call a model"); },
  ), (error) => error === stop);
  assert.deepEqual(events.filter((event) => event.type.startsWith("message_")).map(
    (event) => `${event.type}:${event.message.role}`,
  ), ["message_start:system", "message_end:system", "message_start:user", "message_end:user"]);
  assert.deepEqual(ui.messages(), [optimistic]);
  assert.equal(ui.env.optimisticUserMessageKeyRef.current, null);
});

test("system updates do not touch chat, streaming state, phase, scroll or optimistic key", () => {
  const optimistic = user();
  const ui = harness(optimistic);
  ui.deliver(system);
  assert.deepEqual(ui.messages(), [optimistic]);
  assert.equal(ui.env.optimisticUserMessageKeyRef.current, userMessageKey(optimistic));
  assert.deepEqual(ui.actions, []);
  assert.deepEqual(ui.phases, []);
  assert.deepEqual(ui.frames, []);
});

test("ordinary prompts still reconcile without a system event", () => {
  const optimistic = user();
  const ui = harness(optimistic);
  ui.deliver({ ...optimistic, content: [{ type: "text", text: optimistic.content }] });
  assert.deepEqual(ui.messages(), [optimistic]);
});

test("a delivered rewrite replaces only the pending optimistic prompt", () => {
  const earlier = user("earlier history");
  const ui = harness(user(), { earlier: [earlier] });
  ui.deliver(system);
  const rewritten = user("extension-expanded input");
  ui.deliver(rewritten);
  assert.deepEqual(ui.messages(), [earlier, rewritten]);
});

test("image prompts reconcile across UI and SDK image formats after system updates", () => {
  const optimistic = { ...user(), content: [
    { type: "text", text: "describe this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture-image" } },
  ] };
  const delivered = { ...optimistic, content: [
    { type: "text", text: "describe this" },
    { type: "image", mimeType: "image/png", data: "fixture-image" },
  ] };
  const ui = harness(optimistic);
  ui.deliver(system);
  ui.deliver(delivered);
  assert.deepEqual(ui.messages(), [optimistic]);
});

test("same-text steering and follow-up deliveries are not globally deduplicated", () => {
  const optimistic = user();
  const ui = harness(optimistic, { earlier: [user()] });
  ui.deliver(system);
  ui.deliver(user());
  ui.deliver(assistant);
  // Includes an adjacent same-text delivery: only the original pending one is consumed.
  ui.deliver(system);
  ui.deliver(user());
  ui.deliver(user());
  assert.deepEqual(ui.messages().map((message) => message.role), ["user", "user", "assistant", "user", "user"]);
});

test("tool-loadout system updates preserve assistant and tool result rendering", () => {
  const ui = harness(null);
  const toolReply = { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "result" }] };
  ui.deliver(assistant);
  ui.deliver(system);
  ui.deliver(toolReply);
  assert.deepEqual(ui.messages(), [assistant, toolReply]);
  assert.equal(ui.actions.filter((action) => action.type === "end").length, 2);
});

test("late message events after reconciliation cannot append duplicate bubbles", () => {
  const optimistic = user();
  const ui = harness(optimistic, { running: false });
  ui.deliver(system);
  ui.deliver(user());
  ui.deliver(assistant);
  assert.deepEqual(ui.messages(), [optimistic]);
  assert.deepEqual(ui.actions, []);
});
