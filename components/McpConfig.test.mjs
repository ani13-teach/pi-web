import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transform } from "esbuild";
import { createJiti } from "jiti";

const source = await readFile(new URL("./McpConfig.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const { MCP_REDACTED } = await jiti.import("../lib/mcp-types.ts");
// Execute only the real pure helper segment, not a component or personal configuration.
const helpers = source.slice(source.indexOf("export type McpDraft"), source.indexOf("// End pure renderer helpers."));
const { code } = await transform(`const MCP_REDACTED = ${JSON.stringify(MCP_REDACTED)};\n${helpers}`, { loader: "ts", format: "esm" });
const { mcpDraftFrom, buildMcpConfig, mcpReady, mcpLastCall, mcpApiUrl, createMcpRequestGate, mcpHttpError, mcpEnvironment, updateMcpEnvironment, mcpAdvancedConfigText, mergeMcpAdvancedConfig } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const session = { runtimeActive: true, provider: "builtin", activeTools: ["codemode"] };
const server = { name: "fixture", enabled: true, state: "connected", exposure: "codemode", tools: [{ name: "ping", exposure: "codemode" }], hasResources: false };

test("MCP readiness distinguishes connection, exposure, active tools and external providers", () => {
  assert.equal(mcpReady(server, session), true);
  for (const state of ["starting", "connecting", "disconnected", "needs-auth", "failed", "closed", "disabled"]) {
    assert.equal(mcpReady({ ...server, state }, session), false);
  }
  assert.equal(mcpReady({ ...server, exposure: "hidden", tools: [{ name: "ping", exposure: "hidden" }] }, session), false);
  assert.equal(mcpReady({ ...server, enabled: false }, session), false);
  assert.equal(mcpReady(server, { ...session, runtimeActive: false }), false);
  for (const provider of ["external", "disabled", "unloaded"]) assert.equal(mcpReady(server, { ...session, provider }), false);
  assert.equal(mcpReady(server, null), false);
  assert.equal(mcpReady({ ...server, tools: [{ ...server.tools[0], callable: false }] }, session), false);
  assert.equal(mcpReady({ ...server, tools: [], hasResources: true, resourcesCallable: false }, session), false);
  assert.equal(mcpReady(server, { ...session, activeTools: [] }), false);
  assert.equal(mcpReady(server, { ...session, activeTools: ["tool_search"] }), true);
  const direct = { ...server, exposure: "direct", tools: [{ name: "fixture_tool", exposure: "direct" }] };
  assert.equal(mcpReady(direct, { ...session, activeTools: ["fixture_tool"] }), true);
  assert.equal(mcpReady(direct, { ...session, activeTools: ["other"] }), false);
  assert.equal(mcpReady({ ...server, tools: [] }, session), false);
  assert.equal(mcpReady({ ...server, exposure: "hidden", tools: [{ name: "ping", exposure: "direct" }] }, { ...session, activeTools: ["ping"] }), true);
  assert.equal(mcpReady({ ...server, tools: [], hasResources: true, resourceCount: 2 }, { ...session, activeTools: [] }), false);
  assert.equal(mcpReady({ ...server, tools: [], hasResources: true }, session), true);
});

test("business verification is independent of connected/ready state", () => {
  assert.equal(mcpLastCall(server), "unverified");
  assert.equal(mcpLastCall({ ...server, lastCall: { at: 1, success: true } }), "success");
  assert.equal(mcpLastCall({ ...server, lastCall: { at: 1, success: false } }), "failure");
});

test("sensitive placeholders survive edits without revealing or replacing credentials", () => {
  const original = { name: "remote", overrideOnly: false, config: { url: MCP_REDACTED, headers: { Authorization: MCP_REDACTED }, transport: "http", enabled: false, exposure: "hidden" } };
  const draft = mcpDraftFrom(original);
  assert.equal(draft.endpoint, "");
  assert.equal(draft.transport, "url");
  assert.equal(draft.enabled, false);
  const saved = buildMcpConfig({ ...draft, exposure: "direct" }, original);
  assert.equal(saved.config.url, MCP_REDACTED);
  assert.equal(saved.config.headers.Authorization, MCP_REDACTED);
  assert.equal(saved.config.transport, "http");
  assert.equal(saved.config.exposure, "direct");
  assert.equal(buildMcpConfig({ ...draft, endpoint: "https://fixture.invalid/mcp" }, original).config.url, "https://fixture.invalid/mcp");
  const local = { name: "local", config: { command: "node", args: MCP_REDACTED }, overrideOnly: false };
  assert.equal(buildMcpConfig(mcpDraftFrom(local), local).config.args, MCP_REDACTED);
  assert.deepEqual(buildMcpConfig({ ...mcpDraftFrom(local), args: "[]" }, local).config.args, []);
  assert.match(source, /placeholder=\{original\?\.config\[draft\.transport\] === MCP_REDACTED \? t\("mcp.secretPlaceholder"\)/);
});

test("JSON validation rejects malformed, mixed, unsafe and non-string values", () => {
  const draft = { ...mcpDraftFrom(), name: "fixture", endpoint: "fixture-command", args: '["--one", "two words"]' };
  const good = buildMcpConfig(draft);
  assert.deepEqual(good.config.args, ["--one", "two words"]);
  assert.equal(buildMcpConfig({ ...draft, args: "{" }).error, "jsonInvalid");
  assert.equal(buildMcpConfig({ ...draft, args: "[1]" }).error, "argsInvalid");
  assert.equal(buildMcpConfig({ ...draft, advanced: "[]" }).error, "advancedInvalid");
  assert.equal(buildMcpConfig({ ...draft, advanced: '{"env":{"TOKEN":null}}' }).error, "advancedInvalid");
  assert.equal(buildMcpConfig({ ...draft, advanced: '{"headers":[]}' }).error, "advancedInvalid");
  assert.equal(buildMcpConfig({ ...draft, advanced: '{"__proto__":{"polluted":true}}' }).error, "advancedInvalid");
  assert.equal(buildMcpConfig({ ...draft, advanced: '{"url":"https://fixture.invalid"}' }).error, "advancedReserved");
  assert.equal(buildMcpConfig({ ...draft, endpoint: "" }).error, "endpointRequired");
  const original = { name: "local", overrideOnly: false, config: { command: "fixture" } };
  assert.equal(buildMcpConfig({ ...draft, transport: "url" }, original).error, "transportLocked");
  assert.equal(buildMcpConfig(draft, { ...original, config: { command: "fixture", url: "https://fixture.invalid" } }).error, "transportLocked");
});

test("override-only configuration can disable inherited server without adding a transport", () => {
  const original = { name: "inherited", overrideOnly: true, config: { enabled: true } };
  const { config } = buildMcpConfig({ ...mcpDraftFrom(original), enabled: false }, original);
  assert.equal(config.enabled, false);
  assert.equal("command" in config, false);
  assert.equal("url" in config, false);
});

test("environment form preserves redacted credentials, other variables and unknown configuration", () => {
  const advanced = JSON.stringify({ env: { API_KEY: MCP_REDACTED, LOG_LEVEL: "info" }, timeout: 30000, custom: { keep: true } });
  assert.deepEqual(mcpEnvironment(advanced), [["API_KEY", MCP_REDACTED], ["LOG_LEVEL", "info"]]);
  const next = JSON.parse(updateMcpEnvironment(advanced, "LOG_LEVEL", "debug"));
  assert.deepEqual(next, { env: { API_KEY: MCP_REDACTED, LOG_LEVEL: "debug" }, timeout: 30000, custom: { keep: true } });
  assert.equal(JSON.parse(updateMcpEnvironment(advanced, "NEW_VALUE", "new-secret")).env.NEW_VALUE, "new-secret");
  assert.equal(updateMcpEnvironment(updateMcpEnvironment(JSON.stringify(JSON.parse(advanced), null, 2), "API_KEY", "temporary"), "API_KEY", MCP_REDACTED), JSON.stringify(JSON.parse(advanced), null, 2));
  for (const invalid of ["{", "null", "[]", '{"env":null}', '{"env":{"TOKEN":5}}']) assert.equal(mcpEnvironment(invalid), null);
  assert.deepEqual(mcpEnvironment("{}"), []);
  for (const key of ["", "__proto__", "constructor", "prototype"]) assert.equal(updateMcpEnvironment(advanced, key, "x"), null);
  assert.equal(updateMcpEnvironment("{", "TOKEN", "x"), null);
});

test("advanced editor omits environment values and merges them back without losing secrets", () => {
  const original = JSON.stringify({ env: { TOKEN: "new-sensitive-value", API_KEY: MCP_REDACTED }, timeout: 30000, headers: { Authorization: MCP_REDACTED } });
  const text = mcpAdvancedConfigText(original);
  assert.equal(text.includes("new-sensitive-value"), false);
  assert.equal("env" in JSON.parse(text), false);
  const merged = JSON.parse(mergeMcpAdvancedConfig(JSON.stringify({ ...JSON.parse(text), timeout: 45000 }), original));
  assert.deepEqual(merged.env, { TOKEN: "new-sensitive-value", API_KEY: MCP_REDACTED });
  assert.equal(merged.timeout, 45000);
  assert.equal(merged.headers.Authorization, MCP_REDACTED);
  assert.equal(buildMcpConfig({ ...mcpDraftFrom(), endpoint: "python", advanced: JSON.stringify(merged) }).config.env.TOKEN, "new-sensitive-value");
  for (const invalid of ["{", "null", "[]", '{"env":{}}', '{"constructor":{}}', '{"custom":{"__proto__":{}}}']) assert.equal(mergeMcpAdvancedConfig(invalid, original), null);
  assert.equal(mcpAdvancedConfigText("{"), "{");
});

test("API query omits absent project and session, encodes explicit values", () => {
  assert.equal(mcpApiUrl(null, null), "/api/mcp");
  assert.equal(mcpApiUrl(null, "s + 1"), "/api/mcp?sessionId=s+%2B+1");
  const query = new URL(mcpApiUrl("C:/fixture & space", "session"), "https://fixture.invalid").searchParams;
  assert.equal(query.get("cwd"), "C:/fixture & space");
  assert.equal(query.get("sessionId"), "session");
});

test("request generation aborts and drops stale responses even if a transport ignores abort", async () => {
  const gate = createMcpRequestGate();
  const old = gate.next();
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  let accepted = null;
  const pending = response.then((value) => { if (old.isCurrent()) accepted = value; });
  const current = gate.next();
  assert.equal(old.signal.aborted, true);
  assert.equal(old.isCurrent(), false);
  assert.equal(current.isCurrent(), true);
  release("old scope/session");
  await pending;
  assert.equal(accepted, null);
  gate.cancel();
  assert.equal(current.signal.aborted, true);
  assert.equal(current.isCurrent(), false);
  assert.equal(gate.next().isCurrent(), true);
});

test("conflict and remote errors never expose arbitrary HTTP contents", () => {
  assert.equal(mcpHttpError(409), "conflict");
  for (const code of [400, 401, 403, 500, 502]) assert.equal(mcpHttpError(code), "requestFailed");
  assert.doesNotMatch(source, /console\.|sendAgentCommand|data\.error|response\.text\(/);
  assert.match(source, /error !== "conflict"/);
});

test("scope/session isolation, draft-safe polling and serialized writes are wired into the component", () => {
  assert.match(source, /key=\{JSON\.stringify\(\[props\.cwd, props\.sessionId, effectiveScope\]\)\}/);
  assert.match(source, /if \(!active\) return/);
  assert.match(source, /clearTimeout\(timer\); gate\.current\.cancel\(\)/);
  assert.match(source, /setTimeout\(\(\) => void poll\(\), 2000\)/);
  const accept = source.slice(source.indexOf("const accept ="), source.indexOf("const load ="));
  assert.doesNotMatch(accept, /setDraft|setOriginal|setRevision/);
  assert.match(source, /if \(lock\.current \|\| !mounted\.current\) return/);
  assert.match(source, /lock\.current = true/);
  assert.match(source, /if \(!request\.isCurrent\(\) \|\| !mounted\.current\) return/);
  assert.match(source, /view\?\.servers\.some\(\(item\) => item\.name === name\)/);
  assert.match(source, /revision, name: original\?\.name \?\? name/);
});

test("English and Chinese cover all literal MCP labels and all dynamic status families", async () => {
  const { mcpMessages } = await jiti.import("../lib/i18n/messages/mcp.ts");
  const en = mcpMessages("en");
  const zh = mcpMessages("zh-CN");
  assert.deepEqual(Object.keys(en), Object.keys(zh));
  for (const match of source.matchAll(/t\("(mcp\.[^"]+)"/g)) assert.ok(en[match[1]], match[1]);
  for (const key of ["source.global", "source.project", "source.extension", "lastCall.unverified", "lastCall.success", "lastCall.failure", "deleteConfirm", "applyConfirm", "retryConfirm", ...["builtin", "external", "disabled", "unloaded"].map((s) => `provider.${s}`), ...["idle", "queued", "applying", "failed"].map((s) => `applyState.${s}`)]) {
    assert.ok(en[`mcp.${key}`], key);
    assert.ok(zh[`mcp.${key}`], key);
  }
});
