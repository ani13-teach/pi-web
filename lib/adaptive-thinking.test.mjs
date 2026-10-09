import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readModelsConfig, writeModelsConfig } = await jiti.import("./models-config-store.ts");
const { setAdaptiveThinking } = await jiti.import("../components/models-config-helpers.ts");

async function captureRequest(t, model, reasoning, providerCompat) {
  const root = mkdtempSync(join(tmpdir(), "pi-adaptive-thinking-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelsPath = join(root, "models.json");
  const config = {
    providers: {
      "adaptive-fixture": {
        api: "anthropic-messages",
        baseUrl: "https://adaptive.example.test",
        apiKey: "fixture-key-not-real",
        ...(providerCompat ? { compat: providerCompat } : {}),
        models: [model],
      },
    },
  };
  writeModelsConfig(config, modelsPath);
  assert.deepEqual(readModelsConfig(modelsPath), config);
  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath: join(root, "auth.json"),
    modelsStorePath: join(root, "models-cache.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  assert.equal(runtime.getError(), undefined);
  const registered = runtime.getModel("adaptive-fixture", model.id);
  assert.ok(registered, "saved custom model must be registered");
  const requests = [];
  const response = await runtime.completeSimple(registered, {
    messages: [{ role: "user", content: "fixture", timestamp: 0 }],
  }, {
    reasoning,
    maxRetries: 0,
    env: {},
    fetch: async (url, options) => {
      assert.match(String(url), /^https:\/\/adaptive\.example\.test\//);
      requests.push(JSON.parse(options.body));
      const events = [
        { type: "message_start", message: { id: "msg_fixture", role: "assistant", model: model.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
        { type: "message_stop" },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  assert.equal(response.stopReason, "stop", response.errorMessage);
  assert.equal(requests.length, 1);
  return requests[0];
}

const model = { id: "claude-opus-5-5", maxTokens: 32768, contextWindow: 128000 };

for (const effort of ["low", "medium", "high"]) {
  test(`saved Adaptive flag sends adaptive thinking and ${effort} effort without a token budget`, async (t) => {
    const body = await captureRequest(t, setAdaptiveThinking(model, true), effort);
    assert.equal(body.thinking.type, "adaptive");
    assert.equal(body.thinking.budget_tokens, undefined);
    assert.deepEqual(body.output_config, { effort });
  });
}

test("adaptive thinking honors the model's explicit effort mapping", async (t) => {
  const body = await captureRequest(t, setAdaptiveThinking({ ...model, thinkingLevelMap: { max: "max" } }, true), "max");
  assert.equal(body.thinking.type, "adaptive");
  assert.deepEqual(body.output_config, { effort: "max" });
});

test("adaptive thinking inherits provider compat when no model override exists", async (t) => {
  const body = await captureRequest(t, { ...model, reasoning: true }, "high", { forceAdaptiveThinking: true });
  assert.equal(body.thinking.type, "adaptive");
  assert.deepEqual(body.output_config, { effort: "high" });
});

test("explicitly disabling Adaptive overrides provider true and restores budget-based thinking", async (t) => {
  const body = await captureRequest(t, setAdaptiveThinking({ ...model, reasoning: true }, false), "high", { forceAdaptiveThinking: true });
  assert.equal(body.thinking.type, "enabled");
  assert.ok(body.thinking.budget_tokens > 0);
  assert.equal(body.output_config, undefined);
});

test("the Adaptive capability does not force thinking when the chat level is off", async (t) => {
  const body = await captureRequest(t, setAdaptiveThinking(model, true), undefined);
  assert.notEqual(body.thinking?.type, "adaptive");
  assert.equal(body.output_config, undefined);
});
