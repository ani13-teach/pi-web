/**
 * Runs the window smoke checks against the real Electron app, then verifies the
 * two things a unit test cannot see: that nothing in the app's process tree was
 * listening on a TCP port while it ran, and that every process seen at that
 * moment was gone once the app quit.
 *
 * Those last two checks are one snapshot each, not continuous monitoring. While
 * the app holds itself open the script takes a single Win32_Process snapshot of
 * the root process it reported plus every descendant, keeping each process id
 * with its start time, and reads the listening sockets of those pids from that
 * same moment. After the app exits it looks the same pids up again and compares
 * start times, because Windows reuses process ids. The reported names say
 * exactly that much: they cover what the snapshot saw, not the whole lifetime of
 * the app and not processes started after the snapshot.
 *
 *   node scripts/smoke-window.mjs [--hold 15000] [--binary <exe>] [--isolate]
 *
 * --binary points the same checks at a packaged build (release/win-unpacked/...),
 * which is the artifact users actually run. A packaged build must be checked
 * somewhere outside this repository: module resolution walks up from the
 * unpacked backend, so an ancestor node_modules here silently supplies the pi
 * runtime and hides a build that cannot start on its own. --isolate copies the
 * build to a temporary directory outside the repository and checks it there
 * (and the script refuses to run a packaged build without it).
 *
 * A stale instance would hold the single-instance lock and make this exit
 * instantly with code 0 and no output, so that case is detected up front.
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stageApp } from "./stage-app.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
// Long enough that the one snapshot below finishes while the app is still held
// open; the snapshot needs a second or two of PowerShell.
const hold = flag("hold", "15000");
const packagedBinary = flag("binary", null);
const isolate = args.includes("--isolate");

/**
 * ELECTRON_RUN_AS_NODE makes an Electron binary start as plain Node. Pi Desktop
 * sets it for its own children, so a check run from a session hosted there
 * inherits it and the app dies immediately with `electron.protocol` undefined
 * instead of opening a window. These checks want the GUI, so they always drop
 * it — otherwise the launcher's own environment can decide whether the test
 * gets to run at all.
 */
function guiEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * The probe prints a tally whether or not individual checks failed, so the tally
 * — not the process exit code — is what decides this run. Kept as a named
 * function so the gate itself can be tested. See --selftest.
 */
function tallyOf(text) {
  const match = /(\d+)\/(\d+) window checks passed/.exec(text);
  return match ? { passed: Number(match[1]), total: Number(match[2]) } : null;
}
const gatePassed = (text) => {
  const tally = tallyOf(text);
  return tally !== null && tally.total > 0 && tally.passed === tally.total;
};

// Proves that this script fails when the window checks fail. Without it the old
// behaviour (always exit 0) could come back unnoticed.
if (args.includes("--selftest")) {
  const cases = [
    ["16/16 window checks passed", true],
    ["15/16 window checks passed", false],
    ["0/0 window checks passed", false],
    ["no checks ran at all", false],
  ];
  let bad = 0;
  for (const [text, expected] of cases) {
    const got = gatePassed(text);
    console.log(`${got === expected ? "PASS" : "FAIL"}  gate on ${JSON.stringify(text)} -> ${got}`);
    if (got !== expected) bad += 1;
  }
  console.log(bad === 0 ? "the check gate answers correctly" : `${bad} gate case(s) wrong`);
  process.exit(bad === 0 ? 0 : 1);
}

let binary = packagedBinary;
let cleanupStagedCopy = () => {};
if (packagedBinary) {
  try {
    const staged = stageApp(packagedBinary, { isolate });
    binary = staged.binary;
    cleanupStagedCopy = staged.cleanup;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const electronBinary = binary
  ?? join(
    process.cwd(),
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron",
  );

if (!existsSync(electronBinary)) {
  console.error(`Electron binary not found at ${electronBinary}`);
  console.error("Run: npm install --include=dev   (then node node_modules/electron/install.js)");
  process.exit(1);
}

if (!packagedBinary) {
  for (const required of ["dist/main/main.cjs", "dist/main/backend.mjs", "dist/renderer/index.html"]) {
    if (!existsSync(join(process.cwd(), required))) {
      console.error(`Missing ${required} — run: npm run build`);
      process.exit(1);
    }
  }
}

const powershell = (command) =>
  execFileSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8" }).trim();

/** PowerShell hands back a bare value instead of a one-element array sometimes. */
const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

/**
 * One Win32_Process snapshot of the root process and everything below it, plus
 * the listening sockets owned by those pids at that same instant.
 *
 * Anything that goes wrong here is thrown on purpose: an unreadable socket table
 * must not look the same as an app that listens on nothing. A missing root
 * process is reported too — the pids below are only meaningful for the run this
 * script started. Only the "the query succeeded and matched nothing" error from
 * Get-NetTCPConnection is treated as an empty socket list.
 *
 * A child is only followed when it started at or after the root. Windows keeps
 * the parent id a process was created with, so once that id is recycled, an
 * unrelated long-running process still names one of our pids as its parent and
 * its whole subtree would be pulled in — the user's own pi-web server showed up
 * as "listening" this way. A process cannot have been started by one that began
 * later, so the creation time rules that case out.
 */
function sampleAppProcesses(rootPid) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = ${rootPid}
$snapshot = Get-CimInstance Win32_Process
$tree = @($snapshot | Where-Object { [int]$_.ProcessId -eq $root })
$rootCreated = if ($tree.Count -gt 0) { $tree[0].CreationDate } else { $null }
$frontier = @($root)
while ($frontier.Count -gt 0) {
  $next = @()
  foreach ($p in $snapshot) {
    if (($frontier -contains [int]$p.ParentProcessId) -and
        ($tree.ProcessId -notcontains [int]$p.ProcessId) -and
        ($null -ne $rootCreated) -and
        ($p.CreationDate -ge $rootCreated)) {
      $tree += $p
      $next += [int]$p.ProcessId
    }
  }
  $frontier = @($next)
}
$treePids = @($tree | ForEach-Object { [int]$_.ProcessId })
$ports = @()
$portQueryFailed = $null
try {
  $ports = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Where-Object { $treePids -contains [int]$_.OwningProcess } |
    ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" })
} catch {
  if ($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*') {
    $portQueryFailed = "$($_.FullyQualifiedErrorId): $($_.Exception.Message)"
  }
}
[pscustomobject]@{
  rootFound = ($treePids -contains $root)
  ports = $ports
  portQueryFailed = $portQueryFailed
  tree = @($tree | ForEach-Object {
    [pscustomobject]@{ pid = [int]$_.ProcessId; created = $_.CreationDate.ToString('o'); name = $_.Name }
  })
} | ConvertTo-Json -Depth 5 -Compress
`;
  const parsed = JSON.parse(powershell(script));
  if (parsed.ports == null || parsed.tree == null) {
    // An unreadable snapshot must not look like an app with nothing listening.
    throw new Error("the snapshot did not come back in the expected shape");
  }
  return {
    rootFound: parsed.rootFound === true,
    ports: asArray(parsed.ports).map(String),
    portQueryFailed: parsed.portQueryFailed ? String(parsed.portQueryFailed) : null,
    processes: asArray(parsed.tree).map((entry) => ({
      pid: Number(entry.pid),
      created: String(entry.created),
      name: String(entry.name),
    })),
  };
}

/**
 * Which of the sampled processes are still there. A pid only counts as a
 * survivor when it carries the start time it had in the snapshot: a recycled id
 * belongs to some unrelated newcomer and says nothing about ours.
 */
function stillRunning(processes) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$sampled = @'
${JSON.stringify(processes)}
'@ | ConvertFrom-Json
$alive = @()
$reused = @()
foreach ($s in $sampled) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$s.pid)"
  if ($null -eq $p) { continue }
  $created = $p.CreationDate.ToString('o')
  if ($created -eq $s.created) { $alive += "$($s.pid) $($s.name)" }
  else { $reused += "$($s.pid) is now $($p.Name), started $created" }
}
[pscustomobject]@{ count = @($sampled).Count; alive = $alive; reused = $reused } | ConvertTo-Json -Depth 5 -Compress
`;
  const parsed = JSON.parse(powershell(script));
  const count = Number(parsed.count);
  if (count !== processes.length) {
    // Half a list would report "everything exited" for processes never looked up.
    throw new Error(`read back ${parsed.count} of ${processes.length} sampled process(es)`);
  }
  return {
    alive: asArray(parsed.alive).map(String),
    reused: asArray(parsed.reused).map(String),
  };
}

// Electron takes the single-instance lock per profile directory, so a second run
// is only possible with a profile of its own. Set PI_DESKTOP_SMOKE_USERDATA to a
// throwaway directory to check a build while the app is already open.
const userData = process.env.PI_DESKTOP_SMOKE_USERDATA;
if (userData) mkdirSync(userData, { recursive: true });
const childArgs = packagedBinary ? [] : ["."];
if (userData) childArgs.push(`--user-data-dir=${userData}`);

const child = spawn(electronBinary, childArgs, {
  env: guiEnv({
    PI_DESKTOP_SMOKE: "1",
    PI_DESKTOP_SMOKE_HOLD_MS: hold,
  }),
  stdio: ["ignore", "pipe", "pipe"],
});

/** One place for the cleanup, whichever way the run ends. */
const dropStagedCopy = () => cleanupStagedCopy();

let output = "";
let appPid = null;
let sample = null;
let sampleError = null;

child.stdout.on("data", (chunk) => {
  const text = String(chunk);
  output += text;
  process.stdout.write(text);

  const holdLine = /holding the app open for \d+ms \(pid (\d+)\)/.exec(output);
  if (holdLine && appPid === null) {
    appPid = Number(holdLine[1]);
    // The window is up and the backend is running; this is the moment to look.
    try {
      sample = sampleAppProcesses(appPid);
    } catch (error) {
      sampleError = error instanceof Error ? error.message : String(error);
    }
  }
});

child.stderr.on("data", (chunk) => process.stderr.write(chunk));

child.on("exit", (code) => {
  if (!tallyOf(output)) {
    dropStagedCopy();
    // A silent exit is the signature of the single-instance lock: the second
    // launch quits with code 0 and prints nothing. Anything else means the app
    // failed on its own, and guessing "lock" there sends the reader off
    // closing perfectly healthy windows.
    const quiet = output.trim() === "";
    console.error(
      quiet
        ? "\nNo checks ran, and the launch printed nothing. That is what the single-instance\n" +
          "lock looks like: another Pi Desktop instance is already running, so this launch\n" +
          "exits with code 0 and no window. Close it and retry — or set\n" +
          "PI_DESKTOP_SMOKE_USERDATA to a throwaway directory to run alongside it."
        : `\nNo checks ran. The launch failed first${code === null ? "" : ` (exit code ${code})`} —\n` +
          "its output above says why. The single-instance lock is not the likely cause here,\n" +
          "because that failure is silent.",
    );
    process.exit(2);
  }

  const failures = [];
  const { passed, total } = tallyOf(output);

  // Nothing was sampled: without a snapshot there is no evidence either way, so
  // both checks below fail rather than pass by default.
  const nothingSampled = () => {
    if (sampleError) return `sampling the process tree failed: ${sampleError}`;
    if (!sample) return "the app never reported its hold line, so nothing was sampled";
    if (!sample.rootFound) return `pid ${appPid} was not in the process snapshot`;
    return null;
  };

  const listeningLine = () => {
    const missing = nothingSampled();
    if (missing) return [false, missing];
    if (sample.portQueryFailed) return [false, `the socket query failed: ${sample.portQueryFailed}`];
    return [
      sample.ports.length === 0,
      sample.ports.length === 0 ? "none" : `listening: ${sample.ports.join(", ")}`,
    ];
  };

  const exitedLine = () => {
    const missing = nothingSampled();
    if (missing) return [false, missing];
    const count = sample.processes.length;
    try {
      const { alive, reused } = stillRunning(sample.processes);
      const detail =
        `sampled ${count} process(es); ` +
        (alive.length === 0
          ? `all gone${reused.length > 0 ? ` (${reused.join("; ")})` : ""}`
          : `still running: ${alive.join(", ")}`);
      return [alive.length === 0, detail];
    } catch (error) {
      return [
        false,
        `sampled ${count} process(es); the liveness query failed: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
  };

  // Everything is asked after a pause, so the OS has had a moment to reap the
  // children before the second query looks for survivors.
  setTimeout(() => {
    const [portOk, portDetail] = listeningLine();
    const [exitOk, exitDetail] = exitedLine();
    const lines = [
      ["the window probe ran and every check passed", gatePassed(output), `${passed}/${total}`],
      ["nothing was listening when the tree was sampled", portOk, portDetail],
      ["every process in the snapshot had exited after the app quit", exitOk, exitDetail],
    ];

    console.log("");
    for (const [name, ok, detail] of lines) {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
      if (!ok) failures.push(name);
    }
    console.log("");
    console.log("note: the last two checks describe the one snapshot taken while the app held itself");
    console.log("      open. Processes started after that snapshot, and everything that happened");
    console.log("      between startup and the snapshot, are not covered.");
    console.log(failures.length ? `\n${failures.length} post-run check(s) failed` : "\npost-run checks passed");
    dropStagedCopy();
    process.exit(code === 0 && failures.length === 0 ? 0 : 1);
  }, 1500);
});
