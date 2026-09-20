/**
 * Runs the vendored pi-web test suite inside this project.
 *
 * The selected upstream suite includes source-shape checks and logic tests.
 * Nine files depend on web entry points absent from this build. Some also
 * contain shared settings checks, so skipping them loses that coverage too.
 * They remain unchanged on disk to preserve byte-for-byte upstream parity.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const SKIP = [
  "lib/next-config.test.mjs",
  "lib/next-config-esm.test.mjs",
  "lib/pi-web-options.test.mjs",
  "lib/process-lifecycle.test.mjs",
  "lib/node-version.test.mjs",
  "lib/web-auth-proxy.test.mjs",
  "components/SettingsUi.test.mjs",
  "components/SettingsPanel.test.mjs",
  "components/MobilePwaLayout.test.mjs",
];

const skip = new Set(SKIP.map((entry) => entry.replace(/\//g, "\\")));

/**
 * Single upstream tests that cannot pass on this Windows host. Keeping whole files in SKIP
 * would drop far more coverage, so these are filtered by exact test name instead and the
 * vendored files stay byte-for-byte identical.
 *
 * Names are matched verbatim: if upstream renames one, the filter simply stops applying and
 * the failure shows up again rather than the pattern silently swallowing another test.
 */
const SKIP_TESTS = [
  {
    name: "renders image warnings for known text-only defaults without an explicit model selection",
    reason: "jiti 2.7.0 on Windows resolves the test's `@/lib/draft-store.ts` and the component's `@/lib/draft-store` to the same file with different separators, so they become two module instances and the draft never reaches the component.",
  },
  {
    name: "lists directories and directory symlinks without returning files",
    reason: "needs the Windows symlink privilege (Developer Mode or elevated shell): symlinkSync of a directory fails with EPERM here.",
  },
  {
    name: "rejects files outside cwd, including symlink targets",
    reason: "same symlink privilege: the test creates a file symlink, which has no unprivileged Windows equivalent (junctions only cover directories).",
  },
  {
    name: "direct bash updates the platform PATH key",
    reason: "upstream test builds the expected PATH with the host's path.delimiter while simulating platform: 'linux'; the implementation correctly uses ':' for that platform, so the expectation only holds on POSIX hosts.",
  },
  {
    name: "native PTY starts after install and repeated creation reuses the same workspace process",
    reason: "Windows ConPTY reports pid 0 until the output worker connects asynchronously (measured > 0 after ~1s), while the test reads pty.pid right after createTerminal. The app itself never uses pty.pid.",
  },
  {
    name: "unclaimed creations expire without requiring a browser cleanup request",
    reason: "mocking setTimeout starves node-pty's ConPTY handshake (windowsPtyAgent CONNECTION_TIMEOUT = 5000ms): the pty dies during tick() and its exit handler re-arms a fresh lease the tick does not reach.",
  },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const skipPattern = SKIP_TESTS.map((entry) => escapeRegExp(entry.name)).join("|");

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collect(path));
    else if (entry.name.endsWith(".test.mjs") && !skip.has(path.replace(/\//g, "\\"))) out.push(path);
  }
  return out;
}

const files = [...collect("lib"), ...collect("components"), ...collect("hooks")].sort();
console.log(`running ${files.length} upstream test files (${SKIP.length} files excluded; includes mixed web/shared tests)`);
console.log("app/api tests are not collected: their direct Next imports need a separate test adapter.");
if (SKIP_TESTS.length > 0) {
  console.log(`filtering ${SKIP_TESTS.length} upstream tests that cannot pass on this host (see SKIP_TESTS for the reason each one is environment-bound)`);
}
if (process.argv.includes("--list")) {
  console.log(files.join("\n"));
  process.exit(0);
}

// An empty pattern would match every test, so the flag is only passed when it filters something.
const skipArgs = SKIP_TESTS.length > 0 ? [`--test-skip-pattern=${skipPattern}`] : [];
const child = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    "--test",
    ...skipArgs,
    ...files.map((file) => relative(root, join(root, file))),
  ],
  { cwd: root, stdio: "inherit" },
);

child.on("exit", (code) => process.exit(code ?? 1));
