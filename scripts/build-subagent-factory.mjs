import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

/** Compile the entire mutable extension graph into a collectible lexical scope.
 * SDK ESM namespaces are shared; no ESM-only package is loaded with require().
 * sdkImportSpecifier exists solely for isolated test outputs outside node_modules.
 */
export async function buildSubagentFactory({
  outfile,
  entryPoint = resolve(root, "builtin/pi-subagents/src/index.ts"),
  sdkImportSpecifier = name => name,
} = {}) {
  if (!outfile) throw new Error("Subagent factory outfile is required");
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    write: false,
    splitting: false,
    metafile: true,
    external: ["@earendil-works/*"],
    define: { "import.meta.url": "__piSubagentModuleUrl" },
    logLevel: "silent",
  });
  const externals = [...new Set(Object.values(result.metafile.outputs)
    .flatMap(output => output.imports.filter(item => item.external).map(item => item.path)))].sort();
  const sdk = externals.filter(name => name.startsWith("@earendil-works/"));
  for (const name of externals) {
    if (!sdk.includes(name) && !builtins.has(name)) throw new Error(`Unexpected subagent external: ${name}`);
  }
  const imports = sdk.map((name, i) => `import * as __piSdk${i} from ${JSON.stringify(sdkImportSpecifier(name))};`);
  const source = [
    '// Generated: import this URL once; call the factory once per activation.',
    'import { createRequire as __piCreateRequire } from "node:module";',
    ...imports,
    'const __piSubagentModuleUrl = import.meta.url;',
    'const __piNodeRequire = __piCreateRequire(import.meta.url);',
    'export function createSubagentModule() {',
    'const module = { exports: {} };',
    'const exports = module.exports;',
    'const require = (name) => {',
    'switch (name) {',
    ...sdk.map((name, i) => `case ${JSON.stringify(name)}: return __piSdk${i};`),
    'default: return __piNodeRequire(name);',
    '}',
    '};',
    result.outputFiles.find(file => file.path === resolve(outfile))?.text ?? result.outputFiles[0].text,
    'return module.exports;',
    '}',
    '',
  ].join("\n");
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, source);
  return { metafile: result.metafile, sdkExternals: sdk };
}
