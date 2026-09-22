/**
 * Regression checks for spawning the package manager used by the plugin update
 * check.
 *
 * `lib/plugin-updates.ts` asks the configured package manager (npm by default)
 * for the published versions. On Windows the `npm` on PATH is `npm.cmd`, which
 * Node refuses to spawn without a shell, so the check failed with
 * `spawn npm ENOENT` and reported an error instead of a version. `lib/npx.ts`
 * routes a bare `npm`/`npx` through the CLI entry point that sits next to the
 * running binary (the packaged app ships npm there).
 *
 * Run with:  node --experimental-strip-types --test tests/npm-cli-resolution.test.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const { resolvePackageManagerCommand } = await import("../lib/npx.ts");

const view = ["view", "npm", "version", "--json"];
const resolved = resolvePackageManagerCommand("npm", view);
// A runtime with no npm next to it (some Linux layouts) keeps the plain
// command, and there is nothing to route through then.
const cliEntry = resolved.command === "npm" ? null : resolved.args[0];
const missingNpm = "npm is not installed next to the running binary";

test("routes a bare npm through the CLI entry point next to the runtime", { skip: !cliEntry && missingNpm }, () => {
  assert.equal(resolved.command, process.execPath);
  assert.ok(existsSync(cliEntry), `${cliEntry} exists`);
  assert.ok(cliEntry.startsWith(join(process.execPath, "..", "node_modules", "npm", "bin")),
    `${cliEntry} is the bundled npm`);
  assert.deepEqual(resolved.args.slice(1), view);
});

test("the routed npm runs without a shell", { skip: !cliEntry && missingNpm }, async () => {
  const version = resolvePackageManagerCommand("npm", ["--version"]);
  const { stdout } = await execFileAsync(version.command, version.args, { encoding: "utf8" });
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("leaves other package managers and explicit paths alone", () => {
  for (const command of ["pnpm", "bun", String.raw`C:\tools\npm.cmd`, "/usr/local/bin/npm"]) {
    assert.deepEqual(resolvePackageManagerCommand(command, view), { command, args: view });
  }
});

test("the update check spawns the resolved command, not the raw one", async () => {
  const source = await readFile(new URL("../lib/plugin-updates.ts", import.meta.url), "utf8");
  assert.match(source, /resolvePackageManagerCommand\(command, args\)/);
  assert.match(source, /execFileAsync\(executable, executableArgs/);
});
