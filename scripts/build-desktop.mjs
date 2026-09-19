/**
 * Bundles the TypeScript entries into dist/main.
 *
 * - main and preload are CommonJS (Electron's main process and sandboxed
 *   preloads are happiest there);
 * - backend is ESM because the pi SDK is ESM-only;
 * - native modules and the SDK stay external so they are loaded from
 *   node_modules at runtime instead of being inlined into the bundle;
 * - the ported pi-web code keeps its `@/…` imports, and `next/server` is
 *   redirected to the desktop shim.
 */
import { build } from "esbuild";
import { copyFile, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await import("./gen-routes.mjs");

const external = ["electron", "node-pty", "@earendil-works/*"];

/** Resolves `@/lib/x` and `next/server` the way the web build did. */
const piWebAliases = {
  name: "pi-web-aliases",
  setup(build_) {
    build_.onResolve({ filter: /^@\// }, async (args) => {
      const result = await build_.resolve(`./${args.path.slice(2)}`, {
        resolveDir: root,
        kind: args.kind,
        importer: args.importer,
      });
      if (result.errors.length) return { errors: result.errors };
      return { path: result.path, sideEffects: result.sideEffects };
    });
  },
};

const alias = {
  "next/server": join(root, "desktop", "shims", "next-server.ts"),
};

await rm(join(root, "dist", "main"), { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
  external,
  alias,
  plugins: [piWebAliases],
  absWorkingDir: root,
};

await build({
  ...common,
  entryPoints: [join(root, "desktop", "main.ts")],
  outfile: join(root, "dist", "main", "main.cjs"),
  format: "cjs",
});

await build({
  ...common,
  entryPoints: [join(root, "desktop", "preload.ts")],
  outfile: join(root, "dist", "main", "preload.cjs"),
  format: "cjs",
  define: {
    "process.env.PI_DESKTOP_VERSION": JSON.stringify(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version),
  },
});

await build({
  ...common,
  entryPoints: [join(root, "desktop", "backend.ts")],
  outfile: join(root, "dist", "main", "backend.mjs"),
  format: "esm",
  // CommonJS dependencies (web-push, parts of the SDK) call require() for node
  // builtins. ESM has no require, so the bundle gets a real one up front.
  banner: {
    js: [
      'import { createRequire as __piDesktopCreateRequire } from "node:module";',
      "globalThis.require = __piDesktopCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

// The renderer smoke probe is executed as-is inside the window, so it is copied
// rather than bundled.
for (const name of ["smoke-probe.js", "layout-probe.js", "chat-probe.js"]) {
  await copyFile(join(root, "desktop", name), join(root, "dist", "main", name));
}
