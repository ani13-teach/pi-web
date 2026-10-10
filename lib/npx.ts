import { execFile } from "child_process";
import { terminateProcessTree } from "../desktop/process-tree.ts";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { execPath } from "process";

type NpxTask = { stop(reason: unknown): Promise<void> };
const tasks = new Set<NpxTask>();
const cleanupFailures: unknown[] = [];
let stopping = false;
let stopPromise: Promise<void> | undefined;

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
  signal?: AbortSignal;
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
  if (stopping) return Promise.reject(new Error("npx is shutting down"));
  if (opts.signal?.aborted) return Promise.reject(opts.signal.reason);
  const { command, args: commandArgs } = resolvePackageManagerCommand("npx", args);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanup: Promise<void> | undefined;
    let cancelled = false;
    let stdout = "", stderr = "";
    const detach = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
    };
    const createdAfter = Date.now();
    const child = execFile(command, commandArgs, {
      cwd: opts.cwd,
      env: opts.env,
    }, (error, out, err) => {
      stdout = out;
      stderr = err;
      if (cancelled) return; // Cancellation settles only after tree cleanup.
      detach();
      tasks.delete(task);
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    const createdBefore = Date.now();
    const task: NpxTask = {
      stop(reason) {
        if (cleanup) return cleanup;
        cancelled = true;
        detach();
        cleanup = Promise.resolve().then(async () => {
          if (child.pid === undefined) return;
          try {
            // Capture only on cancellation, while the npm root still exists.
            await terminateProcessTree(child.pid, 6_000, {
              createdAfter, createdBefore,
              isCurrent: () => child.exitCode === null && child.signalCode === null,
            });
          } catch (error) {
            cleanupFailures.push(error);
            try { child.kill("SIGKILL"); } catch { /* Preserve the tree cleanup failure. */ }
            throw error;
          }
        });
        // Attach both handlers immediately, including for fire-and-forget aborts.
        void cleanup.then(() => {
          tasks.delete(task);
          reject(reason);
        }, (error) => {
          tasks.delete(task);
          reject(Object.assign(new AggregateError([reason, error], "npx cancellation failed to clean its process tree"), { stdout, stderr }));
        });
        return cleanup;
      },
    };
    const abort = () => { void task.stop(opts.signal?.reason); };
    // Register synchronously: shutdown cannot miss a process awaiting completion.
    tasks.add(task);
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    else if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        void task.stop(Object.assign(new Error(`npx timed out after ${opts.timeout}ms`), { code: "ETIMEDOUT" }));
      }, opts.timeout);
    }
  });
}

/** Seal the launch gate immediately, then wait for every registered tree. */
export function stopNpxProcesses(): Promise<void> {
  stopping = true;
  stopPromise ??= (async () => {
    await Promise.allSettled([...tasks].map((task) => task.stop(new Error("npx is shutting down"))));
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Failed to stop npx process trees");
  })();
  return stopPromise;
}
