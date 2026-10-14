/** Real compiled desktop IPC, isolated configuration and local MCP process. No model requests. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = await mkdtemp(join(tmpdir(), "pi-mcp-ipc-")), agentDir = join(sandbox, "agent"), project = join(sandbox, "project");
await Promise.all([mkdir(join(agentDir, "sessions", "fixture"), { recursive: true }), mkdir(project)]);
const ledger = join(sandbox, "ledger.txt");
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], retry: { enabled: false }, compaction: { enabled: false } }));
const config = { mcpServers: { fixture: { command: process.execPath, args: [join(root, "tests/fixtures/mcp-server.cjs"), ledger], env: { FIXTURE_SECRET: "masked-test-secret" } } } };
await writeFile(join(agentDir, "mcp.json"), JSON.stringify(config));
const id = randomUUID(), timestamp = new Date().toISOString();
await writeFile(join(agentDir, "sessions/fixture/history.jsonl"), [
  { type: "session", version: 3, id, cwd: project, timestamp },
  { type: "message", id: "fixture-user", parentId: null, timestamp, message: { role: "user", content: "Local MCP fixture only", timestamp: Date.now() } },
].map(entry => JSON.stringify(entry)).join("\n") + "\n");
const env = { ...process.env };
for (const key of Object.keys(env)) if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|CLIENT_KEY|NPM_CONFIG_USERCONFIG|^(?:PI_|XDG_|OPENAI|ANTHROPIC|GOOGLE|GEMINI|AWS_|AZURE_|GCP_|CLOUDSDK_|VERTEX_))/i.test(key)) delete env[key];
Object.assign(env, { HOME: sandbox, USERPROFILE: sandbox, APPDATA: join(sandbox, "roaming"), LOCALAPPDATA: join(sandbox, "local"), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_WEB_IDLE_TIMEOUT_MS: "0" });
const child = fork(join(root, "dist/main/backend.mjs"), [], { cwd: project, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
const pending = new Map(); let stderr = "", exit; let passed = 0;
child.stdout.on("data", () => {}); child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-12000); });
const exited = new Promise(resolveExit => child.once("exit", (code, signal) => { exit = { code, signal }; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Backend exited: " + JSON.stringify(exit))); } pending.clear(); resolveExit(exit); }));
child.on("message", message => {
  if (message?.kind === "proxy.query") { child.send({ kind: "proxy.result", id: message.id, ok: true, value: "DIRECT" }); return; }
  if (message?.kind !== "response") return; const value = message.envelope, item = pending.get(value.id); if (!item) return;
  clearTimeout(item.timer); pending.delete(value.id); if (value.ok) item.resolve(value.result); else item.reject(new Error(value.error));
});
function call(method, params = {}) { return new Promise((resolveCall, reject) => { const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error("IPC timeout: " + method)); }, 20000); pending.set(id, { resolve: resolveCall, reject, timer }); child.send({ kind: "request", envelope: { id, method, params } }); }); }
async function request(url, method = "GET", body) { const response = await call("http.request", { url, method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64") }) }); const text = Buffer.from(response.bodyBase64 ?? "", "base64").toString("utf8"); return { ...response, json: text ? JSON.parse(text) : undefined }; }
function check(name, condition) { assert.ok(condition, name); passed++; console.log("PASS " + name); }
const query = "?cwd=" + encodeURIComponent(project) + "&sessionId=" + id;
try {
  check("compiled backend uses isolated agent root", resolve((await call("app.info")).agentDir) === resolve(agentDir));
  check("workspace registered", (await request("/api/cwd/validate", "POST", { cwd: project })).status === 200);
  const cold = await request("/api/mcp" + query); check("MCP GET does not wake dormant history", cold.status === 200 && cold.json.session.runtimeActive === false);
  const activation = await request("/api/agent/" + id, "POST", { type: "ensure_session" }); check("real desktop session binds default extensions", activation.status === 200);
  let state = await request("/api/mcp" + query, "POST", { action: "check", sessionId: id });
  check("default compiled MCP connects", state.status === 200 && state.json.session.provider === "builtin" && state.json.session.snapshot.servers[0].state === "connected");
  check("all fixture tools discovered with indirect exposure", state.json.session.snapshot.servers[0].tools.length === 2 && state.json.session.snapshot.servers[0].tools.every(tool => tool.exposure === "codemode"));
  check("credentials and arguments masked over IPC", !JSON.stringify(state.json).includes("masked-test-secret") && state.json.config.global.servers[0].config.args === "__PI_DESKTOP_REDACTED__");
  check("check makes no business call", !(await readFile(ledger, "utf8")).includes("tools/call"));
  await request("/api/agent/" + id, "POST", { type: "set_tools", toolNames: ["read", "grep"] });
  const tools = await request("/api/agent/" + id, "POST", { type: "get_tools" });
  check("preset keeps discovery but not direct MCP declarations", tools.json.data.some(tool => tool.name === "codemode" && tool.active) && !tools.json.data.some(tool => tool.name.startsWith("mcp__") && tool.active));
  const generation = state.json.session.generation;
  const mutation = { scope: "global", revision: state.json.config.global.revision, operation: "upsert", name: "fixture", config: { enabled: false } };
  state = await request("/api/mcp" + query, "PUT", mutation);
  check("save marks pending without stopping active connection", state.status === 200 && state.json.session.pending && state.json.session.snapshot.servers[0].state === "connected");
  check("stale save rejected", (await request("/api/mcp" + query, "PUT", mutation)).status === 409);
  state = await request("/api/mcp" + query, "POST", { action: "apply", sessionId: id });
  check("applying saved disable updates current generation and state", state.status === 200 && state.json.session.generation > generation && !state.json.session.pending && state.json.session.snapshot.servers[0].state === "disabled");
  const before = state.json.session.generation;
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify(config));
  state = await request("/api/mcp" + query);
  check("external editor change detected without reconnect", state.json.session.pending && state.json.session.generation === before && state.json.session.snapshot.servers[0].state === "disabled");
  state = await request("/api/mcp" + query, "POST", { action: "apply", sessionId: id });
  state = await request("/api/mcp" + query, "POST", { action: "check", sessionId: id });
  check("explicit apply reconnects", state.status === 200 && !state.json.session.pending && state.json.session.snapshot.servers[0].state === "connected");
  check("no hidden business test ran", !(await readFile(ledger, "utf8")).includes("tools/call"));
  check("graceful backend shutdown completes", (await call("backend.shutdown")).closed === true);
  let timer; try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Backend did not exit")), 10000); })]); } finally { clearTimeout(timer); }
  check("backend exits normally", exit.code === 0);
  console.log(passed + "/" + passed + " MCP desktop IPC checks passed (no model requests)");
} catch (error) { console.error(error); if (stderr) console.error(stderr); process.exitCode = 1; }
finally { if (!exit) child.kill(); await exited; for (const item of pending.values()) clearTimeout(item.timer); if (process.exitCode) console.error("Retained isolated fixture: " + sandbox); else await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
