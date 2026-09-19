/**
 * Drives the two failure scenarios a desktop app has to survive.
 *
 *   node scripts/smoke-resilience.mjs [reload|crash|all]
 *
 * These need a real model, because "the answer kept arriving" is the actual
 * claim being tested. Each scenario runs in its own app launch.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stageApp } from "./stage-app.mjs";

const args = process.argv.slice(2);
const flagValue = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} needs a path to the executable`);
    process.exit(1);
  }
  return value;
};

const requested = args.find((arg) => !arg.startsWith("--") && arg !== flagValue("--binary")) ?? "all";
const scenarios = requested === "all" ? ["reload", "crash"] : [requested];

const electronBinary = join(
  process.cwd(),
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

/**
 * A packaged build has to be checked through its own executable, and (see
 * stage-app.mjs) from outside this repository. Without --binary these scenarios
 * launch the dev build in dist/, which says nothing about the installer.
 */
const packagedBinary = flagValue("--binary");
let binary = electronBinary;
let cleanup = () => {};
if (packagedBinary) {
  try {
    const staged = stageApp(packagedBinary, { isolate: args.includes("--isolate") });
    binary = staged.binary;
    cleanup = staged.cleanup;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else if (!existsSync(electronBinary)) {
  console.error(`Electron binary not found at ${electronBinary}`);
  process.exit(1);
}

/**
 * ELECTRON_RUN_AS_NODE turns an Electron binary into plain Node. Pi Desktop sets
 * it for its own children, so a check launched from a session hosted there would
 * start the app as Node and die before the window ever opens. Drop it: these
 * scenarios need the real app.
 */
function guiEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * The app prints "N/M <scenario> checks passed" whether or not individual checks
 * failed, so the tally is what decides — the word "passed" alone is not
 * evidence (a run that reported 3/11 still contains it).
 */
function tallyOf(text, scenario) {
  const match = new RegExp(`(\\d+)/(\\d+) ${scenario} checks passed`).exec(text);
  return match ? { passed: Number(match[1]), total: Number(match[2]) } : null;
}

function runScenario(scenario) {
  return new Promise((resolve) => {
    console.log(`\n=== scenario: ${scenario} ===`);
    // A profile of its own lets these run while the app is already open: the
    // single-instance lock is taken per user data directory.
    const userData = process.env.PI_DESKTOP_SMOKE_USERDATA;
    // The dev build is launched as "open this directory" (electron .); a
    // packaged executable is launched directly and takes no such argument.
    const childArgs = packagedBinary ? [] : ["."];
    if (userData) childArgs.push(`--user-data-dir=${userData}`);
    const child = spawn(binary, childArgs, {
      env: guiEnv({ PI_DESKTOP_SCENARIO: scenario }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const forward = (chunk) => {
      const text = String(chunk);
      output += text;
      for (const line of text.split("\n")) {
        if (/^(PASS|FAIL|INFO|===|\d+\/\d+)/.test(line.trim()) || line.includes("checks passed")) {
          console.log(line.trimEnd());
        }
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("exit", (code) => resolve({ scenario, code: code ?? 1, output }));
  });
}

let failed = 0;
for (const scenario of scenarios) {
  const result = await runScenario(scenario);
  const tally = tallyOf(result.output, scenario);
  const problems = [];
  if (result.code !== 0) problems.push(`exit ${result.code}`);
  if (!tally) problems.push("no check tally in the output");
  else if (tally.total === 0) problems.push("the tally says no checks ran");
  else if (tally.passed !== tally.total) problems.push(`only ${tally.passed}/${tally.total} checks passed`);
  if (problems.length) {
    failed += 1;
    console.error(`scenario ${scenario} failed: ${problems.join(", ")}`);
  }
}

cleanup();
console.log(failed ? `\n${failed} scenario(s) failed` : "\nall scenarios passed");
process.exit(failed ? 1 : 0);
