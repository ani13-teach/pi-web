import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { build, transform } from "esbuild";

// Uses the upstream watch branch verbatim. Only filesystem calls are replaced,
// so the test observes its actual cancel() cleanup without touching real files.
export async function watchRouteFixture() {
  const source = await readFile("app/api/files/[...path]/route.ts", "utf8");
  const start = source.indexOf('if (type === "watch")');
  const end = source.indexOf('// type === "list"', start);
  assert.ok(start >= 0 && end > start);
  const { code } = await transform(`globalThis.handle = () => { ${source.slice(start, end)} };`, { loader: "ts" });
  const counts = { opened: 0, closed: 0 };
  const scope = { Response, ReadableStream, TextEncoder, path, type: "watch", filePath: "C:/fixture/example.txt",
    stat: { isFile: () => true, mtimeMs: 1, ctimeMs: 1, ino: 1, size: 1 },
    fs: { watch() { counts.opened++; return { on() {}, close() { counts.closed++; } }; } } };
  vm.runInNewContext(code, scope);
  return { counts, handle: scope.handle };
}

export async function routerFixture(handle) {
  const result = await build({ entryPoints: ["services/http-router.ts"], bundle: true, write: false,
    platform: "node", format: "cjs", plugins: [{ name: "route-fixture", setup(builder) {
      builder.onResolve({ filter: /routes.gen|next-server/ }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.includes("routes.gen")
        ? 'export const ROUTES = [{path:"/api/watch", module:{GET:globalThis.handle}}];'
        : 'export const attachNextRequestHelpers = (request, url) => {request.nextUrl = url;};' }));
    } }] });
  const context = { handle, module: { exports: {} }, exports: {}, URL, Headers, Request, Response,
    TextEncoder, Uint8Array, Buffer };
  vm.runInNewContext(result.outputFiles[0].text, context);
  return context.module.exports.handleRequest;
}
