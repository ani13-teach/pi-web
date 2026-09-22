import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { execPath } from "process";

const execFileAsync = promisify(execFile);

/**
 * Locate the `npm-cli.js` / `npx-cli.js` shipped with the running runtime.
 *
 * On Windows the `npm` and `npx` on PATH are `npm.cmd` / `npx.cmd`, which
 * Node.js (since 20.12 due to CVE-2024-27980) refuses to spawn from
 * `execFile`/`spawn` without `shell: true`. Going through a shell reintroduces
 * quoting bugs for user-supplied args. Instead we find the real JS entry point
 * and invoke it directly via the current runtime (Electron running as Node in
 * the packaged app, plain Node when running from source), which works
 * identically on every platform and needs no shell.
 */
function findNpmCli(name: "npm" | "npx"): string | null {
  const nodeDir = dirname(execPath);
  const candidates = [
    // Windows MSI installer layout, and the copy `scripts/vendor-npm.mjs`
    // stages next to the app binary: the runtime and node_modules share a dir
    join(nodeDir, "node_modules", "npm", "bin", `${name}-cli.js`),
    // Unix layout: .../bin/node + .../lib/node_modules/npm/bin/npm-cli.js
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", `${name}-cli.js`),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Rewrite a bare `npm` / `npx` invocation into `<runtime> <…>-cli.js …` when
 * that entry point is available, so it can be spawned without a shell. An
 * explicit path or another package manager is returned unchanged.
 */
export function resolvePackageManagerCommand(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (command.includes("/") || command.includes("\\")) return { command, args };
  const name = command.replace(/\.(cmd|ps1|exe)$/i, "").toLowerCase();
  if (name !== "npm" && name !== "npx") return { command, args };
  const cli = findNpmCli(name);
  return cli ? { command: execPath, args: [cli, ...args] } : { command, args };
}

export interface RunNpxOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunNpxResult {
  stdout: string;
  stderr: string;
}

/**
 * Cross-platform wrapper for invoking `npx <args>` without ever using a
 * shell, so user-controlled arguments are never interpreted as shell syntax.
 */
export function runNpx(args: string[], opts: RunNpxOptions = {}): Promise<RunNpxResult> {
  const { command, args: commandArgs } = resolvePackageManagerCommand("npx", args);
  return execFileAsync(command, commandArgs, {
    timeout: opts.timeout,
    cwd: opts.cwd,
    env: opts.env,
  });
}
