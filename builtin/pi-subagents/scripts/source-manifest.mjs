import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "SOURCE-MANIFEST.json");
const provenance = ["LICENSE", "LOCAL-CHANGES.md", "package.json"];
const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
const source = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;
const refresh = args.includes("--refresh");
if ((sourceIndex >= 0 && !source) || args.some((arg, i) => !["--source", "--refresh"].includes(arg) && !(sourceIndex >= 0 && i === sourceIndex + 1))) {
  throw new Error("Usage: source-manifest.mjs [--source directory] [--refresh]");
}

async function srcFiles(base, relative = "src") {
  const result = [];
  for (const entry of await readdir(join(base, relative), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await srcFiles(base, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Unexpected non-file source entry: ${path}`);
  }
  return result.sort();
}

async function hashes(base) {
  const result = {};
  for (const path of [...await srcFiles(base), ...provenance].sort()) {
    result[path] = createHash("sha256").update(await readFile(join(base, path))).digest("hex");
  }
  return result;
}

const desktopHashes = await hashes(root);
if (refresh) {
  if (!source) throw new Error("--refresh requires --source directory");
  const sourceRoot = resolve(source);
  const sourceHashes = await hashes(sourceRoot);
  for (const path of Object.keys(sourceHashes)) assert.ok(path in desktopHashes, `Missing copied source: ${path}`);
  const sourcePackage = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  const manifest = {
    algorithm: "sha256",
    source: { path: sourceRoot.replaceAll("\\", "/"), package: sourcePackage.name, version: sourcePackage.version },
    files: Object.fromEntries(Object.keys(desktopHashes).sort().map(path => [path, {
      sourceSha256: sourceHashes[path] ?? null,
      desktopSha256: desktopHashes[path],
    }])),
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Recorded ${Object.keys(sourceHashes).length} source/provenance files and ${Object.keys(desktopHashes).length} Desktop files`);
} else {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.algorithm, "sha256");
  const expectedDesktop = Object.fromEntries(Object.entries(manifest.files).map(([path, hashes]) => [path, hashes.desktopSha256]));
  assert.deepEqual(desktopHashes, expectedDesktop, "Vendored file inventory or bytes changed");
  if (source) {
    const expectedSource = Object.fromEntries(Object.entries(manifest.files)
      .filter(([, hashes]) => hashes.sourceSha256 !== null).map(([path, hashes]) => [path, hashes.sourceSha256]));
    assert.deepEqual(await hashes(resolve(source)), expectedSource, "Original source inventory or bytes changed");
  }
  console.log(`Verified ${Object.keys(desktopHashes).length} Desktop files${source ? " and original source" : ""}`);
}
