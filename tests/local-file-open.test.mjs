import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build, transform } from "esbuild";
import { openLocalFile } from "../desktop/local-file-open.ts";
import { isSameOrigin, APP_ORIGIN } from "../desktop/navigation.ts";
import { DESKTOP_CHANNEL } from "../shared/contract.ts";
import { encodeFilePathForApi } from "../lib/file-paths.ts";

const root = resolve("local-file-open-fixture");
const file = (name) => join(root, name);
const fileStat = () => ({ isFile: () => true, isDirectory: () => false });
const directoryStat = () => ({ isFile: () => false, isDirectory: () => true });
const specialStat = () => ({ isFile: () => false, isDirectory: () => false });

function fixture(overrides = {}) {
  const calls = { requests: [], opens: [], reveals: [], stats: [], realpaths: [] };
  const dependencies = {
    stat: async (path) => { calls.stats.push(path); return fileStat(); },
    realpath: async (path) => { calls.realpaths.push(path); return path; },
    request: async (...args) => { calls.requests.push(args); return { status: 200 }; },
    openPath: async (path) => { calls.opens.push(path); return ""; },
    showItemInFolder: (path) => { calls.reveals.push(path); },
    ...overrides,
  };
  return { dependencies, calls };
}

function apiPath(path, sessionId) {
  return `/api/files/${encodeFilePathForApi(normalize(path))}?type=meta${sessionId == null ? "" : `&sessionId=${encodeURIComponent(sessionId)}`}`;
}

function assertNoShell(calls) {
  assert.deepEqual(calls.opens, []);
  assert.deepEqual(calls.reveals, []);
}

test("reveals spaces, Chinese and literal percent filenames without URL-decoding or execution", async () => {
  for (const name of ["space name.txt", "\u4e2d\u6587 \u6587\u6863.docx", "actual%20name.md", "literal%2F%25name.pdf", "bad%escape.txt"]) {
    const { dependencies, calls } = fixture();
    const path = file(name);
    await openLocalFile({ filePath: path, sourceSessionId: "session & another" }, dependencies);
    assert.deepEqual(calls.requests, [["http.request", {
      url: apiPath(path, "session & another"), method: "GET",
    }, 10_000]]);
    assert.deepEqual(calls.reveals, [normalize(path)]);
    assert.deepEqual(calls.opens, []);
    assert.equal(calls.stats.length, 3);
    assert.ok(calls.stats.every((candidate) => candidate === normalize(path)));
    if (name.includes("%20")) assert.match(calls.requests[0][1].url, /%2520/);
    if (name.includes("%2F")) assert.match(calls.requests[0][1].url, /%252F/);
  }
});

test("normalizes a native absolute path and treats missing/null session IDs identically", async () => {
  for (const sourceSessionId of [undefined, null]) {
    const { dependencies, calls } = fixture();
    const path = `${root}/nested/../report.TXT`;
    await openLocalFile({ filePath: path, sourceSessionId }, dependencies);
    assert.equal(calls.requests[0][1].url, apiPath(file("report.TXT")));
    assert.deepEqual(calls.reveals, [file("report.TXT")]);
    assert.deepEqual(calls.opens, []);
  }
});

test("reveals documents, executables, scripts, shortcuts, unknown and extensionless files without executing", async () => {
  for (const name of ["README", ..."md txt json pdf docx png mp3 mp4 exe com bat cmd ps1 js mjs cjs ts vbs vbe wsf wsh lnk url sh py scr msi hta html dll jar reg unknown".split(" ").map((ext) => `item.${ext.toUpperCase()}`)]) {
    const { dependencies, calls } = fixture();
    await openLocalFile({ filePath: file(name) }, dependencies);
    assert.deepEqual(calls.reveals, [file(name)], name);
    assert.deepEqual(calls.opens, [], name);
  }
});

test("opens ordinary and dotted directories directly without revealing them", async () => {
  for (const name of ["directory", "directory.txt", "\u4e2d\u6587 space%20", "project.v2"]) {
    const { dependencies, calls } = fixture();
    dependencies.stat = async (path) => { calls.stats.push(path); return directoryStat(); };
    await openLocalFile({ filePath: file(name) }, dependencies);
    assert.equal(calls.requests[0][1].url, apiPath(file(name)));
    assert.deepEqual(calls.opens, [file(name)]);
    assert.deepEqual(calls.reveals, []);
    assert.equal(calls.stats.length, 3);
  }
});

test("default filesystem dependencies reveal extensionless files and open canonical directories without a GUI", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-local-open-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const document = join(temp, "README");
  const directory = join(temp, "project.v2");
  const alias = join(temp, "alias");
  await writeFile(document, "content");
  await mkdir(directory);
  await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
  const { dependencies, calls } = fixture();
  delete dependencies.stat;
  delete dependencies.realpath;
  await openLocalFile({ filePath: document }, dependencies);
  await openLocalFile({ filePath: alias }, dependencies);
  assert.deepEqual(calls.reveals, [await realpath(document)]);
  assert.deepEqual(calls.opens, [await realpath(directory)]);
  assert.equal(calls.requests[1][1].url, apiPath(await realpath(directory)));
  await assert.rejects(openLocalFile({ filePath: join(temp, "missing") }, dependencies), /ENOENT/);
  assert.equal(calls.requests.length, 2);
});

test("rejects malformed options and session IDs before touching the filesystem", async () => {
  for (const options of [null, undefined, [], "file.txt", {}, { filePath: 1 },
    { filePath: file("ok.txt"), sourceSessionId: 12 },
    { filePath: file("ok.txt"), sourceSessionId: "" },
    { filePath: file("ok.txt"), sourceSessionId: "bad\nID" },
    { filePath: file("ok.txt"), sourceSessionId: "x".repeat(1025) }]) {
    const { dependencies, calls } = fixture();
    await assert.rejects(openLocalFile(options, dependencies), /Invalid/);
    assert.equal(calls.stats.length, 0);
    assert.equal(calls.requests.length, 0);
    assertNoShell(calls);
  }
});

test("rejects relative paths, URLs, controls, ADS and network/device paths", async () => {
  const invalid = ["", "relative.txt", "C:relative.txt", "file:///C:/file.txt", "https://example.com/file.txt",
    "javascript:alert(1)", "\\\\server\\share\\file.txt", "//server/share/file.txt",
    "\\\\?\\C:\\file.txt", "\\\\.\\C:\\file.txt", "\\Device\\file.txt",
    "C:/file.txt:stream.txt", `${root}/file.txt:stream.txt`,
    file("nul\u0000.txt"), file("newline\n.txt"), file("delete\u007f.txt"), file("control\u0085.txt"),
    `${root}/${"x".repeat(4096)}.txt`];
  if (process.platform === "win32") invalid.push("/rooted.txt", "\\rooted.txt", file("bad?.txt"), file("NUL.txt"),
    file("bad. /report.txt"), file("bad.txt "));
  for (const filePath of invalid) {
    const { dependencies, calls } = fixture();
    await assert.rejects(openLocalFile({ filePath }, dependencies));
    assert.equal(calls.stats.length, 0, filePath);
    assert.equal(calls.requests.length, 0, filePath);
    assertNoShell(calls);
  }
});

test("rejects special objects and missing paths", async () => {
  const { dependencies, calls } = fixture({ stat: async () => specialStat() });
  await assert.rejects(openLocalFile({ filePath: file("special") }, dependencies), /Not a regular file or directory/);
  assert.equal(calls.requests.length, 0);
  assertNoShell(calls);
  const missing = fixture({ stat: async () => { throw new Error("ENOENT"); } });
  await assert.rejects(openLocalFile({ filePath: file("missing") }, missing.dependencies), /ENOENT/);
  assertNoShell(missing.calls);
});

test("requires metadata status 200 for files and directories and propagates backend failures", async () => {
  for (const kind of [fileStat, directoryStat]) {
    for (const status of [204, 301, 400, 403, 404, 500]) {
      const { dependencies, calls } = fixture({ stat: async () => kind(), request: async () => ({ status }) });
      await assert.rejects(openLocalFile({ filePath: file("target") }, dependencies), new RegExp(`access denied \\(${status}\\)`));
      assertNoShell(calls);
    }
  }
  const { dependencies, calls } = fixture({ request: async () => { throw new Error("backend timed out"); } });
  await assert.rejects(openLocalFile({ filePath: file("document.txt") }, dependencies), /backend timed out/);
  assertNoShell(calls);
});

test("propagates directory shell errors and synchronous reveal errors", async () => {
  for (const openPath of [async () => "Folder could not be opened", async () => { throw new Error("shell failed"); }]) {
    const { dependencies, calls } = fixture({ openPath, stat: async () => directoryStat() });
    await assert.rejects(openLocalFile({ filePath: file("directory") }, dependencies), /Folder could not|shell failed/);
    assert.equal(calls.requests.length, 1);
    assert.deepEqual(calls.reveals, []);
  }
  const { dependencies, calls } = fixture({ showItemInFolder: () => { throw new Error("reveal failed"); } });
  await assert.rejects(openLocalFile({ filePath: file("document.txt") }, dependencies), /reveal failed/);
  assert.deepEqual(calls.opens, []);
});

test("authorizes and reveals a symlink's canonical path including executable targets", async () => {
  for (const name of ["target.txt", "payload.exe", "README"]) {
    const alias = file("alias.md");
    const target = file(name);
    const { dependencies, calls } = fixture({ realpath: async (path) => path === alias ? target : path });
    await openLocalFile({ filePath: alias, sourceSessionId: "source-session" }, dependencies);
    assert.equal(calls.requests[0][1].url, apiPath(target, "source-session"));
    assert.deepEqual(calls.reveals, [target]);
    assert.deepEqual(calls.opens, []);
  }
});

test("rejects unsafe canonical paths or type changes before authorization", async () => {
  for (const target of ["\\\\server\\share\\report.txt", "C:/report.txt:stream.txt"]) {
    const { dependencies, calls } = fixture({ realpath: async () => target });
    await assert.rejects(openLocalFile({ filePath: file("alias.txt") }, dependencies));
    assert.equal(calls.requests.length, 0);
    assertNoShell(calls);
  }
  for (const [initial, replacement] of [[fileStat, directoryStat], [directoryStat, fileStat], [fileStat, specialStat], [directoryStat, specialStat]]) {
    let count = 0;
    const { dependencies, calls } = fixture({ stat: async () => (++count === 1 ? initial() : replacement()) });
    await assert.rejects(openLocalFile({ filePath: file("alias") }, dependencies), /type changed/);
    assert.equal(calls.requests.length, 0);
    assertNoShell(calls);
  }
});

test("does not retry authorization against an alias when the real path is denied", async () => {
  const target = file("outside.txt");
  const { dependencies, calls } = fixture({ realpath: async () => target });
  dependencies.request = async (...args) => { calls.requests.push(args); return { status: 403 }; };
  await assert.rejects(openLocalFile({ filePath: file("session-referenced-alias.txt"), sourceSessionId: "session-1" }, dependencies), /access denied/);
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.requests[0][1].url, apiPath(target, "session-1"));
  assertNoShell(calls);
});

test("rejects symlink redirection, file/directory swaps, special objects and deletion during authorization", async () => {
  for (const initial of [fileStat, directoryStat]) {
    for (const replacement of ["symlink", "swap", "special", "missing"]) {
      let changed = false;
      const { dependencies, calls } = fixture({
        realpath: async (path) => changed && replacement === "symlink" ? file("outside") : path,
        stat: async () => {
          if (!changed) return initial();
          if (replacement === "missing") throw new Error("ENOENT");
          if (replacement === "special") return specialStat();
          if (replacement === "swap") return initial === fileStat ? directoryStat() : fileStat();
          return initial();
        },
        request: async () => { changed = true; return { status: 200 }; },
      });
      await assert.rejects(openLocalFile({ filePath: file("target") }, dependencies), /changed during authorization|ENOENT/);
      assertNoShell(calls);
    }
  }
});

test("checks availability initially, before the request and after backend authorization", async () => {
  for (const blockedCheck of [1, 2, 3]) {
    let checks = 0;
    const { dependencies, calls } = fixture({ assertAvailable: () => { if (++checks === blockedCheck) throw new Error("Backup in progress"); } });
    await assert.rejects(openLocalFile({ filePath: file("document.txt") }, dependencies), /Backup in progress/);
    assert.equal(calls.requests.length, blockedCheck === 3 ? 1 : 0);
    if (blockedCheck === 1) assert.equal(calls.stats.length, 0);
    assertNoShell(calls);
  }
});

test("main IPC only accepts the app's main frame and blocks backup before and after authorization", async () => {
  const source = await readFile(new URL("../desktop/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("ipcMain.handle(DESKTOP_CHANNEL.openLocalFile,");
  const end = source.indexOf("\nconst windowRequests", start);
  assert.ok(start >= 0 && end > start);
  const { code } = await transform(source.slice(start, end), { loader: "ts" });
  let handler;
  const frame = { url: `${APP_ORIGIN}/index.html` };
  const sender = { mainFrame: frame };
  const { dependencies, calls } = fixture();
  const context = {
    ipcMain: { handle: (channel, callback) => { assert.equal(channel, DESKTOP_CHANNEL.openLocalFile); handler = callback; } },
    DESKTOP_CHANNEL, APP_ORIGIN, isSameOrigin,
    mainWindow: { webContents: sender }, backupBusy: false,
    backend: { request: dependencies.request }, shell: { openPath: dependencies.openPath, showItemInFolder: dependencies.showItemInFolder },
    openLocalFile: (options, injected) => openLocalFile(options, { ...dependencies, ...injected }),
  };
  vm.runInNewContext(code, context);
  const options = { filePath: file("document.txt") };
  for (const event of [{ sender: {}, senderFrame: frame }, { sender, senderFrame: null },
    { sender, senderFrame: { url: frame.url } }]) {
    await assert.rejects(handler(event, options), /Only the main app window can open local files/);
  }
  for (const url of ["pi-app://app.evil/index.html", "pi-app://app:1234/index.html", "https://app/index.html", "file:///tmp/document.txt"]) {
    frame.url = url;
    await assert.rejects(handler({ sender, senderFrame: frame }, options), /Only the main app window/);
  }
  assert.equal(calls.requests.length, 0);
  frame.url = `${APP_ORIGIN}/index.html`;
  context.backupBusy = true;
  await assert.rejects(handler({ sender, senderFrame: frame }, options), /Backup in progress/);
  assert.equal(calls.requests.length, 0);
  context.backupBusy = false;
  await handler({ sender, senderFrame: frame }, options);
  assert.deepEqual(calls.reveals, [file("document.txt")]);
  assert.deepEqual(calls.opens, []);
  context.backend.request = async () => { context.backupBusy = true; return { status: 200 }; };
  await assert.rejects(handler({ sender, senderFrame: frame }, options), /Backup in progress/);
  assert.equal(calls.reveals.length, 1);
  context.backupBusy = false;
  context.backend.request = async () => { context.mainWindow = null; return { status: 200 }; };
  await assert.rejects(handler({ sender, senderFrame: frame }, options), /Only the main app window/);
  assert.equal(calls.reveals.length, 1);
});

test("preload exposes the dedicated bridge and preserves IPC errors", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../desktop/preload.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", external: ["electron"] });
  let bridge;
  let ipcError;
  const invocations = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "piDesktop"); bridge = value; } },
    ipcRenderer: { invoke: async (...args) => { invocations.push(args); if (ipcError) throw ipcError; } },
  };
  vm.runInNewContext(result.outputFiles[0].text, {
    require: (name) => { assert.equal(name, "electron"); return electron; },
    process: { env: {}, platform: process.platform },
  });
  const options = { filePath: file("document.txt"), sourceSessionId: null };
  assert.equal(await bridge.openLocalFile(options), undefined);
  assert.deepEqual(invocations, [[DESKTOP_CHANNEL.openLocalFile, options]]);
  ipcError = new Error("Access denied");
  await assert.rejects(bridge.openLocalFile(options), /Access denied/);
});
