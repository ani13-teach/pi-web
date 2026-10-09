import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getSessionEntries, buildSessionContext } = await jiti.import("../lib/session-reader.ts");
const { readSubagentRun, readSubagentSessionResources } = await jiti.import("../lib/subagents.ts");
const { getDisplayableAssistantBlocks, isDisplayableMessage } = await jiti.import("../lib/message-display.ts");

// Read the actual Electron fixture declaration instead of maintaining a second
// copy. Evaluate only its local data creation; never import/launch main.ts.
async function fixtures() {
  const source = await readFile(new URL("../desktop/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("  const fixtureId = randomUUID();", source.indexOf("async function runSmokeChecks("));
  const end = source.indexOf("  try {\n    mkdirSync(fixtureDir", start);
  assert.ok(start >= 0 && end > start, "runSmokeChecks fixture declaration must be identifiable");
  const directory = await mkdtemp(join(tmpdir(), "pi-smoke-subagent-fixture-"));
  const program = ts.transpileModule(`${source.slice(start, end)}\n({ fixtureId, childId, fixture, childFixture, subagentFixture });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const data = runInNewContext(program, {
    randomUUID, join, runtime: { agentDir: directory }, scenarioWorkspace: () => directory,
  });
  const parentFile = join(directory, "parent.jsonl");
  const childFile = join(directory, "child.jsonl");
  // Exercise the SDK JSONL parser as well as the Desktop context converter.
  await writeFile(parentFile, data.fixture.map(JSON.stringify).join("\n") + "\n");
  await writeFile(childFile, data.childFixture.map(JSON.stringify).join("\n") + "\n");
  return { ...data, directory, parentEntries: getSessionEntries(parentFile), childEntries: getSessionEntries(childFile) };
}

function options(messages, hideSubagentActivity) {
  return {
    hideSubagentActivity,
    toolResults: new Map(messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message])),
  };
}

function calls(messages) {
  return messages.filter((message) => message.role === "assistant").flatMap((message) => message.content)
    .filter((block) => block.type === "toolCall");
}

test("actual window smoke child JSONL restores its relation, lifecycle and complete active branch", async (t) => {
  const data = await fixtures();
  t.after(() => rm(data.directory, { recursive: true, force: true }));
  const { fixtureId, childId, childEntries, subagentFixture: markers } = data;
  const run = readSubagentRun(childEntries, childId, "fixture-child.jsonl");
  assert.equal(run.parentSessionId, fixtureId);
  assert.equal(run.parentToolCallId, "smoke-legacy-agent");
  assert.equal(run.description, markers.description);
  assert.equal(run.profile, "work");
  assert.equal(run.status, "completed");
  assert.equal(run.result, markers.childAnswer);
  const metadata = childEntries.find((entry) => entry.type === "custom" && entry.customType === "pi-web:subagent");
  assert.equal(data.childFixture[0].parentSession, metadata.data.parentSessionPath);
  const resources = readSubagentSessionResources(childEntries);
  assert.equal(resources.loadSkills, false);
  assert.equal(resources.loadExtensions, false);
  const { messages } = buildSessionContext(childEntries);
  for (const marker of [markers.childTitle, markers.childProcess, markers.childControl, markers.childControlResult,
    markers.childTool, markers.childToolResult, markers.childNotification, markers.childAnswer]) {
    assert.ok(JSON.stringify(messages).includes(marker), `active child branch retains ${marker}`);
  }
  assert.equal(calls(messages).find((block) => block.toolName === "Agent").displayOrigin, "pi-subagents");
});

test("actual window smoke fixture covers old result provenance, native origin and child hide=false", async (t) => {
  const data = await fixtures();
  t.after(() => rm(data.directory, { recursive: true, force: true }));
  const { messages: main } = buildSessionContext(data.parentEntries);
  const { messages: child } = buildSessionContext(data.childEntries);
  const mainCalls = calls(main);
  assert.equal(mainCalls.length, 3);
  const legacy = mainCalls.find((block) => block.input.prompt === data.subagentFixture.legacyControl);
  assert.equal(legacy.displayOrigin, undefined);
  assert.equal(options(main, true).toolResults.get(legacy.toolCallId).details.kind, "pi-subagents");
  const displayed = (messages, hide) => messages.filter((message) => message.role === "assistant")
    .flatMap((message) => getDisplayableAssistantBlocks(message, options(messages, hide)))
    .filter((block) => block.type === "toolCall").map((block) => block.toolName);
  assert.deepEqual(displayed(main, true), ["read"]);
  assert.deepEqual(displayed(main, false), ["Agent", "Agent", "read"]);
  assert.deepEqual(displayed(child, false), ["Agent", "read"]);
  assert.deepEqual(displayed(child, true), ["read"]);
  for (const messages of [main, child]) {
    const notice = messages.find((message) => message.customType === "subagent-notification");
    assert.ok(notice);
    assert.equal(isDisplayableMessage(notice, options(messages, true)), false);
    assert.equal(isDisplayableMessage(notice, options(messages, false)), true);
  }
});
