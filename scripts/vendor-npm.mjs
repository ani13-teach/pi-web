/**
 * Copies npm into the places this app looks for it.
 *
 * pi installs skills and plugins by shelling out to `npx skills add …`, and
 * lib/npx.ts resolves that by looking for `node_modules/npm/bin/npx-cli.js`
 * next to `process.execPath`. The app's execPath is the app binary, which ships
 * without npm, so the lookup fails and every install returns ENOENT.
 *
 * Shipping a copy of npm next to the binary makes the original lookup succeed:
 * it runs `electron.exe npx-cli.js …` with ELECTRON_RUN_AS_NODE already in the
 * environment, so no Node installation is required on the machine.
 *
 * Writes two copies:
 *   vendor/npm-bundle/npm                          packaged as <install>/node_modules/npm
 *   node_modules/electron/dist/node_modules/npm    so `npm start` behaves the same
 *
 * The packaged copy sits one level down on purpose: electron-builder drops a
 * `node_modules` directory sitting at the root of an extraFiles source
 * (app-builder-lib/out/util/filter.js, `relative === "node_modules"`), which
 * leaves a broken npm behind. One extra directory level avoids that rule.
 *
 * The source is still this machine's npm, the one next to the running Node
 * (printed on every run); nothing is downloaded.
 *
 * An existing target is only skipped when its full contents match the source
 * (recursive list + sha256), so a same-version copy that lost files or was
 * patched gets repaired instead of being trusted on version alone. A
 * replacement is copied to a staging directory and verified before the old
 * target is removed, so a failed copy leaves the previous copy in place.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Relative paths of every file under `dir`, following symlinks, POSIX-style. */
function listFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const absolute = join(current, name);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else files.push(relative(dir, absolute).split(sep).join("/"));
    }
  };
  walk(dir);
  return files.sort();
}

/** Content digest of a whole directory tree: file names plus file contents. */
export function dirDigest(dir) {
  const files = listFiles(dir);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const contents = readFileSync(join(dir, file));
    bytes += contents.length;
    hash.update(file).update("\0").update(contents);
  }
  return { hash: hash.digest("hex"), files: files.length, bytes };
}

/**
 * Makes `target` byte-identical to `source`.
 *
 * Returns `{ action: "kept" | "copied", hash, files, bytes }`. Throws if the
 * source is unreadable or the staged copy does not verify, leaving any existing
 * target untouched.
 */
export function syncDir(source, target, { force = false } = {}) {
  const wanted = dirDigest(source);

  if (!force && existsSync(target) && dirDigest(target).hash === wanted.hash) {
    return { action: "kept", ...wanted };
  }

  const staging = `${target}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  try {
    cpSync(source, staging, { recursive: true, dereference: true });
    const copied = dirDigest(staging);
    if (copied.hash !== wanted.hash) {
      throw new Error(`copy does not match source (${copied.hash} != ${wanted.hash})`);
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  return { action: "copied", ...wanted };
}

function main() {
  const systemNpm = join(dirname(process.execPath), "node_modules", "npm");
  if (!existsSync(join(systemNpm, "bin", "npx-cli.js"))) {
    console.error(`Could not find npm next to the running Node (${systemNpm}).`);
    console.error("Install Node.js with npm, or copy a node_modules/npm directory in by hand.");
    process.exit(1);
  }

  const version = JSON.parse(readFileSync(join(systemNpm, "package.json"), "utf8")).version;
  const force = process.argv.includes("--force");

  const copyTo = (target, label) => {
    const result = syncDir(systemNpm, target, { force });
    const summary = `npm ${version} sha256 ${result.hash.slice(0, 12)} (${result.files} files, ${result.bytes}b)`;
    if (result.action === "kept") console.log(`${label}: ${summary} already matches, left alone`);
    else console.log(`${label}: ${summary} -> ${target}`);
  };

  // Traceability: which npm this build copies from. The digest of what was
  // copied is printed by copyTo below.
  console.log(`source: ${systemNpm} (npm ${version}, this machine's Node install)`);

  copyTo(join(root, "vendor", "npm-bundle", "npm"), "packaged");

  // Development parity: the dev build runs from node_modules/electron/dist.
  const electronDist = join(root, "node_modules", "electron", "dist");
  if (existsSync(electronDist)) {
    copyTo(join(electronDist, "node_modules", "npm"), "development");
  } else {
    console.log("development: skipped (no electron/dist yet)");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
