import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  isBuiltInSubagentsEnabled,
  readSubagentSettings,
  writeBuiltInSubagentsEnabled,
  writeSubagentMaxConcurrent,
  getSubagentSettingsPath,
} = await createJiti(import.meta.url).import("./subagent-settings.ts");

test("subagent settings default native built-in pi-subagents to enabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: true });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  assert.equal(readSubagentSettings(settingsPath).maxConcurrent, 10);
});

test("subagent settings persist both states and preserve unrelated fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: true });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  const first = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(first, { version: 1, builtInEnabled: true });

  await writeFile(settingsPath, JSON.stringify({ ...first, futureSetting: 3 }));
  writeBuiltInSubagentsEnabled(false, settingsPath);
  const second = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(second, { version: 1, builtInEnabled: false, futureSetting: 3 });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
});

test("damaged settings fail closed and are not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, "{");

  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.throws(() => readSubagentSettings(settingsPath));
  assert.throws(() => writeBuiltInSubagentsEnabled(true, settingsPath));
  assert.equal(await readFile(settingsPath, "utf8"), "{");
});

test("concurrency stays in Desktop agents/settings.json and respects explicit false", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = getSubagentSettingsPath(root);
  assert.equal(settingsPath, join(root, "agents", "settings.json"));
  writeSubagentMaxConcurrent(6, settingsPath);
  assert.equal(readSubagentSettings(settingsPath).builtInEnabled, true);
  assert.equal(readSubagentSettings(settingsPath).maxConcurrent, 6);
  writeBuiltInSubagentsEnabled(false, settingsPath);
  assert.equal(readSubagentSettings(settingsPath).maxConcurrent, 6);
  writeSubagentMaxConcurrent(32, settingsPath);
  assert.equal(readSubagentSettings(settingsPath).builtInEnabled, false);
  assert.equal(readSubagentSettings(settingsPath).maxConcurrent, 32);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, builtInEnabled: false, maxConcurrent: 32 });
  for (const invalid of [0, 33, 1.5, NaN]) assert.throws(() => writeSubagentMaxConcurrent(invalid, settingsPath));
});

test("omitted or non-boolean enabled values use the new enabled default", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  for (const stored of [{ maxConcurrent: 4 }, { builtInEnabled: "false" }, { builtInEnabled: null }]) {
    await writeFile(settingsPath, JSON.stringify(stored));
    assert.equal(readSubagentSettings(settingsPath).builtInEnabled, true);
  }
});
