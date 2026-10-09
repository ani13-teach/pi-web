import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { readCodemodeEnabled, writeCodemodeEnabled, updateCodemodeDefaultTools } = await jiti.import("./codemode-settings.ts");
const { applyCodemodeSelection } = await jiti.import("./codemode.ts");
const { writePowerShellToolEnabled, readPowerShellToolEnabled } = await jiti.import("./powershell-settings.ts");

async function fixture(t, settings) {
  const dir = await mkdtemp(join(tmpdir(), "pi-desktop-codemode-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");
  if (settings) await writeFile(path, JSON.stringify(settings));
  return path;
}

for (const current of [undefined, [], ["read", "grep"], ["+grep", "-write"], ["read", "+grep", "-bash"], ["codemode"], ["+codemode"], ["codemode", "+grep"], ["codemode", "-write"]]) {
  test(`codemode toggle preserves other resolved tools: ${JSON.stringify(current)}`, () => {
    const resolve = (defaultTools) => SettingsManager.inMemory({ defaultTools }).getDefaultTools() ?? ["read", "bash", "edit", "write"];
    const other = (tools) => tools.filter((name) => name !== "codemode");
    const on = updateCodemodeDefaultTools(current, true);
    assert.ok(resolve(on).includes("codemode"));
    assert.deepEqual(other(resolve(on)), other(resolve(current)));
    const off = updateCodemodeDefaultTools(on, false);
    assert.ok(!resolve(off).includes("codemode"));
    assert.deepEqual(other(resolve(off)), other(resolve(current)));
    assert.deepEqual(updateCodemodeDefaultTools(on, true), on, "enabling twice is idempotent");
  });
}

test("global codemode setting defaults off, persists and preserves unrelated keys", async (t) => {
  const path = await fixture(t);
  assert.equal(await readCodemodeEnabled(path), false);
  await writeCodemodeEnabled(true, path);
  assert.equal(await readCodemodeEnabled(path), true);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { defaultTools: ["+codemode"] });
  await writeFile(path, JSON.stringify({ defaultTools: ["+codemode", "-write"], unrelated: { keep: true }, codemode: { inlineBudget: 99 } }));
  await writeCodemodeEnabled(false, path);
  assert.equal(await readCodemodeEnabled(path), false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { defaultTools: ["-write", "-codemode"], unrelated: { keep: true }, codemode: { inlineBudget: 99 } });
});

test("PowerShell toggle understands modifiers and preserves Code Mode and coding tools", async (t) => {
  const path = await fixture(t, { defaultTools: ["+codemode"] });
  await writePowerShellToolEnabled(true, path, "win32");
  assert.equal(await readPowerShellToolEnabled(path, "win32"), true);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).defaultTools, ["read", "powershell", "edit", "write", "codemode"]);
  await writeCodemodeEnabled(false, path);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).defaultTools, ["read", "powershell", "edit", "write"]);
  await writePowerShellToolEnabled(false, path, "win32");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).defaultTools, ["read", "bash", "edit", "write"]);
});

test("invalid settings fail without overwriting the original file", async (t) => {
  for (const settings of [[], { defaultTools: "bash" }, { defaultTools: [42] }]) {
    const path = await fixture(t, settings);
    const before = await readFile(path, "utf8");
    await assert.rejects(writeCodemodeEnabled(true, path), /Invalid settings.json/);
    assert.equal(await readFile(path, "utf8"), before);
  }
});

test("desktop extension retention keeps codemode opt-in and chat-only empty", () => {
  assert.deepEqual(applyCodemodeSelection(["read", "codemode", "Agent"], undefined), ["read", "Agent"]);
  assert.deepEqual(applyCodemodeSelection(["read", "Agent"], ["read", "codemode"]), ["read", "Agent", "codemode"]);
  assert.deepEqual(applyCodemodeSelection([], ["codemode"]), []);
  assert.deepEqual(applyCodemodeSelection(["read", "codemode"], ["read"]), ["read"]);
});
