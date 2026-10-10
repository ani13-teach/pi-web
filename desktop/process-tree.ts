import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const systemRoot = process.env.SystemRoot || "C:\\Windows";
const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const taskkill = join(systemRoot, "System32", "taskkill.exe");

export interface ProcessIdentity {
  pid: number;
  ppid: number;
  /** UTC milliseconds, shared by CIM and System.Diagnostics.Process. */
  createdAt: string;
}

export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.createdAt === b.createdAt;
}

/** Reject stale PPIDs: a child cannot have been created before its parent. */
export function processTree(root: ProcessIdentity, list: readonly ProcessIdentity[]): ProcessIdentity[] {
  const result = [root];
  const seen = new Set([root.pid]);
  for (let i = 0; i < result.length; i++) {
    const parent = result[i];
    for (const child of list) {
      if (!seen.has(child.pid) && child.ppid === parent.pid && child.createdAt >= parent.createdAt) {
        seen.add(child.pid);
        result.push(child);
      }
    }
  }
  return result;
}

async function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], { timeout: Math.max(1, timeoutMs), windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.replace(/^\uFEFF/, "").trim();
}

export async function readWindowsProcesses(timeoutMs = 3_000): Promise<ProcessIdentity[]> {
  const output = await runPowerShell(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$items = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 -and $_.CreationDate } | ForEach-Object {
  @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; createdAt = $_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fff') }
})
ConvertTo-Json -InputObject $items -Compress
`, timeoutMs);
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.some((p) => !p || !Number.isSafeInteger(p.pid)
    || p.pid <= 0 || !Number.isSafeInteger(p.ppid) || typeof p.createdAt !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}$/.test(p.createdAt))) {
    throw new Error("Invalid Windows process snapshot");
  }
  return parsed as ProcessIdentity[];
}

async function killWindowsProcesses(targets: readonly ProcessIdentity[], timeoutMs: number): Promise<void> {
  if (!targets.length) return;
  // Identity is checked again in the terminating process. Holding the process
  // handle while taskkill runs also prevents a stale PID from being reused.
  const payload = Buffer.from(JSON.stringify(targets), "utf8").toString("base64");
  const executable = taskkill.replace(/'/g, "''");
  const output = await runPowerShell(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$targets = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$failures = @()
foreach ($target in $targets) {
  $p = Get-Process -Id $target.pid -ErrorAction SilentlyContinue
  if ($null -eq $p) { continue }
  try {
    $handle = $p.Handle
    if ($p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fff') -ne $target.createdAt) { continue }
    & '${executable}' /PID ([string]$target.pid) /T /F *> $null
    if ($LASTEXITCODE -ne 0 -and -not $p.HasExited) { $failures += [int]$target.pid }
  } catch {
    if (-not $p.HasExited) { $failures += [int]$target.pid }
  } finally { $p.Dispose() }
}
ConvertTo-Json -InputObject @($failures) -Compress
`, timeoutMs);
  const failures: unknown = JSON.parse(output);
  if (!Array.isArray(failures) || failures.length) throw new Error(`Could not terminate process trees: ${output}`);
}

export interface SpawnIdentity {
  createdAfter: number;
  createdBefore: number;
  isCurrent(): boolean;
}

export interface ProcessTreeOperations {
  list(timeoutMs: number): Promise<ProcessIdentity[]>;
  kill(targets: readonly ProcessIdentity[], timeoutMs: number): Promise<void>;
}

/**
 * A shutdown-local scope, never a name-based/global kill list. Keep the backend
 * alive until terminate(): a graceful parent exit would orphan its children.
 * Remember observed identities as well, since cleanup may end intermediate
 * parents. This is not a Job Object: an unobserved, already detached daemon is
 * deliberately not claimed as owned.
 */
export class ProcessTreeScope {
  private readonly known = new Map<number, ProcessIdentity>();
  private captured = false;
  private readonly windows: boolean;
  private readonly rootPid: number;
  private readonly operations: ProcessTreeOperations;
  private readonly spawnIdentity: SpawnIdentity | undefined;

  constructor(rootPid: number, operations: ProcessTreeOperations = {
    list: readWindowsProcesses, kill: killWindowsProcesses,
  }, platform: NodeJS.Platform = process.platform, spawnIdentity?: SpawnIdentity) {
    if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || rootPid === process.pid) {
      throw new Error("Invalid child process tree root");
    }
    this.rootPid = rootPid;
    this.operations = operations;
    this.spawnIdentity = spawnIdentity;
    this.windows = platform === "win32";
  }

  async capture(timeoutMs = 3_000): Promise<void> {
    if (!this.windows) { this.captured = true; return; }
    if (!this.captured && this.spawnIdentity && !this.spawnIdentity.isCurrent()) {
      this.captured = true;
      return;
    }
    const list = await this.operations.list(timeoutMs);
    if (!this.captured) {
      if (this.spawnIdentity && !this.spawnIdentity.isCurrent()) {
        this.captured = true;
        return;
      }
      const root = list.find((p) => p.pid === this.rootPid);
      if (root && this.spawnIdentity) {
        const born = Date.parse(root.createdAt + "Z");
        if (born < this.spawnIdentity.createdAfter - 1 || born > this.spawnIdentity.createdBefore + 1) {
          throw new Error("Process root identity does not match its spawned child");
        }
      }
      if (root) for (const p of processTree(root, list)) this.known.set(p.pid, p);
      this.captured = true;
    } else {
      this.refresh(list);
    }
  }

  private refresh(list: readonly ProcessIdentity[]): ProcessIdentity[] {
    // Only a still-matching identity can establish ownership of new children.
    for (const seed of [...this.known.values()]) {
      const live = list.find((p) => sameProcess(p, seed));
      if (live) for (const p of processTree(live, list)) {
        // Never replace a remembered PID with a different process identity.
        if (!this.known.has(p.pid)) this.known.set(p.pid, p);
      }
    }
    return list.filter((p) => {
      const remembered = this.known.get(p.pid);
      return remembered && sameProcess(p, remembered);
    });
  }

  async terminate(timeoutMs = 6_000): Promise<void> {
    if (!this.windows) {
      try { process.kill(this.rootPid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      return;
    }
    const deadline = Date.now() + timeoutMs;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error("Timed out cleaning the process tree");
      return ms;
    };
    if (!this.captured) await this.capture(remaining());
    for (;;) {
      const live = this.refresh(await this.operations.list(remaining()));
      if (!live.length) return;
      // Kill current roots before their children, then remembered orphans.
      const ids = new Set(live.map((p) => p.pid));
      const roots = live.filter((p) => !ids.has(p.ppid));
      if (!roots.length) throw new Error("Invalid cyclic process tree");
      await this.operations.kill(roots, remaining());
      // Verify actual disappearance, not merely a successful taskkill status.
    }
  }
}

export async function terminateProcessTree(pid: number, timeoutMs = 6_000, spawnIdentity?: SpawnIdentity): Promise<void> {
  await new ProcessTreeScope(pid, undefined, process.platform, spawnIdentity).terminate(timeoutMs);
}
