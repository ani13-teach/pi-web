import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { DefaultResourceLoader, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { filteredSubagentLoaderOptions } = await jiti.import("./extension-loader-options.ts");
const { FilteredResourceLoader } = await jiti.import("./filtered-resource-loader.ts");

async function fixture(t, globalSettings = {}, projectSettings) {
  const root = await mkdtemp(join(tmpdir(), "pi-filtered-extensions-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(globalSettings));
  if (projectSettings) {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(projectSettings));
  }
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const options = { cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir), noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true };
  return { cwd, agentDir, options };
}

function builtin(name, calls = []) {
  return { name, builtin: true, replaceable: true, factory(pi) {
    calls.push(name);
    pi.registerCommand(name, { handler: async () => {} });
  } };
}

async function load(options) {
  const filtered = await filteredSubagentLoaderOptions(options, options.settingsManager);
  const loader = new DefaultResourceLoader(filtered);
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  return { filtered, loader };
}

test("the desktop filter discovers every registered builtin, not just codemode, without executing factories", async (t) => {
  const { options } = await fixture(t);
  const calls = [];
  options.extensionFactories = [builtin("fixture-one", calls), builtin("fixture-two", calls)];
  const filtered = await filteredSubagentLoaderOptions(options, options.settingsManager);
  assert.equal(filtered.noExtensions, true);
  assert.deepEqual(filtered.additionalExtensionPaths, ["builtin:fixture-one", "builtin:fixture-two"]);
  assert.deepEqual(calls, []);
  const loader = new DefaultResourceLoader(filtered);
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(calls, ["fixture-one", "fixture-two"]);
});

test("global builtin exclusions survive conversion to explicit SDK paths", async (t) => {
  const { options } = await fixture(t, { extensions: ["-builtin:fixture-one"] });
  options.extensionFactories = [builtin("fixture-one"), builtin("fixture-two")];
  const { filtered } = await load(options);
  assert.deepEqual(filtered.additionalExtensionPaths, ["builtin:fixture-two"]);
});

test("untrusted project settings cannot override global builtin exclusions", async (t) => {
  const { options } = await fixture(t, { extensions: ["-builtin:fixture-one"] }, { extensions: ["+builtin:fixture-one"] });
  // A stale/optimistic trust state must not leak project settings into discovery.
  options.settingsManager.setProjectTrusted(true);
  options.extensionFactories = [builtin("fixture-one")];
  const { filtered } = await load(options);
  assert.equal(options.settingsManager.isProjectTrusted(), false);
  assert.deepEqual(filtered.additionalExtensionPaths, []);
});

test("trusted project builtin enable/disable overrides use SDK precedence", async (t) => {
  const { cwd, agentDir, options } = await fixture(t, { extensions: ["-builtin:fixture-one"] },
    { extensions: ["+builtin:fixture-one", "-builtin:fixture-two"] });
  new ProjectTrustStore(agentDir).set(cwd, true);
  options.extensionFactories = [builtin("fixture-one"), builtin("fixture-two")];
  const { filtered } = await load(options);
  assert.deepEqual(filtered.additionalExtensionPaths, ["builtin:fixture-one"]);
});

test("untrusted project builtin exclusions do not suppress a host builtin", async (t) => {
  const { options } = await fixture(t, {}, { extensions: ["-builtin:fixture-one"] });
  options.extensionFactories = [builtin("fixture-one")];
  const { filtered } = await load(options);
  assert.deepEqual(filtered.additionalExtensionPaths, ["builtin:fixture-one"]);
});

test("caller noExtensions disables discovered builtins but keeps ordinary inline factories", async (t) => {
  const { options } = await fixture(t);
  const calls = [];
  options.noExtensions = true;
  options.extensionFactories = [builtin("fixture-one", calls), () => calls.push("inline")];
  const { filtered } = await load(options);
  assert.deepEqual(filtered.additionalExtensionPaths, []);
  assert.deepEqual(calls, ["inline"]);
});

test("explicit builtin IDs bypass disk trust checks, override settings exclusions, and deduplicate", async (t) => {
  const { options } = await fixture(t, { extensions: ["-builtin:fixture-one"] }, {});
  const calls = [];
  options.noExtensions = true;
  options.additionalExtensionPaths = ["builtin:fixture-one", "builtin:fixture-one"];
  options.extensionFactories = [builtin("fixture-one", calls)];
  const { filtered } = await load(options);
  assert.deepEqual(filtered.additionalExtensionPaths, ["builtin:fixture-one"]);
  assert.deepEqual(calls, ["fixture-one"]);
});

test("hard-disabled builtin names stay disabled even when explicitly requested", async (t) => {
  const { options } = await fixture(t);
  options.additionalExtensionPaths = ["builtin:fixture-one"];
  options.disabledBuiltinExtensions = ["fixture-one"];
  options.extensionFactories = [builtin("fixture-one")];
  const { filtered } = await load(options);
  assert.deepEqual(filtered.additionalExtensionPaths, []);
});

test("dynamic reload applies trust grants and revocations before importing project code", async (t) => {
  const { cwd, agentDir, options } = await fixture(t);
  const path = join(cwd, ".pi", "extensions", "project.js");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(path, 'export default function(pi) { pi.registerCommand("project-command", { handler: async () => {} }); }');
  options.extensionFactories = [builtin("fixture-one")];
  const loader = new FilteredResourceLoader(options);
  const hasProject = () => loader.getExtensions().extensions.some((extension) => extension.commands.has("project-command"));
  await loader.reload();
  assert.equal(hasProject(), false);
  const trust = new ProjectTrustStore(agentDir);
  trust.set(cwd, true);
  await loader.reload();
  assert.equal(hasProject(), true);
  trust.set(cwd, false);
  await writeFile(path, 'throw new Error("REVOKED_PROJECT_FACTORY_EXECUTED")');
  await loader.reload();
  assert.equal(hasProject(), false);
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.ok(loader.getExtensions().extensions.some((extension) => extension.path === "builtin:fixture-one"));
});

test("dynamic filtering does not mutate the caller's original explicit list", async (t) => {
  const { options } = await fixture(t);
  const explicit = ["builtin:fixture-one"];
  options.additionalExtensionPaths = explicit;
  options.extensionFactories = [builtin("fixture-one"), builtin("fixture-two")];
  const loader = new FilteredResourceLoader(options);
  await loader.reload();
  await loader.reload();
  assert.deepEqual(explicit, ["builtin:fixture-one"]);
  assert.equal(loader.getExtensions().extensions.length, 2);
});

test("untrusted project files and duplicate subagent packages remain filtered alongside builtins", async (t) => {
  const { cwd, agentDir, options } = await fixture(t);
  const evil = join(cwd, ".pi", "extensions", "evil.ts");
  const duplicate = join(agentDir, "extensions", "pi-subagents", "index.ts");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await mkdir(join(agentDir, "extensions", "pi-subagents"), { recursive: true });
  await writeFile(evil, 'throw new Error("UNTRUSTED_FACTORY_EXECUTED")');
  await writeFile(duplicate, 'throw new Error("DUPLICATE_FACTORY_EXECUTED")');
  options.additionalExtensionPaths = [evil];
  options.extensionFactories = [builtin("fixture-one")];
  const { filtered } = await load(options);
  assert.deepEqual(filtered.additionalExtensionPaths, ["builtin:fixture-one"]);
});
