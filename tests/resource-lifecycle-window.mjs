/** Run the existing full window probe with an isolated, offline-only fixture. */
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of ["dist/main/main.cjs", "dist/main/backend.mjs", "dist/renderer/index.html"]) {
  if (!existsSync(join(root, file))) throw new Error(`Missing ${file}; run npm run build first`);
}
const sandbox = await mkdtemp(join(tmpdir(), "pi-resource-window-"));
for (const name of ["agent", "roaming", "local", "profile"]) await mkdir(join(sandbox, name));
await writeFile(join(sandbox, "agent/settings.json"), JSON.stringify({ packages: [] }));
// Availability is a local catalogue property. This non-secret key never leaves
// the fixture; no prompt is sent, and its URL cannot reach a real provider.
await writeFile(join(sandbox, "agent/models.json"), JSON.stringify({
  providers: {
    "offline-fixture": {
      baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "offline-fixture-not-a-real-key",
      models: [{
        id: "fixture-model", name: "Offline fixture model", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024,
      }],
    },
  },
}));
const env = {
  ...process.env,
  HOME: sandbox, USERPROFILE: sandbox, APPDATA: join(sandbox, "roaming"), LOCALAPPDATA: join(sandbox, "local"),
  PI_CODING_AGENT_DIR: join(sandbox, "agent"), PI_DESKTOP_SMOKE_USERDATA: join(sandbox, "profile"),
  PI_OFFLINE: "1", PI_TELEMETRY: "0",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_DESKTOP_SCENARIO;
const child = spawn(process.execPath, [join(root, "scripts/smoke-window.mjs"), "--project", root], {
  cwd: sandbox, env, stdio: "inherit",
});
let timedOut = false;
const timer = setTimeout(() => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  timedOut = true;
  console.error("Window test timed out; terminating only its owned process tree");
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); }
  catch { child.kill(); }
}, 90_000);
try {
  const [code, signal] = await once(child, "close");
  if (timedOut || code !== 0) {
    console.error(`Window test failed: code=${code}, signal=${signal}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (process.exitCode) console.error(`Diagnostics fixture retained at ${sandbox}`);
  else await rm(sandbox, { recursive: true, force: true });
}
