import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { build, transform } from "esbuild";
import { openFileTab } from "./file-tab-state.ts";

const require = createRequire(import.meta.url);
const result = await build({
  entryPoints: [fileURLToPath(new URL("./LinkedFileExplorer.tsx", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic",
  plugins: [{ name: "component-hooks", setup(builder) {
    builder.onResolve({ filter: /^(react)$|(?:useI18n|FileIcons)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents:
      args.path === "react" ? "export const useState = (v) => runtime.useState(v); export const useEffect = (f, d) => runtime.useEffect(f, d);" :
      args.path.endsWith("useI18n") ? "export const useI18n = () => ({ t: runtime.translate });" :
      "export const FolderIcon = () => null; export const getFileIcon = () => null;",
    }));
  } }],
});

// Run the real renderer and effects, retaining state and effect cleanup across renders.
function mount(props, fetcher) {
  const slots = [], effects = [], pending = [], requests = [];
  let cursor = 0, dirty = false, mounted = true, tree;
  const runtime = {
    translate: (key) => key,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next) => {
        if (!mounted) assert.fail("state updated after unmount");
        const value = typeof next === "function" ? next(slots[index]) : next;
        if (!Object.is(value, slots[index])) { slots[index] = value; dirty = true; }
      }];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = effects[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        pending.push(() => {
          previous?.cleanup?.();
          effects[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, runtime, URLSearchParams, AbortController,
    fetch(url, options) { requests.push({ url, options }); return fetcher(url, options); },
  });
  function render() {
    do {
      dirty = false; cursor = 0;
      tree = module.exports.LinkedFileExplorer(props);
      pending.splice(0).forEach((effect) => effect());
    } while (dirty);
    return tree;
  }
  render();
  return {
    requests,
    render,
    get tree() { return tree; },
    async flush() {
      for (let i = 0; i < 3; i++) { await new Promise(setImmediate); if (dirty) render(); }
    },
    update(next) { props = { ...props, ...next }; render(); },
    unmount() { effects.forEach((effect) => effect?.cleanup?.()); mounted = false; },
  };
}

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
}
function labelled(subject, label) {
  const node = nodes(subject.tree).find((node) => node.props?.["aria-label"] === label);
  assert.ok(node, `Missing ${label}`);
  return node;
}
function row(subject, name) {
  const node = nodes(subject.tree).find((node) => node.props?.role === "option" && node.props.title.endsWith(`/${name}`));
  assert.ok(node, `Missing row ${name}`);
  return node;
}
function reply(data, status = 200) { return Promise.resolve({ ok: status < 400, status, json: async () => data }); }
const entry = (name, isDir = false) => ({ name, isDir, size: 0, modified: "" });
const props = { filePath: "C:/repo/中文目录", sourceSessionId: "source 中文", onOpenFile: () => assert.fail("unexpected contents"), onReveal: () => assert.fail("unexpected reveal") };
const requestType = (url) => new URL(url, "http://local").searchParams.get("type");

// The AppShell callback is exercised separately so its actual ID and option routing are checked.
test("AppShell opens a separate explorer tab and normal content tab without losing the source", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  const handleOpenFile = useCallback(");
  const end = source.indexOf("\n  const handleRevealFile", start);
  assert.ok(start >= 0 && end > start);
  const { code } = await transform(`${source.slice(start, end)}\nglobalThis.open = handleOpenFile;`, { loader: "ts" });
  let tabs = [], active, panelOpen;
  const context = { useCallback: (callback) => callback, openFileTab, isMobile: false,
    setFileTabs: (update) => { tabs = update(tabs); }, setActiveFileTabId: (id) => { active = id; },
    setRightPanelOpen: (value) => { panelOpen = value; },
  };
  vm.runInNewContext(code, context);
  context.open(props.filePath, "中文目录", { sourceSessionId: "s1", previewKind: "explorer" });
  assert.equal(active, `explorer:${props.filePath}`);
  assert.equal(panelOpen, true);
  assert.equal(tabs[0].previewKind, "explorer");
  context.open(props.filePath, "中文目录", { sourceSessionId: tabs[0].sourceSessionId });
  assert.equal(active, `file:${props.filePath}`);
  assert.equal(tabs.length, 2);
  assert.equal(tabs[1].previewKind, undefined);
  assert.equal(tabs[1].sourceSessionId, "s1");
});

test("directories use metadata then their own authorized listing, including dotted directory names", async () => {
  const subject = mount({ ...props, filePath: "C:/repo/中文目录.md" }, (url) => requestType(url) === "meta" ? reply({ isDir: true }) : reply({ entries: [entry("child", true)], path: "C:\\repo\\中文目录.md" }));
  assert.ok(nodes(subject.tree).some((node) => node.props?.role === "status" && node.props.children === "files.loading"));
  await subject.flush();
  assert.equal(subject.requests.length, 2);
  const [meta, list] = subject.requests.map(({ url }) => new URL(url, "http://local"));
  assert.equal(meta.searchParams.get("type"), "meta");
  assert.equal(list.searchParams.get("type"), "list");
  assert.equal(decodeURIComponent(list.pathname), "/api/files/C:/repo/中文目录.md");
  for (const url of [meta, list]) assert.equal(url.searchParams.get("sessionId"), "source 中文");
  assert.equal(labelled(subject, "files.location").props.value, "C:/repo/中文目录.md");
  assert.equal(labelled(subject, "files.viewContents").props.disabled, true);
  subject.unmount();
});

test("extensionless files show their parent, select the target, and open contents only by explicit command", async () => {
  const contents = [], reveals = [];
  const subject = mount({ ...props, filePath: "C:/repo/中文文件", onOpenFile: (...args) => contents.push(args), onReveal: (path) => reveals.push(path) }, (url) => requestType(url) === "meta" ? reply({ isDir: false }) : reply({ entries: [entry("中文文件"), entry("other")] }));
  await subject.flush();
  assert.equal(decodeURIComponent(new URL(subject.requests[1].url, "http://local").pathname), "/api/files/C:/repo");
  assert.equal(row(subject, "中文文件").props["aria-selected"], true);
  labelled(subject, "i18n.refresh").props.onClick(); subject.render(); await subject.flush();
  assert.equal(row(subject, "中文文件").props["aria-selected"], true, "refresh keeps the linked target highlighted");
  row(subject, "other").props.onClick(); subject.render();
  assert.equal(row(subject, "other").props["aria-selected"], true);
  assert.equal(contents.length, 0);
  row(subject, "other").props.onClick();
  row(subject, "other").props.onDoubleClick();
  assert.deepEqual(reveals, ["C:/repo/other"]);
  assert.equal(contents.length, 0);
  labelled(subject, "files.viewContents").props.onClick();
  assert.deepEqual(contents, [["C:/repo/other", "other"]]);
  subject.unmount();
});

test("parent listing permission failures are visible and never broaden authorization", async () => {
  const subject = mount({ ...props, filePath: "C:/denied/file" }, (url) => requestType(url) === "meta" ? reply({ isDir: false }) : reply({ error: "Access denied" }, 403));
  await subject.flush();
  assert.equal(subject.requests.length, 2);
  assert.ok(nodes(subject.tree).some((node) => node.props?.role === "alert" && node.props.children === "Access denied"));
  assert.equal(labelled(subject, "files.viewContents").props.disabled, true);
  assert.ok(subject.requests.every(({ url, options }) => !url.includes("allow-root") && !options.method));
  subject.unmount();
});

test("folder navigation, parent navigation, refresh and address submission remain read-only and authorized", async () => {
  const subject = mount({ ...props, filePath: "C:/repo" }, (url) => requestType(url) === "meta" ? reply({ isDir: true }) : reply({ entries: [entry("child", true)] }));
  await subject.flush();
  row(subject, "child").props.onClick(); subject.render(); await subject.flush();
  assert.equal(labelled(subject, "files.location").props.value, "C:/repo/child");
  labelled(subject, "files.parentDirectory").props.onClick(); subject.render(); await subject.flush();
  assert.equal(labelled(subject, "files.location").props.value, "C:/repo");
  const beforeRefresh = subject.requests.length;
  labelled(subject, "i18n.refresh").props.onClick(); subject.render(); await subject.flush();
  assert.equal(subject.requests.length, beforeRefresh + 2);
  labelled(subject, "files.location").props.onChange({ target: { value: "C:/other" } }); subject.render();
  nodes(subject.tree).find((node) => node.type === "form").props.onSubmit({ preventDefault() {} }); subject.render(); await subject.flush();
  assert.equal(labelled(subject, "files.location").props.value, "C:/other");
  for (const { url } of subject.requests) assert.equal(new URL(url, "http://local").searchParams.get("sessionId"), props.sourceSessionId);
  subject.unmount();
});

test("Windows drive, UNC share and POSIX roots disable parent navigation and show empty state", async () => {
  for (const filePath of ["C:/", "C:\\", "//server/share/", "/"]) {
    const subject = mount({ ...props, filePath }, (url) => requestType(url) === "meta" ? reply({ isDir: true }) : reply({ entries: [] }));
    await subject.flush();
    assert.equal(labelled(subject, "files.parentDirectory").props.disabled, true, filePath);
    assert.ok(nodes(subject.tree).some((node) => node.props?.role === "status" && node.props.children === "files.emptyDirectory"));
    subject.unmount();
  }
});

test("missing metadata and request failures show errors without guessing by path suffix", async () => {
  for (const [data, status, message] of [[{}, 200, "files.invalidMetadata"], [{ error: "Not found" }, 404, "Not found"]]) {
    const subject = mount(props, () => reply(data, status));
    await subject.flush();
    assert.equal(subject.requests.length, 1);
    assert.ok(nodes(subject.tree).some((node) => node.props?.role === "alert" && node.props.children === message));
    subject.unmount();
  }
});

test("late metadata or listing responses cannot overwrite new navigation or update after unmount", async () => {
  let resolveList;
  const subject = mount({ ...props, filePath: "C:/old" }, (url) => {
    if (requestType(url) === "meta") return reply({ isDir: true });
    if (url.includes("old")) return new Promise((resolve) => { resolveList = resolve; });
    return reply({ entries: [entry("new-file")] });
  });
  await subject.flush();
  const oldSignal = subject.requests[1].options.signal;
  labelled(subject, "files.location").props.onChange({ target: { value: "C:/new" } }); subject.render();
  nodes(subject.tree).find((node) => node.type === "form").props.onSubmit({ preventDefault() {} }); subject.render(); await subject.flush();
  assert.equal(oldSignal.aborted, true);
  resolveList(await reply({ entries: [entry("stale-file")], path: "C:/old" })); await subject.flush();
  assert.equal(labelled(subject, "files.location").props.value, "C:/new");
  row(subject, "new-file");
  assert.equal(nodes(subject.tree).some((node) => node.props?.title === "C:/old/stale-file"), false);
  subject.unmount();

  let resolveMeta;
  const pending = mount(props, () => new Promise((resolve) => { resolveMeta = resolve; }));
  const signal = pending.requests[0].options.signal;
  pending.unmount();
  assert.equal(signal.aborted, true);
  resolveMeta(await reply({ isDir: true })); await pending.flush();
  assert.equal(pending.requests.length, 1);
});

test("changing source sessions aborts the old request and reloads using the new authorization", async () => {
  let resolveOld;
  const subject = mount(props, (url) => {
    const params = new URL(url, "http://local").searchParams;
    if (params.get("sessionId") === props.sourceSessionId) return new Promise((resolve) => { resolveOld = resolve; });
    return requestType(url) === "meta" ? reply({ isDir: true }) : reply({ entries: [] });
  });
  const signal = subject.requests[0].options.signal;
  subject.update({ sourceSessionId: "new-source" }); await subject.flush();
  assert.equal(signal.aborted, true);
  assert.equal(subject.requests.length, 3);
  for (const { url } of subject.requests.slice(1)) assert.equal(new URL(url, "http://local").searchParams.get("sessionId"), "new-source");
  resolveOld(await reply({ isDir: false })); await subject.flush();
  assert.equal(subject.requests.length, 3, "stale metadata must not start a listing under the old session");
  assert.equal(labelled(subject, "files.location").props.value, props.filePath);
  subject.unmount();
});

test("all explorer messages are translated in the three built-in locales", async () => {
  const source = await readFile(new URL("./LinkedFileExplorer.tsx", import.meta.url), "utf8");
  const keys = [...source.matchAll(/\bt\("([\w.]+)"/g)].map((match) => match[1]);
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of keys) assert.ok(messages.includes(`"${key}":`), `${locale}: ${key}`);
  }
});
