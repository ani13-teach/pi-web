import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagents-global-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const {
  deleteSubagentProfile,
  deleteProjectSubagentProfile,
  listSubagentProfileSources,
  listSubagentProfiles,
  readSubagentRun,
  readSubagentSessionResources,
  resolveSubagentProfile,
  saveSubagentProfile,
  saveProjectSubagentProfile,
  SUBAGENT_META_TYPE,
  SUBAGENT_STATUS_TYPE,
  SUBAGENT_RESULT_TYPE,
  withSubagentExtensionTools,
  selectSubagentExtensionTools,
} = await createJiti(import.meta.url).import("./subagents.ts");
const native = createJiti(import.meta.url);
const { DEFAULT_AGENTS } = await native.import("../builtin/pi-subagents/src/default-agents.ts");
const { builtinDeletionPath, loadBuiltinAgents } = await native.import("../builtin/pi-subagents/src/builtin-agents.ts");
const { loadCustomAgents } = await native.import("../builtin/pi-subagents/src/custom-agents.ts");
const { resolveEnabledTypeIn, resolveSpawnTypeIn, setFallbackSubagent, buildAgentRegistry, setDefaultsDisabled } = await native.import("../builtin/pi-subagents/src/agent-types.ts");
const { DEFAULT_AGENT_NAMES } = await native.import("../builtin/pi-subagents/src/types.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

afterEach(async () => {
  setDefaultsDisabled(false);
  setFallbackSubagent(undefined);
  await rm(join(testAgentDir, "agents"), { recursive: true, force: true });
  await rm(join(testAgentDir, "desktop-agents"), { recursive: true, force: true });
});

function profile(overrides = {}) {
  return {
    name: "test-agent",
    displayName: " Test agent ",
    description: " Test description ",
    systemPrompt: " Test prompt. ",
    tools: ["read", "read", "unknown-tool"],
    loadSkills: false,
    loadExtensions: false,
    model: " provider/model ",
    thinking: "high",
    maxTurns: 4.9,
    inheritContext: false,
    runInBackground: false,
    enabled: true,
    ...overrides,
  };
}

test("fallback model round-trips, changes and clears in all writable scopes and native config", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-fallback-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const scope of ["builtin", "global", "project"]) {
    const name = `fallback-${scope}`;
    const saved = saveSubagentProfile(cwd, scope, profile({ name, fallbackModel: " backup-provider/models/backup " }));
    assert.equal(saved.fallbackModel, "backup-provider/models/backup");
    assert.equal(listSubagentProfileSources(cwd).find((p) => p.name === name).fallbackModel, saved.fallbackModel);
    assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get(name).fallbackModel, saved.fallbackModel);
    assert.match(await readFile(saved.filePath, "utf8"), /fallback_model: backup-provider\/models\/backup/);
    // Older API clients and PATCH toggles must not erase the setting.
    const { fallbackModel, ...legacy } = saved;
    const preserved = saveSubagentProfile(cwd, scope, { ...legacy, enabled: false });
    assert.equal(preserved.fallbackModel, saved.fallbackModel);
    const changed = saveSubagentProfile(cwd, scope, { ...preserved, fallbackModel: "other/replacement" });
    assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get(name).fallbackModel, "other/replacement");
    const cleared = saveSubagentProfile(cwd, scope, { ...changed, fallbackModel: " " });
    assert.equal(cleared.fallbackModel, undefined);
    assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get(name).fallbackModel, undefined);
    assert.doesNotMatch(await readFile(saved.filePath, "utf8"), /fallback_model:/);
    deleteSubagentProfile(cwd, scope, name);
  }
});

test("invalid fallback model values are rejected without overwriting the profile", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-fallback-invalid-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const saved = saveSubagentProfile(cwd, "project", profile({ fallbackModel: "backup/model" }));
  const before = await readFile(saved.filePath, "utf8");
  for (const value of [null, 42, ["backup/model"], {}]) {
    assert.throws(() => saveSubagentProfile(cwd, "project", { ...saved, fallbackModel: value }), /Fallback model must be a string/);
  }
  assert.equal(await readFile(saved.filePath, "utf8"), before);
});

test("built-ins preserve native identities, prompts, models and resource defaults", () => {
  const profiles = listSubagentProfiles(testAgentDir);
  assert.deepEqual(profiles.filter((item) => item.scope === "builtin").map((item) => item.name).sort(),
    ["plan", "review", "scout", "test", "work"].sort());
  for (const [name, config] of DEFAULT_AGENTS) {
    const builtin = profiles.find((item) => item.name === name);
    assert.equal(builtin.systemPrompt, config.systemPrompt);
    assert.equal(builtin.description, config.description);
    assert.equal(builtin.displayName, config.displayName);
    assert.equal(builtin.model, config.model);
    assert.equal(builtin.promptMode, config.promptMode);
    assert.equal(builtin.loadSkills, config.skills !== false);
    assert.equal(builtin.loadExtensions, config.extensions !== false);
    assert.equal(builtin.runInBackground, config.runInBackground ?? true);
  }
  for (const name of ["plan", "review", "scout", "test"]) {
    assert.deepEqual(profiles.find((item) => item.name === name).tools, ["read", "grep", "find", "ls", "bash"]);
  }
});

test("five Desktop presets retain the user's prompt snapshots and complete native defaults", () => {
  const expected = {
    plan: [25, "high", "82970a52a989088fec0d61b15971d3b4edfbde80217b2fbebd9377e20a4bc0fd"],
    review: [25, "high", "85ecfab0aa5bad1c0a28571406d19984accaaae3194b8029d3db2255f5b60f20"],
    scout: [80, "medium", "fdacc75780f0c947187e41245efb43e594b9807f9b5067814c09dfca4f4baa2e"],
    test: [150, "high", "9fd6a193923667cf7ecbfd9a5896654e5c9e90c9f16650945d3a19050236e2f0"],
    work: [200, "high", "cdcec738ddd5be9373981844afad52a5c008665719020288cf1411bf1254c137"],
  };
  assert.deepEqual([...DEFAULT_AGENT_NAMES], [...DEFAULT_AGENTS.keys()]);
  const registry = buildAgentRegistry(new Map());
  assert.deepEqual([...DEFAULT_AGENTS.keys()], ["plan", "review", "scout", "test", "work"]);
  assert.equal(registry.size, 5);
  for (const [name, [maxTurns, thinking, promptHash]] of Object.entries(expected)) {
    const config = registry.get(name);
    assert.ok(config, name);
    assert.equal(config.isDefault, true);
    assert.equal(config.source, "default");
    assert.equal(config.sourcePath, undefined);
    assert.equal(config.name, name);
    assert.equal(config.displayName, name);
    assert.equal(config.maxTurns, maxTurns);
    assert.equal(config.thinking, thinking);
    assert.equal(config.model, "哈尔/gpt-6.1-sol");
    assert.equal(config.fallbackModel, "openai-codex/gpt-6.1-sol");
    assert.equal(config.skills, false);
    assert.equal(config.extensions, false);
    assert.equal(config.inheritContext, false);
    assert.equal(config.runInBackground, false);
    assert.equal(config.enabled, true);
    assert.equal(config.promptMode, "append");
    assert.deepEqual(config.builtinToolNames, ["read", "grep", "find", "ls", "bash", ...(name === "work" ? ["edit", "write"] : [])]);
    assert.equal(createHash("sha256").update(config.systemPrompt).digest("hex"), promptHash, `${name} prompt matches the original definition`);
    assert.equal(resolveEnabledTypeIn(registry, name), name);
    assert.equal(resolveSubagentProfile(testAgentDir, name).scope, "builtin");
  }
  // Native opt-out suppresses presets but must never suppress a user's own file.
  try {
    setDefaultsDisabled(true);
    assert.equal(buildAgentRegistry(new Map()).size, 0);
    const override = { ...registry.get("work"), isDefault: undefined, source: "global", model: "custom/model" };
    assert.deepEqual([...buildAgentRegistry(new Map([["work", override]])).values()], [override]);
  } finally {
    setDefaultsDisabled(false);
  }
});

test("all five presets take precedence over user scopes and deletion exposes lower sources persistently", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-desktop-preset-precedence-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const name of DEFAULT_AGENT_NAMES) {
    const builtin = resolveSubagentProfile(cwd, name);
    assert.equal(builtin.scope, "builtin");
    const global = saveSubagentProfile(cwd, "global", { ...builtin, model: "global/model" });
    await mkdir(join(cwd, ".agents", "agents"), { recursive: true });
    await writeFile(join(cwd, ".agents", "agents", `${name}.md`), `---\nname: ${name}\nmodel: workspace/model\n---\nWorkspace prompt.\n`);
    const project = saveSubagentProfile(cwd, "project", { ...builtin, model: "project/model", enabled: false });
    assert.equal(resolveSubagentProfile(cwd, name).model, builtin.model);
    assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get(name).model, builtin.model);
    assert.equal(resolveEnabledTypeIn(buildAgentRegistry(loadCustomAgents(cwd)), name), name);
    const sources = listSubagentProfileSources(cwd).filter(p => p.name === name);
    assert.deepEqual(sources.map(p => p.scope), ["global", "workspace", "project", "builtin"]);
    assert.equal(sources[0].filePath, global.filePath);
    assert.equal(sources[1].model, "workspace/model");
    assert.equal(sources[2].filePath, project.filePath);
    assert.equal(sources[3].model, builtin.model);
    deleteSubagentProfile(cwd, "builtin", name);
    assert.equal(await readFile(builtinDeletionPath(name), "utf8"), "deleted\n");
    for (let reload = 0; reload < 2; reload++) {
      assert.equal(loadBuiltinAgents().has(name), false);
      assert.equal(resolveSubagentProfile(cwd, name), undefined);
      assert.equal(resolveEnabledTypeIn(buildAgentRegistry(loadCustomAgents(cwd)), name), undefined);
      assert.equal(listSubagentProfileSources(cwd).some(p => p.name === name && p.scope === "builtin"), false);
    }
    deleteSubagentProfile(cwd, "project", name);
    assert.equal(resolveSubagentProfile(cwd, name).model, "workspace/model");
    await rm(join(cwd, ".agents", "agents", `${name}.md`));
    assert.equal(resolveSubagentProfile(cwd, name).model, "global/model");
    assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get(name).sourcePath, global.filePath);
    deleteSubagentProfile(cwd, "global", name);
    assert.equal(resolveSubagentProfile(cwd, name), undefined);
    assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).has(name), false);
    await rm(builtinDeletionPath(name));
    assert.deepEqual(resolveSubagentProfile(cwd, name), builtin);
    assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get(name), DEFAULT_AGENTS.get(name));
  }
});

test("project profiles round-trip their runtime settings without inventing a legacy built-in", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    saveProjectSubagentProfile(cwd, {
      name: "Explore",
      displayName: "Repository scout",
      description: "Inspect this repository",
      systemPrompt: "Read carefully and report findings.",
      tools: ["read", "grep"],
      loadSkills: true,
      loadExtensions: true,
      model: "anthropic/test-model",
      thinking: "high",
      maxTurns: 8,
      inheritContext: true,
      runInBackground: true,
      enabled: true,
    });

    const profile = listSubagentProfiles(cwd).find((item) => item.name === "Explore");
    assert.equal(profile.scope, "project");
    assert.equal(profile.displayName, "Repository scout");
    assert.deepEqual(profile.tools, ["read", "grep"]);
    assert.equal(profile.loadSkills, true);
    assert.equal(profile.loadExtensions, true);
    assert.equal(profile.thinking, "high");
    assert.equal(profile.maxTurns, 8);
    assert.equal(profile.inheritContext, true);
    assert.equal(profile.runInBackground, true);

    const source = await readFile(join(cwd, ".pi", "agents", "Explore.md"), "utf8");
    assert.match(source, /max_turns: 8/);
    assert.match(source, /load_skills: true/);
    assert.match(source, /load_extensions: true/);
    assert.match(source, /Read carefully and report findings\./);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tintinweb extension selectors stay scoped to the selected extension tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "legacy.md"),
      "---\ndescription: Legacy\ntools: read, ext:mcp/search, write\ndisallowed_tools: write\n---\nInspect only.\n",
    );
    const profile = listSubagentProfiles(cwd).find((item) => item.name === "legacy");
    assert.deepEqual(profile.tools, ["read"]);
    assert.deepEqual(profile.extensionTools, ["ext:mcp/search"]);
    assert.equal(profile.loadSkills, true);
    assert.equal(profile.loadExtensions, true);
    const extensions = [
      { path: "/tmp/mcp/index.ts", sourceInfo: { source: "mcp" }, tools: new Map([["search", {}], ["admin", {}]]) },
      { path: "/tmp/other/index.ts", sourceInfo: { source: "other" }, tools: new Map([["search", {}]]) },
    ];
    assert.deepEqual(selectSubagentExtensionTools(extensions, profile.extensionTools), ["search"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reads tintinweb profile aliases and frontmatter identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-tintin-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(join(cwd, ".pi", "agents", "review.md"), `---
name: security-review
color: cyan
skills: true
extensions: false
prompt_mode: replace
isolation: worktree
persist_session: false
disallowed_tools: bash
---
Review securely.
`);
    const profile = resolveSubagentProfile(cwd, "security-review");
    assert.equal(profile.name, "security-review");
    assert.equal(profile.loadSkills, true);
    assert.equal(profile.loadExtensions, false);
    assert.equal(profile.promptMode, "replace");
    assert.equal(profile.color, "cyan");
    assert.equal(profile.isolation, "worktree");
    assert.equal(profile.persistSession, false);
    assert.equal(profile.tools.includes("bash"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persisted subagent metadata reconstructs the final run", () => {
  const entries = [
    {
      type: "custom",
      customType: SUBAGENT_META_TYPE,
      id: "meta",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: {
        version: 1,
        parentSessionId: "parent",
        parentSessionPath: "/tmp/parent.jsonl",
        parentToolCallId: "tool-call",
        profile: "Explore",
        description: "Find the parser",
        task: "Locate parser code",
        runInBackground: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      type: "custom",
      customType: SUBAGENT_RESULT_TYPE,
      id: "result",
      parentId: "meta",
      timestamp: "2026-01-01T00:01:00.000Z",
      data: {
        version: 1,
        status: "completed",
        completedAt: "2026-01-01T00:01:00.000Z",
        result: "Located it.",
      },
    },
  ];

  assert.deepEqual(readSubagentRun(entries, "child", "/tmp/child.jsonl"), {
    sessionId: "child",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent",
    parentToolCallId: "tool-call",
    profile: "Explore",
    description: "Find the parser",
    task: "Locate parser code",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: "Located it.",
  });
});

test("persisted subagent resources restore the exact isolated prompt and tools", () => {
  const entries = [{
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    id: "meta",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      profile: "reviewer",
      resourceSnapshot: {
        version: 1,
        appendSystemPrompt: ["Review carefully.", "Inherited parent context."],
        tools: ["read", "grep", "web_search", "read"],
        loadSkills: true,
        loadExtensions: true,
      },
    },
  }];

  assert.deepEqual(readSubagentSessionResources(entries), {
    appendSystemPrompt: ["Review carefully.", "Inherited parent context."],
    tools: ["read", "grep", "web_search"],
    loadSkills: true,
    loadExtensions: true,
  });
});

test("legacy subagent resource snapshots keep skills and extensions disabled", () => {
  const entries = [{
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      resourceSnapshot: {
        version: 1,
        appendSystemPrompt: ["Stay focused."],
        tools: ["read"],
      },
    },
  }];

  assert.deepEqual(readSubagentSessionResources(entries), {
    appendSystemPrompt: ["Stay focused."],
    tools: ["read"],
    loadSkills: false,
    loadExtensions: false,
  });
});

test("extension tools are merged while subagent control tools stay excluded", () => {
  assert.deepEqual(
    withSubagentExtensionTools(
      ["read"],
      ["web_search", "Agent", "get_subagent_result", "steer_subagent", "web_search"],
    ),
    ["read", "web_search"],
  );
});

test("an empty tool selection round-trips without restoring default tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const saved = saveProjectSubagentProfile(cwd, profile({ tools: [] }));
    const loaded = listSubagentProfiles(cwd).find((item) => item.name === saved.name);
    const source = await readFile(join(cwd, ".pi", "agents", `${saved.name}.md`), "utf8");

    assert.deepEqual(saved.tools, []);
    assert.deepEqual(loaded.tools, []);
    assert.match(source, /tools: none/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("saved profiles normalize runtime values and reject invalid settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const saved = saveProjectSubagentProfile(cwd, profile());
    assert.equal(saved.displayName, "Test agent");
    assert.equal(saved.description, "Test description");
    assert.equal(saved.systemPrompt, "Test prompt.");
    assert.deepEqual(saved.tools, ["read"]);
    assert.equal(saved.model, "provider/model");
    assert.equal(saved.maxTurns, 4);
    assert.equal(saved.loadSkills, false);
    assert.equal(saved.loadExtensions, false);

    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ name: "../escape" })),
      /Agent name may contain only/,
    );
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ thinking: "extreme" })),
      /Invalid thinking level/,
    );
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ maxTurns: Number.POSITIVE_INFINITY })),
      /Max turns must be a non-negative number/,
    );
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ maxTurns: -1 })),
      /Max turns must be a non-negative number/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project profiles override workspace profiles and deletion restores the workspace version", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".agents", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "agents", "test-agent.md"),
      "---\ndescription: Workspace version\ntools: read\n---\nWorkspace prompt.\n",
    );
    saveProjectSubagentProfile(cwd, profile({ description: "Project version" }));
    assert.equal(resolveSubagentProfile(cwd, "TEST-AGENT").description, "Project version");

    deleteProjectSubagentProfile(cwd, "test-agent");
    const restored = resolveSubagentProfile(cwd, "test-agent");
    assert.equal(restored.scope, "workspace");
    assert.equal(restored.description, "Workspace version");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("global and project sources with the same name stay visible while project wins at runtime", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    saveSubagentProfile(cwd, "global", profile({ description: "Global version" }));
    saveSubagentProfile(cwd, "project", profile({ description: "Project version" }));

    const sources = listSubagentProfileSources(cwd)
      .filter((item) => item.name === "test-agent")
      .sort((a, b) => a.scope.localeCompare(b.scope));
    assert.deepEqual(sources.map((item) => item.scope), ["global", "project"]);
    assert.deepEqual(sources.map((item) => item.description), ["Global version", "Project version"]);

    const effective = resolveSubagentProfile(cwd, "test-agent");
    assert.equal(effective.scope, "project");
    assert.equal(effective.description, "Project version");
  } finally {
    deleteSubagentProfile(cwd, "global", "test-agent");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("global profiles round-trip and deleting them leaves legacy names absent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const saved = saveSubagentProfile(cwd, "global", profile({
      name: "Explore",
      displayName: "Global explorer",
      description: "Global override",
      tools: ["read", "grep"],
    }));
    assert.equal(saved.scope, "global");
    assert.equal(saved.filePath, join(testAgentDir, "agents", "Explore.md"));
    assert.equal(resolveSubagentProfile(cwd, "Explore").scope, "global");
    assert.equal(resolveSubagentProfile(cwd, "Explore").description, "Global override");

    deleteSubagentProfile(cwd, "global", "Explore");
    const restored = resolveSubagentProfile(cwd, "Explore");
    assert.equal(restored, undefined);
    assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).has("Explore"), false);
  } finally {
    deleteSubagentProfile(cwd, "global", "Explore");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("disabled profiles cannot be resolved for execution", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    saveSubagentProfile(cwd, "global", profile({ description: "Global version" }));
    saveProjectSubagentProfile(cwd, profile({ enabled: false }));
    const sources = listSubagentProfileSources(cwd).filter((item) => item.name === "test-agent");
    assert.deepEqual(sources.map((item) => item.scope), ["global", "project"]);
    assert.equal(sources[0].enabled, true);
    assert.equal(sources[1].enabled, false);
    assert.equal(resolveSubagentProfile(cwd, "test-agent"), undefined);
    assert.equal(listSubagentProfiles(cwd).find((item) => item.name === "test-agent").enabled, false);
  } finally {
    deleteSubagentProfile(cwd, "global", "test-agent");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persisted runs distinguish interrupted, failed, aborted, and latest results", () => {
  const meta = {
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    id: "meta",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "tool-call",
      profile: "Explore",
      description: "Inspect",
      task: "Inspect files",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  assert.equal(readSubagentRun([meta], "child", "/tmp/child.jsonl").status, "interrupted");

  const failed = {
    ...meta,
    id: "failed",
    customType: SUBAGENT_RESULT_TYPE,
    data: { version: 1, status: "failed", completedAt: "2026-01-01T00:01:00.000Z", error: "boom" },
  };
  const aborted = {
    ...failed,
    id: "aborted",
    data: { version: 1, status: "aborted", completedAt: "2026-01-01T00:02:00.000Z" },
  };
  assert.equal(readSubagentRun([meta, failed], "child", "/tmp/child.jsonl").status, "failed");
  assert.equal(readSubagentRun([meta, failed], "child", "/tmp/child.jsonl").error, "boom");
  assert.equal(readSubagentRun([meta, failed, aborted], "child", "/tmp/child.jsonl").status, "aborted");
  const resumed = { ...failed, id: "resumed", customType: SUBAGENT_STATUS_TYPE, data: { version: 1, status: "queued" } };
  assert.equal(readSubagentRun([meta, failed, resumed], "child", "/tmp/child.jsonl").status, "queued");
  assert.equal(readSubagentRun([{ ...meta, data: { version: 2 } }], "child", "/tmp/child.jsonl"), null);
});

test("project profile directories cannot escape cwd through symbolic links", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "pi-web-subagent-boundary-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(join(cwd, ".agents"), { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret.md"), "---\ndescription: Secret\n---\nprivate\n");

  try {
    await symlink(outside, join(cwd, ".agents", "agents"), process.platform === "win32" ? "junction" : "dir");
    await symlink(outside, join(cwd, ".pi", "agents"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.equal(listSubagentProfileSources(cwd).some((item) => item.name === "secret"), false);
  assert.equal(listSubagentProfiles(cwd).some((item) => item.name === "secret"), false);
  assert.throws(
    () => saveProjectSubagentProfile(cwd, profile({ name: "escaped" })),
    /outside the project root/,
  );
  assert.throws(
    () => deleteProjectSubagentProfile(cwd, "secret"),
    /outside the project root/,
  );
  assert.match(await readFile(join(outside, "secret.md"), "utf8"), /private/);
});

test("a save keeps frontmatter keys this app does not manage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const file = join(cwd, ".pi", "agents", "orchestrator.md");
    await writeFile(
      file,
      [
        "---",
        "name: orchestrator",
        "description: Hands out work",
        "display_name: orchestrator",
        "tools: read, bash, edit, write, grep, find, ls, ext:pi-advisor-flow/ask_advisor",
        "skills: false",
        "extensions: pi-advisor-flow",
        "exclude_extensions: pi-advisor-flow",
        "allowed_subagents: thinker, executor",
        "disallowed_tools: write",
        "enabled: true",
        "inherit_context: false",
        "run_in_background: false",
        "---",
        "Dispatch the work.",
      ].join("\n"),
    );

    saveProjectSubagentProfile(cwd, profile({ name: "orchestrator", tools: ["read", "bash"] }));
    const source = await readFile(file, "utf8");

    assert.match(source, /^name: orchestrator$/m);
    assert.match(source, /allowed_subagents: thinker, executor/);
    assert.match(source, /exclude_extensions: pi-advisor-flow/);
    assert.match(source, /disallowed_tools: write/);
    assert.match(source, /skills: false/);
    assert.match(source, /extensions: pi-advisor-flow/);
    assert.match(source, /tools: read, bash, ext:pi-advisor-flow\/ask_advisor/);
    assert.match(source, /Test prompt\./);

    const loaded = listSubagentProfiles(cwd).find((item) => item.name === "orchestrator");
    assert.deepEqual(loaded.tools, ["read", "bash"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a save refuses to overwrite malformed existing frontmatter", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const file = join(cwd, ".pi", "agents", "malformed.md");
    const source = "---\nallowed_subagents: [executor\n---\nKeep this file intact.\n";
    await writeFile(file, source);

    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ name: "malformed" })),
      /existing frontmatter is invalid/,
    );
    assert.equal(await readFile(file, "utf8"), source);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the pi-subagents flag aliases are seeded, kept in step, and never overwrite a whitelist", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const file = join(cwd, ".pi", "agents", "fresh.md");
    saveProjectSubagentProfile(cwd, profile({ name: "fresh", loadSkills: true, loadExtensions: true }));
    const seeded = await readFile(file, "utf8");
    assert.match(seeded, /load_skills: true/);
    assert.match(seeded, /skills: true/);
    assert.match(seeded, /load_extensions: true/);
    assert.match(seeded, /extensions: true/);

    saveProjectSubagentProfile(cwd, profile({ name: "fresh", loadSkills: false, loadExtensions: false }));
    const flipped = await readFile(file, "utf8");
    assert.match(flipped, /skills: false/);
    assert.match(flipped, /extensions: false/);

    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const scoped = join(cwd, ".pi", "agents", "scoped.md");
    await writeFile(scoped, "---\ndescription: Scoped\nextensions: pi-advisor-flow\n---\nOnly the advisor.\n");
    saveProjectSubagentProfile(cwd, profile({ name: "scoped", loadExtensions: true }));
    assert.match(await readFile(scoped, "utf8"), /extensions: pi-advisor-flow/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("profile flags fall back to the pi-subagents spellings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "legacy-flags.md"),
      "---\ndescription: Legacy flags\nskills: false\nextensions: pi-advisor-flow\n---\nScoped.\n",
    );

    const loaded = listSubagentProfiles(cwd).find((item) => item.name === "legacy-flags");
    assert.equal(loaded.loadSkills, false);
    assert.equal(loaded.loadExtensions, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("case variants remain distinct and only exact or unambiguous enabled identities resolve", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-case-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".agents", "agents"), { recursive: true });
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(join(cwd, ".agents", "agents", "explore.md"), "---\nname: explore\n---\nLowercase workspace.\n");
  await writeFile(join(cwd, ".pi", "agents", "override.md"), "---\nname: Explore\n---\nExact project override.\n");
  const profiles = listSubagentProfiles(cwd);
  assert.equal(profiles.find((item) => item.name === "Explore").scope, "project");
  assert.equal(profiles.find((item) => item.name === "explore").scope, "workspace");
  const registry = buildAgentRegistry(loadCustomAgents(cwd));
  for (const name of ["Explore", "explore", "EXPLORE", " Plan ", "missing"]) {
    assert.equal(resolveSubagentProfile(cwd, name)?.name, resolveEnabledTypeIn(registry, name));
  }
  assert.equal(resolveSubagentProfile(cwd, "EXPLORE"), undefined);
  assert.equal(listSubagentProfileSources(cwd).filter((item) => item.name === "Explore").length, 1);
});

test("native parsing owns aliases, permissive names, BOM, empty tools and zero max turns", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-native-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = join(cwd, ".pi", "agents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "review.md"), '\uFEFF---\nname: Code Reviewer\ndisplay_name: ""\ntools: ""\nload_skills: false\nload_extensions: false\ninherit_skills: none\nextensions: false\nmax_turns: 0\nisolation: no\n---\r\nNative prompt.\r\n');
  await writeFile(join(dir, "unicode.md"), "---\nname: 审查员\n---\nReview.\n");
  await writeFile(join(dir, "colon.md"), "---\nname: plugin:reviewer\n---\nSkip.\n");
  const raw = loadCustomAgents(cwd).get("Code Reviewer");
  const loaded = resolveSubagentProfile(cwd, "Code Reviewer");
  assert.equal(loaded.displayName, raw.displayName);
  assert.equal(loaded.systemPrompt, raw.systemPrompt);
  assert.deepEqual(loaded.tools, []);
  assert.equal(loaded.loadSkills, false);
  assert.equal(loaded.loadExtensions, false);
  assert.equal(loaded.promptMode, "replace");
  assert.equal(loaded.runInBackground, true);
  assert.equal(loaded.maxTurns, 0);
  assert.equal(loaded.isolation, "off");
  assert.equal(resolveSubagentProfile(cwd, "审查员").scope, "project");
  assert.equal(resolveSubagentProfile(cwd, "plugin:reviewer"), undefined);
  const fresh = saveProjectSubagentProfile(cwd, profile({ name: "zero", maxTurns: 0 }));
  assert.equal(fresh.maxTurns, 0);
  assert.equal(resolveSubagentProfile(cwd, "zero").maxTurns, 0);
});

test("declared identity edits and deletes keep the existing source path", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-source-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = join(cwd, ".pi", "agents");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "different-filename.md");
  await writeFile(filePath, "---\nname: reviewer\nfallback_model: provider/fallback\nallowed_subagents: Plan\n---\nReview.\n");
  const loaded = resolveSubagentProfile(cwd, "reviewer");
  const saved = saveSubagentProfile(cwd, "project", { ...loaded, description: "Updated" });
  assert.equal(saved.filePath, filePath);
  assert.equal(saved.name, "reviewer");
  assert.match(await readFile(filePath, "utf8"), /fallback_model: provider\/fallback/);
  await assert.rejects(readFile(join(dir, "reviewer.md")), { code: "ENOENT" });
  assert.throws(() => saveSubagentProfile(cwd, "project", { ...loaded, filePath: join(cwd, "outside.md") }), /outside its scope directory/);
  deleteProjectSubagentProfile(cwd, "reviewer");
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
});

test("same-scope declared collisions retain all sources and the native later-file winner", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-collision-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = join(cwd, ".pi", "agents");
  await mkdir(dir, { recursive: true });
  for (const filename of ["a.md", "z.md"]) {
    await writeFile(join(dir, filename), `---\nname: reviewer\n---\n${filename}\n`);
  }
  const allSources = listSubagentProfileSources(cwd).filter((item) => item.name === "reviewer");
  assert.deepEqual(allSources.map(item => item.scope), ["project", "project"]);
  const sources = allSources.filter(item => item.scope === "project");
  assert.equal(sources.length, 2);
  assert.equal(resolveSubagentProfile(cwd, "reviewer").filePath, loadCustomAgents(cwd).get("reviewer").sourcePath);
  assert.throws(() => saveProjectSubagentProfile(cwd, profile({ name: "reviewer" })), /multiple source files/);
  assert.throws(() => deleteProjectSubagentProfile(cwd, "reviewer"), /multiple source files/);
  saveSubagentProfile(cwd, "project", { ...sources[0], description: "Edit first only" });
  assert.match(await readFile(sources[0].filePath, "utf8"), /description: Edit first only/);
  assert.equal(resolveSubagentProfile(cwd, "reviewer").filePath, sources[1].filePath);
  deleteSubagentProfile(cwd, "project", "reviewer", sources[0].filePath);
  await assert.rejects(readFile(sources[0].filePath), { code: "ENOENT" });
  assert.equal(resolveSubagentProfile(cwd, "reviewer").filePath, sources[1].filePath);
});

for (const scope of ["builtin", "global", "project"]) {
  test(`${scope} rename preserves settings and unknown frontmatter, removes the old source and reloads natively`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-rename-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const configured = profile({ name: "before", tools: ["read", "edit"], extensionTools: ["ext:mcp/search"],
      fallbackModel: "backup/model", promptMode: "append", color: "cyan", isolation: "off", persistSession: false });
    const saved = saveSubagentProfile(cwd, scope, configured);
    const source = await readFile(saved.filePath, "utf8");
    await writeFile(saved.filePath, source.replace("---\n", "---\nallowed_subagents: plan, review\ncustom_metadata:\n  owner: fixture\nexclude_extensions: other\n"));
    const { fallbackModel, ...legacy } = saved;
    const renamed = saveSubagentProfile(cwd, scope, { ...legacy, name: "after" }, { originalName: "before" });
    assert.equal(renamed.filePath, join(scope === "builtin" ? join(testAgentDir, "desktop-agents") : scope === "global" ? join(testAgentDir, "agents") : join(cwd, ".pi", "agents"), "after.md"));
    await assert.rejects(readFile(saved.filePath), { code: "ENOENT" });
    for (const key of ["displayName", "description", "systemPrompt", "tools", "extensionTools", "model", "fallbackModel", "thinking", "maxTurns", "promptMode", "loadSkills", "loadExtensions", "inheritContext", "runInBackground", "enabled", "color", "isolation", "persistSession"]) {
      assert.deepEqual(renamed[key], saved[key], `${scope}: ${key}`);
    }
    const text = await readFile(renamed.filePath, "utf8");
    assert.match(text, /^name: after$/m);
    assert.match(text, /allowed_subagents: plan, review/);
    assert.match(text, /custom_metadata:\n  owner: fixture/);
    assert.match(text, /exclude_extensions: other/);
    assert.match(text, /ext:mcp\/search/);
    const registry = buildAgentRegistry(loadCustomAgents(cwd));
    assert.equal(registry.has("before"), false);
    assert.equal(resolveSubagentProfile(cwd, "before"), undefined);
    const raw = registry.get("after");
    assert.equal(raw.sourcePath, renamed.filePath);
    assert.equal(raw.model, renamed.model);
    assert.equal(raw.fallbackModel, renamed.fallbackModel);
    assert.equal(raw.systemPrompt, renamed.systemPrompt);
    assert.equal(raw.promptMode, renamed.promptMode);
    assert.deepEqual(raw.builtinToolNames, renamed.tools);
    assert.deepEqual(raw.extSelectors, renamed.extensionTools);
    assert.equal(raw.skills, renamed.loadSkills);
    assert.equal(raw.extensions, renamed.loadExtensions);
    assert.equal(raw.thinking, renamed.thinking);
    assert.equal(raw.maxTurns, renamed.maxTurns);
    assert.equal(raw.inheritContext, renamed.inheritContext);
    assert.equal(raw.runInBackground, renamed.runInBackground);
    assert.equal(raw.enabled, renamed.enabled);
    assert.equal(raw.color, renamed.color);
    assert.equal(raw.isolation, renamed.isolation);
    assert.equal(raw.persistSession, renamed.persistSession);
    assert.equal(resolveSubagentProfile(cwd, "after").scope, scope);
  });

  test(`${scope} refuses unsafe names, identity collisions, mismatched paths, occupied destinations and missing originals without damage`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-rename-errors-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const original = saveSubagentProfile(cwd, scope, profile({ name: "original" }));
    const target = saveSubagentProfile(cwd, scope, profile({ name: "occupied", description: "Keep target" }));
    const before = await readFile(original.filePath, "utf8");
    const targetBefore = await readFile(target.filePath, "utf8");
    const dir = scope === "builtin" ? join(testAgentDir, "desktop-agents") : scope === "global" ? join(testAgentDir, "agents") : join(cwd, ".pi", "agents");
    const foreignPath = join(dir, "destination.md");
    const foreign = "---\nname: unrelated\n---\nKeep unrelated source.\n";
    await writeFile(foreignPath, foreign);
    const cases = [
      [{ ...original, name: "../escape" }, { originalName: "original" }, /Agent name may contain only/],
      [{ ...original, name: "new" }, { originalName: "../escape" }, /Agent name may contain only/],
      [{ ...original, name: "occupied" }, { originalName: "original" }, /already exists in this scope/],
      [{ ...original, name: "new", filePath: target.filePath }, { originalName: "original" }, /does not match its declared name/],
      [{ ...original, name: "destination" }, { originalName: "original" }, /destination file already exists/],
      [{ ...original, name: "new" }, { originalName: "missing" }, /profile not found/],
      [{ ...original }, { createOnly: true }, /already exists in this scope/],
      [profile({ name: "destination" }), { createOnly: true }, /destination file already exists/],
    ];
    for (const [draft, options, error] of cases) {
      assert.throws(() => saveSubagentProfile(cwd, scope, draft, options), error);
      assert.equal(await readFile(original.filePath, "utf8"), before);
      assert.equal(await readFile(target.filePath, "utf8"), targetBefore);
      assert.equal(await readFile(foreignPath, "utf8"), foreign);
      await assert.rejects(readFile(join(dir, "new.md")), { code: "ENOENT" });
    }
    assert.throws(() => deleteSubagentProfile(cwd, scope, "original", target.filePath), /does not match its declared name/);
    assert.equal(await readFile(original.filePath, "utf8"), before);
    assert.equal(await readFile(target.filePath, "utf8"), targetBefore);
    assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get("original").sourcePath, original.filePath);
  });
}

test("renaming a preset hides its old embedded ID and createOnly explicitly recreates deleted presets and new built-ins", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-builtin-create-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const preset = resolveSubagentProfile(cwd, "plan");
  assert.throws(() => saveSubagentProfile(cwd, "builtin", { ...preset, model: "bad/overwrite" }, { createOnly: true }), /already exists in this scope/);
  assert.deepEqual(resolveSubagentProfile(cwd, "plan"), preset);
  const renamed = saveSubagentProfile(cwd, "builtin", { ...preset, name: "custom-plan" }, { originalName: "plan" });
  assert.equal(resolveSubagentProfile(cwd, "plan"), undefined);
  assert.equal(loadBuiltinAgents().has("plan"), false);
  assert.equal(await readFile(builtinDeletionPath("plan"), "utf8"), "deleted\n");
  assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).get("custom-plan").sourcePath, renamed.filePath);
  assert.throws(() => saveSubagentProfile(cwd, "builtin", { ...preset, name: "replacement" }, { originalName: "plan" }), /profile not found/);
  const recreated = saveSubagentProfile(cwd, "builtin", { ...preset, model: "local/recreated" }, { createOnly: true });
  await assert.rejects(readFile(builtinDeletionPath("plan")), { code: "ENOENT" });
  assert.equal(loadBuiltinAgents().get("plan").model, "local/recreated");
  const before = await readFile(recreated.filePath, "utf8");
  assert.throws(() => saveSubagentProfile(cwd, "builtin", { ...recreated, model: "bad/overwrite" }, { createOnly: true }), /already exists in this scope/);
  assert.equal(await readFile(recreated.filePath, "utf8"), before);
  deleteSubagentProfile(cwd, "builtin", "plan", recreated.filePath);
  await assert.rejects(readFile(recreated.filePath), { code: "ENOENT" });
  assert.equal(resolveSubagentProfile(cwd, "plan"), undefined);
  assert.equal(buildAgentRegistry(loadCustomAgents(cwd)).has("plan"), false);
  const fresh = saveSubagentProfile(cwd, "builtin", profile({ name: "new-builtin" }), { createOnly: true });
  assert.equal(resolveSubagentProfile(cwd, fresh.name).scope, "builtin");
  assert.equal(loadBuiltinAgents().get(fresh.name).sourcePath, fresh.filePath);
  deleteSubagentProfile(cwd, "builtin", fresh.name, fresh.filePath);
  assert.equal(loadBuiltinAgents().has(fresh.name), false);
  assert.equal(resolveSubagentProfile(cwd, fresh.name), undefined);
});

test("case-only preset rename retains exact deletion identity on case-insensitive filesystems", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-case-rename-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const preset = resolveSubagentProfile(cwd, "work");
  const lower = saveSubagentProfile(cwd, "global", { ...preset, model: "global/keep" });
  const renamed = saveSubagentProfile(cwd, "builtin", { ...preset, name: "Work", model: "custom/upper" }, { originalName: "work" });
  assert.notEqual(builtinDeletionPath("work").toLowerCase(), builtinDeletionPath("Work").toLowerCase());
  assert.equal(await readFile(builtinDeletionPath("work"), "utf8"), "deleted\n");
  assert.equal(loadBuiltinAgents().has("work"), false);
  assert.equal(loadBuiltinAgents().get("Work").model, "custom/upper");
  assert.equal(resolveSubagentProfile(cwd, "work").filePath, lower.filePath);
  assert.equal(resolveSubagentProfile(cwd, "Work").filePath, renamed.filePath);
  // Also rename a persisted source in place on Windows, then delete it.
  const twice = saveSubagentProfile(cwd, "builtin", { ...renamed, name: "WORK" }, { originalName: "Work" });
  assert.equal(loadBuiltinAgents().has("Work"), false);
  assert.equal(loadBuiltinAgents().has("work"), false);
  assert.equal(loadBuiltinAgents().get("WORK").sourcePath, twice.filePath);
  deleteSubagentProfile(cwd, "builtin", "WORK", twice.filePath);
  assert.equal(loadBuiltinAgents().has("WORK"), false);
  assert.equal(loadBuiltinAgents().has("work"), false);
  assert.equal(resolveSubagentProfile(cwd, "work").model, "global/keep");
});

test("default dispatch falls back only to enabled work and refuses a missing or deleted work preset", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-work-fallback-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const registry = buildAgentRegistry(new Map());
  assert.deepEqual(resolveSpawnTypeIn(registry, "missing"), { ok: true, type: "work", fellBackFrom: "missing" });
  assert.deepEqual(resolveSpawnTypeIn(registry, undefined), { ok: true, type: "work", fellBackFrom: "" });
  assert.equal(resolveSpawnTypeIn(new Map([["general-purpose", { name: "general-purpose", enabled: true }]]), "missing").ok, false);
  const disabled = new Map(registry);
  disabled.set("work", { ...registry.get("work"), enabled: false });
  assert.equal(resolveSpawnTypeIn(disabled, "missing").ok, false);
  deleteSubagentProfile(cwd, "builtin", "work");
  const deleted = resolveSpawnTypeIn(buildAgentRegistry(new Map()), "missing");
  assert.equal(deleted.ok, false);
  assert.match(deleted.message, /Default fallback "work" is unavailable/);
});
