/** Apply only the extension-loader fix to an installed SDK 1.1.0 backend.
 * Do not replace the entire backend with a build containing unrelated changes.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendArgument = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const backend = resolve(backendArgument ?? join(process.env.LOCALAPPDATA, "Programs", "Pi Desktop", "resources", "app.asar.unpacked", "dist", "main", "backend.mjs"));
const apply = process.argv.includes("--apply");
const marker = "// Desktop builtin extension loader fix (SDK 1.1.0).";
const moduleName = "desktop-extension-loader-fix.mjs";

function replaceOnce(source, oldText, newText) {
  const index = source.indexOf(oldText);
  assert.ok(index >= 0, `Installed backend does not match expected fragment: ${oldText.slice(0, 90)}`);
  assert.equal(source.indexOf(oldText, index + oldText.length), -1, "Patch fragment must be unique");
  return source.slice(0, index) + newText + source.slice(index + oldText.length);
}

let source = await readFile(backend, "utf8");
const installedSdk = JSON.parse(await readFile(join(dirname(backend), "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"));
assert.equal(installedSdk.version, "1.1.0", "This compatibility patch is tested against SDK 1.1.0 only");
if (!source.includes(marker)) {
  const start = source.indexOf("async function filteredSubagentLoaderOptions(options, settingsManager) {");
  const end = source.indexOf("\nfunction mapStatus(status)", start);
  assert.ok(start >= 0 && end > start, "Expected extension filter boundaries are missing");
  source = replaceOnce(source, source.slice(start, end),
    "async function filteredSubagentLoaderOptions(options, settingsManager) {\n  return desktopFilteredLoaderOptions(options, settingsManager);\n}\n");
  source = replaceOnce(source, `    const settingsManager = SettingsManager2.create(sessionCwd, agentDir);
    const services = await createAgentSessionServices({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: await filteredSubagentLoaderOptions({
        cwd: sessionCwd,
        agentDir,
        settingsManager,`, `    const settingsManager = SettingsManager2.create(sessionCwd, agentDir);
    const resourceLoaderOptions = {
        cwd: sessionCwd,
        agentDir,
        settingsManager,
        eventBus: createDesktopLoaderEventBus(),`);
  source = replaceOnce(source, `      }, settingsManager),
      ...trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}
    });
    const scope = await resolveVisibleModels(`, `    };
    const filteredLoaderOptions = await filteredSubagentLoaderOptions(resourceLoaderOptions, settingsManager);
    const services = await createAgentSessionServices({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: filteredLoaderOptions,
      ...trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}
    });
    services.resourceLoader = new DesktopFilteredResourceLoader(resourceLoaderOptions, {
      loader: services.resourceLoader,
      extensionPaths: filteredLoaderOptions.additionalExtensionPaths
    });
    const scope = await resolveVisibleModels(`);
  source = `${marker}\nimport { FilteredResourceLoader as DesktopFilteredResourceLoader, filteredSubagentLoaderOptions as desktopFilteredLoaderOptions, createEventBus as createDesktopLoaderEventBus } from "./${moduleName}";\n${source}`;
}

const output = join(root, ".tmp-codemode-loader-fix");
await mkdir(output, { recursive: true });
const result = await build({
  stdin: { contents: 'export { FilteredResourceLoader } from "./lib/filtered-resource-loader.ts"; export { filteredSubagentLoaderOptions } from "./lib/extension-loader-options.ts"; export { createEventBus } from "@earendil-works/pi-coding-agent";', resolveDir: root, sourcefile: "desktop-extension-loader-fix.ts" },
  bundle: true, platform: "node", format: "esm", target: "node24", external: ["@earendil-works/*"], write: false,
});
const candidate = join(output, "backend.mjs");
await writeFile(candidate, source);
await writeFile(join(output, moduleName), result.outputFiles[0].contents);
const syntax = spawnSync(process.execPath, ["--check", candidate], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr);
console.log(`Prepared: ${candidate}`);
if (apply) {
  const directory = dirname(backend);
  const backup = join(directory, `codemode-loader-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(backup);
  await copyFile(backend, join(backup, "backend.mjs"));
  const module = join(directory, moduleName);
  try { await copyFile(module, join(backup, moduleName)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(`${module}.tmp`, result.outputFiles[0].contents);
  await rename(`${module}.tmp`, module);
  await writeFile(`${backend}.tmp`, source);
  await rename(`${backend}.tmp`, backend);
  console.log(`Applied: ${backend}\nBackup: ${backup}`);
} else {
  console.log("Preparation only; pass --apply to deploy after verification.");
}
