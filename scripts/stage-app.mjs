/**
 * Puts a packaged build somewhere it can be tested honestly.
 *
 * A packaged app's backend is started from `resources/app.asar.unpacked/dist/`,
 * and ESM walks *up* the directory tree to resolve its imports. Inside the repo
 * that walk reaches the repository's own `node_modules`, so a build whose
 * dependencies were never unpacked still starts and every check passes — the
 * installer is broken and the test suite says it is fine. That already happened
 * once (ERR_MODULE_NOT_FOUND only after installing on a clean machine).
 *
 * So: staging a copy in a temp directory is the default expectation, and the
 * guard below refuses a binary that sits under any `node_modules` ancestor
 * rather than quietly testing the wrong thing.
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Ancestors above the app directory that hold node_modules. The app's own root
 * has one on purpose (the copy of npm shipped for skill installs), so the walk
 * starts one level above the build.
 */
function ancestorsWithNodeModules(path) {
  const found = [];
  let current = dirname(dirname(path));
  for (;;) {
    if (existsSync(join(current, "node_modules"))) found.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}

/**
 * Returns `{ binary, cleanup }`. `binary` is the executable to launch — the
 * original path, or the staged copy when `isolate` is set. Call `cleanup()`
 * whatever happens afterwards.
 */
export function stageApp(binaryPath, { isolate = false } = {}) {
  if (!existsSync(binaryPath)) {
    throw new Error(`Packaged binary not found at ${binaryPath}`);
  }
  const suspicious = ancestorsWithNodeModules(binaryPath);
  if (suspicious.length > 0 && !isolate) {
    throw new Error(
      [
        "A packaged build must be checked outside this repository.",
        `These directories above the binary hold node_modules: ${suspicious.join(", ")}`,
        "Re-run with --isolate to copy the build somewhere clean first.",
      ].join("\n"),
    );
  }
  if (!isolate) {
    return { binary: binaryPath, cleanup: () => {} };
  }

  const stagedRoot = mkdtempSync(join(tmpdir(), "pi-desktop-check-"));
  const appDir = join(stagedRoot, "app");
  cpSync(dirname(binaryPath), appDir, { recursive: true });
  const binary = join(appDir, binaryPath.split(/[\\/]/).pop());
  const stillInside = ancestorsWithNodeModules(binary);
  if (stillInside.length > 0) {
    rmSync(stagedRoot, { recursive: true, force: true });
    throw new Error(`isolated copy still sits under node_modules: ${stillInside.join(", ")}`);
  }
  console.log(`isolated copy: ${appDir}`);
  return { binary, cleanup: () => rmSync(stagedRoot, { recursive: true, force: true }) };
}
