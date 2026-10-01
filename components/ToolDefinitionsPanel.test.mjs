import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ToolDescription } = await jiti.import("./ToolDefinitionsPanel.tsx");

const panelSource = await readFile(new URL("./ToolDefinitionsPanel.tsx", import.meta.url), "utf8");
const systemSource = await readFile(new URL("./SystemPromptPanel.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("keeps System and Tools in separate adjacent toolbar actions", () => {
  assert.match(appShellSource, /handleSystemInfoToggle\("system", mobile\)[\s\S]*?handleSystemInfoToggle\("tools", mobile\)/);
  assert.match(appShellSource, /activeTopPanel === "system"[\s\S]*?<SystemPromptPanel/);
  assert.match(appShellSource, /activeTopPanel === "tools"[\s\S]*?<ToolDefinitionsPanel/);
  assert.doesNotMatch(systemSource, /ToolEntry|tools/);
  assert.doesNotMatch(systemSource, /system-prompt-heading/);
  assert.doesNotMatch(panelSource, /tool-definitions-heading/);
});

test("renders active tool definitions in a selectable master-detail layout", () => {
  assert.match(panelSource, /tools\?\.filter\(\(tool\) => tool\.active\)/);
  assert.match(panelSource, /setSelectedToolName\(tool\.name\)/);
  assert.match(panelSource, /activeTools\?\.some\(\(tool\) => tool\.name === current\)/);
  assert.match(panelSource, /className="tool-definitions-sidebar"/);
  assert.match(panelSource, /className="tool-definition-detail"/);
  assert.match(panelSource, /grid-template-columns: clamp\(112px, 26%, 220px\) minmax\(0, 1fr\)/);
});

test("shows schema fields and metadata in the detail form", () => {
  assert.match(panelSource, /parameters\.properties/);
  assert.match(panelSource, /parameters\.required/);
  assert.match(panelSource, /field\.allowedValues/);
  assert.match(panelSource, /field\.defaultValue/);
  assert.match(panelSource, /selectedTool\.promptGuidelines/);
});

test("built-in Agent model descriptions display channels without mutating the registered text", () => {
  const description = "Delegate a focused task to a configured subagent. Details.\n\nAvailable agent types:\n"
    + "- reviewer: Review code (Tools: read, bash; Model: 哈尔/vendor/shared-id)\n"
    + "- worker: Write code (Tools: edit; Model: legacy-id)";
  const html = renderToStaticMarkup(React.createElement(ToolDescription, { name: "Agent", description }));
  assert.match(html, /title="vendor\/shared-id \(哈尔\)"/);
  assert.match(html, />\(哈尔\)<\/span>/);
  assert.ok(html.includes("Model: legacy-id)"));
  assert.ok(description.includes("Model: 哈尔/vendor/shared-id)"));
  assert.ok(!description.includes("shared-id (哈尔)"));
});

test("ordinary tool and extension descriptions stay as original free text", () => {
  for (const [name, description] of [
    ["other", "Model: relay/model-id"],
    ["Agent", "An external agent.\n- reviewer: Review (Tools: read; Model: relay/model-id)"],
    ["read", "Delegate a focused task to a configured subagent.\n- reviewer: Review (Tools: read; Model: relay/model-id)"],
  ]) {
    assert.equal(renderToStaticMarkup(React.createElement(ToolDescription, { name, description })), description);
  }
});

test("preserves the two-column layout on narrow screens", () => {
  assert.match(
    panelSource,
    /@media \(max-width: 640px\)[\s\S]*?\.tool-definitions-panel \{[\s\S]*?grid-template-columns: 112px minmax\(0, 1fr\)/,
  );
  assert.doesNotMatch(panelSource, /@media \(max-width: 640px\)[\s\S]*?\.tool-definitions-panel \{[\s\S]*?display: block/);
});
