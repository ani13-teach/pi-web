// Run only after npm run build:ui. This harness never starts the real app/backend.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "pi-mcp-settings-"));
const artifacts = path.join(root, ".artifacts", "mcp-ui");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
let succeeded = false;

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { SettingsPanel } from "@/components/SettingsPanel";
import { I18nProvider } from "@/hooks/useI18n";
import { mcpMessages } from "@/lib/i18n/messages/mcp";
import { MCP_REDACTED, type McpOverview } from "@/lib/mcp-types";
localStorage.setItem("pi-locale", "zh-CN");
localStorage.setItem("pi-theme", "light");
document.documentElement.dataset.theme = "light";
const clone = value => JSON.parse(JSON.stringify(value));
const rea = { name: "rea", overrideOnly: false, config: {
  command: "python", args: ["-m", "rea_mcp_server"],
  env: { API_KEY: MCP_REDACTED, LOG_LEVEL: "info" }, timeout: 30000,
  enabled: true, exposure: "codemode",
} };
const state: McpOverview = {
  config: {
    global: { scope: "global", path: "C:/fixture/global/mcp.json", revision: "g0", exists: true,
      editable: true, servers: [rea, { name: "remote", overrideOnly: false,
        config: { url: "https://fixture.invalid/mcp", enabled: true, exposure: "deferred" } }] },
    project: { scope: "project", path: "C:/fixture/.pi/mcp.json", revision: "p0", exists: true,
      editable: true, servers: [{ name: "rea", overrideOnly: true, config: { enabled: false, exposure: "hidden" } }] },
  },
  projectTrusted: true, configRoot: "C:/fixture/global",
  session: { id: "fixture-session", runtimeActive: false, busy: false, provider: "unloaded",
    generation: 0, appliedRevision: null, pending: true, applyState: "idle", activeTools: [], snapshot: null },
  affectedSessions: [],
};
const f = window.fixture = {
  requests: [], unexpectedFetches: [], errors: [], confirms: [], confirmAnswer: false,
  failNextPut: false, holdPut: false, releasePut: null, reloads: 0, closes: 0,
  messages: mcpMessages("zh-CN"), snapshot: () => clone(state),
  activate: () => Object.assign(state.session, {
    runtimeActive: true, provider: "builtin", activeTools: ["codemode", "tool_search"],
    snapshot: { generation: state.session.generation, started: true, errors: [], autoEnableCodemode: true,
      servers: [{ name: "rea", source: "C:/fixture/global/mcp.json", scope: "global", enabled: true,
        exposure: "codemode", state: "connected", tools: [{ name: "fixture_probe", callable: true, exposure: "codemode" }],
        resourceCount: 1, hasResources: true, resourcesCallable: true },
        { name: "remote", source: "C:/fixture/global/mcp.json", scope: "global", enabled: true,
          exposure: "deferred", state: "disconnected", tools: [], resourceCount: 0, hasResources: false }] },
  }),
};
window.confirm = message => { f.confirms.push(String(message)); return f.confirmAnswer; };
window.addEventListener("error", event => f.errors.push(event.message));
window.addEventListener("unhandledrejection", event => f.errors.push(String(event.reason)));
// Never capture/delegate native fetch: every non-MCP request is a hard failure.
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, "https://fixture.invalid");
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(String(init.body)) : null;
  const request = { sequence: f.requests.length + 1, method, path: url.pathname,
    query: Object.fromEntries(url.searchParams), body, status: null };
  f.requests.push(request);
  const reject = message => { f.unexpectedFetches.push({ ...request, message }); throw new Error(message); };
  if (url.origin !== "https://fixture.invalid" || url.pathname !== "/api/mcp"
    || url.searchParams.get("cwd") !== "C:/fixture" || url.searchParams.get("sessionId") !== "fixture-session"
    || [...url.searchParams.keys()].some(key => !["cwd", "sessionId"].includes(key))) return reject("Unexpected fixture request");
  if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const response = (value, status = 200) => {
    request.status = status;
    return new Response(JSON.stringify(clone(value)), { status, headers: { "Content-Type": "application/json" } });
  };
  if (method === "GET") return response(state);
  if (method === "PUT") {
    const view = state.config[body?.scope];
    if (!view || !["upsert", "delete"].includes(body?.operation) || !/^[A-Za-z0-9_-]+$/.test(body?.name || "")
      || Object.keys(body).some(key => !["scope", "revision", "name", "operation", "config"].includes(key))) return reject("Invalid mutation");
    if (f.holdPut) { f.holdPut = false; await new Promise(resolve => { f.releasePut = resolve; }); f.releasePut = null; }
    if (f.failNextPut) { f.failNextPut = false; return response({ error: "fixture save rejected" }, 500); }
    if (body.revision !== view.revision) return response({ error: "revision conflict" }, 409);
    const index = view.servers.findIndex(entry => entry.name === body.name);
    if (body.operation === "delete") view.servers = view.servers.filter(entry => entry.name !== body.name);
    else {
      if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) return reject("Missing configuration");
      const entry = { name: body.name, config: { ...(view.servers[index]?.config || {}), ...clone(body.config) }, overrideOnly: false };
      if (index < 0) view.servers.push(entry); else view.servers[index] = entry;
    }
    view.revision = body.scope[0] + (Number(view.revision.slice(1)) + 1);
    state.session.pending = true;
    return response(state);
  }
  if (method === "POST" && body?.sessionId === "fixture-session" && ["apply", "check"].includes(body?.action)
    && Object.keys(body).every(key => ["sessionId", "action"].includes(key))) {
    if (!state.session.runtimeActive || state.session.provider !== "builtin") return reject("Inactive runtime action");
    if (body.action === "apply") {
      state.session.generation++;
      state.session.snapshot.generation = state.session.generation;
      state.session.appliedRevision = state.config.global.revision;
      state.session.pending = false;
    }
    return response(state);
  }
  return reject("Unsupported MCP fixture action");
};
createRoot(document.getElementById("root")).render(
  <I18nProvider><SettingsPanel cwd="C:/fixture" sessionId="fixture-session" initialSection="mcp"
    onClose={() => f.closes++} onSessionReloaded={() => f.reloads++}
    quoteSelectionEnabled={false} onQuoteSelectionChange={() => {}} /></I18nProvider>
);
`;

// Only this disposable main runs: no app main, preload, IPC, backend or real config.
async function electronMain(options) {
  const { app, BrowserWindow, session } = require("electron");
  const fs = require("node:fs");
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");
  for (const key of ["userData", "sessionData", "crashDumps"]) app.setPath(key, path.join(__dirname, key));
  app.commandLine.appendSwitch("lang", "zh-CN");
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  app.disableHardwareAcceleration();
  const results = [], screenshots = [], network = [], rendererErrors = [];
  let win, evaluate, finished = false;
  const capture = async name => {
    const file = path.join(options.artifacts, `${options.runId}-${name}.png`);
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    screenshots.push(file);
  };
  const check = async (name, passed, detail) => {
    results.push({ name, passed: Boolean(passed), ...(passed ? {} : { detail }) });
    if (!passed) { await capture(`failure-${results.length}`); throw new Error(name + ": " + JSON.stringify(detail)); }
  };
  const finish = async code => {
    if (finished) return;
    finished = true;
    let fixtureState;
    try { fixtureState = await evaluate(() => ({ state: window.fixture.snapshot(), requests: window.fixture.requests,
      unexpectedFetches: window.fixture.unexpectedFetches, errors: window.fixture.errors, confirms: window.fixture.confirms })); }
    catch (error) { rendererErrors.push(error.message); }
    const report = { passed: results.filter(row => row.passed).length, total: results.length, results,
      screenshots, network, rendererErrors, fixtureState, inputs: options.inputs, mcpStylesEmbedded: options.mcpStylesEmbedded };
    const reportPath = path.join(options.artifacts, `${options.runId}-report.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`${report.passed}/${report.total} MCP UI checks; ${screenshots.length} screenshots\nReport: ${reportPath}`);
    app.exit(code);
  };
  const watchdog = setTimeout(() => { rendererErrors.push("Electron deadline exceeded"); void finish(1); }, 90000);
  try {
    await app.whenReady();
    const htmlUrl = pathToFileURL(path.join(__dirname, "fixture.html")).href;
    const allowed = new Set([htmlUrl, pathToFileURL(path.join(__dirname, "fixture.js")).href, ...options.resources]);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const ok = details.url.startsWith("file:") && allowed.has(details.url);
      if (!ok) network.push(details.url);
      callback({ cancel: !ok });
    });
    win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => { if (url !== htmlUrl) { event.preventDefault(); network.push(url); } });
    win.webContents.on("console-message", details => { if (details.level === "error" || details.level === 3) rendererErrors.push(details.message); });
    win.webContents.on("render-process-gone", (_event, details) => rendererErrors.push(JSON.stringify(details)));
    evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
    const frame = () => evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const waitFor = async (fn, ...args) => {
      const deadline = Date.now() + 7000;
      while (!await evaluate(fn, ...args)) {
        if (Date.now() > deadline) throw new Error("waitFor timed out: " + fn.toString());
        await frame();
      }
      await frame();
    };
    const click = async target => {
      const point = await evaluate(target => {
        const nodes = [...document.querySelectorAll(target.css)];
        const el = target.text === undefined ? nodes[0] : nodes.find(node => (node.querySelector(".config-sidebar-text")?.textContent ?? node.textContent).trim() === target.text);
        if (!el || el.disabled) throw new Error("Missing/disabled target " + JSON.stringify(target));
        el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        const r = el.getBoundingClientRect(), x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !(hit === el || el.contains(hit)))
          throw new Error("Clipped/occluded target " + JSON.stringify(target));
        return { x, y };
      }, typeof target === "string" ? { css: target } : target);
      for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...point, button: "left", clickCount: 1 });
      await frame();
    };
    const type = async (css, value) => {
      await click(css);
      await check("keyboard focus: " + css, await evaluate(css => document.activeElement === document.querySelector(css), css));
      for (const [keyCode, modifiers] of [["A", ["control"]], ["Backspace", []]]) {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      }
      await frame(); // Let React process clearing before inserting replacement text.
      // Chromium insertion supports Chinese/JSON text without synthetic DOM events.
      await win.webContents.insertText(value);
      await waitFor((css, value) => document.querySelector(css)?.value === value, css, value);
    };
    await win.loadFile(path.join(__dirname, "fixture.html"));
    await waitFor(() => document.documentElement.lang === "zh-CN" && document.querySelector(".mcp-settings input"));
    const messages = await evaluate(() => window.fixture.messages);
    const label = key => messages["mcp." + key] || ({ basicTab: "基本配置", advancedTab: "高级配置", runtimeTab: "运行状态",
      search: "搜索服务", variableName: "变量名", variableValue: "变量值", saveApply: "保存并应用" }[key]) || "mcp." + key;
    const field = (key, tag = "input") => `.mcp-settings ${tag}[aria-label=${JSON.stringify(label(key))}]`;
    const button = (key, css = ".mcp-settings button") => ({ css, text: label(key) });
    const tab = async key => { await click(button(key, '.mcp-settings button[role="tab"]')); await waitFor(text =>
      [...document.querySelectorAll('.mcp-settings [role="tab"]')].some(el => el.textContent.trim() === text && el.getAttribute("aria-selected") === "true"), label(key)); };
    const snapshot = () => evaluate(() => ({ state: window.fixture.snapshot(), requests: window.fixture.requests }));
    const puts = data => data.requests.filter(row => row.method === "PUT");
    const posts = data => data.requests.filter(row => row.method === "POST");
    const confirmation = '.mcp-confirm button, [role="alertdialog"] button';
    const waitConfirmation = () => waitFor(css => !!document.querySelector(css), confirmation);
    const waitMutation = async previous => {
      await waitFor(previous => window.fixture.requests.filter(row => row.method === "PUT" && row.status !== null).length > previous, previous);
      await waitFor(() => [...document.querySelectorAll(".mcp-settings button")]
        .some(el => el.textContent.trim() === window.fixture.messages["mcp.save"] && el.disabled));
      await frame();
    };
    const layout = async name => {
      await frame();
      const info = await evaluate(() => {
        const surface = document.querySelector(".settings-dialog-surface"), rect = surface.getBoundingClientRect();
        const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
        const overflow = [document.documentElement, document.body, surface, ...document.querySelectorAll(".mcp-settings, .config-sidebar, .config-detail, .config-footer, .config-field")]
          .filter(el => visible(el) && el.scrollWidth > el.clientWidth + 1).map(el => el.className || el.tagName);
        // Vertical clipping is allowed only within a genuine scrolling ancestor.
        const escaped = [...surface.querySelectorAll("button")].filter(visible).filter(el => {
          const r = el.getBoundingClientRect();
          let scrolls = false;
          for (let parent = el.parentElement; parent && parent !== surface; parent = parent.parentElement) {
            if (/auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 1) scrolls = true;
          }
          return r.left < rect.left - 1 || r.right > rect.right + 1
            || (!scrolls && (r.top < rect.top - 1 || r.bottom > rect.bottom + 1));
        }).map(el => el.textContent.trim() || el.getAttribute("aria-label"));
        const clippedText = [...document.querySelectorAll('.mcp-settings button, .mcp-settings [role="tab"], .mcp-settings .config-field-label')]
          .filter(el => visible(el) && el.textContent.trim() && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)).map(el => el.textContent.trim());
        return { width: innerWidth, height: innerHeight, overflow, escaped, clippedText,
          inside: rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 };
      });
      await check(name + ": no horizontal overflow, buttons/labels contained", info.inside && !info.overflow.length && !info.escaped.length && !info.clippedText.length, info);
      await capture(name);
    };
    const captureTab = async (key, name) => {
      await tab(key);
      await evaluate(() => { const detail = document.querySelector(".mcp-settings .config-detail"); if (detail) detail.scrollTop = 0; });
      await layout(name);
      if (key === "basicTab" && await evaluate(() => { const el = document.querySelector(".mcp-settings .config-detail"); return el && el.scrollHeight > el.clientHeight + 1; })) {
        await evaluate(() => { const el = document.querySelector(".mcp-settings .config-detail"); el.scrollTop = el.scrollHeight; });
        await layout(name + "-bottom");
      }
    };
    await waitFor(css => document.querySelector(css)?.value === "python", field("command"));
    await check("automatically selects rea", await evaluate(css => document.querySelector(css)?.value === "python" &&
      [...document.querySelectorAll('.mcp-settings .config-sidebar-item[aria-current="page"]')].some(el => el.querySelector(".config-sidebar-text")?.textContent.trim() === "rea"), field("command")));
    await check("existing name is immutable", await evaluate(css => { const el = document.querySelector(css); return !el || el.disabled || el.readOnly; }, field("name")));
    await check("scope controls live in sidebar", await evaluate(text => [...document.querySelectorAll(".mcp-settings .config-sidebar button")].some(el => el.textContent.trim() === text), label("project")));
    await tab("basicTab");
    await check("environment values use password fields", await evaluate(prefix => {
      const fields = [...document.querySelectorAll(".mcp-settings input")].filter(el => el.getAttribute("aria-label")?.startsWith(prefix));
      return fields.length >= 2 && fields.every(el => el.type === "password") && fields.some(el => el.value === "info")
        && ![...document.querySelectorAll('.mcp-settings input:not([type="password"])')].some(el => el.value === "info" || el.value === "__PI_DESKTOP_REDACTED__");
    }, label("variableValue")));
    const secretField = '.mcp-settings input[aria-label=' + JSON.stringify(label("variableValue") + " API_KEY") + ']';
    await type(secretField, "temporary-secret");
    await type(secretField, "");
    await check("clearing a replacement restores the original hidden credential", await evaluate(() =>
      document.querySelector('.mcp-settings input[aria-label="' + window.fixture.messages["mcp.variableValue"] + ' API_KEY"]').value === ""
      && [...document.querySelectorAll(".mcp-settings button")].find(el => el.textContent.trim() === window.fixture.messages["mcp.save"]).disabled));
    await tab("runtimeTab");
    await check("inactive apply/check disabled with honest explanation", await evaluate((apply, check, reason) => {
      const buttons = [...document.querySelectorAll(".mcp-settings button")];
      const disabled = text => buttons.find(el => el.textContent.trim() === text)?.disabled === true;
      return disabled(apply) && disabled(check) && document.querySelector(".mcp-settings").textContent.includes(reason);
    }, label("apply"), label("check"), label("provider.unloaded")));
    for (const [width, height] of [[1440, 900], [1000, 760], [640, 780], [420, 760]]) {
      win.setContentSize(width, height);
      await waitFor((w, h) => innerWidth === w && innerHeight === h, width, height);
      for (const key of ["basicTab", "advancedTab", "runtimeTab"]) await captureTab(key, `light-${width}x${height}-${key}`);
    }
    win.setContentSize(1440, 900);
    await waitFor(() => innerWidth === 1440 && innerHeight === 900);
    await tab("basicTab");
    let before = await snapshot();
    await type(field("command"), "python-fixture-draft");
    const pollCount = (await snapshot()).requests.filter(row => row.method === "GET").length;
    await waitFor(count => window.fixture.requests.filter(row => row.method === "GET").length > count, pollCount);
    await check("real polling does not replace unsaved draft", await evaluate(css => document.querySelector(css)?.value === "python-fixture-draft", field("command")));
    await type(field("args", "textarea"), '["-m","rea_mcp_server","--fixture"]');
    await click(button("save"));
    await waitMutation(puts(before).length);
    let after = await snapshot();
    await check("save only PUTs and preserves unknown/env/JSON fields", puts(after).length === puts(before).length + 1 && posts(after).length === posts(before).length
      && after.state.config.global.servers[0].config.command === "python-fixture-draft"
      && after.state.config.global.servers[0].config.timeout === 30000
      && after.state.config.global.servers[0].config.env.API_KEY === "__PI_DESKTOP_REDACTED__"
      && after.state.config.global.servers[0].config.args.at(-1) === "--fixture", puts(after).at(-1));
    await tab("advancedTab");
    const advanced = JSON.parse(await evaluate(css => document.querySelector(css)?.value, field("advanced", "textarea")));
    await check("advanced JSON retains timeout without revealing environment values", advanced.timeout === 30000 && !("env" in advanced), advanced);
    await type(field("advanced", "textarea"), JSON.stringify({ ...advanced, timeout: 45000, fixtureOption: { retained: true } }, null, 2));
    before = await snapshot(); await click(button("save")); await waitMutation(puts(before).length); after = await snapshot();
    await check("advanced changes and unknown fields saved", after.state.config.global.servers[0].config.timeout === 45000
      && after.state.config.global.servers[0].config.fixtureOption.retained && after.state.config.global.servers[0].config.env.LOG_LEVEL === "info");
    await type(field("search"), "remote");
    await check("search filters server list", await evaluate(() => {
      const names = [...document.querySelectorAll(".mcp-settings .config-sidebar-text")].map(el => el.textContent.trim());
      return names.includes("remote") && !names.includes("rea");
    }));
    await type(field("search"), "不存在的服务");
    await check("Chinese search handles no matches", await evaluate(() => document.querySelectorAll(".mcp-settings .config-sidebar-item").length === 0));
    await type(field("search"), "");
    await click(button("project"));
    await waitFor(text => document.querySelector(".mcp-settings").textContent.includes(text), "C:/fixture/.pi/mcp.json");
    await check("project scope is selected", await evaluate(text => [...document.querySelectorAll(".mcp-settings .config-sidebar button")]
      .some(el => el.textContent.trim() === text && el.getAttribute("aria-pressed") === "true"), label("project")));
    await click(button("global")); await tab("basicTab");
    await waitFor(css => document.querySelector(css)?.value === "python-fixture-draft", field("command"));
    before = await snapshot(); await click(button("delete")); await waitConfirmation();
    await check("delete confirmation identifies its original target", await evaluate(() => document.querySelector(".mcp-confirm strong")?.textContent === "rea"));
    await click({ css: ".mcp-settings .config-sidebar-item", text: "remote" });
    await check("switching server cancels pending deletion instead of deleting the new selection", await evaluate(() => !document.querySelector(".mcp-confirm")) && puts(await snapshot()).length === puts(before).length);
    await click({ css: ".mcp-settings .config-sidebar-item", text: "rea" });
    before = await snapshot(); await click(button("add"));
    await check("new service name is editable", await evaluate(css => { const el = document.querySelector(css); return el && !el.disabled && !el.readOnly; }, field("name")));
    await type(field("name"), "fixture_new"); await type(field("command"), "fixture-command");
    await click({ css: ".mcp-settings .config-sidebar-item", text: "rea" });
    await check("cancel discard keeps new draft and sends no writes", await evaluate(css => document.querySelector(css)?.value === "fixture_new" && window.fixture.confirms.length > 0, field("name"))
      && puts(await snapshot()).length === puts(before).length);
    await click(button("save")); await waitMutation(puts(before).length);
    before = await snapshot(); await click(button("delete")); await waitConfirmation(); await capture("delete-confirm");
    await click(button("cancel", confirmation)); await frame();
    await check("cancel delete keeps config without mutation", puts(await snapshot()).length === puts(before).length &&
      (await snapshot()).state.config.global.servers.some(el => el.name === "fixture_new"));
    await click(button("delete")); await waitConfirmation(); await click(button("confirm", confirmation));
    await waitFor(() => !window.fixture.snapshot().config.global.servers.some(el => el.name === "fixture_new"));
    await click({ css: ".mcp-settings .config-sidebar-item", text: "rea" });
    await evaluate(() => window.fixture.activate());
    await tab("runtimeTab");
    await waitFor(text => [...document.querySelectorAll(".mcp-settings button")].some(el => el.textContent.trim() === text && !el.disabled), label("check"));
    before = await snapshot(); await click(button("check"));
    await waitFor(n => window.fixture.requests.filter(row => row.method === "POST").length > n, posts(before).length);
    await check("active check is POST check only", posts(await snapshot()).at(-1)?.body.action === "check");
    await tab("basicTab"); await type(field("command"), "python-save-apply");
    before = await snapshot(); await click(button("saveApply")); await waitConfirmation(); await capture("save-apply-confirm");
    await check("save/apply waits for confirmation", puts(await snapshot()).length === puts(before).length && posts(await snapshot()).length === posts(before).length);
    await click(button("cancel", confirmation));
    await check("cancel save/apply does not mutate", puts(await snapshot()).length === puts(before).length && posts(await snapshot()).length === posts(before).length);
    await click(button("saveApply")); await waitConfirmation();
    await evaluate(() => { window.fixture.holdPut = true; });
    await click(button("confirm", confirmation));
    await waitFor(n => window.fixture.requests.filter(row => row.method === "PUT").length > n && !!window.fixture.releasePut, puts(before).length);
    await check("apply cannot run while PUT is unresolved", posts(await snapshot()).length === posts(before).length);
    await evaluate(() => window.fixture.releasePut());
    await waitFor(n => window.fixture.requests.filter(row => row.method === "POST" && row.body.action === "apply" && row.status === 200).length > n,
      posts(before).filter(row => row.body.action === "apply").length);
    after = await snapshot();
    const put = puts(after).at(-1), post = posts(after).at(-1);
    await check("successful PUT precedes POST apply", put.status === 200 && post.body.action === "apply" && post.sequence > put.sequence
      && post.body.sessionId === "fixture-session" && after.state.config.global.servers[0].config.command === "python-save-apply", { put, post });
    await waitFor(text => [...document.querySelectorAll(".mcp-settings button")].some(el => el.textContent.trim() === text && el.disabled), label("save"));
    await type(field("command"), "python-failed-save");
    before = await snapshot(); await evaluate(() => { window.fixture.failNextPut = true; });
    await click(button("saveApply")); await waitConfirmation(); await click(button("confirm", confirmation));
    await waitFor(text => document.querySelector(".mcp-settings").textContent.includes(text), label("requestFailed"));
    await waitFor(n => window.fixture.requests.some(row => row.method === "GET" && row.sequence > n), before.requests.length + 1);
    after = await snapshot();
    await check("failed PUT never applies or overwrites saved config", puts(after).at(-1).status === 500 && posts(after).length === posts(before).length
      && after.state.config.global.servers[0].config.command === "python-save-apply"
      && await evaluate(css => document.querySelector(css)?.value === "python-failed-save", field("command")));
    // Refresh only fixture data; explicitly permit the expected discard dialog.
    await evaluate(() => { window.fixture.confirmAnswer = true; }); await click(button("refresh"));
    await waitFor(css => document.querySelector(css)?.value === "python-save-apply", field("command"));
    await evaluate(() => { localStorage.setItem("pi-theme", "dark"); document.documentElement.dataset.theme = "dark"; document.documentElement.classList.add("dark"); });
    for (const key of ["basicTab", "advancedTab", "runtimeTab"]) await captureTab(key, `dark-1440x900-${key}`);
    const errors = await evaluate(() => ({ errors: window.fixture.errors, unexpected: window.fixture.unexpectedFetches, closes: window.fixture.closes }));
    await check("no renderer errors or non-fixture/network traffic", !rendererErrors.length && !network.length && !errors.errors.length && !errors.unexpected.length && errors.closes === 0,
      { rendererErrors, network, ...errors });
    clearTimeout(watchdog); await finish(0);
  } catch (error) {
    rendererErrors.push(error.stack || error.message);
    try { if (win && !win.isDestroyed()) await capture("scenario-failure"); } catch { /* best effort */ }
    clearTimeout(watchdog); await finish(1);
  }
}

try {
  await mkdir(artifacts, { recursive: true });
  const assets = path.join(root, "dist", "renderer", "assets");
  const entries = await readdir(assets, { withFileTypes: true });
  const cssPaths = entries.filter(entry => entry.isFile() && entry.name.endsWith(".css")).map(entry => path.join(assets, entry.name)).sort();
  if (!cssPaths.length) throw new Error("Missing built renderer CSS. Run npm run build:ui first.");
  const input = async file => { const data = await readFile(file); return { file, sha256: createHash("sha256").update(data).digest("hex"), mtimeMs: (await stat(file)).mtimeMs }; };
  const inputs = await Promise.all([...cssPaths, path.join(root, "renderer", "mcp-settings.css"), path.join(root, "components", "McpConfig.tsx"), path.join(root, "components", "SettingsPanel.tsx")].map(input));
  const mcpSource = path.join(root, "renderer", "mcp-settings.css");
  const mcpInput = inputs.find(row => row.file === mcpSource);
  const builtCss = await Promise.all(cssPaths.map(file => readFile(file, "utf8")));
  // A fresh build containing the MCP rules needs no duplicate stylesheet.
  const embedded = builtCss.some((css, index) => css.includes(".mcp-settings") && inputs[index].mtimeMs >= mcpInput.mtimeMs);
  const resources = entries.filter(entry => entry.isFile()).map(entry => pathToFileURL(path.join(assets, entry.name)).href);
  const styles = cssPaths.map(file => pathToFileURL(file).href);
  if (!embedded) {
    const latest = path.join(temporary, "mcp-settings.css");
    await writeFile(latest, await readFile(mcpSource));
    styles.push(pathToFileURL(latest).href); resources.push(pathToFileURL(latest).href);
  }
  await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root, sourcefile: "mcp-settings-fixture.tsx" },
    bundle: true, platform: "browser", format: "iife", jsx: "automatic", alias: { "@": root },
    outfile: path.join(temporary, "fixture.js"), define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent" });
  const links = styles.map(url => `<link rel="stylesheet" href="${url.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`).join("");
  await writeFile(path.join(temporary, "fixture.html"), `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'none'">${links}</head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
  await writeFile(path.join(temporary, "main.cjs"), `(${electronMain.toString()})(${JSON.stringify({ artifacts, runId, resources, inputs, mcpStylesEmbedded: embedded })});\n`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)("electron"), [path.join(temporary, "main.cjs")], { cwd: temporary, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => process.stdout.write(chunk));
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 100000);
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); }).finally(() => clearTimeout(timeout));
  let report;
  try { report = JSON.parse(await readFile(path.join(artifacts, `${runId}-report.json`), "utf8")); } catch { /* missing report fails */ }
  succeeded = !timedOut && exit === 0 && report?.total > 0 && report.passed === report.total
    && report.results.every(row => row.passed) && !report.network.length && !report.rendererErrors.length;
  process.exitCode = succeeded ? 0 : 1;
  if (!succeeded) console.error(`MCP UI regression failed. Screenshots/reports: ${artifacts}; isolated fixture: ${temporary}`);
} catch (error) {
  console.error(error.stack || error.message); process.exitCode = 1;
} finally {
  // Screenshots/reports are persistent and uniquely named; never remove .artifacts/mcp-ui.
  if (succeeded) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  else console.error(`Isolated fixture retained: ${temporary}`);
}
