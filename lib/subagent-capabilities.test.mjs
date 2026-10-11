import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createHook } from "node:async_hooks";
import { build } from "esbuild";
import { buildSubagentFactory } from "../scripts/build-subagent-factory.mjs";
import { AssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ProjectTrustStore, initTheme } from "@earendil-works/pi-coding-agent";

// Build BOTH adapters beside the native factory. Never resolve a production dist.
const adapterDir = await mkdtemp(new URL("../.tmp-subagent-capabilities-", import.meta.url));
const oldHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const testHome = join(adapterDir, "home");
await mkdir(testHome, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
assert.equal(homedir(), testHome, "automode's home-scoped reads/writes must stay in the temporary fixture");
const adapterFile = join(adapterDir, "adapter.mjs");
const rpcFile = join(adapterDir, "rpc-manager.mjs");
await buildSubagentFactory({ outfile: join(adapterDir, "pi-subagents.mjs") });
const buildOptions = { bundle: true, platform: "node", format: "esm", target: "node24", external: ["@earendil-works/*"], banner: { js: 'import { createRequire } from "node:module"; globalThis.require = createRequire(import.meta.url);' } };
await Promise.all([
  build({ ...buildOptions, entryPoints: [fileURLToPath(new URL("./subagent-extension.ts", import.meta.url))], outfile: adapterFile }),
  build({ ...buildOptions, entryPoints: [fileURLToPath(new URL("./rpc-manager.ts", import.meta.url))], outfile: rpcFile }),
]);
const { createSubagentExtension, filteredSubagentLoaderOptions } = await import(pathToFileURL(adapterFile).href);
const { startRpcSession, getRpcSession } = await import(pathToFileURL(rpcFile).href);
initTheme();
test.after(async () => {
  delete globalThis[MOCK_KEY];
  for (const [key, value] of Object.entries(oldHome)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(adapterDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const MOCK_KEY = Symbol.for("pi-desktop/subagent-capabilities/mock");
const nestedNames = ["Agent", "get_subagent_result", "steer_subagent", "subagent_tasks", "SubagentWorkflow"];
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function contentText(message) {
  return typeof message?.content === "string" ? message.content : (message?.content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
}
function mockStream(model, context) {
  const fixture = globalThis[MOCK_KEY];
  assert.ok(fixture, "a local fixture owns every model request");
  const classifier = getCurrentSystemPrompt(context.messages).includes("auto-mode security classifier");
  // SDK 1.1 embeds authoritative tool declarations in transcript system messages.
  if (!classifier) fixture.requests.push({ tools: getCurrentTools(context.messages).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })), messages: context.messages });
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => {
    const last = context.messages.at(-1);
    const text = contentText(last);
    let content = [{ type: "text", text: classifier ? "0" : last?.role === "toolResult" ? text : "FIXTURE_OK" }];
    let stopReason = "stop";
    if (last?.role === "user" && text.startsWith("CAP:")) {
      const call = JSON.parse(text.slice(4));
      content = [{ type: "toolCall", id: `fixture-${fixture.requests.length}`, name: call.name, arguments: call.args }];
      stopReason = "toolUse";
    }
    const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() };
    stream.push({ type: "done", reason: stopReason, message });
    stream.end();
  });
  return stream;
}
const provider = { api: "openai-completions", baseUrl: "http://127.0.0.1:1/never-used", apiKey: "fixture-only", models: [{ id: "mock", name: "Local fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }], streamSimple: mockStream };
const capPrompt = (name, args) => `CAP:${JSON.stringify({ name, args })}`;
const scriptPrompt = code => capPrompt("codemode", { code });

async function fixture(fn, { codemode = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-capabilities-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network requests are forbidden in this local SDK fixture"); };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, "sessions");
  const state = { dir, cwd, agentDir, roots: [], wrappers: [], requests: [], hits: [] };
  globalThis[MOCK_KEY] = state;
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "native-test", defaultModel: "mock", defaultTools: ["read", "bash", "edit", "write", ...(codemode ? ["codemode"] : [])], packages: [], compaction: { enabled: false } }));
    // Provider survives root shutdown and is rediscovered by REAL startRpcSession.
    await writeFile(join(agentDir, "extensions", "fixture-provider.ts"), `export default function(pi) { pi.registerProvider("native-test", { api: "openai-completions", baseUrl: "http://127.0.0.1:1/never-used", apiKey: "fixture-only", models: ${JSON.stringify(provider.models)}, streamSimple: (...args) => globalThis[Symbol.for("pi-desktop/subagent-capabilities/mock")].stream(...args) }); }`);
    state.stream = mockStream;
    new ProjectTrustStore(agentDir).set(cwd, true);
    await fn(state);
  } finally {
    try {
      for (const wrapper of state.wrappers) await wrapper.shutdown();
      for (const root of state.roots) await root.close();
      await globalThis.__piSessionListPromise?.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      delete globalThis[MOCK_KEY];
      globalThis.fetch = oldFetch;
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      if (oldSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = oldSessionDir;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
async function profile(state, name, frontmatter = "", { skills = false } = {}) {
  await writeFile(join(state.cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\nmodel: native-test/mock\noutput_transcript: false\npersist_session: true\nskills: ${skills}\n${frontmatter}\n---\nCAPABILITIES_${name}`);
}
async function extension(state, filename, name, { deferred = false, late = false } = {}) {
  await writeFile(join(state.agentDir, "extensions", `${filename}.ts`), `export default function(pi) { const register = () => pi.registerTool({ name: ${JSON.stringify(name)}, label: "Fixture tool", description: "Local capability fixture", parameters: { type: "object", properties: {} }, ${deferred ? 'exposure: "deferred",' : ""} execute: async () => { globalThis[Symbol.for("pi-desktop/subagent-capabilities/mock")].hits.push(${JSON.stringify(name)}); return { content: [{ type: "text", text: "EXECUTED_${name}" }] }; } }); ${late ? 'pi.on("before_agent_start", register);' : "register();"} }`);
}
async function makeRoot(state) {
  const children = [];
  const settingsManager = SettingsManager.create(state.cwd, state.agentDir);
  const options = await filteredSubagentLoaderOptions({ cwd: state.cwd, agentDir: state.agentDir, settingsManager, noExtensions: false, noSkills: true, extensionFactories: [
    pi => pi.registerProvider("native-test", provider),
    createSubagentExtension(state.cwd, {
      async bindChild(session, info) { children.push({ session, info }); await session.bindExtensions({ mode: "rpc" }); },
      async shutdownChild(session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); },
      invalidate() {},
    }),
  ] }, settingsManager);
  const loader = new DefaultResourceLoader(options);
  await loader.reload({ resolveProjectTrust: async () => true });
  assert.deepEqual(loader.getExtensions().errors, [], "root discovery loads only local fixture resources");
  const { session } = await createAgentSession({ cwd: state.cwd, agentDir: state.agentDir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.create(state.cwd) });
  await session.setModel(session.modelRuntime.getModel("native-test", "mock"));
  await session.bindExtensions({ mode: "rpc" });
  const root = { session, children, closed: false, async close() { if (this.closed) return; this.closed = true; await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } };
  root.spawn = async (name = "work", prompt = "Inspect capabilities", extra = {}) => {
    const tool = loader.getExtensions().extensions.flatMap(entry => [...entry.tools.values()]).find(tool => tool.definition.name === "Agent");
    assert.ok(tool, "native Agent is actually registered");
    const result = await tool.definition.execute("fixture-agent-call", { subagent_type: name, model: "native-test/mock", prompt, description: "capability fixture", run_in_background: false, ...extra }, undefined, undefined, session.extensionRunner.createToolContext("fixture-agent-call"));
    assert.equal(result.isError, undefined, contentText(result));
    assert.ok(children.length, "a real child SDK session was created");
    return children.at(-1).session;
  };
  state.roots.push(root);
  return root;
}
function requestNames(state, index = 0) { return state.requests[index].tools.map(tool => tool.name); }
function hasSafetyHandler(session) {
  const automode = session.resourceLoader.getExtensions().extensions.find(entry => entry.path.includes("automode"));
  assert.ok(automode, "ordinary extension exclusion keeps automode loaded");
  assert.ok(automode.handlers.get("tool_call")?.length, "real safety tool_call handler stays installed");
}
function lastToolResult(session, name = "codemode") {
  const result = session.messages.findLast(message => message.role === "toolResult" && message.toolName === name);
  assert.ok(result, `SDK persisted a real ${name} result`);
  return result;
}
async function reopen(state, child) {
  const file = child.sessionManager.getSessionFile();
  const id = child.sessionId;
  await state.roots.at(-1).close();
  const started = await startRpcSession(id, file, undefined);
  state.wrappers.push(started.session);
  await started.session.waitUntilReady();
  assert.equal(started.realSessionId, id);
  assert.equal(started.session.inner.model.provider, "native-test");
  return started.session.inner;
}

// Sequential fixtures mutate process environment, never user configuration.
test("default work follows settings, declares codemode and really calculates 42", async () => fixture(async state => {
  const root = await makeRoot(state);
  const child = await root.spawn("work", scriptPrompt("return 6 * 7;"));
  assert.ok(requestNames(state).includes("codemode"));
  assert.ok(child.getActiveToolNames().includes("codemode"));
  assert.match(contentText(lastToolResult(child)), /Script completed[\s\S]*\b42\b/);
  assert.equal(lastToolResult(child).isError, false);
  hasSafetyHandler(child);
}));

test("codemode off remains registered but is not active or declared", async () => fixture(async state => {
  const root = await makeRoot(state);
  const child = await root.spawn();
  assert.ok(child.getAllTools().some(tool => tool.name === "codemode"));
  assert.equal(child.getActiveToolNames().includes("codemode"), false);
  assert.equal(requestNames(state).includes("codemode"), false);
}, { codemode: false }));

test("extensions false and isolated omit codemode while retaining automode handlers", async () => fixture(async state => {
  await profile(state, "closed", "extensions: false");
  const root = await makeRoot(state);
  for (const [name, extra] of [["closed", {}], ["work", { isolated: true }]]) {
    const before = state.requests.length;
    const child = await root.spawn(name, "Inspect capabilities", extra);
    assert.equal(child.getAllTools().some(tool => tool.name === "codemode"), false, name);
    assert.equal(requestNames(state, before).includes("codemode"), false, name);
    hasSafetyHandler(child);
  }
}));

test("ext:codemode opts in; exclude_extensions and disallowed_tools override it", async () => fixture(async state => {
  await profile(state, "selected", "tools: read, ext:codemode\nextensions: true");
  await profile(state, "excluded", "tools: read, ext:codemode\nextensions: true\nexclude_extensions: codemode");
  await profile(state, "denied", "tools: read, ext:codemode\nextensions: true\ndisallowed_tools: codemode");
  const root = await makeRoot(state);
  const selected = await root.spawn("selected", scriptPrompt("return 6 * 7;"));
  assert.ok(requestNames(state).includes("codemode"));
  assert.match(contentText(lastToolResult(selected)), /Script completed[\s\S]*\b42\b/);
  for (const name of ["excluded", "denied"]) {
    const before = state.requests.length;
    const child = await root.spawn(name, scriptPrompt("return 6 * 7;"));
    assert.equal(requestNames(state, before).includes("codemode"), false, name);
    assert.equal(lastToolResult(child).isError, true, `${name} refuses an actual model-issued codemode call`);
    assert.match(contentText(lastToolResult(child)), /not found|not available|unknown tool/i, name);
    assert.equal(child.getActiveToolNames().includes("codemode"), false, name);
    assert.equal(child.getAllTools().some(tool => tool.name === "codemode"), false, name);
    hasSafetyHandler(child);
  }
}, { codemode: false }));

test("codemode ctx.executeTool cannot bypass ext selection for late deferred tools", async () => fixture(async state => {
  await profile(state, "guarded", "tools: read, ext:codemode\nextensions: true");
  await extension(state, "unselected", "deferred_secret", { deferred: true, late: true });
  const root = await makeRoot(state);
  const child = await root.spawn("guarded", scriptPrompt('return await tools.deferred_secret({});'));
  assert.ok(child.getAllTools().some(tool => tool.name === "deferred_secret"), "late tool really registered during before_agent_start");
  assert.ok(child.getCallableToolNames().includes("deferred_secret"), "deferred exposure enters SDK nested-tool registry, requiring the scope guard");
  assert.equal(requestNames(state).includes("deferred_secret"), false);
  const result = lastToolResult(child);
  assert.equal(result.isError, true);
  assert.match(contentText(result), /not available.*configured scope/);
  assert.deepEqual(state.hits, [], "blocked nested call never ran the extension execute function");
}));

test("default nested delegation declares all five tools; explicit false closes it", async () => fixture(async state => {
  await profile(state, "no-nesting", "extensions: true\nallowed_subagents: false");
  const root = await makeRoot(state);
  const child = await root.spawn();
  for (const name of nestedNames) assert.ok(requestNames(state).includes(name), `${name} declared on real child model request`);
  await child.prompt(capPrompt("get_subagent_result", { agent_id: "missing-owned-child" }));
  assert.match(contentText(lastToolResult(child, "get_subagent_result")), /not found|unknown|not owned/i);
  const before = state.requests.length;
  const closed = await root.spawn("no-nesting");
  for (const name of nestedNames) {
    assert.equal(requestNames(state, before).includes(name), false, name);
    assert.equal(closed.getAllTools().some(tool => tool.name === name), false, name);
  }
}));

test("v2 readonly/disallow/depth policy survives root shutdown and real RPC reopen without freezing tools", async () => fixture(async state => {
  await profile(state, "readonly", "tools: read, grep, find, ls, bash\nextensions: true\ndisallowed_tools: bash\nallowed_subagents: false");
  const root = await makeRoot(state);
  const child = await root.spawn("readonly", scriptPrompt("return 6 * 7;"));
  const entries = (await readFile(child.sessionManager.getSessionFile(), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const snapshot = entries.findLast(entry => entry.customType === "pi-web:subagent").data.resourceSnapshot;
  assert.equal(snapshot.version, 2);
  assert.deepEqual(snapshot.policy.tools, ["read", "grep", "find", "ls", "bash"]);
  assert.equal(snapshot.policy.extensions, true);
  assert.equal(snapshot.policy.skills, false);
  assert.deepEqual(snapshot.policy.disallowedTools, ["bash"]);
  assert.equal(snapshot.policy.allowedSubagents, false);
  assert.equal(snapshot.policy.depth, 1);
  assert.equal(snapshot.policy.maxSubagentDepth, 2);
  assert.equal(snapshot.policy.configCwd, state.cwd);
  assert.ok(snapshot.tools.includes("codemode"), "the stored transient active set is different from policy.tools");
  await root.close();
  const resumed = await reopen(state, child);
  await extension(state, "new-global", "new_global_tool");
  assert.deepEqual(await state.wrappers.at(-1).send({ type: "reload" }), { success: true });
  const before = state.requests.length;
  await resumed.prompt(scriptPrompt('text(6 * 7); return await tools.new_global_tool({});'));
  assert.ok(requestNames(state, before).includes("codemode"));
  assert.ok(requestNames(state, before).includes("new_global_tool"), "new global extension not in the saved instantaneous set is visible");
  assert.match(contentText(lastToolResult(resumed)), /\b42\b[\s\S]*EXECUTED_new_global_tool/);
  assert.deepEqual(state.hits, ["new_global_tool"]);
  for (const name of ["write", "edit", "bash", ...nestedNames]) {
    assert.equal(requestNames(state, before).includes(name), false, name);
    assert.equal(resumed.getAllTools().some(tool => tool.name === name), false, name);
  }
  const forbiddenFile = join(state.cwd, "forbidden.txt");
  await resumed.prompt(scriptPrompt(`return await tools.write(${JSON.stringify({ path: forbiddenFile, content: "must not be written" })});`));
  assert.equal(lastToolResult(resumed).isError, true, "readonly blocks actual nested write execution");
  await assert.rejects(readFile(forbiddenFile), { code: "ENOENT" });
  await resumed.prompt(scriptPrompt('return await tools.bash({ command: "printf denied-tool-ran" });'));
  assert.equal(lastToolResult(resumed).isError, true, "disallowed bash cannot run through codemode");
  assert.doesNotMatch(contentText(lastToolResult(resumed)), /Output:\s*denied-tool-ran/);
  hasSafetyHandler(resumed);
}));

test("v2 explicit ext selectors and depth cap survive real RPC reopen", async () => fixture(async state => {
  await writeFile(join(state.agentDir, "subagents.json"), JSON.stringify({ maxSubagentDepth: 1, workflowsEnabled: true }));
  await profile(state, "selected-resume", "tools: read, ext:codemode\nextensions: true\nexclude_extensions: excluded-global\ndisallowed_tools: write\nallowed_subagents: all");
  const root = await makeRoot(state);
  const child = await root.spawn("selected-resume", scriptPrompt("return 6 * 7;"));
  const snapshot = child.sessionManager.getEntries().findLast(entry => entry.customType === "pi-web:subagent").data.resourceSnapshot;
  assert.equal(snapshot.version, 2);
  assert.deepEqual(snapshot.policy.extSelectors, ["ext:codemode"]);
  assert.deepEqual(snapshot.policy.excludeExtensions, ["excluded-global"]);
  assert.deepEqual(snapshot.policy.disallowedTools, ["write"]);
  assert.equal(snapshot.policy.allowedSubagents, "all");
  assert.equal(snapshot.policy.depth, 1);
  assert.equal(snapshot.policy.maxSubagentDepth, 1);
  await root.close();
  const resumed = await reopen(state, child);
  const initialRequest = state.requests.length;
  await resumed.prompt(scriptPrompt("return 6 * 7;"));
  assert.match(contentText(lastToolResult(resumed)), /Script completed[\s\S]*\b42\b/);
  for (const name of ["write", "edit", ...nestedNames]) assert.equal(requestNames(state, initialRequest).includes(name), false, `initial reopen: ${name}`);
  await extension(state, "unselected-global", "unselected_resumed", { deferred: true });
  await extension(state, "excluded-global", "excluded_resumed");
  assert.deepEqual(await state.wrappers.at(-1).send({ type: "reload" }), { success: true });
  const before = state.requests.length;
  await resumed.prompt(scriptPrompt('text(6 * 7); return await tools.unselected_resumed({});'));
  assert.ok(requestNames(state, before).includes("codemode"));
  assert.match(contentText(lastToolResult(resumed)), /\b42\b[\s\S]*not available.*configured scope/);
  assert.equal(lastToolResult(resumed).isError, true);
  assert.deepEqual(state.hits, []);
  for (const name of ["write", "edit", "unselected_resumed", "excluded_resumed", ...nestedNames]) assert.equal(requestNames(state, before).includes(name), false, name);
  assert.ok(resumed.getAllTools().some(tool => tool.name === "unselected_resumed"));
  assert.equal(resumed.getAllTools().some(tool => tool.name === "excluded_resumed"), false);
  hasSafetyHandler(resumed);
}));

test("explicit ext selection excludes before_agent_start direct tools on the first request, including command reload", async () => fixture(async state => {
  await profile(state, "late-direct", "tools: read, ext:codemode\nextensions: true");
  await extension(state, "unselected-direct", "late_direct", { late: true });
  await writeFile(join(state.agentDir, "extensions", "fixture-reload.ts"), `export default function(pi) {
    pi.registerCommand("fixture-reload", { description: "Reload locally", handler: async (_args, ctx) => {
      await ctx.reload();
      globalThis[Symbol.for("pi-desktop/subagent-capabilities/mock")].reloads++;
    } });
  }`);
  state.reloads = 0;
  const root = await makeRoot(state);
  const beforeSpawn = state.requests.length;
  const child = await root.spawn("late-direct", scriptPrompt('return await tools.late_direct({});'));
  assert.ok(child.getAllTools().some(tool => tool.name === "late_direct"), "unselected global extension really registers its direct tool during before_agent_start");
  assert.ok(requestNames(state, beforeSpawn).includes("codemode"));
  const boundaryRequests = [["initial child", beforeSpawn]];
  assert.equal(lastToolResult(child).isError, true);
  assert.match(contentText(lastToolResult(child)), /not available.*configured scope|tools\.late_direct does not exist/);
  assert.deepEqual(state.hits, [], "codemode cannot execute the late direct tool");

  const resumed = await reopen(state, child);
  const beforeReopen = state.requests.length;
  await resumed.prompt(scriptPrompt('return await tools.late_direct({});'));
  boundaryRequests.push(["initial RPC restore", beforeReopen]);
  assert.equal(lastToolResult(resumed).isError, true);
  assert.match(contentText(lastToolResult(resumed)), /not available.*configured scope|tools\.late_direct does not exist/);

  const wrapper = state.wrappers.at(-1);
  const beforeReload = state.requests.length;
  assert.equal(await wrapper.send({ type: "prompt", message: "/fixture-reload" }), null);
  assert.equal(state.reloads, 1, "the extension command really awaited RPC's ctx.reload binding");
  assert.equal(state.requests.length, beforeReload, "the command itself makes no model request");
  await resumed.prompt(scriptPrompt('return await tools.late_direct({});'));
  assert.ok(resumed.getAllTools().some(tool => tool.name === "late_direct"), "reload discovered the extension and its late registration again");
  assert.ok(requestNames(state, beforeReload).includes("codemode"));
  boundaryRequests.push(["extension-command ctx.reload", beforeReload]);
  assert.equal(lastToolResult(resumed).isError, true);
  assert.match(contentText(lastToolResult(resumed)), /not available.*configured scope|tools\.late_direct does not exist/);
  assert.deepEqual(state.hits, [], "no rejected call reached extension execution, before or after reload");
  hasSafetyHandler(resumed);
  // Check all first-request boundaries together, so an early declaration leak
  // does not prevent exercising the real RPC command reload and execution guard.
  assert.deepEqual(boundaryRequests.filter(([, index]) => requestNames(state, index).includes("late_direct")).map(([stage]) => stage), [], "late_direct must not be declared at any first-request boundary");
}));

test("real RPC restore uses saved parent configCwd while read and bash remain in the target project", async () => fixture(async state => {
  const target = join(state.dir, "target-project");
  for (const [cwd, marker] of [[state.cwd, "parent"], [target, "target"]]) {
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await mkdir(join(cwd, ".pi", "skills", `${marker}-skill`), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
      defaultThinkingLevel: marker === "parent" ? "low" : "high",
      defaultTools: marker === "parent" ? ["read", "bash", "codemode"] : ["read"],
      compaction: { enabled: false },
    }));
    await writeFile(join(cwd, ".pi", "skills", `${marker}-skill`, "SKILL.md"), `---\nname: ${marker}-skill\ndescription: ${marker} local discovery marker\n---\n${marker.toUpperCase()}_SKILL_MARKER\n`);
    await writeFile(join(cwd, ".pi", "extensions", `${marker}-extension.ts`), `export default function(pi) {
      globalThis[Symbol.for("pi-desktop/subagent-capabilities/mock")].hits.push("LOADED_${marker}");
      pi.registerTool({ name: "${marker}_project_tool", label: "Project marker", description: "${marker} project marker", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "${marker.toUpperCase()}_EXTENSION_MARKER" }] }) });
    }`);
    await writeFile(join(cwd, "cwd-probe.txt"), `${marker.toUpperCase()}_WORKING_FILE`);
    new ProjectTrustStore(state.agentDir).set(cwd, true);
  }
  await profile(state, "cross-project", "extensions: true\nallowed_subagents: false", { skills: true });
  const root = await makeRoot(state);
  const child = await root.spawn("cross-project", "Inspect cross-project capabilities");
  assert.equal(child.sessionManager.getCwd(), state.cwd);
  const snapshot = child.sessionManager.getEntries().findLast(entry => entry.customType === "pi-web:subagent").data.resourceSnapshot;
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.policy.configCwd, state.cwd, "saved config root stays with the parent project");
  assert.equal(snapshot.policy.skills, true);
  assert.ok(state.hits.includes("LOADED_parent"));
  assert.equal(state.hits.includes("LOADED_target"), false, "initial creation never evaluates target extension code");
  // Simulate a saved cross-project child: preserve the real model transcript and
  // parent policy, changing only the saved session's working-directory header.
  await root.close();
  const sessionFile = child.sessionManager.getSessionFile();
  const entries = (await readFile(sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries[0].type, "session");
  entries[0].cwd = target;
  await writeFile(sessionFile, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");

  const resumed = await reopen(state, child);
  assert.equal(resumed.sessionManager.getCwd(), target);
  assert.equal(state.wrappers.at(-1).cwd, target);
  assert.equal(resumed.settingsManager.getDefaultThinkingLevel(), "low", "restored SettingsManager reads parent settings, not target's high marker");
  assert.deepEqual(resumed.settingsManager.getDefaultTools(), ["read", "bash", "codemode"]);
  const skills = resumed.resourceLoader.getSkills().skills;
  const extensions = resumed.resourceLoader.getExtensions().extensions;
  const discoveryFailures = [];
  if (!skills.some(skill => skill.name === "parent-skill" && resolve(skill.filePath) === join(state.cwd, ".pi", "skills", "parent-skill", "SKILL.md"))) discoveryFailures.push("parent skill missing");
  if (skills.some(skill => skill.name === "target-skill")) discoveryFailures.push("target skill loaded");
  if (!extensions.some(entry => resolve(entry.path) === join(state.cwd, ".pi", "extensions", "parent-extension.ts"))) discoveryFailures.push("parent extension missing");
  if (extensions.some(entry => resolve(entry.path).startsWith(join(target, ".pi")))) discoveryFailures.push("target extension loaded");
  if (state.hits.includes("LOADED_target")) discoveryFailures.push("target extension code executed");

  const before = state.requests.length;
  await resumed.prompt(capPrompt("read", { path: "cwd-probe.txt" }));
  if (!requestNames(state, before).includes("parent_project_tool")) discoveryFailures.push("parent extension tool not declared");
  if (requestNames(state, before).includes("target_project_tool")) discoveryFailures.push("target extension tool declared");
  assert.match(contentText(lastToolResult(resumed, "read")), /TARGET_WORKING_FILE/);
  assert.doesNotMatch(contentText(lastToolResult(resumed, "read")), /PARENT_WORKING_FILE/);
  await resumed.prompt(capPrompt("bash", { command: "pwd; cat cwd-probe.txt" }));
  const bash = lastToolResult(resumed, "bash");
  assert.equal(bash.isError, false);
  assert.match(contentText(bash), /target-project[\s\S]*TARGET_WORKING_FILE/);
  assert.doesNotMatch(contentText(bash), /PARENT_WORKING_FILE/);
  hasSafetyHandler(resumed);
  // Assert after actual filesystem calls to report discovery separately from
  // the target working directory, even when a config-root regression exists.
  assert.deepEqual(discoveryFailures, [], "both projects are trusted, but only saved parent configCwd resources may load");
}));

test("default depth-one RPC owner dynamically declares all nested tools, creates depth two and cleans up on shutdown", async () => fixture(async state => {
  state.lifecycle = [];
  await writeFile(join(state.agentDir, "extensions", "fixture-lifecycle.ts"), `export default function(pi) {
    for (const type of ["session_start", "session_shutdown"]) pi.on(type, (_event, ctx) => {
      globalThis[Symbol.for("pi-desktop/subagent-capabilities/mock")].lifecycle.push({ type, id: ctx.sessionManager.getSessionId() });
    });
  }`);
  const root = await makeRoot(state);
  const child = await root.spawn();
  const policy = child.sessionManager.getEntries().findLast(entry => entry.customType === "pi-web:subagent").data.resourceSnapshot.policy;
  assert.equal(policy.allowedSubagents, "all", "unconfigured default, not an explicit opt-in profile");
  assert.equal(policy.depth, 1);
  assert.equal(policy.maxSubagentDepth, 2);
  await root.close();
  const timers = [];
  const timerHook = createHook({ init(_id, type, _trigger, resource) {
    if (type === "Timeout" && resource._idleTimeout === 60_000) timers.push(resource);
  } });
  timerHook.enable();
  let resumed;
  try { resumed = await reopen(state, child); }
  finally { timerHook.disable(); }
  const maintenance = timers.filter(timer => timer._repeat === 60_000);
  assert.equal(maintenance.length, 1, "helper created inside session_start immediately starts exactly one maintenance interval");
  assert.equal(maintenance[0]._destroyed, false);
  for (const name of nestedNames) assert.ok(resumed.getAllTools().some(tool => tool.name === name), `${name} registered dynamically during real RPC session_start`);

  const before = state.requests.length;
  const beforeLifecycle = state.lifecycle.length;
  await resumed.prompt(capPrompt("Agent", { subagent_type: "work", model: "native-test/mock", prompt: "NESTED_DEPTH_TWO_FIXTURE", description: "Restored owner's local child", run_in_background: false, result_format: "text" }));
  for (const name of nestedNames) assert.ok(requestNames(state, before).includes(name), `${name} visible on restored owner's first real model request`);
  const result = lastToolResult(resumed, "Agent");
  assert.equal(result.isError, false, contentText(result));
  assert.match(contentText(result), /FIXTURE_OK/);
  // Nested Agent returns its answer inline, not a Desktop sessionId detail.
  // Observe the real SDK lifecycle and live RPC registry instead of inventing one.
  const starts = state.lifecycle.slice(beforeLifecycle).filter(entry => entry.type === "session_start");
  assert.equal(starts.length, 1, "actual model-issued Agent call starts exactly one SDK child session");
  const grandchild = getRpcSession(starts[0].id);
  assert.ok(grandchild?.isAlive(), "nested child is bound to a real RPC wrapper");
  const grandchildPolicy = grandchild.inner.sessionManager.getEntries().findLast(entry => entry.customType === "pi-web:subagent").data.resourceSnapshot.policy;
  assert.equal(grandchildPolicy.depth, 2);
  assert.equal(grandchildPolicy.maxSubagentDepth, 2);
  assert.equal(grandchildPolicy.configCwd, state.cwd);
  const childRequest = state.requests.slice(before + 1).find(request => request.messages.some(message => message.role === "user" && contentText(message).includes("NESTED_DEPTH_TWO_FIXTURE")));
  assert.ok(childRequest, "depth-two session really reached the local model provider");
  for (const name of nestedNames) assert.equal(childRequest.tools.some(tool => tool.name === name), false, `depth-two cap excludes ${name}`);
  assert.equal(state.lifecycle.filter(entry => entry.type === "session_start" && entry.id === grandchild.inner.sessionId).length, 1);

  const owner = state.wrappers.at(-1);
  const ownerId = owner.inner.sessionId;
  const grandchildId = grandchild.inner.sessionId;
  await owner.shutdown();
  assert.equal(owner.isAlive(), false);
  assert.equal(grandchild.isAlive(), false, "ending the restored owner awaits its nested child's shutdown");
  assert.equal(getRpcSession(ownerId), undefined);
  assert.equal(getRpcSession(grandchildId), undefined, "owned child is removed from live RPC registry");
  assert.equal(maintenance[0]._destroyed, true, "owner shutdown clears the restored helper's maintenance timer");
  assert.equal(state.lifecycle.filter(entry => entry.type === "session_shutdown" && entry.id === ownerId).length, 2, "one shutdown of the original saved child and one of its restored owner");
  assert.equal(state.lifecycle.filter(entry => entry.type === "session_shutdown" && entry.id === grandchildId).length, 1, "nested resources receive shutdown exactly once");
}));
