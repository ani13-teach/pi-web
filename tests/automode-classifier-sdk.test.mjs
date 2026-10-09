import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { defaultClassifyAction, buildClassifierPrompt } = await jiti.import("../builtin/automode/extensions/auto-mode/classifier.ts");
const { buildEffectiveConfigFromSources } = await jiti.import("../builtin/automode/extensions/auto-mode/config.ts");

for (const [name, response, expected] of [["allow", "0", "allow"], ["malformed fails closed", "invalid", "block"]]) {
  test(`Pi 1.1 classifier context normalization: ${name}`, async () => {
    const requests = [];
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("classifier-local", {
      api: "classifier-local-api", apiKey: "fixture-only", baseUrl: "https://classifier.invalid",
      models: [{ id: "mock", name: "Mock", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }],
      streamSimple(model, context, options) {
        requests.push({ context: structuredClone(context), options });
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: [{ type: "text", text: response }], stopReason: "stop", timestamp: Date.now(),
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        });
        return stream;
      },
    });
    // Explicit reasoning exercises the normalized/simple provider boundary.
    const config = { ...buildEffectiveConfigFromSources(), classifierReasoningLevel: "low" };
    const manager = SessionManager.inMemory(process.cwd());
    manager.appendMessage({ role: "user", content: "Inspect README", timestamp: Date.now() });
    const ctx = { cwd: process.cwd(), model: runtime.getModel("classifier-local", "mock"), modelRegistry: new ModelRegistry(runtime), sessionManager: manager };
    const action = JSON.stringify({ toolName: "read", input: { path: "README.md" } });
    const result = await defaultClassifyAction(ctx, config, action, "LOCAL_PROJECT_INSTRUCTIONS");
    assert.equal(result.decision, expected);
    assert.equal(requests.length, 1);
    assert.equal(getCurrentSystemPrompt(requests[0].context.messages), buildClassifierPrompt(config));
    assert.ok(JSON.stringify(requests[0].context.messages).includes(action.replaceAll('"', '\\"')));
    assert.ok(JSON.stringify(requests[0].context.messages).includes("LOCAL_PROJECT_INSTRUCTIONS"));
    assert.equal(requests[0].options.reasoning, "low");
    if (expected === "block") assert.match(result.reason, /fails closed/);
  });
}
