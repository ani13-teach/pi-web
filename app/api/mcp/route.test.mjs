import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, PUT, POST } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");
const { MCP_REDACTED } = await jiti.import("../../../lib/mcp-types.ts");
function request(method = "GET", body, query = "", headers = {}) { return new Request("http://localhost/api/mcp" + query, { method, headers: { host: "localhost", ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-route-")); const agentDir = join(root, "agent"); await mkdir(agentDir);
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const registry = globalThis.__piSessions; globalThis.__piSessions = new Map(); allowFileRoot(root);
  t.after(async () => { globalThis.__piSessions = registry; if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; globalThis.__piAdditionalAllowedRoots?.delete(root.replace(/\\/g, "/")); globalThis.__piAllowedRootsCache = undefined; await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, agentDir, query: "?cwd=" + encodeURIComponent(root) };
}
test("global no-session CRUD uses revisions, masks credentials, preserves unknown fields and detects external writes", async t => {
  const f = await fixture(t);
  const configPath = join(f.agentDir, "mcp.json");
  await writeFile(configPath, JSON.stringify({ vendor: { keep: 1 }, mcpServers: { remote: { url: "https://fixture.invalid/mcp", headers: { Authorization: "Bearer test-secret" } } } }));
  let response = await GET(request()); let body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.session, null); assert.equal(body.config.project, null);
  assert.equal(body.config.global.servers[0].config.headers.Authorization, MCP_REDACTED); assert.ok(!JSON.stringify(body).includes("test-secret"));
  const revision = body.config.global.revision;
  response = await PUT(request("PUT", { scope: "global", revision, operation: "upsert", name: "remote", config: { enabled: false, headers: { Authorization: MCP_REDACTED } } }));
  assert.equal(response.status, 200);
  const saved = JSON.parse(await readFile(configPath, "utf8")); assert.equal(saved.vendor.keep, 1); assert.equal(saved.mcpServers.remote.headers.Authorization, "Bearer test-secret"); assert.equal(saved.mcpServers.remote.enabled, false);
  response = await PUT(request("PUT", { scope: "global", revision, operation: "delete", name: "remote" })); assert.equal(response.status, 409);
  body = await (await GET(request())).json();
  response = await PUT(request("PUT", { scope: "global", revision: body.config.global.revision, operation: "delete", name: "remote" })); assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).mcpServers, {});
});
test("untrusted project is not read or edited; trusted exact-name override does not expose global credentials", async t => {
  const f = await fixture(t); await mkdir(join(f.root, ".pi"));
  await writeFile(join(f.root, ".pi/mcp.json"), JSON.stringify({ mcpServers: { private: { command: "SECRET_PROJECT" } } }));
  await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "fixture", env: { TOKEN: "test-secret" } } } }));
  let body = await (await GET(request("GET", null, f.query))).json(); assert.equal(body.projectTrusted, false); assert.deepEqual(body.config.project.servers, []);
  let response = await PUT(request("PUT", { scope: "project", revision: body.config.global.revision, operation: "upsert", name: "shared", config: { enabled: false } }, f.query)); assert.equal(response.status, 403);
  new ProjectTrustStore(f.agentDir).set(f.root, true);
  body = await (await GET(request("GET", null, f.query))).json(); assert.equal(body.projectTrusted, true);
  response = await PUT(request("PUT", { scope: "project", revision: body.config.project.revision, operation: "upsert", name: "shared", config: { enabled: false } }, f.query)); assert.equal(response.status, 200);
  const project = JSON.parse(await readFile(join(f.root, ".pi/mcp.json"), "utf8")); assert.deepEqual(project.mcpServers.shared, { enabled: false });
});
test("host/origin/content-type/path checks and dormant actions fail without starting sessions", async t => {
  const f = await fixture(t);
  assert.equal((await GET(request("GET", null, "", { host: "evil.invalid" }))).status, 403);
  assert.equal((await PUT(request("PUT", { scope: "global" }, "", { origin: "https://evil.invalid", "sec-fetch-site": "cross-site" }))).status, 403);
  assert.equal((await PUT(request("PUT", {}, "", { "content-type": "text/plain" }))).status, 415);
  assert.equal((await GET(request("GET", null, "?cwd=relative"))).status, 400);
  assert.equal((await POST(request("POST", { action: "apply", sessionId: "not-running" }, f.query))).status, 409);
  assert.equal(globalThis.__piSessions.size, 0);
  assert.equal((await PUT(request("PUT", { large: "中".repeat(90000) }))).status, 413);
  assert.equal((await PUT(request("PUT", {}, "", { "content-length": "262145" }))).status, 413);
  let canceled = false;
  const oversized = new Request("http://localhost/api/mcp", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" }, duplex: "half", body: new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel() { canceled = true; } }) });
  assert.equal((await PUT(oversized)).status, 413); assert.equal(canceled, true);
  const dormant = await (await GET(request("GET", null, f.query + "&sessionId=not-running"))).json(); assert.equal(dormant.session.runtimeActive, false); assert.equal(dormant.session.pending, true);
  await writeFile(join(f.agentDir, "mcp.json"), '{"secret-parser-fragment":"DO_NOT_ECHO",');
  const body = await (await GET(request())).json(); assert.ok(body.config.global.error); assert.ok(!JSON.stringify(body).includes("DO_NOT_ECHO"));
});
