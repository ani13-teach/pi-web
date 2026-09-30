import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test, { afterEach } from "node:test";
import vm from "node:vm";
import { build, transform } from "esbuild";

const require = createRequire(import.meta.url);

// Execute the real component renderers with only hooks and unrelated visual
// blocks stubbed. React's JSX elements retain their actual event handlers.
async function loadComponent(name) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../components/${name}.tsx`, import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    jsx: "automatic",
    plugins: [{ name: "stateless-hooks", setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "stub" }));
      builder.onResolve({ filter: /(?:useI18n|MermaidBlock|FileIcons)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents:
        args.path === "react" ? "export const useMemo = (factory) => factory(); export const useRef = (value) => ({ current: value }); export const useEffect = (effect) => { globalThis.cleanups.push(effect()); };" :
        args.path.endsWith("useI18n") ? "export const useI18n = () => ({ t: (key) => key });" :
        "export const MermaidBlock = () => null; export const CodeBlock = () => null; export const getFileIcon = () => null;",
      }));
    } }],
  });
  const module = { exports: {} };
  const timers = new Map(), cleanups = [];
  let nextTimer = 0;
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, URL, cleanups,
    setTimeout(callback, delay) { assert.equal(delay, 500); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { Component: module.exports[name], timers,
    flush() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback()); },
    unmount() { cleanups.splice(0).forEach((cleanup) => cleanup?.()); },
  };
}

const markdownSubject = await loadComponent("MarkdownBody");
const filesSubject = await loadComponent("TurnWrittenFiles");
const MarkdownBody = markdownSubject.Component;
const TurnWrittenFiles = filesSubject.Component;
afterEach(() => { markdownSubject.unmount(); filesSubject.unmount(); });
const path = "C:/Users/WJZN/Desktop/Pi Desktop 添加 GPT-6.1 Sol 模型教程.md";
const href = "C:/Users/WJZN/Desktop/Pi%20Desktop%20添加%20GPT-6.1%20Sol%20模型教程.md";

function links(onOpenFile, ...destinations) {
  const tree = MarkdownBody({ children: "", cwd: "C:/Users/WJZN/pi-desktop/pi-web", onOpenFile });
  const markdown = tree.props.children;
  return destinations.map((destination) => markdown.props.components.a({
    href: markdown.props.urlTransform(destination), children: "tutorial",
  }));
}

function link(onOpenFile, destination = href) {
  return links(onOpenFile, destination)[0];
}

function event(detail = 1, extra = {}) {
  return { detail, defaultPrevented: false, button: 0, ctrlKey: false, metaKey: false,
    shiftKey: false, altKey: false, currentTarget: { getAttribute: () => null },
    preventDefault() { this.defaultPrevented = true; }, ...extra };
}

async function loadAppHandler(bridge) {
  const source = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  const handleRevealFile = useCallback(");
  const end = source.indexOf("\n  const handleOpenTerminal", start);
  assert.ok(start >= 0 && end > start);
  const { code } = await transform(`${source.slice(start, end)}\n globalThis.handler = handleOpenLinkedFile;`, { loader: "ts" });
  const previews = [], alerts = [];
  const context = { window: { piDesktop: bridge, alert: (message) => alerts.push(message) },
    selectedSession: { id: "source-session" }, useCallback: (callback) => callback,
    getFileName: (filePath) => filePath.split("/").at(-1),
    handleOpenFile: (...args) => previews.push(args), translate: (_key, values) => values.error,
  };
  vm.runInNewContext(code, context);
  return { handler: context.handler, previews, alerts };
}

test("encoded Windows chat link previews the decoded path and double-clicks through the native bridge once", async () => {
  const opens = [];
  const app = await loadAppHandler({ openLocalFile: async (options) => opens.push(options) });
  const anchor = link(app.handler);
  const first = event(1);
  anchor.props.onClick(first);
  assert.equal(first.defaultPrevented, true);
  assert.equal(app.previews.length, 0, "first click must not move the link or cover it with the file panel");
  anchor.props.onClick(event(2));
  anchor.props.onDoubleClick(event(2));
  markdownSubject.flush();
  assert.equal(app.previews.length, 0, "double-click cancels pending preview");
  assert.equal(opens.length, 1);
  assert.equal(opens[0].filePath, path);
  assert.equal(opens[0].sourceSessionId, "source-session");
});

test("a single click previews after the double-click interval, preserving session authorization", async () => {
  const app = await loadAppHandler({ openLocalFile: async () => assert.fail("single click must not open externally") });
  link(app.handler).props.onClick(event());
  assert.equal(app.previews.length, 0);
  markdownSubject.flush();
  assert.equal(app.previews.length, 1);
  assert.equal(app.previews[0][0], path);
  assert.equal(app.previews[0][2].sourceSessionId, "source-session");
  assert.equal(app.previews[0][2].previewKind, "explorer");
});

test("clicking A then double-clicking B never opens a panel between B's clicks", async () => {
  const opens = [];
  const app = await loadAppHandler({ openLocalFile: async (options) => opens.push(options) });
  const [a, b] = links(app.handler, href, "C:/Users/me/second.md");
  a.props.onClick(event(1));
  b.props.onClick(event(1));
  assert.equal(app.previews.length, 0);
  assert.equal(markdownSubject.timers.size, 1);
  b.props.onClick(event(2));
  b.props.onDoubleClick(event(2));
  markdownSubject.flush();
  assert.equal(app.previews.length, 0);
  assert.equal(opens.length, 1);
  assert.equal(opens[0].filePath, "C:/Users/me/second.md");
});

test("keyboard activation previews immediately and unmount cancels pending pointer clicks", () => {
  const previews = [];
  const anchor = link((filePath) => previews.push(filePath));
  anchor.props.onClick(event(0));
  assert.equal(previews.length, 1);
  anchor.props.onClick(event(1));
  assert.equal(markdownSubject.timers.size, 1);
  markdownSubject.unmount();
  markdownSubject.flush();
  assert.equal(previews.length, 1);
});

test("literal encoded percent remains literal after the whole href conversion", () => {
  let actual;
  const anchor = link((filePath) => { actual = filePath; }, "C:/Users/me/literal%2520.md");
  anchor.props.onClick(event());
  markdownSubject.flush();
  assert.equal(actual, "C:/Users/me/literal%20.md");
});

test("external links and blocked modified clicks do not trigger native file opening", () => {
  const calls = [];
  const web = link((...args) => calls.push(args), "https://example.com/tutorial.md");
  assert.equal(web.props.target, "_blank");
  assert.equal(web.props.onDoubleClick, undefined);
  const anchor = link((...args) => calls.push(args));
  for (const extra of [{ shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    anchor.props.onClick(event(1, extra));
    anchor.props.onDoubleClick(event(2, extra));
  }
  assert.equal(calls.length, 0);
});

test("written-file card double-click uses the same system-open handler without decoding actual paths", async () => {
  const opens = [];
  const app = await loadAppHandler({ openLocalFile: async (options) => opens.push(options) });
  const actualPath = "C:/Users/me/actual%20file.md";
  const card = TurnWrittenFiles({ files: [{ filePath: actualPath }], onOpenFile: app.handler }).props.children[0];
  card.props.onClick(event(1));
  card.props.onClick(event(2));
  card.props.onDoubleClick(event(2));
  filesSubject.flush();
  assert.equal(app.previews.length, 0);
  assert.equal(opens.length, 1);
  assert.equal(opens[0].filePath, actualPath);
});

test("system open failures are visible and never retry or silently fall back", async () => {
  const app = await loadAppHandler({ openLocalFile: async () => { throw new Error("No associated application"); } });
  link(app.handler).props.onDoubleClick(event(2));
  await Promise.resolve();
  assert.equal(app.previews.length, 0);
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /No associated application/);
});

test("browser-only clients keep previewing on double-click", async () => {
  const app = await loadAppHandler(undefined);
  link(app.handler).props.onDoubleClick(event(2));
  assert.equal(app.previews.length, 1);
  assert.equal(app.previews[0][0], path);
  assert.equal(app.previews[0][2].previewKind, "explorer");
  assert.equal(app.alerts.length, 0);
});

test("directory links with encoded Chinese names use location preview without a content read", async () => {
  const app = await loadAppHandler(undefined);
  const directory = "C:/Users/me/中文目录";
  link(app.handler, "C:/Users/me/%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95").props.onClick(event());
  markdownSubject.flush();
  assert.equal(app.previews.length, 1);
  assert.equal(app.previews[0][0], directory);
  assert.equal(app.previews[0][2].previewKind, "explorer");
  assert.equal(app.previews[0][2].sourceSessionId, "source-session");
});
