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
if (process.argv.includes("--list")) {
  console.log(files.join("\n"));
  process.exit(0);
}

const child = spawn(
  process.execPath,
  ["--experimental-strip-types", "--test", ...files.map((file) => relative(root, join(root, file)))],
  { cwd: root, stdio: "inherit" },
);

child.on("exit", (code) => process.exit(code ?? 1));
