import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, initTheme } from "@earendil-works/pi-coding-agent";

// Run the adapter as native ESM, exactly like the Desktop backend. jiti's
// dynamic-import cache ignores URL queries and would destroy root isolation.
const adapterDir = await mkdtemp(new URL("../.tmp-subagent-test-", import.meta.url));
const adapterFile = join(adapterDir, "adapter.mjs");
await build({ entryPoints: [new URL("./subagent-extension.ts", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], outfile: adapterFile, bundle: true, platform: "node", format: "esm", target: "node24", external: ["@earendil-works/*"], banner: { js: 'import { createRequire } from "node:module"; globalThis.require = createRequire(import.meta.url);' } });
const { createSubagentExtension, filteredSubagentLoaderOptions, isSubagentsSource, getNativeSubagentRun, steerNativeSubagent, abortNativeSubagent } = await import(pathToFileURL(adapterFile).href);
test.after(async () => rm(adapterDir, { recursive: true, force: true }));

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function mockStream(model, context, options) {
  const stream = new AssistantMessageEventStream();
  queueMicrotask(async () => {
    const text = context.systemPrompt.includes("ROOT_B_MARK") ? "RESULT_B" : "RESULT_A";
    const message = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
    // Give the control bridge a real running window, without a model request.
    await new Promise((resolve) => setTimeout(resolve, 40));
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  });
  return stream;
}

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-desktop-native-subagents-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  const roots = [];
  try { await fn(dir, roots); }
  finally {
    for (const root of roots) await root.close();
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function makeRoot(dir, name, roots, options = {}) {
  const cwd = join(dir, name);
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(join(cwd, ".pi", "agents", "fixture-test.md"), `---\ntools: none\nextensions: false\nskills: false\npersist_session: true\noutput_transcript: false\n---\nROOT_${name}_MARK`);
  const children = [];
  const binds = new Map();
  const shutdowns = new Map();
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, noExtensions: true, noSkills: true,
    extensionFactories: [
      (pi) => {
        const provider = { api: "openai-completions", baseUrl: "https://invalid.example", apiKey: "not-a-real-key", models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }], streamSimple: mockStream };
        pi.registerProvider("native-test", provider);
        // Supply the presets' exact model locally, never a real service/key.
        if (options.presetModels) pi.registerProvider("哈尔", { ...provider, models: [{ ...provider.models[0], id: "gpt-6.1-sol", reasoning: true }] });
      },
      createSubagentExtension(cwd, {
        async bindChild(session, info) {
          children.push({ session, info });
          binds.set(session.sessionId, (binds.get(session.sessionId) ?? 0) + 1);
          await options.bindGate?.(session);
          if (!root.closed) await session.bindExtensions({ mode: "rpc" });
        },
        async shutdownChild(session) {
          shutdowns.set(session.sessionId, (shutdowns.get(session.sessionId) ?? 0) + 1);
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session.dispose();
        },
        invalidate() {},
      }),
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(cwd) });
  const model = session.modelRuntime.getModel("native-test", "mock");
  await session.setModel(model);
  await session.bindExtensions({ mode: "rpc" });
  const root = { session, children, binds, shutdowns, loader, closed: false };
  root.close = async () => {
    if (root.closed) return;
    root.closed = true;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  };
  roots.push(root);
  root.call = async (name, args) => {
    const tool = loader.getExtensions().extensions.flatMap((e) => [...e.tools.values()]).find((tool) => tool.definition.name === name);
    assert.ok(tool, `native tool ${name} is registered`);
    return tool.definition.execute("test-tool-id", args, undefined, undefined, session.extensionRunner.createContext());
  };
  return root;
}

initTheme();

test("native source classifier recognizes scoped npm, local checkout and renamed package directories", async () => {
  assert.equal(isSubagentsSource("/tmp/local/pi-subagents/src/index.ts"), true);
  assert.equal(isSubagentsSource("/tmp/index.ts", "npm:@tintinweb/pi-subagents@0.19.0"), true);
  assert.equal(isSubagentsSource("/tmp/other/index.ts", "npm:other"), false);
});

test("source discovery removes duplicate factories before importing them", async () => fixture(async (dir) => {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const duplicate = join(agentDir, "extensions", "pi-subagents", "index.ts");
  const ordinary = join(agentDir, "extensions", "ordinary.ts");
  await mkdir(join(agentDir, "extensions", "pi-subagents"), { recursive: true });
  await writeFile(duplicate, 'throw new Error("DUPLICATE_FACTORY_EXECUTED");');
  await writeFile(ordinary, "export default function(pi) { pi.registerCommand('ordinary', {handler: async()=>{}}); }");
  const settingsManager = SettingsManager.inMemory({});
  const options = await filteredSubagentLoaderOptions({ cwd: dir, agentDir, settingsManager }, settingsManager);
  assert.equal(options.noExtensions, true);
  assert.ok(options.additionalExtensionPaths.includes(ordinary));
  assert.ok(!options.additionalExtensionPaths.includes(duplicate));
  const loader = new DefaultResourceLoader(options);
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
}));

test("two real SDK roots isolate native config, run children and retain exact resource snapshots", async () => fixture(async (dir, roots) => {
  const a = await makeRoot(dir, "A", roots);
  const b = await makeRoot(dir, "B", roots);
  const [ra, rb] = await Promise.all([
    a.call("Agent", { subagent_type: "fixture-test", prompt: "reply", description: "test A", run_in_background: false }),
    b.call("Agent", { subagent_type: "fixture-test", prompt: "reply", description: "test B", run_in_background: false }),
  ]);
  assert.match(ra.content[0].text, /RESULT_A/);
  assert.match(rb.content[0].text, /RESULT_B/);
  assert.equal(a.children.length, 1);
  assert.equal(b.children.length, 1);
  assert.equal(a.children[0].session.systemPrompt.includes("ROOT_A_MARK"), true);
  assert.equal(b.children[0].session.systemPrompt.includes("ROOT_B_MARK"), true);
  for (const root of [a, b]) {
    const { session } = root.children[0];
    assert.equal(root.binds.get(session.sessionId), 1);
    const run = getNativeSubagentRun(session.sessionId);
    assert.equal(run.status, "completed");
    const meta = session.sessionManager.getEntries().filter((e) => e.customType === "pi-web:subagent").at(-1).data;
    assert.equal(meta.parentSessionId, root.session.sessionId);
    assert.deepEqual(meta.resourceSnapshot.tools, []);
    assert.equal(meta.resourceSnapshot.loadExtensions, false);
    assert.ok(session.resourceLoader.getExtensions().extensions.some((e) => e.path.includes("automode")), "isolated child retains host safety handlers");
    const original = run.result;
    const result = await root.call("get_subagent_result", { agent_id: root === a ? ra.details.agentId : rb.details.agentId });
    assert.match(result.content[0].text, new RegExp(original));
    assert.equal(getNativeSubagentRun(session.sessionId).result, original);
  }
}));

test("five built-in Desktop presets register and run without personal agent files", async () => fixture(async (dir, roots) => {
  const root = await makeRoot(dir, "PRESETS", roots, { presetModels: true });
  const expected = ["plan", "review", "scout", "test", "work"];
  const originalPromptIdentities = { plan: "planner", review: "reviewer", scout: "scout", test: "tester", work: "worker" };
  const tools = root.loader.getExtensions().extensions.flatMap(e => [...e.tools.values()]);
  const agentTool = tools.find(tool => tool.definition.name === "Agent");
  for (const name of expected) {
    assert.ok(agentTool.definition.description.includes(name), `${name} appears in the runtime tool description`);
    const result = await root.call("Agent", { subagent_type: name, prompt: "Return the local fixture result only.", description: `${name} preset test`, run_in_background: false });
    assert.match(result.content[0].text, /RESULT_A/);
    const child = root.children.at(-1);
    assert.equal(child.info.profile, name);
    assert.ok(child.session.systemPrompt.includes(`（${originalPromptIdentities[name]}）`), `${name} prompt reached the child`);
    assert.equal(child.session.model.provider, "哈尔");
    assert.equal(child.session.model.id, "gpt-6.1-sol");
    const meta = child.session.sessionManager.getEntries().findLast(e => e.customType === "pi-web:subagent").data;
    assert.equal(meta.profile, name);
    assert.equal(meta.runInBackground, false);
    assert.equal(meta.resourceSnapshot.loadSkills, false);
    assert.equal(meta.resourceSnapshot.loadExtensions, false);
    for (const tool of ["read", "grep", "find", "ls", "bash"]) assert.ok(meta.resourceSnapshot.tools.includes(tool));
    assert.equal(meta.resourceSnapshot.tools.includes("edit"), name === "work");
    assert.equal(meta.resourceSnapshot.tools.includes("write"), name === "work");
    assert.equal(getNativeSubagentRun(child.session.sessionId).status, "completed");
  }
  assert.equal(root.children.length, expected.length);
}));

test("native bridge steers and stops the owning live record without falling back to old runtime", async () => fixture(async (dir, roots) => {
  const root = await makeRoot(dir, "A", roots);
  const result = await root.call("Agent", { subagent_type: "fixture-test", prompt: "reply", description: "background test", run_in_background: true });
  const id = result.details.agentId;
  assert.equal(getNativeSubagentRun(id).status, "running");
  steerNativeSubagent(id, "finish now");
  abortNativeSubagent(id);
  assert.equal(getNativeSubagentRun(id).status, "aborted");
  assert.throws(() => steerNativeSubagent("missing", "no"), /not found/);
  await root.call("get_subagent_result", { agent_id: id, wait: true });
}));

test("untrusted project explicit paths never execute their factory", async () => fixture(async (dir) => {
  const evil = join(dir, ".pi", "extensions", "evil.ts");
  await mkdir(join(dir, ".pi", "extensions"), { recursive: true });
  await writeFile(evil, 'throw new Error("UNTRUSTED_FACTORY_EXECUTED");');
  const settingsManager = SettingsManager.inMemory({});
  const options = await filteredSubagentLoaderOptions({ cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, additionalExtensionPaths: [evil] }, settingsManager);
  assert.deepEqual(options.additionalExtensionPaths, []);
  const loader = new DefaultResourceLoader(options);
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
}));

test("root shutdown owns a child still binding and persists its aborted state", async () => fixture(async (dir, roots) => {
  const gate = Promise.withResolvers();
  const announced = Promise.withResolvers();
  const root = await makeRoot(dir, "A", roots, { async bindGate(session) { announced.resolve(session); await gate.promise; } });
  const launch = root.call("Agent", { subagent_type: "fixture-test", prompt: "reply", description: "delayed child", run_in_background: true });
  const child = await announced.promise;
  await root.close();
  assert.equal(root.shutdowns.get(child.sessionId), 1, "pending child closed once");
  const entry = child.sessionManager.getEntries().filter((e) => e.customType === "pi-web:subagent-result").at(-1);
  assert.equal(entry.data.status, "aborted");
  gate.resolve();
  await launch.catch(() => {});
  // The failed setup's second cleanup is idempotent, not a second dispose.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(root.shutdowns.get(child.sessionId), 1);
}));

test("single-file bundles give every root an isolated module graph", async () => {
  const url = new URL("../dist/main/pi-subagents.mjs", import.meta.url);
  const a = await import(`${url.href}?test=${Math.random()}`);
  const b = await import(`${url.href}?test=${Math.random()}`);
  assert.notEqual(a.default, b.default);
  assert.notEqual(a.configureDesktopHost, b.configureDesktopHost);
  const source = await readFile(url, "utf8");
  assert.doesNotMatch(source, /from\s+["']\.\//);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.build.asarUnpack.includes("dist/main/pi-subagents.mjs"), "native bundle lives beside unpacked backend in packaged apps");
});
