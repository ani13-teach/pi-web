import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Type } from "@sinclair/typebox";
import { AssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Test the source directly; Desktop's dist bundle is owned by the build task.
const buildDir = await mkdtemp(new URL("../.tmp-mention-clone-test-", import.meta.url));
const entry = join(buildDir, "mention-clone.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../builtin/pi-subagents/src/mention-clone.ts", import.meta.url))], outfile: entry, bundle: true, platform: "node", format: "esm", target: "node24", external: ["@earendil-works/*"] });
const { runMentionClone } = await import(pathToFileURL(entry).href);
test.after(() => rm(buildDir, { recursive: true, force: true }));

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const toolParameters = Type.Object({ prompt: Type.String(), run_in_background: Type.Boolean() });
const text = (value) => typeof value === "string" ? value : value.filter((block) => block.type === "text").map((block) => block.text).join("\n");
const assistant = (model, content, stopReason = "stop") => ({ role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: 10 });

async function fixture(fn, { seed, callCount = 1, livePrompt = "LIVE_PARENT_PROMPT", holdParent = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-mention-clone-"));
  const agentDir = join(dir, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let parent;
  let parentRun;
  const parentRequested = Promise.withResolvers();
  const parentGate = Promise.withResolvers();
  try {
    await mkdir(agentDir, { recursive: true });
    // Would be appended by the clone's default loader without the override.
    await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "MUST_NOT_APPEND_TO_LIVE_PROMPT");
    const requests = [];
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider("mention-test", {
      api: "openai-completions", baseUrl: "https://invalid.example", apiKey: "local-fixture-only",
      models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
      streamSimple(model, context) {
        requests.push(structuredClone(context.messages));
        const stream = new AssistantMessageEventStream();
        queueMicrotask(async () => {
          const mentioned = context.messages.some((message) => message.role === "user" && text(message.content).includes("<system-reminder>"));
          if (!mentioned && holdParent) {
            parentRequested.resolve();
            await parentGate.promise;
          }
          const finished = context.messages.some((message) => message.role === "toolResult" && message.toolName === "Agent");
          const calls = Array.from({ length: callCount }, (_, index) => ({ type: "toolCall", id: `clone-call-${index}`, name: "Agent", arguments: { prompt: "Use the inherited context", run_in_background: false } }));
          const message = assistant(model, mentioned && !finished && callCount ? calls : [{ type: "text", text: "LOCAL_RESULT" }], mentioned && !finished && callCount ? "toolUse" : "stop");
          stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        });
        return stream;
      },
    });
    const model = runtime.getModel("mention-test", "mock");
    const manager = SessionManager.inMemory(dir);
    seed?.(manager, model);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => "BASE_PARENT_PROMPT", appendSystemPromptOverride: () => [],
      extensionFactories: [(pi) => pi.on("before_agent_start", () => ({ systemPrompt: livePrompt }))],
    });
    await loader.reload();
    ({ session: parent } = await createAgentSession({ cwd: dir, agentDir, resourceLoader: loader, modelRuntime: runtime, model, settingsManager, sessionManager: manager, tools: [] }));
    await parent.bindExtensions({ mode: "rpc" });
    if (holdParent) {
      parentRun = parent.prompt("PARENT_LAST_USER");
      await parentRequested.promise;
    }
    await fn({ parent, manager, requests, model, livePrompt });
  } finally {
    parentGate.resolve();
    await parentRun;
    parent?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function agentTool(execute) {
  return { name: "Agent", label: "Agent", description: "Start the mentioned agent", parameters: toolParameters, execute };
}

function snapshot(manager) {
  return structuredClone({ entries: manager.getEntries(), leaf: manager.getLeafId(), projection: manager.buildSessionContext(), id: manager.getSessionId() });
}

function cloneRequests(requests) {
  return requests.filter((messages) => messages.some((message) => message.role === "user" && text(message.content).includes("<system-reminder>")));
}

test("mention clone sends projected parent history and live prompt with one tool and parent spawn ownership", async () => fixture(async ({ parent, manager, requests, livePrompt }) => {
  // The actual SDK hook changes the prompt during the held parent request.
  assert.equal(parent.systemPrompt, livePrompt);
  const ctx = parent.extensionRunner.createContext();
  const before = snapshot(manager);
  const spawns = [];
  const result = await runMentionClone({ ctx, type: "work", message: "MENTION_USER_TASK", agentTool: agentTool(async (id, params, signal, onUpdate, toolCtx) => {
    assert.equal(toolCtx.sessionManager, ctx.sessionManager);
    assert.equal(toolCtx.cwd, ctx.cwd);
    assert.equal(toolCtx.model, ctx.model);
    assert.equal(toolCtx.ui, ctx.ui);
    assert.equal(toolCtx.getSystemPrompt(), livePrompt);
    assert.equal(toolCtx.isIdle, ctx.isIdle);
    assert.deepEqual(toolCtx.tools.map((tool) => tool.name), ["Agent"]);
    // The capability comes from a real SDK tool invocation. Unknown tools
    // return a validated failure instead of running a parent built-in.
    const nested = await toolCtx.executeTool("read", { path: "never-read" });
    assert.equal(nested.isError, true);
    // Count only calls whose context assertions passed: SDK tool failures are
    // returned to the model rather than rejecting runMentionClone().
    spawns.push({ id, params, sessionId: toolCtx.sessionManager.getSessionId() });
    return { content: [{ type: "text", text: "STARTED_IN_PARENT" }], details: undefined };
  }) });
  assert.deepEqual(result, { spawned: true });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].id, undefined);
  assert.equal(spawns[0].params.run_in_background, true);
  assert.equal(spawns[0].sessionId, parent.sessionId);
  assert.deepEqual(snapshot(manager), before, "clone leaves raw parent entries, leaf and projection unchanged");
  const [first] = cloneRequests(requests);
  assert.ok(first, "mock provider received the clone's first request");
  assert.equal(getCurrentSystemPrompt(first), livePrompt, "live prompt is preserved verbatim");
  assert.deepEqual(getCurrentTools(first).map((tool) => tool.name), ["Agent"]);
  const body = first.filter((message) => message.role !== "system");
  assert.equal(body.at(-1).role, "user");
  assert.match(text(body.at(-1).content), /^MENTION_USER_TASK\n\n<system-reminder>/);
  const contextText = JSON.stringify(body);
  for (const expected of ["COMPACTION_SUMMARY", "KEEP_EDITED", "TOOL_EDITED", "CUSTOM_PARENT_CONTEXT", "BRANCH_SUMMARY", "PARENT_LAST_USER"]) assert.ok(contextText.includes(expected), `${expected} reaches first request`);
  for (const discarded of ["PRECOMPACT_DISCARDED", "KEEP_ORIGINAL", "TOOL_ORIGINAL", "DROP_EDITED_OUT", "STATE_ONLY"]) assert.ok(!contextText.includes(discarded), `${discarded} stays out of model context`);
  const inheritedToolCall = body.find((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === "parent-read"));
  assert.ok(inheritedToolCall, "parent tool-call history remains intact");
  const inheritedResult = body.find((message) => message.role === "toolResult" && message.toolCallId === "parent-read");
  assert.equal(text(inheritedResult.content), "TOOL_EDITED");
}, { holdParent: true, seed(manager, model) {
  manager.appendMessage({ role: "system", content: "STALE_PARENT_PROMPT", toolsAdded: [{ name: "read", description: "Parent-only reader", parameters: {} }], timestamp: 1 });
  manager.appendMessage({ role: "user", content: "PRECOMPACT_DISCARDED", timestamp: 2 });
  const kept = manager.appendMessage({ role: "user", content: "KEEP_ORIGINAL", timestamp: 3 });
  manager.appendMessage(assistant(model, [{ type: "toolCall", id: "parent-read", name: "read", arguments: { path: "parent-only" } }], "toolUse"));
  const toolResult = manager.appendMessage({ role: "toolResult", toolCallId: "parent-read", toolName: "read", content: [{ type: "text", text: "TOOL_ORIGINAL" }], isError: false, timestamp: 4 });
  manager.appendCompaction("COMPACTION_SUMMARY", kept, 100);
  manager.appendContextEdit(kept, { content: "KEEP_EDITED" });
  manager.appendContextEdit(toolResult, { content: "TOOL_EDITED" });
  const omitted = manager.appendMessage({ role: "user", content: "DROP_EDITED_OUT", timestamp: 5 });
  manager.appendContextEdit(omitted, null);
  manager.appendCustomMessageEntry("fixture", "CUSTOM_PARENT_CONTEXT", false);
  manager.appendCustomEntry("fixture-state", { text: "STATE_ONLY" });
  manager.branchWithSummary(manager.getLeafId(), "BRANCH_SUMMARY");
} }));

test("multiple clone tool calls still spawn only one background agent", async () => fixture(async ({ parent, manager, requests }) => {
  const before = snapshot(manager);
  let spawns = 0;
  const result = await runMentionClone({ ctx: parent.extensionRunner.createContext(), type: "work", message: "duplicate tool calls", agentTool: agentTool(async (_id, params) => {
    assert.equal(params.run_in_background, true);
    spawns++;
    return { content: [{ type: "text", text: "STARTED_ONCE" }], details: undefined };
  }) });
  assert.deepEqual(result, { spawned: true });
  assert.equal(spawns, 1);
  assert.deepEqual(snapshot(manager), before);
  const turns = cloneRequests(requests);
  assert.ok(turns.length >= 2, "clone receives a follow-up request after the tool batch");
  assert.ok(turns.at(-1).some((message) => message.role === "toolResult" && text(message.content).includes("Already started an agent")));
}, { callCount: 2 }));

test("empty parent history can clone, and a prose-only response reports the direct-start fallback", async () => fixture(async ({ parent, manager, requests }) => {
  const before = snapshot(manager);
  let spawns = 0;
  const result = await runMentionClone({ ctx: parent.extensionRunner.createContext(), type: "work", message: "empty parent", agentTool: agentTool(async () => {
    spawns++;
    return { content: [], details: undefined };
  }) });
  assert.deepEqual(result, { spawned: false, error: "the conversation clone did not start it" });
  assert.equal(spawns, 0);
  assert.deepEqual(snapshot(manager), before);
  const [first] = cloneRequests(requests);
  assert.ok(first);
  assert.equal(first.filter((message) => message.role !== "system").length, 1);
  assert.equal(getCurrentSystemPrompt(first), parent.systemPrompt);
  assert.deepEqual(getCurrentTools(first).map((tool) => tool.name), ["Agent"]);
}, { callCount: 0 }));
