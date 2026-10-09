import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "pi-runtime-settings-route-"));
const agentDir = join(root, "global");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, {
  alias: { "next/server": join(repoRoot, "desktop", "shims", "next-server.ts"), "@": repoRoot },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const globalPath = join(agentDir, "subagents.json");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

async function fixture(t, allowed = true) {
  const cwd = await mkdtemp(join(root, "project-"));
  if (allowed) allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, projectPath: join(cwd, ".pi", "subagents.json") };
}

function getRequest(cwd, scope, headers = {}) {
  const url = new URL("http://localhost/api/subagents/runtime-settings");
  if (cwd !== undefined) url.searchParams.set("cwd", cwd);
  if (scope !== undefined) url.searchParams.set("scope", scope);
  return new Request(url, { headers: { host: "localhost", ...headers } });
}

function putRequest(body, headers = {}, raw = false) {
  return new Request("http://localhost/api/subagents/runtime-settings", {
    method: "PUT",
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    body: raw ? body : JSON.stringify(body),
  });
}

async function save(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
}

test("GET defaults to global and reports both layers with effective project precedence", async (t) => {
  const { cwd, projectPath } = await fixture(t);
  let response = await GET(getRequest(cwd));
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.scope, "global");
  assert.equal(body.filePath, globalPath);
  assert.deepEqual(body.values, {});
  assert.deepEqual(body.global, {});
  assert.deepEqual(body.project, {});
  assert.equal(body.effective.fallbackSubagent, "work");
  assert.equal(body.effective.maxConcurrent, 10);
  assert.equal(Object.keys(body.effective).length, 18);
  assert.equal(Object.hasOwn(body, "legacyMaxConcurrent"), false);
  await save(join(agentDir, "agents", "settings.json"), { maxConcurrent: 17 });
  await save(globalPath, { graceTurns: 9, fallbackSubagent: false });
  await save(projectPath, { graceTurns: 3 });
  response = await GET(getRequest(cwd, "project"));
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.scope, "project");
  assert.equal(body.filePath, projectPath);
  assert.deepEqual(body.values, { graceTurns: 3 });
  assert.equal(body.effective.maxConcurrent, 17);
  assert.equal(body.legacyMaxConcurrent, 17);
  assert.equal(body.effective.graceTurns, 3);
  assert.equal(body.global.fallbackSubagent, "none");
});

test("PUT patches only the selected native layer, preserves unknown keys and supports inheritance", async (t) => {
  const { cwd, projectPath } = await fixture(t);
  await save(globalPath, { maxConcurrent: 31, unrelated: { keep: [true, null] } });
  await save(projectPath, { workflowsEnabled: false, unknown: "preserved" });
  const globalBefore = await readFile(globalPath, "utf8");
  let response = await PUT(putRequest({ cwd, scope: "project", patch: { maxConcurrent: 1024, workflowsEnabled: null, reportUsage: true } }));
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.deepEqual(body.values, { maxConcurrent: 1024, reportUsage: true });
  assert.equal(body.effective.workflowsEnabled, true);
  assert.equal(body.effective.maxConcurrent, 1024);
  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), { unknown: "preserved", maxConcurrent: 1024, reportUsage: true });
  assert.equal(await readFile(globalPath, "utf8"), globalBefore);
  response = await PUT(putRequest({ cwd, scope: "project", patch: { maxConcurrent: null } }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).effective.maxConcurrent, 31);
  response = await PUT(putRequest({ cwd, scope: "global", patch: { fallbackSubagent: "none" } }));
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.values.fallbackSubagent, "none");
  assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), { maxConcurrent: 31, unrelated: { keep: [true, null] }, fallbackSubagent: "none" });
});

test("PUT creates just the requested keys and accepts structured JSON media types", async (t) => {
  const { cwd, projectPath } = await fixture(t);
  const response = await PUT(putRequest({ cwd, scope: "project", patch: { backgroundByDefault: false } }, { "content-type": "application/vnd.pi+json; charset=utf-8", origin: "http://localhost" }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), { backgroundByDefault: false });
  assert.deepEqual(await readdir(dirname(projectPath)), ["subagents.json"]);
  await assert.rejects(readFile(globalPath), { code: "ENOENT" });
});

test("both methods require absolute existing allowed cwd directories and reject invalid scope", async (t) => {
  const { cwd } = await fixture(t);
  const denied = await fixture(t, false);
  const filePath = join(cwd, "file.txt");
  await writeFile(filePath, "file");
  for (const invalidCwd of [undefined, "", ".", "C:relative", join(cwd, "missing"), filePath]) {
    assert.equal((await GET(getRequest(invalidCwd))).status, 400);
    assert.equal((await PUT(putRequest({ cwd: invalidCwd, scope: "global", patch: {} }))).status, 400);
  }
  assert.equal((await GET(getRequest(denied.cwd))).status, 403);
  assert.equal((await PUT(putRequest({ cwd: denied.cwd, scope: "global", patch: {} }))).status, 403);
  for (const scope of ["", "builtin", "workspace", "GLOBAL"]) {
    assert.equal((await GET(getRequest(cwd, scope))).status, 400);
    assert.equal((await PUT(putRequest({ cwd, scope, patch: {} }))).status, 400);
  }
});

test("host/origin protection runs for reads and writes before accessing settings", async (t) => {
  const { cwd } = await fixture(t);
  for (const headers of [
    { host: "attacker.invalid" },
    { host: "" },
    { origin: "https://attacker.invalid" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    const getResponse = await GET(getRequest(cwd, undefined, headers));
    const putResponse = await PUT(putRequest({ cwd, scope: "global", patch: { maxConcurrent: 1 } }, headers));
    assert.equal(getResponse.status, 403);
    assert.equal(putResponse.status, 403);
    assert.match((await putResponse.json()).error, /Untrusted/);
  }
  const noHost = getRequest(cwd);
  noHost.headers.delete("host");
  assert.equal((await GET(noHost)).status, 403);
  assert.equal((await GET(getRequest(cwd, undefined, { origin: "http://localhost", "sec-fetch-site": "same-origin" }))).status, 200);
  await assert.rejects(readFile(globalPath), { code: "ENOENT" });
});

test("PUT rejects wrong content types, malformed bodies and invalid/unknown patches without mutation", async (t) => {
  const { cwd } = await fixture(t);
  await save(globalPath, { maxConcurrent: 12, keep: true });
  const before = await readFile(globalPath, "utf8");
  for (const contentType of ["text/plain", "", "application/jsonp"]) {
    assert.equal((await PUT(putRequest({}, { "content-type": contentType }))).status, 415);
  }
  for (const body of [null, [], 1, "bad", {}, { cwd, patch: {} }, { cwd, scope: "global" }, { cwd, scope: "global", patch: null }, { cwd, scope: "global", patch: [] }, { cwd, scope: "global", patch: {}, unexpected: true }]) {
    assert.equal((await PUT(putRequest(body))).status, 400);
  }
  assert.equal((await PUT(putRequest("{", {}, true))).status, 400);
  for (const patch of [{ maxConcurrent: 0 }, { maxConcurrent: 1025 }, { maxConcurrent: 1.5 }, { reportUsage: "true" }, { defaultJoinMode: "invalid" }, { fallbackSubagent: false }, { fleetView: false }, { maxConcurrent: 4, typo: true }]) {
    assert.equal((await PUT(putRequest({ cwd, scope: "global", patch }))).status, 400);
  }
  assert.equal(await readFile(globalPath, "utf8"), before);
});

test("corrupt or invalid known native configuration is reported and never overwritten", async (t) => {
  const { cwd, projectPath } = await fixture(t);
  await save(globalPath, { graceTurns: 5 });
  const globalBefore = await readFile(globalPath, "utf8");
  for (const contents of ["{bad", "[]", "null", '{"workflowsEnabled":null}', '{"maxConcurrent":0}']) {
    await save(projectPath, contents);
    const getResponse = await GET(getRequest(cwd));
    assert.equal(getResponse.status, 400);
    assert.match((await getResponse.json()).error, /Invalid/);
    assert.equal((await PUT(putRequest({ cwd, scope: "global", patch: { graceTurns: 6 } }))).status, 400);
    assert.equal(await readFile(projectPath, "utf8"), contents);
    assert.equal(await readFile(globalPath, "utf8"), globalBefore);
  }
});

test("a linked project settings directory cannot read or patch files outside the allowed cwd", async (t) => {
  const { cwd } = await fixture(t);
  const outside = await mkdtemp(join(root, "outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "subagents.json"), '{"graceTurns":8}');
  await symlink(outside, join(cwd, ".pi"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await GET(getRequest(cwd, "project"))).status, 403);
  assert.equal((await PUT(putRequest({ cwd, scope: "project", patch: { graceTurns: 9 } }))).status, 403);
  assert.equal(await readFile(join(outside, "subagents.json"), "utf8"), '{"graceTurns":8}');
});
