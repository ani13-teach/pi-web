import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readSubagentRuntimeSettings: read, writeSubagentRuntimeSettings: write } = await jiti.import("./subagent-runtime-settings.ts");
const { RUNTIME_SETTING_FIELDS: fields, DEFAULT_SUBAGENT_RUNTIME_SETTINGS: defaults } = await jiti.import("./subagent-runtime-schema.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "global");
  await mkdir(cwd);
  const paths = {
    global: join(agentDir, "subagents.json"),
    project: join(cwd, ".pi", "subagents.json"),
    legacy: join(agentDir, "agents", "settings.json"),
  };
  const save = async (scope, value) => {
    await mkdir(dirname(paths[scope]), { recursive: true });
    await writeFile(paths[scope], typeof value === "string" ? value : JSON.stringify(value));
  };
  return { root, cwd, agentDir, paths, save, read: (scope) => read(cwd, scope, agentDir), write: (scope, patch) => write(cwd, scope, patch, agentDir) };
}

const expectedDefaults = {
  maxConcurrent: 10, maxConcurrentForeground: 0, defaultMaxTurns: 0, graceTurns: 5,
  defaultJoinMode: "smart", backgroundByDefault: true, schedulingEnabled: true,
  scopeModels: false, strictAgentFiles: false, disableDefaultAgents: false,
  toolDescriptionMode: "full", rememberAgents: true, outputTranscript: true,
  worktreeIsolation: true, workflowsEnabled: true, maxSubagentDepth: 2,
  fallbackSubagent: "work", reportUsage: false,
};

test("schema is renderer-safe and exposes exactly the 18 requested fields and defaults", async () => {
  const source = await readFile(new URL("./subagent-runtime-schema.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.deepEqual(defaults, expectedDefaults);
  assert.equal(fields.length, 18);
  assert.deepEqual(fields.map((f) => f.key).sort(), Object.keys(expectedDefaults).sort());
  assert.deepEqual(JSON.parse(JSON.stringify(fields)), fields, "metadata is only JSON data");
});

test("missing files return empty layers without creating files or materializing defaults", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.read(), {
    scope: "global", filePath: f.paths.global, values: {}, effective: expectedDefaults, global: {}, project: {},
  });
  assert.deepEqual(f.read("project").values, {});
  assert.equal(f.read("project").filePath, f.paths.project);
  assert.deepEqual(f.write("project", { workflowsEnabled: null }).values, {});
  f.write("global", {});
  assert.deepEqual(await readdir(f.root), ["project"]);
  assert.deepEqual(await readdir(f.cwd), []);
});

test("native project overrides global, then explicit legacy concurrency, then defaults", async (t) => {
  const f = await fixture(t);
  await f.save("legacy", { builtInEnabled: false, maxConcurrent: 23, unknown: "keep" });
  const legacyBefore = await readFile(f.paths.legacy, "utf8");
  assert.equal(f.read().effective.maxConcurrent, 23);
  assert.equal(f.read().legacyMaxConcurrent, 23);
  await f.save("global", { maxConcurrent: 42, graceTurns: 9, fallbackSubagent: false, fleetView: false });
  await f.save("project", { maxConcurrent: 1024, defaultMaxTurns: 0, graceTurns: 3, workflowsEnabled: false });
  let response = f.read("global");
  assert.deepEqual(response.values, { maxConcurrent: 42, graceTurns: 9, fallbackSubagent: "none" });
  assert.equal(response.effective.maxConcurrent, 1024);
  assert.equal(response.effective.graceTurns, 3);
  assert.equal(response.effective.fallbackSubagent, "none");
  assert.equal(response.effective.workflowsEnabled, false);
  response = f.write("project", { maxConcurrent: null, graceTurns: null, workflowsEnabled: null });
  assert.deepEqual(response.values, { defaultMaxTurns: 0 });
  assert.equal(response.effective.maxConcurrent, 42);
  assert.equal(response.effective.graceTurns, 9);
  assert.equal(response.effective.workflowsEnabled, true);
  response = f.write("global", { maxConcurrent: null, fallbackSubagent: null });
  assert.equal(response.effective.maxConcurrent, 23);
  assert.equal(response.effective.fallbackSubagent, "work");
  assert.equal(await readFile(f.paths.legacy, "utf8"), legacyBefore);
});

test("fallback names are normalized just like native parsing", async (t) => {
  const f = await fixture(t);
  await f.save("global", { fallbackSubagent: " none " });
  assert.equal(f.read().effective.fallbackSubagent, "none");
  const changed = f.write("global", { fallbackSubagent: " work " });
  assert.equal(changed.effective.fallbackSubagent, "work");
  assert.equal(JSON.parse(await readFile(f.paths.global, "utf8")).fallbackSubagent, "work");
});

test("only explicit valid legacy numbers participate, and the legacy file is never rewritten", async (t) => {
  const f = await fixture(t);
  for (const maxConcurrent of [undefined, null, 0, -1, 1025, 1.5, "12", true]) {
    await f.save("legacy", { maxConcurrent, builtInEnabled: false });
    const before = await readFile(f.paths.legacy, "utf8");
    const response = f.read();
    assert.equal(response.effective.maxConcurrent, 10);
    assert.equal(Object.hasOwn(response, "legacyMaxConcurrent"), false);
    f.write("project", { defaultJoinMode: "async" });
    assert.equal(await readFile(f.paths.legacy, "utf8"), before);
  }
});

test("patches preserve unknown JSON, CLI-only fields, the other scope and native false spelling", async (t) => {
  const f = await fixture(t);
  const original = JSON.parse('{"fallbackSubagent":false,"fleetView":false,"agentMentions":"direct","widgetMode":"off","custom":{"deep":[null,true,{"a":1}]},"__proto__":{"keep":true},"constructor":{"safe":true}}');
  await f.save("global", original);
  await f.save("project", { graceTurns: 6, extensionSetting: [1, 2] });
  const projectBefore = await readFile(f.paths.project, "utf8");
  const response = f.write("global", { maxConcurrent: 88, rememberAgents: false });
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, "utf8")), { ...original, maxConcurrent: 88, rememberAgents: false });
  assert.equal(response.global.fallbackSubagent, "none");
  assert.equal(response.effective.graceTurns, 6);
  assert.equal(await readFile(f.paths.project, "utf8"), projectBefore);
  assert.deepEqual(await readdir(dirname(f.paths.global)), ["subagents.json"], "atomic writer cleans temporary files");
  const globalBefore = await readFile(f.paths.global, "utf8");
  f.write("global", { maxConcurrent: 88, workflowsEnabled: null });
  assert.equal(await readFile(f.paths.global, "utf8"), globalBefore, "no-op patch retains original bytes");
});

for (const field of fields) {
  test(`${field.key} enforces type/range and allows null to inherit`, async (t) => {
    const f = await fixture(t);
    const valid = field.type === "number" ? [field.min, field.max]
      : field.type === "boolean" ? [true, false]
        : field.type === "select" ? field.options : ["work", "none", "custom-agent"];
    for (const value of valid) {
      assert.equal(f.write("project", { [field.key]: value }).values[field.key], value);
    }
    const invalid = field.type === "number"
      ? [field.min - 1, field.max + 1, 1.5, NaN, Infinity, "2", true, undefined, {}, []]
      : field.type === "boolean" ? ["true", 0, 1, undefined, {}, []]
        : field.type === "select" ? ["invalid", "", false, 1, undefined, {}, []]
          : ["", " \t\n", false, true, 1, undefined, {}, []];
    const before = await readFile(f.paths.project, "utf8");
    for (const value of invalid) {
      assert.throws(() => f.write("project", { [field.key]: value }), new RegExp(field.key));
      assert.equal(await readFile(f.paths.project, "utf8"), before);
    }
    const response = f.write("project", { [field.key]: null });
    assert.deepEqual(response.values, {});
    assert.equal(response.effective[field.key], expectedDefaults[field.key]);
    assert.deepEqual(JSON.parse(await readFile(f.paths.project, "utf8")), {});
  });
}

test("unknown patch fields, arrays, null, invalid scope and cwd are rejected before writes", async (t) => {
  const f = await fixture(t);
  for (const patch of [[], null, "bad", { fleetView: true }, { maxConcurrent: 3, typo: null }, JSON.parse('{"__proto__":null}')]) {
    assert.throws(() => f.write("global", patch), /patch must be|Unknown runtime/);
  }
  assert.throws(() => f.read("builtin"), /scope/);
  assert.throws(() => f.write("invalid", {}), /scope/);
  assert.throws(() => read("relative", "global", f.agentDir), /absolute cwd/);
  assert.deepEqual(await readdir(f.root), ["project"]);
});

test("malformed files and invalid native known values fail without overwriting either layer", async (t) => {
  const f = await fixture(t);
  await f.save("global", { graceTurns: 7 });
  for (const scope of ["project", "legacy"]) {
    for (const contents of ["{bad", "[]", "null", "42", '"text"']) {
      await f.save(scope, contents);
      const otherBefore = await readFile(f.paths.global, "utf8");
      assert.throws(() => f.read(), /Invalid JSON|expected a JSON object/);
      assert.throws(() => f.write("global", { graceTurns: 8 }), /Invalid JSON|expected a JSON object/);
      assert.equal(await readFile(f.paths[scope], "utf8"), contents);
      assert.equal(await readFile(f.paths.global, "utf8"), otherBefore);
    }
    await rm(f.paths[scope]);
  }
  for (const field of fields) {
    await f.save("project", { [field.key]: null });
    const before = await readFile(f.paths.project, "utf8");
    assert.throws(() => f.read(), /Invalid settings/);
    assert.throws(() => f.write("project", { [field.key]: null }), /Invalid settings/);
    assert.equal(await readFile(f.paths.project, "utf8"), before);
  }
  await rm(f.paths.project);
  await f.save("global", "{");
  assert.throws(() => f.write("global", { maxConcurrent: 1 }), /Invalid JSON/);
  assert.equal(await readFile(f.paths.global, "utf8"), "{");
});

test("project configuration cannot escape cwd through a linked .pi directory", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "subagents.json"), '{"graceTurns":8}');
  await symlink(outside, join(f.cwd, ".pi"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.read(), /Access denied/);
  assert.throws(() => f.write("project", { graceTurns: 10 }), /Access denied/);
  assert.equal(await readFile(join(outside, "subagents.json"), "utf8"), '{"graceTurns":8}');
});
