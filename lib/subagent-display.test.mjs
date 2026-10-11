import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const dir = await mkdtemp(join(tmpdir(), "pi-coordination-display-"));
const file = join(dir, "display.mjs");
await build({ entryPoints: ["lib/subagent-display.ts"], outfile: file, bundle: true, platform: "node", format: "esm" });
const { isSubagentInternalMessage, isSubagentControlBlock, nativeSubagentToolNames } = await import(pathToFileURL(file));
test.after(() => rm(dir, { recursive: true, force: true }));
test("join markers hide only with native provenance", () => {
  assert.equal(isSubagentInternalMessage({ role: "custom", customType: "subagent-task-state", details: { displayOrigin: "pi-subagents" } }), true);
  assert.equal(isSubagentInternalMessage({ role: "custom", customType: "subagent-task-state", details: {} }), false);
  assert.equal(isSubagentInternalMessage({ role: "assistant", customType: "subagent-task-state", details: { displayOrigin: "pi-subagents" } }), false);
});
test("new coordination tool needs real SDK source evidence", () => {
  assert.deepEqual(nativeSubagentToolNames([{ name: "subagent_tasks", sourceInfo: { path: "<inline:pi-subagents>" } }]), ["subagent_tasks"]);
  assert.deepEqual(nativeSubagentToolNames([{ name: "subagent_tasks", sourceInfo: { path: "other" } }]), []);
  assert.equal(isSubagentControlBlock({ type: "toolCall", toolName: "subagent_tasks", toolCallId: "x", displayOrigin: "pi-subagents" }), true);
  assert.equal(isSubagentControlBlock({ type: "toolCall", toolName: "subagent_tasks", toolCallId: "x" }), false);
});
test("other custom message types are never hidden solely by an origin field", () => {
  assert.equal(isSubagentInternalMessage({ role: "custom", customType: "user-error", details: { displayOrigin: "pi-subagents" } }), false);
});
