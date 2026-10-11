import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import vm from "node:vm";
import test from "node:test";
import { build } from "esbuild";

// Each bundle has a fresh registry and launch gate. The child_process shim only
// records real handles; successful lifecycle tests still run the installed npx.
async function npxFixture({ failCleanup = false } = {}) {
  const source = await readFile(new URL("../lib/npx.ts", import.meta.url), "utf8");
  const result = await build({
    stdin: { contents: source + '\nexport { children as fixtureChildren } from "child_process";',
      loader: "ts", resolveDir: resolve("lib") },
    bundle: true, write: false, format: "esm", platform: "node",
    plugins: [{ name: "record-children", setup(builder) {
      builder.onResolve({ filter: /^child_process$/ }, () => ({ path: "children", namespace: "fixture" }));
      builder.onLoad({ filter: /^children$/, namespace: "fixture" }, () => ({ contents: `
        import { execFile as realExecFile } from "node:child_process";
        export const children = [];
        export function execFile(command, args, options, callback) {
          const child = ${failCleanup
            ? 'realExecFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options, callback)'
            : 'realExecFile(command, args, options, callback)'};
          children.push(child);
          return child;
        }
      ` }));
      if (failCleanup) {
        builder.onResolve({ filter: /process-tree\.ts$/ }, () => ({ path: "tree", namespace: "fixture" }));
        builder.onLoad({ filter: /^tree$/, namespace: "fixture" }, () => ({
          contents: 'export async function terminateProcessTree() { throw new Error("tree capture failed"); }',
        }));
      }
    } }],
  });
  // A unique URL prevents Node from caching an earlier stopping registry.
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${randomUUID()}`);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-npx-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const userconfig = join(dir, "user.npmrc"), globalconfig = join(dir, "global.npmrc");
  await Promise.all([writeFile(userconfig, ""), writeFile(globalconfig, "")]);
  const env = { ...process.env, npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
    npm_config_cache: join(dir, "cache"), npm_config_offline: "true", npm_config_update_notifier: "false",
    npm_config_audit: "false", npm_config_fund: "false" };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = dirname(process.execPath) + delimiter + (env[pathKey] ?? "");
  const script = join(dir, "task.cjs");
  await writeFile(script, `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    if (process.argv[2] === "output") {
      process.stdout.write("local stdout"); process.stderr.write("local stderr");
    } else {
      const depth = Number(process.argv[2] || 0);
      writeFileSync(join(__dirname, "pid-" + process.pid + ".json"), JSON.stringify({ pid: process.pid, ppid: process.ppid }));
      if (depth < 2) spawn(process.execPath, [__filename, String(depth + 1)], { stdio: "ignore", windowsHide: true });
      setInterval(() => {}, 1000);
    }
  `);
  return { dir, script, opts: { cwd: dir, env } };
}

// npm exec builds its own shell command, with fragile Program Files quoting.
// --call avoids package-name inference; this sandbox's PATH selects the SAME
// installed runtime by basename, and cwd resolves the owned fixture task.
// runNpx itself still uses execFile without a shell; no production code changes.
function taskArgs(box, mode = "") {
  return ["--offline", "--call", `${basename(process.execPath)} ${basename(box.script)}${mode ? ` ${mode}` : ""}`];
}

async function runningTree(t, fixture, { timeout } = {}) {
  const box = await sandbox(t);
  const controller = new AbortController();
  const result = fixture.runNpx(taskArgs(box), {
    ...box.opts, signal: controller.signal, timeout,
  });
  // Handle rejection immediately, even when startup itself fails.
  const outcome = result.then(value => ({ value }), error => ({ error }));
  const root = fixture.fixtureChildren[0];
  let pids = [];
  t.after(async () => {
    controller.abort();
    await fixture.stopNpxProcesses().catch(() => {});
    // Failure-path cleanup is confined to the handles and fixture PIDs we own.
    for (const pid of pids) { if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} } }
    if (root && root.exitCode === null && root.signalCode === null) root.kill("SIGKILL");
  });
  await waitFor(async () => {
    const names = (await readdir(box.dir)).filter(name => name.startsWith("pid-"));
    const records = await Promise.all(names.map(async name => JSON.parse(await readFile(join(box.dir, name), "utf8"))));
    pids = [...new Set(records.flatMap(record => [record.pid, record.ppid]))];
    if (records.length >= 3) return true;
    const early = await Promise.race([outcome, Promise.resolve(null)]);
    if (early) assert.fail(`npx exited before starting its local tree: ${early.error?.stack ?? JSON.stringify(early.value)}`);
    return false;
  }, "three local task generations");
  return { controller, root, pids: [...new Set([root.pid, ...pids])], outcome };
}

async function assertTreeGone(tree) {
  // The shared helper deliberately guarantees only root SIGKILL off Windows.
  // Fixture descendants there are still reaped by runningTree's cleanup hook.
  const expected = process.platform === "win32" ? tree.pids : [tree.root.pid];
  await waitFor(() => expected.every(pid => !alive(pid)), `task tree to exit (${expected.join(", ")})`);
  assert.ok((await tree.outcome).error, "cancelled requests reject");
}

test("real offline npx preserves stdout/stderr and removes abort listeners on success", async t => {
  const fixture = await npxFixture();
  const box = await sandbox(t);
  const controller = new AbortController();
  let listeners = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { listeners++; return add(...args); };
  controller.signal.removeEventListener = (...args) => { listeners--; return remove(...args); };
  const result = await fixture.runNpx(taskArgs(box, "output"), {
    ...box.opts, signal: controller.signal, timeout: 10_000,
  });
  assert.equal(result.stdout, "local stdout");
  assert.equal(result.stderr, "local stderr");
  assert.equal(listeners, 0);
  controller.abort();
  await fixture.stopNpxProcesses();
});

test("an already aborted request never starts npx", async () => {
  const fixture = await npxFixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fixture.runNpx(["--version"], { signal: controller.signal }), { name: "AbortError" });
  assert.equal(fixture.fixtureChildren.length, 0);
});

test("abort clears a real offline npx tree before rejecting", { timeout: 30_000 }, async t => {
  const fixture = await npxFixture();
  const tree = await runningTree(t, fixture);
  tree.controller.abort();
  const { error } = await tree.outcome;
  assert.equal(error.name, "AbortError");
  await assertTreeGone(tree);
});

test("timeout clears a real offline npx tree before rejecting", { timeout: 30_000 }, async t => {
  const fixture = await npxFixture();
  const tree = await runningTree(t, fixture, { timeout: 5_000 });
  const { error } = await tree.outcome;
  assert.equal(error.code, "ETIMEDOUT");
  await assertTreeGone(tree);
});

test("shutdown seals launches synchronously, drains registered trees and is idempotent", { timeout: 30_000 }, async t => {
  const fixture = await npxFixture();
  const tree = await runningTree(t, fixture);
  const first = fixture.stopNpxProcesses();
  const second = fixture.stopNpxProcesses();
  assert.equal(first, second);
  await assert.rejects(fixture.runNpx(["--version"]), /shutting down/);
  assert.equal(fixture.fixtureChildren.length, 1);
  await first;
  await assertTreeGone(tree);
});

test("tree cleanup failure kills the root, rejects cancellation and remains visible to shutdown", async t => {
  const fixture = await npxFixture({ failCleanup: true });
  const controller = new AbortController();
  const request = fixture.runNpx(["--version"], { signal: controller.signal });
  const rejected = assert.rejects(request, /failed to clean its process tree/);
  const root = fixture.fixtureChildren[0];
  t.after(() => { if (root.exitCode === null && root.signalCode === null) root.kill("SIGKILL"); });
  const exited = once(root, "exit");
  controller.abort();
  await rejected;
  await assert.rejects(fixture.stopNpxProcesses(), /Failed to stop npx process trees/);
  await exited;
  assert.equal(alive(root.pid), false);
});

async function searchFixture(overrides) {
  const result = await build({
    entryPoints: ["app/api/skills/search/route.ts"], bundle: true, write: false, platform: "node", format: "cjs",
    plugins: [{ name: "search-fixture", setup(builder) {
      builder.onResolve({ filter: /^(next\/server|@\/lib\/npx)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "next/server"
        ? 'export const NextResponse = { json: value => value };'
        : 'export const runNpx = (args, options) => globalThis.fixtureRunNpx(args, options);' }));
    } }],
  });
  const context = { exports: {}, module: { exports: {} }, process: { env: {} }, ...overrides, fixtureRunNpx: overrides.runNpx };
  vm.runInNewContext(result.outputFiles[0].text, context);
  return context.module.exports.POST;
}

function searchRequest(controller) {
  return new Request("http://localhost/api/skills/search", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "local" }), signal: controller.signal,
  });
}

test("cancelling skills API search passes its signal and prevents npx fallback", async () => {
  let fallbacks = 0;
  let started;
  const fetching = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  const req = searchRequest(controller);
  const POST = await searchFixture({
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      assert.equal(options.signal, req.signal);
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      started();
    }),
    runNpx() { fallbacks++; throw new Error("must not start a fallback"); },
  });
  const rejected = assert.rejects(POST(req), { name: "AbortError" });
  await fetching;
  controller.abort();
  await rejected;
  assert.equal(fallbacks, 0);
});

test("skills CLI fallback receives cancellation and cannot return buffered results afterwards", async () => {
  let started;
  const fallback = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  const req = searchRequest(controller);
  const POST = await searchFixture({
    fetch: async () => { throw new Error("API unavailable"); },
    runNpx: (_args, options) => new Promise(resolve => {
      assert.equal(options.signal, req.signal);
      options.signal.addEventListener("abort", () => resolve({ stdout: "owner/repo@skill  1K installs\n", stderr: "" }), { once: true });
      started();
    }),
  });
  const rejected = assert.rejects(POST(req), { name: "AbortError" });
  await fallback;
  controller.abort();
  await rejected;
});
