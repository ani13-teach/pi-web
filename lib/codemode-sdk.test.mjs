import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { Type } from "typebox";
import { createAssistantMessageEventStream, getCurrentTools, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, createEventBus, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { createDesktopCodemodeExtension } = await jiti.import("./codemode.ts");
const { FilteredResourceLoader } = await jiti.import("./filtered-resource-loader.ts");
const { filteredSubagentLoaderOptions } = await jiti.import("./extension-loader-options.ts");
const { writeCodemodeEnabled } = await jiti.import("./codemode-settings.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { createPiAutomode } = await jiti.import("../builtin/automode/extensions/auto-mode/extension.ts");
const { buildEffectiveConfigFromSources } = await jiti.import("../builtin/automode/extensions/auto-mode/config.ts");

async function fixture(t, { enabled = true, extension = () => {}, guard, noExtensions = false, chatOnly = false, defaultTools, extensions, selection = ["read", "bash", "edit", "write"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-codemode-sdk-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const path = join(agentDir, "settings.json");
  await writeFile(path, JSON.stringify({ defaultTools: defaultTools ?? (enabled ? ["+codemode"] : ["-codemode"]), extensions, compaction: { enabled: false }, retry: { enabled: false } }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  const requests = [];
  let pendingCode;
  runtime.registerProvider("codemode-local", {
    api: "codemode-local-api", baseUrl: "https://codemode.invalid", apiKey: "fixture-only",
    models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      requests.push(structuredClone(context));
      const code = pendingCode;
      pendingCode = undefined;
      queueMicrotask(() => {
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: code === undefined ? [{ type: "text", text: "local response" }] : [{ type: "toolCall", id: `code-${requests.length}`, name: "codemode", arguments: { code } }],
          stopReason: code === undefined ? "stop" : "toolUse", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        for (const [contentIndex, block] of message.content.entries()) {
          if (block.type === "toolCall") {
            stream.push({ type: "toolcall_start", contentIndex, partial: message });
            stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
          }
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  const settingsManager = SettingsManager.create(root, agentDir);
  const loaderOptions = {
    cwd: root, agentDir, settingsManager, eventBus: createEventBus(), noExtensions,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: chatOnly ? [] : [createDesktopCodemodeExtension(), extension, ...(guard ? [guard] : [])],
  };
  const filteredOptions = await filteredSubagentLoaderOptions(loaderOptions, settingsManager);
  const services = await createAgentSessionServices({ cwd: root, agentDir, settingsManager, modelRuntime: runtime,
    resourceLoaderOptions: filteredOptions });
  const loader = new FilteredResourceLoader(loaderOptions, {
    loader: services.resourceLoader, extensionPaths: filteredOptions.additionalExtensionPaths,
  });
  services.resourceLoader = loader;
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSessionFromServices({ services,
    model: runtime.getModel("codemode-local", "mock"), sessionManager: SessionManager.inMemory(root), ...(chatOnly ? { tools: [] } : {}) });
  const events = [];
  const wrapper = new AgentSessionWrapper(session, { chatOnly });
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  wrapper.setActiveToolSelection(chatOnly ? [] : selection);
  t.after(async () => { await session.abort(); await wrapper.shutdown(); });
  async function run(code) {
    pendingCode = code;
    await wrapper.send({ type: "prompt", message: "Run the local fixture script" });
    await session.waitForIdle();
    const result = [...session.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "codemode");
    assert.ok(result, "the model issued a real codemode call and it produced a tool result");
    return result;
  }
  return { root, path, session, wrapper, loader, requests, events, run };
}

test("real SDK registers codemode once, keeps it opt-in and switches it both ways on reload", { timeout: 20000 }, async (t) => {
  const { path, session, wrapper } = await fixture(t, { enabled: false });
  assert.equal(session.getAllTools().filter((tool) => tool.name === "codemode").length, 1);
  assert.equal(session.getActiveToolNames().includes("codemode"), false);
  await writeCodemodeEnabled(true, path);
  await wrapper.send({ type: "reload" });
  assert.ok(session.getActiveToolNames().includes("codemode"));
  for (const tool of ["read", "bash", "edit", "write"]) assert.ok(session.getActiveToolNames().includes(tool));
  wrapper.setActiveToolSelection(["read", "grep", "find", "ls"]);
  assert.ok(session.getActiveToolNames().includes("codemode"), "read-only preset keeps the preference");
  assert.equal(session.getActiveToolNames().includes("write"), false);
  await writeCodemodeEnabled(false, path);
  await wrapper.send({ type: "reload" });
  assert.equal(session.getActiveToolNames().includes("codemode"), false);
  assert.ok(session.getActiveToolNames().includes("grep"));
  assert.equal(session.getAllTools().filter((tool) => tool.name === "codemode").length, 1);
});

test("a genuinely chat-only session stays empty across preference changes and reload", { timeout: 20000 }, async (t) => {
  const { path, session, wrapper } = await fixture(t, { chatOnly: true, enabled: false });
  await writeCodemodeEnabled(true, path);
  await wrapper.send({ type: "reload" });
  assert.deepEqual(session.getActiveToolNames(), []);
  assert.equal(session.getAllTools().some((tool) => tool.name === "codemode"), false);
});

test("a codemode-only normal session can be disabled and re-enabled from an empty loadout", { timeout: 20000 }, async (t) => {
  const { path, session, wrapper } = await fixture(t, { defaultTools: ["codemode"], selection: ["codemode"] });
  assert.deepEqual(session.getActiveToolNames(), ["codemode"]);
  await writeCodemodeEnabled(false, path);
  await wrapper.send({ type: "reload" });
  assert.deepEqual(session.getActiveToolNames(), []);
  await writeCodemodeEnabled(true, path);
  await wrapper.send({ type: "reload" });
  assert.deepEqual(session.getActiveToolNames(), ["codemode"]);
});

test("official sandbox batches real reads and exposes only the selected result to the model", { timeout: 20000 }, async (t) => {
  const { root, run, requests, session, events } = await fixture(t);
  await writeFile(join(root, "a.md"), "# Alpha\nSECRET_BODY_A");
  await writeFile(join(root, "b.md"), "# Beta\nSECRET_BODY_B");
  const result = await run('const files = ["a.md", "b.md"]; const data = await Promise.all(files.map(path => tools.read({ path }))); return data.map(value => value.split("\\n")[0]);');
  assert.equal(result.isError, false);
  const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.match(text, /Script completed/);
  assert.match(text, /Alpha/);
  assert.match(text, /Beta/);
  assert.doesNotMatch(text, /SECRET_BODY/);
  assert.ok(!JSON.stringify(requests).includes("SECRET_BODY"), "intermediate file text is not injected into model context");
  const names = getCurrentTools(requests[0].messages).map((tool) => tool.name);
  for (const name of ["codemode", "read", "bash", "edit", "write"]) assert.ok(names.includes(name), `${name} is still declared in on mode`);
  assert.equal(events.filter((event) => event.type === "tool_execution_start" && event.toolName === "read" && event.parentToolCallId).length, 2);
  assert.equal(session.messages.filter((message) => message.role === "toolResult" && message.toolName === "read").length, 0);
});

test("codemode nested calls still pass the real automode guard; denied tools never execute", { timeout: 20000 }, async (t) => {
  const calls = [];
  const classified = [];
  const guarded = [];
  const config = buildEffectiveConfigFromSources({ inlineSettings: [{ autoMode: { log: { enabled: false } }, permissions: { deny: ["Bash(*)", "Edit(*)", "Write(*)"] } }] });
  const guard = createPiAutomode({
    loadConfig: () => config,
    saveClassifierModel: () => { throw new Error("no classifier settings should be persisted"); },
    classifyAction: async (_ctx, _config, action) => { classified.push(JSON.parse(action).toolName); return { decision: "allow", reason: "local mock", durationMs: 0 }; },
  });
  const { run, events } = await fixture(t, {
    guard,
    extension(pi) {
      pi.on("tool_call", (event) => { guarded.push(event); });
      for (const name of ["bash", "edit", "write"]) pi.registerTool({
        name, label: name, description: "Non-executing safety fixture", parameters: Type.Object({ command: Type.Optional(Type.String()), path: Type.Optional(Type.String()), content: Type.Optional(Type.String()), edits: Type.Optional(Type.Array(Type.Any())) }),
        async execute() { calls.push(name); return { content: [{ type: "text", text: "should not execute" }], details: undefined }; },
      });
    },
  });
  const result = await run('return await Promise.allSettled([tools.bash({ command: "echo fixture" }), tools.edit({ path: "fixture.txt", edits: [] }), tools.write({ path: "fixture.txt", content: "fixture" })]);');
  assert.equal(result.isError, false, "allSettled handles rejection without disguising nested failures");
  assert.match(JSON.stringify(result.content), /rejected/);
  assert.deepEqual(calls, []);
  assert.ok(classified.includes("codemode"), "the outer script still goes through classification");
  assert.deepEqual(classified.filter((name) => name !== "codemode"), [], "deterministic deny blocks nested calls before classification");
  for (const name of ["bash", "edit", "write"]) {
    assert.ok(guarded.some((event) => event.toolName === name && event.parentToolCallId));
    assert.ok(events.some((event) => event.type === "tool_execution_end" && event.toolName === name && event.parentToolCallId && event.isError));
  }
});

test("read-only preset does not make edit or write callable through codemode", { timeout: 20000 }, async (t) => {
  const { run, session, events } = await fixture(t, { selection: ["read", "grep", "find", "ls"] });
  for (const name of ["edit", "write", "bash"]) {
    const result = await run(`return await tools.${name}({});`);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), new RegExp(`tools\\.${name} does not exist`));
    assert.equal(session.getActiveToolNames().includes(name), false);
    assert.equal(events.some((event) => event.type === "tool_execution_start" && event.toolName === name), false);
  }
});

test("automode can reject the outer codemode script before any nested tool executes", { timeout: 20000 }, async (t) => {
  let executed = 0;
  const config = buildEffectiveConfigFromSources({ inlineSettings: [{ autoMode: { log: { enabled: false } } }] });
  const guard = createPiAutomode({ loadConfig: () => config,
    classifyAction: async () => ({ decision: "block", reason: "fixture classifier denial", durationMs: 0 }),
  });
  const { run, events } = await fixture(t, { guard, extension(pi) {
    pi.registerTool({ name: "fixture_step", label: "fixture", description: "local fixture", parameters: Type.Object({}),
      async execute() { executed += 1; return { content: [{ type: "text", text: "unexpected" }], details: undefined }; },
    });
  } });
  const result = await run('return await tools.fixture_step({});');
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /fixture classifier denial/);
  assert.equal(executed, 0);
  assert.equal(events.some((event) => event.parentToolCallId), false);
});

test("disabling built-in extensions prevents codemode registration", { timeout: 20000 }, async (t) => {
  const { session } = await fixture(t, { noExtensions: true });
  assert.equal(session.getAllTools().some((tool) => tool.name === "codemode"), false);
  assert.equal(session.getActiveToolNames().includes("codemode"), false);
});

test("builtin codemode exclusions are recomputed on every real session reload", { timeout: 20000 }, async (t) => {
  const { path, session, wrapper } = await fixture(t);
  const updateExtensions = async (extensions) => {
    const settings = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...settings, extensions }));
    await wrapper.send({ type: "reload" });
  };
  assert.equal(session.getAllTools().filter((tool) => tool.name === "codemode").length, 1);
  await updateExtensions(["-builtin:codemode"]);
  assert.equal(session.getAllTools().some((tool) => tool.name === "codemode"), false);
  assert.equal(session.getActiveToolNames().includes("codemode"), false);
  await updateExtensions([]);
  assert.equal(session.getAllTools().filter((tool) => tool.name === "codemode").length, 1);
  assert.equal(session.getActiveToolNames().includes("codemode"), true);
});

test("global builtin exclusion prevents desktop-filtered codemode registration at startup", { timeout: 20000 }, async (t) => {
  const { session } = await fixture(t, { extensions: ["-builtin:codemode"] });
  assert.equal(session.getAllTools().some((tool) => tool.name === "codemode"), false);
});

test("desktop reload updates disk extension code and resets module state even when the list changes", { timeout: 20000 }, async (t) => {
  const { root, wrapper, loader } = await fixture(t);
  const directory = join(root, "agent", "extensions");
  await mkdir(directory);
  const sourcePath = join(directory, "version.js");
  const source = (version) => `let loads = 0; export default function(pi) { loads++; pi.registerCommand("disk-version", { description: "${version}:" + loads, handler: async () => {} }); }`;
  const description = () => loader.getExtensions().extensions.flatMap((extension) => [...extension.commands.values()])
    .find((command) => command.name === "disk-version")?.description;
  await writeFile(sourcePath, source("v1"));
  await wrapper.send({ type: "reload" });
  assert.equal(description(), "v1:1");
  await wrapper.send({ type: "reload" });
  assert.equal(description(), "v1:1", "same-path module state is reset");
  await writeFile(sourcePath, source("v2"));
  await writeFile(join(directory, "second.js"), 'export default function(pi) { pi.registerCommand("second", { handler: async () => {} }); }');
  await wrapper.send({ type: "reload" });
  assert.equal(description(), "v2:1", "source and discovery changes take effect together");
  assert.deepEqual(loader.getExtensions().errors, []);
});

test("user disk codemode replacement can be added and removed on desktop reload", { timeout: 20000 }, async (t) => {
  const { root, wrapper, loader, session } = await fixture(t);
  const directory = join(root, "agent", "extensions");
  await mkdir(directory);
  const sourcePath = join(directory, "user-codemode.js");
  await writeFile(sourcePath, 'import { createCodemodeExtension } from "@earendil-works/pi-coding-agent"; export default createCodemodeExtension({ mode: "on" });');
  await wrapper.send({ type: "reload" });
  assert.equal(session.getAllTools().filter((tool) => tool.name === "codemode").length, 1);
  assert.equal(loader.getExtensions().extensions.some((extension) => extension.path === "builtin:codemode"), false);
  await rm(sourcePath);
  await wrapper.send({ type: "reload" });
  assert.equal(session.getAllTools().filter((tool) => tool.name === "codemode").length, 1);
  assert.equal(loader.getExtensions().extensions.some((extension) => extension.path === "builtin:codemode"), true);
});

test("desktop startup and settings UI are wired to the official factory and localized toggle", async () => {
  const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(rpc, /extensionFactories: \[\s*createDesktopCodemodeExtension\(\)/);
  const panel = await readFile(new URL("../components/SettingsPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /<CodemodeSettings sessionId=\{sessionId\} onSessionReloaded=\{onSessionReloaded\} \/>/);
  const ui = await readFile(new URL("../components/CodemodeSettings.tsx", import.meta.url), "utf8");
  assert.match(ui, /sendAgentCommand\(sessionId, \{ type: "reload" \}\)/);
  assert.match(ui, /fetch\("\/api\/tools\/codemode"/);
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const source = await readFile(new URL(`./i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of ["settings.enableCodemode", "settings.codemodeDescription"]) assert.ok(source.includes(`"${key}":`));
  }
});
