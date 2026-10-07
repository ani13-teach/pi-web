import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-global-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  // Use the same next/server implementation as the Desktop backend bundle.
  alias: { "next/server": join(process.cwd(), "desktop", "shims", "next-server.ts"), "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT, PATCH, DELETE } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const { loadCustomAgents } = await jiti.import("../../../../builtin/pi-subagents/src/custom-agents.ts");
const { builtinDeletionPath } = await jiti.import("../../../../builtin/pi-subagents/src/builtin-agents.ts");
const { resolveSubagentProfile } = await jiti.import("../../../../lib/subagents.ts");
const { buildAgentRegistry } = await jiti.import("../../../../builtin/pi-subagents/src/agent-types.ts");
const { loadBuiltinAgents } = await jiti.import("../../../../builtin/pi-subagents/src/builtin-agents.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(join(testAgentDir, "agents"), { recursive: true, force: true });
  await rm(join(testAgentDir, "desktop-agents"), { recursive: true, force: true });
});

function profile(overrides = {}) {
  return {
    name: "api-test-agent",
    displayName: "API test agent",
    description: "Used by route tests",
    systemPrompt: "Return a concise result.",
    tools: [],
    loadSkills: true,
    loadExtensions: true,
    inheritContext: false,
    runInBackground: true,
    enabled: true,
    ...overrides,
  };
}

function jsonRequest(method, body) {
  return new Request("http://localhost/api/subagents/profiles", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("profiles route creates, lists, and deletes a project profile", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const putResponse = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile() }));
  const putBody = await putResponse.json();
  assert.equal(putResponse.status, 200);
  assert.equal(putBody.profile.scope, "project");
  assert.deepEqual(putBody.profile.tools, []);
  assert.equal(putBody.profile.loadSkills, true);
  assert.equal(putBody.profile.loadExtensions, true);
  const source = await readFile(join(cwd, ".pi", "agents", "api-test-agent.md"), "utf8");
  assert.match(source, /tools: none/);
  assert.match(source, /load_skills: true/);
  assert.match(source, /load_extensions: true/);

  const getResponse = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const getBody = await getResponse.json();
  assert.equal(getResponse.status, 200);
  const listedProfile = getBody.profiles.find((item) => item.name === "api-test-agent");
  assert.deepEqual(listedProfile.tools, []);
  assert.equal(listedProfile.loadSkills, true);
  assert.equal(listedProfile.loadExtensions, true);

  const deleteResponse = await DELETE(jsonRequest("DELETE", { cwd, scope: "project", name: "api-test-agent" }));
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { ok: true });

  const afterDelete = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const afterDeleteBody = await afterDelete.json();
  assert.equal(afterDeleteBody.profiles.some((item) => item.name === "api-test-agent"), false);
});

test("profiles route keeps same-name global and project profiles independently editable", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));

  let response = await PUT(jsonRequest("PUT", {
    cwd,
    scope: "global",
    profile: profile({ description: "Global profile" }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.scope, "global");
  assert.match(await readFile(join(testAgentDir, "agents", "api-test-agent.md"), "utf8"), /Global profile/);

  response = await PUT(jsonRequest("PUT", {
    cwd,
    scope: "project",
    profile: profile({ description: "Project profile" }),
  }));
  assert.equal(response.status, 200);

  response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const sources = (await response.json()).profiles
    .filter((item) => item.name === "api-test-agent")
    .sort((a, b) => a.scope.localeCompare(b.scope));
  assert.deepEqual(sources.map((item) => item.scope), ["global", "project"]);
  assert.deepEqual(sources.map((item) => item.description), ["Global profile", "Project profile"]);

  response = await PATCH(jsonRequest("PATCH", {
    cwd,
    scope: "global",
    name: "api-test-agent",
    enabled: false,
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.enabled, false);
  response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const toggledSources = (await response.json()).profiles.filter((item) => item.name === "api-test-agent");
  assert.equal(toggledSources.find((item) => item.scope === "global").enabled, false);
  assert.equal(toggledSources.find((item) => item.scope === "global").description, "Global profile");
  assert.equal(toggledSources.find((item) => item.scope === "global").loadSkills, true);
  assert.equal(toggledSources.find((item) => item.scope === "global").loadExtensions, true);
  assert.equal(toggledSources.find((item) => item.scope === "project").enabled, true);

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "project", name: "api-test-agent" }));
  assert.equal(response.status, 200);
  response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  assert.deepEqual(
    (await response.json()).profiles.filter((item) => item.name === "api-test-agent").map((item) => item.scope),
    ["global"],
  );

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "global", name: "api-test-agent" }));
  assert.equal(response.status, 200);
});

test("profiles API lists, updates, toggles and clears the fallback picker value", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-fallback-route-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const scope = "project";
  const configured = profile({ fallbackModel: "backup/model" });
  let response = await PUT(jsonRequest("PUT", { cwd, scope, profile: configured }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.fallbackModel, "backup/model");
  response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profiles.find((p) => p.name === configured.name).fallbackModel, "backup/model");
  response = await PATCH(jsonRequest("PATCH", { cwd, scope, name: configured.name, enabled: false }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.fallbackModel, "backup/model");
  response = await PUT(jsonRequest("PUT", { cwd, scope, profile: { ...configured, fallbackModel: "other/backup" } }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.fallbackModel, "other/backup");
  response = await PUT(jsonRequest("PUT", { cwd, scope, profile: { ...configured, fallbackModel: "" } }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.fallbackModel, undefined);
  assert.doesNotMatch(await readFile(join(cwd, ".pi", "agents", `${configured.name}.md`), "utf8"), /fallback_model:/);
});

test("all five built-in agents use writable CRUD files with native precedence in all three scopes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-builtin-agent-route-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const listed = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  assert.equal(listed.status, 200);
  const defaults = (await listed.json()).profiles.filter((p) => p.scope === "builtin");
  assert.deepEqual(defaults.map((p) => p.name).sort(), ["plan", "review", "scout", "test", "work"].sort());
  for (const scope of ["builtin", "global", "project"]) {
    for (const builtin of defaults) {
      const configured = {
        ...builtin, model: "relay/primary", fallbackModel: "relay/backup", thinking: "high",
        systemPrompt: `Custom prompt for ${builtin.name}`, tools: ["read", "edit", "write"],
        loadSkills: false, loadExtensions: false, maxTurns: 7, inheritContext: true,
        runInBackground: false, color: "blue", isolation: "off", persistSession: false,
      };
      const { scope: ignored, ...draft } = configured;
      let response = await PUT(jsonRequest("PUT", { cwd, scope, profile: draft }));
      assert.equal(response.status, 200);
      const saved = (await response.json()).profile;
      assert.equal(saved.name, builtin.name);
      assert.equal(saved.scope, scope);
      assert.equal(saved.filePath, scope === "builtin" ? join(testAgentDir, "desktop-agents", `${builtin.name}.md`) : join(scope === "global" ? testAgentDir : join(cwd, ".pi"), "agents", `${builtin.name}.md`));
      const text = await readFile(saved.filePath, "utf8");
      assert.match(text, /model: relay\/primary/);
      // Unmanaged native frontmatter is preserved by the same writer.
      await writeFile(saved.filePath, text.replace("---\n", "---\nallowed_subagents: none\n"));
      for (const enabled of [false, true]) {
        response = await PATCH(jsonRequest("PATCH", { cwd, scope, name: builtin.name, enabled }));
        assert.equal(response.status, 200);
        const toggled = (await response.json()).profile;
        for (const key of ["model", "fallbackModel", "thinking", "systemPrompt", "promptMode", "tools", "loadSkills", "loadExtensions", "maxTurns", "inheritContext", "runInBackground", "color", "isolation", "persistSession"]) {
          assert.deepEqual(toggled[key], saved[key], `${builtin.name}: ${key}`);
        }
        assert.equal(toggled.enabled, enabled);
        const registry = buildAgentRegistry(loadCustomAgents(cwd));
        const native = scope === "builtin" ? registry.get(builtin.name) : loadCustomAgents(cwd).get(builtin.name);
        assert.equal(native.sourcePath, saved.filePath);
        assert.equal(native.model, saved.model);
        assert.equal(native.fallbackModel, saved.fallbackModel);
        assert.equal(native.systemPrompt, saved.systemPrompt);
        assert.equal(native.promptMode, saved.promptMode);
        assert.deepEqual(native.builtinToolNames, saved.tools);
        assert.equal(native.skills, false);
        assert.equal(native.extensions, false);
        assert.equal(native.enabled, enabled);
        assert.equal(native.thinking, saved.thinking);
        assert.equal(native.maxTurns, saved.maxTurns);
        assert.equal(native.inheritContext, saved.inheritContext);
        assert.equal(native.runInBackground, saved.runInBackground);
        assert.equal(native.color, "blue");
        assert.equal(native.isolation, "off");
        assert.equal(native.persistSession, false);
        assert.equal(resolveSubagentProfile(cwd, builtin.name)?.name, scope === "builtin" && !enabled ? undefined : builtin.name);
        assert.equal(registry.get(builtin.name).model, scope === "builtin" ? saved.model : builtin.model);
        assert.equal(registry.get(builtin.name).enabled, scope === "builtin" ? enabled : true);
        assert.match(await readFile(saved.filePath, "utf8"), /allowed_subagents: none/);
      }
      response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
      assert.equal(response.status, 200);
      const sources = (await response.json()).profiles.filter((p) => p.name === builtin.name);
      assert.deepEqual(sources.map((p) => p.scope), scope === "builtin" ? ["builtin"] : [scope, "builtin"]);
      assert.equal(sources[0].systemPrompt, saved.systemPrompt);
      assert.equal(sources[0].model, saved.model);
      if (scope !== "builtin") assert.equal(sources[1].systemPrompt, builtin.systemPrompt);
      response = await DELETE(jsonRequest("DELETE", { cwd, scope, name: builtin.name }));
      assert.equal(response.status, 200);
      assert.equal(loadCustomAgents(cwd).has(builtin.name), false);
      if (scope === "builtin") {
        assert.equal(loadBuiltinAgents().has(builtin.name), false);
        assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).has(builtin.name), false);
        assert.equal(resolveSubagentProfile(cwd, builtin.name), undefined);
        await assert.rejects(readFile(saved.filePath), { code: "ENOENT" });
        assert.equal(await readFile(builtinDeletionPath(builtin.name), "utf8"), "deleted\n");
        await rm(builtinDeletionPath(builtin.name));
      }
      const restored = resolveSubagentProfile(cwd, builtin.name);
      assert.equal(restored.scope, "builtin");
      assert.equal(restored.systemPrompt, builtin.systemPrompt);
      assert.equal(restored.model, builtin.model);
    }
  }
});

test("profiles route rejects missing paths, malformed profiles, and unsafe names", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));

  let response = await GET(new Request("http://localhost/api/subagents/profiles"));
  assert.equal(response.status, 400);

  response = await PUT(jsonRequest("PUT", { cwd, scope: "project" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "profile required" });

  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ name: "../escape" }) }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Agent name may contain only/);

  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ thinking: "extreme" }) }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Invalid thinking level/);

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "project" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "name required" });

  response = await PUT(jsonRequest("PUT", { cwd, scope: "workspace", profile: profile() }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be builtin, global or project" });

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "workspace", name: "plan" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be builtin, global or project" });

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "project", name: "missing", enabled: false }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Agent profile not found" });

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "project", name: "api-test-agent" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "enabled required" });

  for (const [field, value, error] of [["originalName", 42, "originalName must be a string"], ["createOnly", "true", "createOnly must be a boolean"]]) {
    response = await PUT(jsonRequest("PUT", { cwd, scope: "builtin", profile: profile(), [field]: value }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
  }
  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "builtin", name: "plan", filePath: 42 }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "filePath must be a string" });
});

for (const scope of ["builtin", "global", "project"]) {
  test(`profiles API ${scope} rename keeps settings, unknown metadata and the native registry in sync`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-route-rename-"));
    allowFileRoot(cwd);
    t.after(() => rm(cwd, { recursive: true, force: true }));
    let response = await PUT(jsonRequest("PUT", { cwd, scope, createOnly: true, profile: profile({
      model: "relay/primary", fallbackModel: "relay/backup", thinking: "high", maxTurns: 7,
      promptMode: "append", tools: ["read", "edit", "write"], color: "cyan", isolation: "off", persistSession: false,
    }) }));
    assert.equal(response.status, 200);
    const original = (await response.json()).profile;
    const text = await readFile(original.filePath, "utf8");
    await writeFile(original.filePath, text.replace("---\n", "---\nallowed_subagents: plan, review\ncustom_metadata:\n  owner: API\n"));
    response = await PUT(jsonRequest("PUT", { cwd, scope, originalName: original.name, profile: { ...original, name: "renamed-agent" } }));
    assert.equal(response.status, 200);
    const renamed = (await response.json()).profile;
    assert.equal(renamed.name, "renamed-agent");
    assert.equal(renamed.scope, scope);
    for (const key of ["displayName", "description", "systemPrompt", "tools", "model", "fallbackModel", "thinking", "maxTurns", "promptMode", "loadSkills", "loadExtensions", "inheritContext", "runInBackground", "enabled", "color", "isolation", "persistSession"]) {
      assert.deepEqual(renamed[key], original[key], `${scope}: ${key}`);
    }
    await assert.rejects(readFile(original.filePath), { code: "ENOENT" });
    const updated = await readFile(renamed.filePath, "utf8");
    assert.match(updated, /^name: renamed-agent$/m);
    assert.match(updated, /allowed_subagents: plan, review/);
    assert.match(updated, /custom_metadata:\n  owner: API/);
    const registry = buildAgentRegistry(loadCustomAgents(cwd));
    assert.equal(registry.has(original.name), false);
    const raw = registry.get(renamed.name);
    assert.equal(raw.sourcePath, renamed.filePath);
    assert.equal(raw.model, renamed.model);
    assert.equal(raw.fallbackModel, renamed.fallbackModel);
    assert.equal(raw.systemPrompt, renamed.systemPrompt);
    assert.equal(raw.promptMode, renamed.promptMode);
    assert.deepEqual(raw.builtinToolNames, renamed.tools);
    assert.equal(raw.skills, renamed.loadSkills);
    assert.equal(raw.extensions, renamed.loadExtensions);
    assert.equal(raw.enabled, renamed.enabled);
    assert.equal(raw.thinking, renamed.thinking);
    assert.equal(raw.maxTurns, renamed.maxTurns);
    assert.equal(raw.inheritContext, renamed.inheritContext);
    assert.equal(raw.runInBackground, renamed.runInBackground);
    assert.equal(raw.color, renamed.color);
    assert.equal(raw.isolation, renamed.isolation);
    assert.equal(raw.persistSession, renamed.persistSession);
    response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
    assert.equal(response.status, 200);
    const listed = (await response.json()).profiles;
    assert.equal(listed.some(p => p.name === original.name), false);
    assert.deepEqual(listed.find(p => p.name === renamed.name && p.scope === scope), renamed);
    response = await DELETE(jsonRequest("DELETE", { cwd, scope, name: renamed.name, filePath: renamed.filePath }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).has(renamed.name), false);
    await assert.rejects(readFile(renamed.filePath), { code: "ENOENT" });
  });

  test(`profiles API ${scope} rejects unsafe rename, collisions and mismatched sources without overwriting`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-route-errors-"));
    allowFileRoot(cwd);
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const create = async (name) => {
      const response = await PUT(jsonRequest("PUT", { cwd, scope, profile: profile({ name }) }));
      assert.equal(response.status, 200);
      return (await response.json()).profile;
    };
    const original = await create("original");
    const occupied = await create("occupied");
    const before = await readFile(original.filePath, "utf8");
    const occupiedBefore = await readFile(occupied.filePath, "utf8");
    const dir = scope === "builtin" ? join(testAgentDir, "desktop-agents") : scope === "global" ? join(testAgentDir, "agents") : join(cwd, ".pi", "agents");
    const destination = join(dir, "destination.md");
    const foreign = "---\nname: foreign\n---\nKeep this source.\n";
    await writeFile(destination, foreign);
    for (const [draft, options, error] of [
      [{ ...original, name: "../escape" }, { originalName: original.name }, /Agent name may contain only/],
      [{ ...original, name: "new" }, { originalName: "../escape" }, /Agent name may contain only/],
      [{ ...original, name: occupied.name }, { originalName: original.name }, /already exists in this scope/],
      [{ ...original, name: "new", filePath: occupied.filePath }, { originalName: original.name }, /does not match its declared name/],
      [{ ...original, name: "destination" }, { originalName: original.name }, /destination file already exists/],
      [{ ...original, name: "new" }, { originalName: "missing" }, /profile not found/],
      [original, { createOnly: true }, /already exists in this scope/],
      [profile({ name: "destination" }), { createOnly: true }, /destination file already exists/],
    ]) {
      const response = await PUT(jsonRequest("PUT", { cwd, scope, profile: draft, ...options }));
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, error);
      assert.equal(await readFile(original.filePath, "utf8"), before);
      assert.equal(await readFile(occupied.filePath, "utf8"), occupiedBefore);
      assert.equal(await readFile(destination, "utf8"), foreign);
      await assert.rejects(readFile(join(dir, "new.md")), { code: "ENOENT" });
    }
    const response = await DELETE(jsonRequest("DELETE", { cwd, scope, name: original.name, filePath: occupied.filePath }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /does not match its declared name/);
    assert.equal(await readFile(original.filePath, "utf8"), before);
    assert.equal(await readFile(occupied.filePath, "utf8"), occupiedBefore);
  });
}

test("builtin API deletion is persistent, exposes user sources and createOnly explicitly recreates presets", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-route-preset-delete-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const builtin = resolveSubagentProfile(cwd, "work");
  for (const scope of ["global", "project"]) {
    const response = await PUT(jsonRequest("PUT", { cwd, scope, profile: { ...builtin, model: `${scope}/model` } }));
    assert.equal(response.status, 200);
  }
  assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get("work").model, builtin.model);
  let response = await DELETE(jsonRequest("DELETE", { cwd, scope: "builtin", name: "work" }));
  assert.equal(response.status, 200);
  for (let reload = 0; reload < 2; reload++) {
    response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).profiles.filter(p => p.name === "work").map(p => p.scope), ["global", "project"]);
    assert.equal(loadBuiltinAgents().has("work"), false);
    assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get("work").model, "project/model");
    assert.equal(resolveSubagentProfile(cwd, "work").scope, "project");
  }
  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "project", name: "work" }));
  assert.equal(response.status, 200);
  assert.equal(resolveSubagentProfile(cwd, "work").model, "global/model");
  response = await PUT(jsonRequest("PUT", { cwd, scope: "builtin", createOnly: true, profile: { ...builtin, model: "builtin/recreated" } }));
  assert.equal(response.status, 200);
  const recreated = (await response.json()).profile;
  assert.equal(loadBuiltinAgents().get("work").model, "builtin/recreated");
  assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get("work").sourcePath, recreated.filePath);
  await assert.rejects(readFile(builtinDeletionPath("work")), { code: "ENOENT" });
  const before = await readFile(recreated.filePath, "utf8");
  response = await PUT(jsonRequest("PUT", { cwd, scope: "builtin", createOnly: true, profile: { ...recreated, model: "bad/overwrite" } }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /already exists in this scope/);
  assert.equal(await readFile(recreated.filePath, "utf8"), before);
  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "builtin", name: "work", filePath: recreated.filePath }));
  assert.equal(response.status, 200);
  await assert.rejects(readFile(recreated.filePath), { code: "ENOENT" });
  assert.equal(loadBuiltinAgents().has("work"), false);
  assert.equal(resolveSubagentProfile(cwd, "work").model, "global/model");
});

test("builtin API renames embedded presets without reviving their old ID and refuses createOnly over existing presets", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-route-preset-rename-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const preset = resolveSubagentProfile(cwd, "review");
  let response = await PUT(jsonRequest("PUT", { cwd, scope: "builtin", createOnly: true, profile: { ...preset, model: "bad/overwrite" } }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /already exists in this scope/);
  assert.deepEqual(resolveSubagentProfile(cwd, "review"), preset);
  response = await PUT(jsonRequest("PUT", { cwd, scope: "builtin", originalName: "review", profile: { ...preset, name: "custom-review" } }));
  assert.equal(response.status, 200);
  const renamed = (await response.json()).profile;
  assert.equal(renamed.filePath, join(testAgentDir, "desktop-agents", "custom-review.md"));
  assert.equal(renamed.systemPrompt, preset.systemPrompt);
  assert.equal(resolveSubagentProfile(cwd, "review"), undefined);
  assert.equal(loadBuiltinAgents().has("review"), false);
  assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).has("review"), false);
  assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get("custom-review").sourcePath, renamed.filePath);
  assert.equal(await readFile(builtinDeletionPath("review"), "utf8"), "deleted\n");
  response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  assert.equal(response.status, 200);
  const listed = (await response.json()).profiles;
  assert.equal(listed.some(p => p.name === "review" && p.scope === "builtin"), false);
  assert.deepEqual(listed.find(p => p.name === "custom-review"), renamed);
  const before = await readFile(renamed.filePath, "utf8");
  response = await PUT(jsonRequest("PUT", { cwd, scope: "builtin", originalName: "review", profile: { ...preset, name: "other-review" } }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /profile not found/);
  assert.equal(await readFile(renamed.filePath, "utf8"), before);
  await assert.rejects(readFile(join(testAgentDir, "desktop-agents", "other-review.md")), { code: "ENOENT" });
});

test("profiles DELETE filePath selects only one colliding declared source", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-route-source-delete-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = join(cwd, ".pi", "agents");
  await mkdir(dir, { recursive: true });
  for (const filename of ["a.md", "z.md"]) await writeFile(join(dir, filename), `---\nname: collision\n---\n${filename}\n`);
  let response = await DELETE(jsonRequest("DELETE", { cwd, scope: "project", name: "collision" }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /multiple source files/);
  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "project", name: "collision", filePath: join(dir, "a.md") }));
  assert.equal(response.status, 200);
  await assert.rejects(readFile(join(dir, "a.md")), { code: "ENOENT" });
  assert.match(await readFile(join(dir, "z.md"), "utf8"), /z\.md/);
  assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get("collision").sourcePath, join(dir, "z.md"));
});
