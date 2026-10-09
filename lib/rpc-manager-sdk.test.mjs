import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { Type } from "typebox";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t, { respond, extension = () => {}, exactSystemPrompt, tools = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-rpc-sdk-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  t.after(async () => rm(root, { recursive: true, force: true }));
  // Every store and resource path is isolated: no user credentials or network.
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const requests = [];
  modelRuntime.registerProvider("rpc-local-mock", {
    api: "rpc-local-mock-api",
    baseUrl: "https://rpc-local-mock.invalid",
    apiKey: "fixture-only-key",
    models: [{
      id: "mock", name: "Mock", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
    }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const request = structuredClone(context);
      requests.push(request);
      queueMicrotask(async () => {
        try {
          const reply = await respond?.(request, requests.length) ?? {};
          const content = reply.content ?? [{ type: "text", text: "local response" }];
          const stopReason = reply.stopReason ?? "stop";
          const message = {
            role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content, stopReason, timestamp: Date.now(),
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
          for (const [contentIndex, block] of content.entries()) {
            const partial = { ...message, stopReason: "pending" };
            if (block.type === "toolCall") {
              stream.push({ type: "toolcall_start", contentIndex, partial });
              stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
            } else {
              stream.push({ type: "text_start", contentIndex, partial });
              stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
              stream.push({ type: "text_end", contentIndex, content: block.text, partial });
            }
          }
          stream.push({ type: "done", reason: stopReason, message });
          stream.end();
        } catch (error) {
          // Unexpected mock failures must fail the test, not leave an open stream.
          stream.push({ type: "error", reason: "error", error: {
            role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: [], stopReason: "error", errorMessage: String(error), timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          } });
          stream.end();
        }
      });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "SDK baseline prompt",
    extensionFactories: [extension],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: root, agentDir, modelRuntime,
    model: modelRuntime.getModel("rpc-local-mock", "mock"),
    resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.inMemory(root), tools,
  });
  const completed = [];
  const events = [];
  const wrapper = new AgentSessionWrapper(session, {
    exactSystemPrompt,
    onAgentRunComplete: (sessionId) => completed.push(sessionId),
  });
  t.after(async () => {
    await session.abort();
    await wrapper.shutdown();
  });
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  async function prompt(message, extra = {}) {
    await wrapper.send({ type: "prompt", message, ...extra });
    await session.waitForIdle();
    await nextTurn();
    assert.equal(session.getLastAssistantText(), "local response");
    assert.equal(wrapper.isRunning(), false);
  }
  return { session, wrapper, requests, completed, events, prompt };
}

for (const mode of ["invalid", "denied"]) {
  test(`real SDK keeps ${mode} native calls quiet after reload without altering model context`, { timeout: 15000 }, async t => {
    let executed = false;
    const { session, prompt, requests } = await fixture(t, {
      tools: ["Agent"],
      extension: { name: "pi-subagents", factory(pi) {
        pi.registerTool({ name: "Agent", label: "Local provenance fixture", description: "test only", parameters: Type.Object({ prompt: Type.String() }),
          async execute() { executed = true; return { content: [{ type: "text", text: "unexpected" }] }; } });
        if (mode === "denied") pi.on("tool_call", () => ({ block: true, reason: "LOCAL_PERMISSION_DENIAL" }));
      } },
      respond(_request, index) {
        if (index === 1) return { stopReason: "toolUse", content: [{ type: "toolCall", id: "held-native", name: "Agent", arguments: mode === "invalid" ? {} : { prompt: "test" } }] };
        return {};
      },
    });
    await prompt("Test pre-execution failure");
    assert.equal(executed, false);
    const result = session.messages.find(message => message.role === "toolResult");
    assert.equal(result.isError, true);
    const persisted = JSON.parse(JSON.stringify(session.sessionManager.getEntries()));
    assert.ok(persisted.some(entry => entry.customType === "pi-web:subagent-display"));
    const jiti = createJiti(import.meta.url);
    const { buildSessionContext } = await jiti.import("./session-reader.ts");
    const { isDisplayableMessage } = await jiti.import("./message-display.ts");
    const restored = buildSessionContext(persisted).messages;
    const call = restored.find(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall"));
    assert.equal(call.content[0].displayOrigin, "pi-subagents");
    assert.equal(isDisplayableMessage(call, { hideSubagentActivity: true }), false);
    assert.ok(restored.find(message => message.role === "toolResult").isError);
    assert.ok(requests[1].messages.some(message => message.role === "toolResult" && message.isError));
    assert.equal(JSON.stringify(requests).includes("displayOrigin"), false);
    assert.equal(JSON.stringify(requests).includes("pi-web:subagent-display"), false);
    assert.equal(session.messages.find(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall")).content[0].displayOrigin, undefined);
  });
}

test("real SDK sends one user message after its system update for one prompt", { timeout: 15000 }, async (t) => {
  const { events, requests, prompt } = await fixture(t);
  await prompt("single submission");
  const delivered = events.filter((event) => event.type === "message_end");
  assert.equal(delivered[0].message.role, "system");
  assert.equal(delivered[1].message.role, "user");
  assert.equal(delivered.filter((event) => event.message.role === "user").length, 1);
  assert.equal(requests.length, 1);
});

test("real SDK preserves the exact prompt on first request, tool continuation and reload", { timeout: 15000 }, async (t) => {
  let exact = "exact first prompt";
  let stepExecuted = false;
  let beforeStartCount = 0;
  let contextCount = 0;
  let fullContextCount = 0;
  const { wrapper, session, requests, prompt, completed } = await fixture(t, {
    tools: ["fixture_step", "fixture_next"],
    exactSystemPrompt: () => exact,
    extension(pi) {
      pi.on("before_agent_start", () => {
        beforeStartCount += 1;
        return { systemPrompt: "extension forced prompt" };
      });
      pi.on("context", (event) => {
        contextCount += 1;
        return { messages: event.messages.map((message) => message.role === "user"
          ? { ...message, content: [{ type: "text", text: "transformed user input" }] }
          : message) };
      });
      pi.on("context_with_system", (event) => {
        fullContextCount += 1;
        return { messages: event.messages.map((message) => message.role === "system"
          ? { ...message, content: "context hook prompt" }
          : message) };
      });
      for (const name of ["fixture_step", "fixture_next"]) pi.registerTool({
        name, label: name, description: name, parameters: Type.Object({}),
        async execute() {
          stepExecuted = true;
          exact = "exact continuation prompt";
          pi.setActiveTools(["fixture_next"]);
          return { content: [{ type: "text", text: "tool response" }], details: undefined };
        },
      });
    },
    respond(_request, index) {
      return index === 1 ? {
        content: [{ type: "toolCall", id: "step-1", name: "fixture_step", arguments: {} }],
        stopReason: "toolUse",
      } : undefined;
    },
  });
  assert.equal((await wrapper.send({ type: "get_state" })).systemPrompt, exact);
  await prompt("first user input");
  assert.equal(stepExecuted, true);
  assert.equal(requests.length, 2);
  assert.equal(beforeStartCount, 1);
  assert.equal(contextCount, 2);
  assert.equal(fullContextCount, 2);
  assert.equal(getCurrentSystemPrompt(requests[0].messages), "exact first prompt");
  assert.equal(getCurrentSystemPrompt(requests[1].messages), "exact continuation prompt");
  assert.deepEqual(getCurrentTools(requests[0].messages).map((tool) => tool.name).sort(), ["fixture_next", "fixture_step"]);
  assert.deepEqual(getCurrentTools(requests[1].messages).map((tool) => tool.name), ["fixture_next"]);
  assert.equal(requests[0].messages.find((message) => message.role === "user").content[0].text, "transformed user input");
  assert.equal(requests[1].messages.some((message) => message.role === "toolResult" && message.content[0].text === "tool response"), true);
  for (const request of requests) {
    assert.equal(request.messages[0].role, "system");
    assert.equal(request.messages.filter((message) => message.role === "system").length, 1);
  }
  assert.equal(session.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "system" && entry.message.content === "exact first prompt"), false);
  assert.equal(completed.length, 1);

  await wrapper.send({ type: "reload" });
  exact = "exact reloaded prompt";
  assert.equal((await wrapper.send({ type: "get_state" })).systemPrompt, exact);
  await prompt("second user input");
  assert.equal(requests.length, 3);
  assert.equal(getCurrentSystemPrompt(requests[2].messages), exact);
  assert.equal(completed.length, 2);
});

test("real SDK handled commands and inputs acknowledge without requests, fake running or completion", { timeout: 15000 }, async (t) => {
  let commands = 0;
  const { wrapper, session, requests, events, completed, prompt } = await fixture(t, {
    extension(pi) {
      pi.registerCommand("local", { handler: async () => { commands += 1; } });
      pi.on("input", (event) => event.text === "consume" ? { action: "handled" } : undefined);
    },
  });
  for (const message of ["/local", "consume"]) {
    await wrapper.send({ type: "prompt", message });
    assert.equal(wrapper.isRunning(), false);
    assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, false);
  }
  for (const type of ["steer", "follow_up"]) {
    await wrapper.send({ type, message: "consume" });
    assert.equal(wrapper.isRunning(), false);
    assert.equal(session.pendingMessageCount, 0);
  }
  assert.equal(commands, 1);
  assert.equal(requests.length, 0);
  assert.equal(events.filter((event) => event.type === "agent_start").length, 0);
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 2);
  assert.deepEqual(completed, []);
  await prompt("ordinary prompt");
  assert.equal(requests.length, 1);
  assert.equal(completed.length, 1);
});

test("real SDK queued follow-up and handled streaming input preserve the active run", { timeout: 15000 }, async (t) => {
  let releaseResponse;
  let reportRequest;
  const responseHeld = new Promise((resolve) => { releaseResponse = resolve; });
  const requestStarted = new Promise((resolve) => { reportRequest = resolve; });
  t.after(() => releaseResponse());
  const { wrapper, session, requests, completed } = await fixture(t, {
    exactSystemPrompt: () => "exact queued prompt",
    extension(pi) {
      pi.on("input", (event) => event.text === "consume" ? { action: "handled" } : undefined);
    },
    async respond(_request, index) {
      if (index === 1) {
        reportRequest();
        await responseHeld;
      }
    },
  });
  await wrapper.send({ type: "prompt", message: "first" });
  await requestStarted;
  await wrapper.send({ type: "prompt", message: "consume", streamingBehavior: "followUp" });
  assert.equal(session.pendingMessageCount, 0);
  assert.equal(wrapper.isRunning(), true);
  await wrapper.send({ type: "prompt", message: "queued", streamingBehavior: "followUp" });
  assert.deepEqual(session.getFollowUpMessages(), ["queued"]);
  assert.equal(wrapper.isRunning(), true);
  releaseResponse();
  await session.waitForIdle();
  await nextTurn();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.some((message) => message.role === "user" && message.content[0].text === "queued"), true);
  for (const request of requests) assert.equal(getCurrentSystemPrompt(request.messages), "exact queued prompt");
  assert.equal(wrapper.isRunning(), false);
  assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, false);
  assert.equal(completed.length, 1);
});
