/** Verify the shipped Code Mode runtime without repository dependencies or real providers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stageApp } from "./stage-app.mjs";

const binary = resolve(process.argv[2] ?? "release/win-unpacked/Pi Desktop.exe");
const staged = stageApp(binary, { isolate: true });
try {
  const appDir = dirname(staged.binary);
  const modules = join(appDir, "resources", "app.asar.unpacked", "node_modules");
  const runtimeScript = join(dirname(appDir), "codemode-fixture.mjs");
  assert.ok(existsSync(join(modules, "@earendil-works", "pi-coding-agent", "dist", "index.js")));
  writeFileSync(runtimeScript, String.raw`
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const modules = process.argv[2];
const fromPackage = (name) => import(pathToFileURL(join(modules, "@earendil-works", name, "dist", "index.js")).href);
const { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore } = await fromPackage("pi-ai");
const { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await fromPackage("pi-coding-agent");
const root = await mkdtemp(join(tmpdir(), "pi-packaged-codemode-fixture-"));
let session;
const checks = [];
const passed = (name) => { checks.push(name); console.log("PASS  " + name); };
try {
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  let pendingCode;
  let requestCount = 0;
  const requests = [];
  runtime.registerProvider("packaged-local", {
    api: "packaged-local-api", apiKey: "fixture-only", baseUrl: "https://packaged.invalid",
    models: [{ id: "mock", name: "Local fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const code = pendingCode;
      pendingCode = undefined;
      requests.push(structuredClone(context));
      requestCount += 1;
      const id = "script-" + requestCount;
      queueMicrotask(() => {
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: code === undefined ? [{ type: "text", text: "local done" }] : [{ type: "toolCall", id, name: "codemode", arguments: { code } }],
          stopReason: code === undefined ? "stop" : "toolUse", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  const toolCalls = [];
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"], compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createCodemodeExtension({ mode: "on" }), (pi) => {
      pi.on("tool_call", (event) => {
        toolCalls.push(event);
        if (event.toolName === "write") return { block: true, reason: "packaged fixture denied write" };
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, modelRuntime: runtime,
    model: runtime.getModel("packaged-local", "mock"), sessionManager: SessionManager.inMemory(root) }));
  await session.bindExtensions({});
  assert.ok(session.getActiveToolNames().includes("codemode"));
  passed("shipped SDK registers and activates Code Mode");
  for (const name of ["read", "bash", "edit", "write"]) assert.ok(session.getActiveToolNames().includes(name));
  passed("ordinary coding tools remain active in on mode");
  await writeFile(join(root, "a.md"), "# Alpha\nHIDDEN_BODY_A");
  await writeFile(join(root, "b.md"), "# Beta\nHIDDEN_BODY_B");
  const run = async (code) => {
    pendingCode = code;
    await session.prompt("Execute this local test script");
    const result = [...session.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "codemode");
    assert.ok(result, "a model-issued codemode call produced a result");
    return result;
  };
  const first = await run('const data = await Promise.all(["a.md", "b.md"].map(path => tools.read({ path }))); store("fixture", "stored"); return data.map(text => text.split(String.fromCharCode(10))[0]);');
  assert.equal(first.isError, false, JSON.stringify(first.content));
  const output = first.content.map((block) => block.text ?? "").join("\n");
  assert.match(output, /Script completed/);
  assert.match(output, /Alpha/);
  assert.match(output, /Beta/);
  passed("shipped worker and QuickJS WASM execute parallel reads");
  assert.equal(toolCalls.filter((event) => event.toolName === "read" && event.parentToolCallId).length, 2);
  passed("nested read calls traverse the SDK tool-call event pipeline");
  assert.ok(!output.includes("HIDDEN_BODY"));
  assert.ok(!JSON.stringify(requests).includes("HIDDEN_BODY"));
  passed("intermediate file bodies do not enter model context");
  const second = await run('return { savedValue: load("fixture"), node: typeof process };');
  assert.equal(second.isError, false, JSON.stringify(second.content));
  const secondOutput = second.content.map((block) => block.text ?? "").join("\n");
  assert.match(secondOutput, /"savedValue"\s*:\s*"stored"/);
  assert.match(secondOutput, /"node"\s*:\s*"undefined"/);
  passed("store survives calls and Node globals stay outside the sandbox");
  const denied = await run('return await tools.write({ path: "denied.txt", content: "should not be written" });');
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /packaged fixture denied write/);
  await assert.rejects(readFile(join(root, "denied.txt")), { code: "ENOENT" });
  passed("a nested tool denial prevents writing even inside a script");
  console.log(checks.length + "/" + checks.length + " packaged Code Mode checks passed (local mock provider, no user credentials)");
} finally {
  session?.dispose();
  await rm(root, { recursive: true, force: true });
}
`, "utf8");
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.NODE_PATH;
  const result = spawnSync(staged.binary, [runtimeScript, modules], {
    cwd: dirname(appDir), env, encoding: "utf8", timeout: 120_000,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "the isolated packaged runtime must exit successfully");
  assert.match(result.stdout, /7\/7 packaged Code Mode checks passed/);
} finally {
  staged.cleanup();
}
