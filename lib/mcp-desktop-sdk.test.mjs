import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { createAgentSessionFromServices, createAgentSessionServices, createEventBus, ModelRuntime, SettingsManager, SessionManager, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
const isolatedHome = await mkdtemp(join(tmpdir(), "pi-desktop-mcp-home-"));
const oldHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = isolatedHome; process.env.USERPROFILE = isolatedHome;
test.after(async () => { for (const [key, value] of Object.entries(oldHome)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(isolatedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createDesktopSessionExtensions } = await jiti.import("./desktop-session-extensions.ts");
const { filteredSubagentLoaderOptions } = await jiti.import("./extension-loader-options.ts");
const { FilteredResourceLoader } = await jiti.import("./filtered-resource-loader.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { getDesktopMcpRuntime } = await jiti.import("./mcp-runtime.ts");
const serverPath = fileURLToPath(new URL("../tests/fixtures/mcp-server.cjs", import.meta.url));

async function fixture(t, { defaultTools, extensions, externalMcp = false, exposure = "codemode" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-mcp-sdk-"));
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const owners = [];
  t.after(async () => { for (const owner of owners.reverse()) { await owner.inner.abort(); await owner.shutdown(); } if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const ledger = join(root, "ledger.txt");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultTools, extensions, retry: { enabled: false }, compaction: { enabled: false } }));
  const config = { mcpServers: { fixture: { command: process.execPath, args: [serverPath, ledger], exposure } } };
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify(config));
  if (externalMcp) {
    await mkdir(join(agentDir, "extensions"));
    await writeFile(join(agentDir, "extensions/mcp.ts"), 'export default function(pi) { pi.registerCommand("mcp", { description: "Local external provider fixture", handler: async () => {} }); }');
  }
  const settingsManager = SettingsManager.create(root, agentDir);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  let nextCode; const requests = [];
  modelRuntime.registerProvider("local", { api: "local-mcp-test", baseUrl: "https://unused.invalid", apiKey: "test-only", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }], streamSimple(model, context) {
    const stream = createAssistantMessageEventStream(); requests.push(context); const classifier = getCurrentSystemPrompt(context.messages).includes("auto-mode security classifier"); const code = classifier ? undefined : nextCode; if (!classifier) nextCode = undefined;
    queueMicrotask(() => { const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: code ? [{ type: "toolCall", id: "mcp-test-call", name: "codemode", arguments: { code } }] : [{ type: "text", text: classifier ? "0" : "done" }], stopReason: code ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } }); if (code) { stream.push({ type: "toolcall_start", contentIndex: 0, partial: message }); stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message }); } stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); }); return stream;
  } });
  const options = { cwd: root, agentDir, settingsManager, eventBus: createEventBus(), noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: createDesktopSessionExtensions(root, settingsManager) };
  const filtered = await filteredSubagentLoaderOptions(options, settingsManager);
  const services = await createAgentSessionServices({ cwd: root, agentDir, settingsManager, modelRuntime, resourceLoaderOptions: filtered });
  services.resourceLoader = new FilteredResourceLoader(options, { loader: services.resourceLoader, extensionPaths: filtered.additionalExtensionPaths });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSessionFromServices({ services, model: modelRuntime.getModel("local", "fixture"), sessionManager: SessionManager.inMemory(root) });
  const wrapper = new AgentSessionWrapper(session, { configurationCwd: root }); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  owners.push(wrapper);
  return { root, agentDir, ledger, config, session, wrapper, services, requests, owners, options, run: async code => { nextCode = code; await wrapper.send({ type: "prompt", message: "Run the isolated fixture" }); await session.waitForIdle(); } };
}

test("default desktop provider connects; check performs no business calls; preset/reload retain discovery without declaring indirect MCP tools", { timeout: 25000 }, async t => {
  const f = await fixture(t);
  const runtime = getDesktopMcpRuntime(f.session.sessionId); assert.ok(runtime);
  const ready = await runtime.check(5000); assert.equal(ready.servers[0].state, "connected");
  assert.equal(ready.servers[0].tools.length, 2); assert.ok(ready.servers[0].tools.every(tool => tool.registeredName.startsWith("mcp__fixture__")));
  assert.equal(f.requests.length, 0);
  assert.doesNotMatch(await readFile(f.ledger, "utf8"), /tools\/call/);
  f.wrapper.setActiveToolSelection(["read", "grep"]);
  assert.ok(f.session.getActiveToolNames().includes("codemode"));
  assert.ok(!f.session.getActiveToolNames().some(name => name.startsWith("mcp__")));
  assert.equal(f.wrapper.getMcpSessionView().pending, false);
  const oldGeneration = runtime.generation;
  await f.wrapper.send({ type: "reload" });
  await getDesktopMcpRuntime(f.session.sessionId).check(5000);
  assert.ok(getDesktopMcpRuntime(f.session.sessionId).generation > oldGeneration);
  assert.ok(f.session.getActiveToolNames().includes("codemode"));
  assert.ok(!f.session.getActiveToolNames().some(name => name.startsWith("mcp__")));
  await f.run('const result = await tools.mcp__fixture__read_fixture({}); text(result);');
  const result = f.session.messages.findLast(message => message.role === "toolResult" && message.toolName === "codemode");
  assert.equal(result.isError, false, JSON.stringify(result)); assert.match(JSON.stringify(result.content), /local-fixture-ok/);
  assert.equal(getDesktopMcpRuntime(f.session.sessionId).snapshot().servers[0].lastCall.success, true);
});

test("explicit codemode disabled and deferred discovery respect user selection", { timeout: 25000 }, async t => {
  const f = await fixture(t, { defaultTools: ["-codemode"] });
  await getDesktopMcpRuntime(f.session.sessionId).check(5000);
  f.wrapper.setActiveToolSelection(["read"]); assert.ok(!f.session.getActiveToolNames().includes("codemode"));
  await f.wrapper.send({ type: "reload" }); assert.ok(!f.session.getActiveToolNames().includes("codemode"));
});

test("deferred service automatically activates tool search without directly declaring server tools", { timeout: 25000 }, async t => {
  const f = await fixture(t, { exposure: "deferred" });
  await getDesktopMcpRuntime(f.session.sessionId).check(5000);
  f.wrapper.setActiveToolSelection(["read"]);
  assert.ok(f.session.getActiveToolNames().includes("tool_search"));
  assert.ok(!f.session.getActiveToolNames().some(name => name.startsWith("mcp__")));
});

test("invalid external file does not destroy live connections; busy apply queues/cancels; different sessions keep their own loaded version", { timeout: 25000 }, async t => {
  const f = await fixture(t);
  await getDesktopMcpRuntime(f.session.sessionId).check(5000);
  const original = f.wrapper.getMcpSessionView();
  const settingsManager = SettingsManager.create(f.root, f.agentDir);
  const siblingOptions = { ...f.options, settingsManager, extensionFactories: createDesktopSessionExtensions(f.root, settingsManager) };
  const siblingFiltered = await filteredSubagentLoaderOptions(siblingOptions, settingsManager);
  const services = await createAgentSessionServices({ cwd: f.root, agentDir: f.agentDir, settingsManager, modelRuntime: f.services.modelRuntime, resourceLoaderOptions: siblingFiltered });
  services.resourceLoader = new FilteredResourceLoader(siblingOptions, { loader: services.resourceLoader, extensionPaths: siblingFiltered.additionalExtensionPaths });
  const other = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(f.root) });
  const sibling = new AgentSessionWrapper(other.session, { configurationCwd: f.root }); f.owners.push(sibling); sibling.start(); sibling.beginExtensionBinding(); await sibling.waitUntilReady();
  await getDesktopMcpRuntime(other.session.sessionId).check(5000);
  assert.equal(sibling.getMcpSessionView().appliedRevision, original.appliedRevision);
  const siblingGeneration = sibling.getMcpSessionView().generation;
  await writeFile(join(f.agentDir, "mcp.json"), "{broken");
  assert.equal(f.wrapper.getMcpSessionView().pending, true);
  await assert.rejects(f.wrapper.requestMcpApply(), /配置文件/);
  assert.equal(getDesktopMcpRuntime(f.session.sessionId).generation, original.generation);
  await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: "invalid array" } } }));
  await assert.rejects(f.wrapper.requestMcpApply(), /无效的服务配置/);
  assert.equal(getDesktopMcpRuntime(f.session.sessionId).generation, original.generation);
  assert.equal(getDesktopMcpRuntime(f.session.sessionId).snapshot().servers[0].state, "connected");
  // Simulate an active UI/tool operation rather than starting a paid model or shell.
  await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ ...f.config, autoEnableCodemode: false }));
  f.wrapper.activeToolEvents.set("fixture-busy", { type: "tool_execution_start" });
  await f.wrapper.requestMcpApply(); assert.equal(f.wrapper.getMcpSessionView().applyState, "queued");
  f.wrapper.cancelMcpApply(); assert.equal(f.wrapper.getMcpSessionView().applyState, "idle");
  assert.equal(getDesktopMcpRuntime(f.session.sessionId).generation, original.generation);
  await f.wrapper.requestMcpApply(); f.wrapper.activeToolEvents.clear();
  const deadline = Date.now() + 5000;
  while (f.wrapper.getMcpSessionView().applyState === "queued" || f.wrapper.getMcpSessionView().applyState === "applying") { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.equal(f.wrapper.getMcpSessionView().applyState, "idle");
  assert.equal(f.wrapper.getMcpSessionView().pending, false);
  assert.ok(f.wrapper.getMcpSessionView().generation > original.generation);
  assert.equal(sibling.getMcpSessionView().generation, siblingGeneration);
  assert.equal(sibling.getMcpSessionView().pending, true);
  await sibling.requestMcpApply();
  assert.equal(sibling.getMcpSessionView().pending, false);
});

test("a discovered external MCP provider replaces the builtin without duplicate connections", { timeout: 25000 }, async t => {
  const f = await fixture(t, { externalMcp: true });
  assert.equal(getDesktopMcpRuntime(f.session.sessionId), undefined);
  assert.equal(f.wrapper.getMcpSessionView().provider, "external");
  await assert.rejects(readFile(f.ledger), { code: "ENOENT" });
  await assert.rejects(f.wrapper.requestMcpApply(), /外部模块/);
  await f.wrapper.send({ type: "reload" });
  assert.equal(f.wrapper.getMcpSessionView().provider, "external");
  await assert.rejects(readFile(f.ledger), { code: "ENOENT" });
});

test("trust synchronization follows explicit SettingsManager roots rather than process environment", async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, ".pi"));
  await writeFile(join(f.root, ".pi/mcp.json"), JSON.stringify({ mcpServers: { local: { command: process.execPath, enabled: false } } }));
  new ProjectTrustStore(f.agentDir).set(f.root, true);
  const alternative = join(f.root, "alternative-agent"); await mkdir(alternative);
  new ProjectTrustStore(alternative).set(f.root, false);
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = alternative;
    f.wrapper.syncProjectTrust();
    assert.equal(f.session.settingsManager.isProjectTrusted(), true);
  } finally { process.env.PI_CODING_AGENT_DIR = previous; }
});

test("project MCP files are dormant until trusted and builtin mcp can be disabled", { timeout: 25000 }, async t => {
  const f = await fixture(t, { extensions: ["-builtin:mcp"] });
  assert.equal(getDesktopMcpRuntime(f.session.sessionId), undefined);
  assert.equal(f.wrapper.getMcpSessionView().provider, "disabled");
  assert.equal(f.session.extensionRunner.getRegisteredCommands().some(command => command.invocationName === "mcp"), false);
  await mkdir(join(f.root, ".pi"));
  await writeFile(join(f.root, ".pi/mcp.json"), JSON.stringify({ mcpServers: { untrusted: { command: process.execPath, args: [serverPath], enabled: false } } }));
  await writeFile(join(f.agentDir, "settings.json"), "{}");
  await f.wrapper.send({ type: "reload" });
  assert.deepEqual((await getDesktopMcpRuntime(f.session.sessionId).check(5000)).servers.map(server => server.name), ["fixture"]);
  new ProjectTrustStore(f.agentDir).set(f.root, true);
  await f.wrapper.send({ type: "reload" });
  assert.deepEqual((await getDesktopMcpRuntime(f.session.sessionId).check(5000)).servers.map(server => server.name), ["fixture", "untrusted"]);
});
