import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bundle the real components; the disposable renderer owns all mock state.
// No app main/preload, server, model, or user agent files participate.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electron = require("electron");
const temporary = await mkdtemp(path.join(tmpdir(), "pi-subagent-settings-"));
const started = Date.now();
let succeeded = false;

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { AgentsConfig } from "@/components/AgentsConfig";
import { I18nProvider } from "@/hooks/useI18n";
import { DEFAULT_SUBAGENT_RUNTIME_SETTINGS, RUNTIME_SETTING_FIELDS } from "@/lib/subagent-runtime-schema";
localStorage.setItem("pi-locale", "en");
const clone = value => JSON.parse(JSON.stringify(value));
const initialProfile = {
  name: "plan", displayName: "Plan", description: "Fixture planning profile",
  systemPrompt: "Plan this fixture task without executing a model.",
  tools: ["read", "grep", "find", "ls"], extensionTools: ["ext:fixture/original"],
  loadSkills: true, loadExtensions: true, model: "fixture/fixture-model",
  fallbackModel: "", thinking: "medium", maxTurns: 12,
  inheritContext: false, runInBackground: false, promptMode: "replace",
  color: "#245bce", isolation: "off", persistSession: true, enabled: true,
  scope: "builtin", filePath: "C:/fixture/desktop-agents/plan.md", effective: true,
};
const state = {
  global: { maxConcurrent: 4 }, project: {}, profile: clone(initialProfile),
  settings: { enabled: true, maxConcurrent: 4 },
};
const version = { runtime: 0, profiles: 0, settings: 0 };
window.fixture = {
  requests: [], unexpectedFetches: [], errors: [], selectInjections: [], closes: 0, failNextProfileRead: false,
  defaults: clone(DEFAULT_SUBAGENT_RUNTIME_SETTINGS), fields: clone(RUNTIME_SETTING_FIELDS),
  initialProfile: clone(initialProfile), version,
  snapshot: () => clone(state),
};
window.addEventListener("error", event => window.fixture.errors.push(event.message));
window.addEventListener("unhandledrejection", event => window.fixture.errors.push(String(event.reason)));
const runtime = scope => ({
  scope,
  filePath: scope === "global" ? "C:/fixture/global/subagents.json" : "C:/fixture/.pi/subagents.json",
  values: clone(state[scope]), global: clone(state.global), project: clone(state.project),
  effective: { ...DEFAULT_SUBAGENT_RUNTIME_SETTINGS, ...state.global, ...state.project },
});
// Never retain or delegate to the native fetch implementation.
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, "https://fixture.invalid");
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(String(init.body)) : null;
  const request = { sequence: window.fixture.requests.length + 1, method, path: url.pathname,
    query: Object.fromEntries(url.searchParams), body, versionBefore: clone(version) };
  window.fixture.requests.push(request);
  const reject = message => {
    window.fixture.unexpectedFetches.push({ ...request, message });
    throw new Error(message);
  };
  if (url.origin !== "https://fixture.invalid") return reject("External fetch blocked");
  if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  let result;
  if (method === "GET" && url.pathname === "/api/subagents/profiles") {
    if (url.searchParams.get("cwd") !== "C:/fixture") return reject("Unexpected profiles cwd");
    if (window.fixture.failNextProfileRead) {
      window.fixture.failNextProfileRead = false;
      request.versionAfter = clone(version);
      request.response = { error: "Fixture profile refresh unavailable" };
      return new Response(JSON.stringify(request.response), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    result = { profiles: [clone(state.profile)] };
  } else if (method === "GET" && url.pathname === "/api/subagents/settings") {
    result = clone(state.settings);
  } else if (method === "GET" && url.pathname === "/api/models") {
    if (url.searchParams.get("cwd") !== "C:/fixture") return reject("Unexpected models cwd");
    result = { modelList: [{ provider: "fixture", id: "fixture-model", name: "Fixture model" }], modelError: null };
  } else if (method === "GET" && url.pathname === "/api/subagents/runtime-settings") {
    const scope = url.searchParams.get("scope");
    if (url.searchParams.get("cwd") !== "C:/fixture" || !["global", "project"].includes(scope)) return reject("Unexpected runtime query");
    result = runtime(scope);
  } else if (method === "PUT" && url.pathname === "/api/subagents/runtime-settings") {
    if (body?.cwd !== "C:/fixture" || !["global", "project"].includes(body.scope)
      || Object.keys(body).sort().join(",") !== "cwd,patch,scope" || !body.patch
      || Object.keys(body.patch).some(key => !RUNTIME_SETTING_FIELDS.some(field => field.key === key))) return reject("Invalid runtime patch body");
    for (const [key, value] of Object.entries(body.patch)) {
      if (value === null) delete state[body.scope][key];
      else state[body.scope][key] = value;
    }
    version.runtime++;
    result = runtime(body.scope);
  } else if (method === "PUT" && url.pathname === "/api/subagents/profiles") {
    if (body?.cwd !== "C:/fixture" || body.scope !== "builtin" || body.originalName !== "plan"
      || body.createOnly !== false || body.profile?.name !== "plan") return reject("Invalid fixture profile save");
    state.profile = { ...clone(body.profile), scope: body.scope, effective: true };
    version.profiles++;
    result = { profile: clone(state.profile) };
  } else if (method === "PUT" && url.pathname === "/api/subagents/settings") {
    if (typeof body?.enabled !== "boolean") return reject("Invalid fixture settings save");
    state.settings = { ...state.settings, enabled: body.enabled };
    version.settings++;
    result = clone(state.settings);
  } else return reject("Unexpected fixture request");
  request.versionAfter = clone(version);
  request.response = clone(result);
  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
};
createRoot(document.getElementById("root")).render(
  <I18nProvider><AgentsConfig cwd="C:/fixture" onClose={() => window.fixture.closes++} /></I18nProvider>
);
`;

// Serialized into the one-off Electron main process. No imports from the app.
async function electronMain() {
  const { app, BrowserWindow, session } = require("electron");
  const path = require("node:path");
  const fs = require("node:fs");
  const { pathToFileURL } = require("node:url");
  app.setPath("userData", path.join(__dirname, "user-data"));
  app.setPath("sessionData", path.join(__dirname, "session-data"));
  app.setPath("crashDumps", path.join(__dirname, "crash-dumps"));
  app.commandLine.appendSwitch("disable-background-networking");
  // Keep frames advancing in an unattended Windows desktop / occluded window.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  const results = [];
  const unexpectedRequests = [];
  const rendererErrors = [];
  const screenshots = [];
  let win;
  let evaluate;
  let finished = false;
  const screenshot = async name => {
    if (!win || win.isDestroyed()) return;
    try {
      const filename = `${String(screenshots.length + 1).padStart(2, "0")}-${name.replace(/[^a-z0-9-]/gi, "-").slice(0, 100)}.png`;
      fs.writeFileSync(path.join(__dirname, filename), (await win.webContents.capturePage()).toPNG());
      screenshots.push(filename);
    } catch (error) { console.error("Screenshot failed: " + error.message); }
  };
  const finish = async code => {
    if (finished) return;
    finished = true;
    let fixtureState;
    try {
      fixtureState = await evaluate?.(() => ({ requests: window.fixture?.requests,
        state: window.fixture?.snapshot(), version: window.fixture?.version,
        unexpectedFetches: window.fixture?.unexpectedFetches, errors: window.fixture?.errors,
        selectInjections: window.fixture?.selectInjections, html: document.getElementById("root").innerHTML }));
    } catch (error) { rendererErrors.push("Diagnostic snapshot: " + error.message); }
    const passed = results.filter(result => result.passed).length;
    fs.writeFileSync(path.join(__dirname, "result.json"), JSON.stringify({
      passed, total: results.length, results, screenshots, unexpectedRequests, rendererErrors, fixtureState,
    }, null, 2));
    console.log(`${passed}/${results.length} subagent settings browser checks passed`);
    console.log("Fixture versions: " + JSON.stringify(fixtureState?.version));
    console.log(`Fixture requests: ${fixtureState?.requests?.length ?? 0}; select change injections: ${fixtureState?.selectInjections?.length ?? 0}`);
    app.exit(code);
  };
  const check = async (name, condition, detail = "") => {
    const passed = Boolean(condition);
    results.push({ name, passed, detail: passed ? "" : detail });
    console.log(`${passed ? "PASS" : "FAIL"}: ${name}${!passed && detail ? " -- " + detail : ""}`);
    if (!passed) await screenshot("failure-" + results.length + "-" + name);
  };
  const watchdog = setTimeout(async () => {
    await check("Electron scenario meets 60-second deadline", false);
    await finish(1);
  }, 60000);
  try {
    await app.whenReady();
    const htmlUrl = pathToFileURL(path.join(__dirname, "fixture.html")).href;
    const jsUrl = pathToFileURL(path.join(__dirname, "fixture.js")).href;
    // Only these two generated files can load. CSP separately denies connections.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url === htmlUrl || details.url === jsUrl;
      if (!allowed) unexpectedRequests.push(details.url);
      callback({ cancel: !allowed });
    });
    win = new BrowserWindow({
      width: 1100, height: 800, useContentSize: true, show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => { if (url !== htmlUrl) event.preventDefault(); });
    win.webContents.on("console-message", details => {
      if (details.level === "error") rendererErrors.push(details.message);
    });
    win.webContents.on("render-process-gone", (_event, details) => rendererErrors.push(JSON.stringify(details)));
    evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
    const settle = () => evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const waitFor = async (fn, ...args) => {
      const deadline = Date.now() + 5000;
      while (!await evaluate(fn, ...args)) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for " + fn.toString());
        await settle();
      }
      await settle();
    };
    // All clicks use hit-tested coordinates and real Chromium input dispatch.
    const click = async target => {
      const point = await evaluate(target => {
        const elements = [...document.querySelectorAll(target.css)];
        const element = target.text === undefined ? elements[0] : elements.find(item => item.textContent.trim() === target.text);
        if (!element) throw new Error("Missing click target " + JSON.stringify(target));
        if (element.disabled) throw new Error("Disabled click target " + JSON.stringify(target));
        element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        const rect = element.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const hit = document.elementFromPoint(x, y);
        if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight
          || !(hit === element || element.contains(hit))) throw new Error("Click target is clipped/occluded " + JSON.stringify(target));
        return { x, y };
      }, typeof target === "string" ? { css: target } : target);
      win.webContents.sendInputEvent({ type: "mouseMove", ...point });
      win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      await settle();
    };
    const key = async (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await settle();
    };
    const type = async (css, text) => {
      await click(css);
      await check("keyboard input focuses " + css, await evaluate(css => document.activeElement === document.querySelector(css), css));
      await key("A", ["control"]);
      await key("Backspace");
      // Real char events, no DOM value setters or synthetic input/change for text.
      for (const character of text) win.webContents.sendInputEvent({ type: "char", keyCode: character });
      await settle();
      await check("real keyboard changes " + css, await evaluate((css, text) => document.querySelector(css)?.value === text, css, text));
    };
    // Explicit exception: native select popups cannot be queried from the DOM.
    // First click the actual control; then inject only its select change event.
    const select = async (css, value) => {
      await click(css);
      await key("Escape");
      await evaluate((css, value) => {
        const element = document.querySelector(css);
        if (!(element instanceof HTMLSelectElement) || element.disabled
          || ![...element.options].some(option => option.value === value)) throw new Error("Invalid select injection " + css);
        element.value = value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
        window.fixture.selectInjections.push({ css, value });
      }, css, value);
      await settle();
    };
    const runtimeSave = ".config-detail .config-footer button.config-button-primary";
    const field = (scope, name) => `#subagent-runtime-${scope}-${name}`;
    const snapshot = () => evaluate(() => ({
      state: window.fixture.snapshot(), requests: window.fixture.requests, version: { ...window.fixture.version },
      runtimePuts: window.fixture.requests.filter(request => request.path === "/api/subagents/runtime-settings" && request.method === "PUT"),
      profilePuts: window.fixture.requests.filter(request => request.path === "/api/subagents/profiles" && request.method === "PUT"),
      settingsPuts: window.fixture.requests.filter(request => request.path === "/api/subagents/settings" && request.method === "PUT"),
    }));
    const checkLayout = async (width, height, stage) => {
      const layout = await evaluate(() => {
        const detail = document.querySelector(".config-detail");
        const surface = document.querySelector(".config-panel-surface");
        const overflow = [document.documentElement, document.body, surface, detail,
          ...document.querySelectorAll(".config-field, .config-footer, .config-sidebar")]
          .filter(element => element.scrollWidth > element.clientWidth + 1)
          .map(element => ({ tag: element.tagName, class: element.className, client: element.clientWidth, scroll: element.scrollWidth }));
        const rect = surface.getBoundingClientRect();
        detail.scrollTop = 0;
        return { width: innerWidth, height: innerHeight, overflow, scrollable: detail.scrollHeight > detail.clientHeight,
          overflowY: getComputedStyle(detail).overflowY,
          inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight };
      });
      await settle();
      await check(`${stage}: exact ${width}x${height} viewport and modal inside it`, layout.width === width && layout.height === height && layout.inViewport, JSON.stringify(layout));
      await check(`${stage}: no horizontal overflow`, layout.overflow.length === 0, JSON.stringify(layout.overflow));
      await check(`${stage}: runtime detail scrolls vertically`, layout.scrollable && layout.overflowY === "auto", JSON.stringify(layout));
      await screenshot(stage + "-top");
      const bottom = await evaluate(() => {
        const detail = document.querySelector(".config-detail");
        detail.scrollTop = detail.scrollHeight;
        const button = detail.querySelector(".config-footer button.config-button-primary");
        const rect = button.getBoundingClientRect();
        const parent = detail.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { scrolled: detail.scrollTop > 0, reachedBottom: Math.abs(detail.scrollHeight - detail.clientHeight - detail.scrollTop) <= 1,
          visible: rect.top >= parent.top && rect.bottom <= parent.bottom && rect.left >= parent.left && rect.right <= parent.right,
          hit: hit === button || button.contains(hit) };
      });
      await settle();
      await check(`${stage}: bottom Save is visible and hit-testable after scrolling`, bottom.scrolled && bottom.reachedBottom && bottom.visible && bottom.hit, JSON.stringify(bottom));
      await screenshot(stage + "-bottom");
    };
    const checkPatch = async (index, scope, patch) => {
      const state = await snapshot();
      const request = state.runtimePuts[index - 1];
      await check(`runtime save ${index} sends only the intended ${scope} patch`, state.runtimePuts.length === index
        && JSON.stringify(request?.body) === JSON.stringify({ cwd: "C:/fixture", scope, patch }), JSON.stringify(request));
      await check(`runtime save ${index} increments only the runtime version`, request?.versionBefore.runtime === index - 1
        && request?.versionAfter.runtime === index && request?.versionAfter.profiles === 0 && request?.versionAfter.settings === 0, JSON.stringify(request));
      await check(`runtime save ${index} does not call profile or feature settings edits`, state.profilePuts.length === 0 && state.settingsPuts.length === 0);
      await check(`runtime save ${index} preserves the complete Plan profile`, await evaluate(() => JSON.stringify(window.fixture.snapshot().profile) === JSON.stringify(window.fixture.initialProfile)));
      await check(`runtime save ${index} confirms saved status and disables clean Save`, await evaluate(css => document.querySelector(css)?.disabled
        && document.querySelector(".config-detail .config-footer [role=status]")?.textContent === "Saved. Reload sessions to apply these settings.", runtimeSave));
    };

    await win.loadFile(path.join(__dirname, "fixture.html"));
    // Windows can constrain the initial native window to the work area. Resize
    // after creation to test the exact requested viewport, including 800px tall.
    win.setContentSize(1100, 800);
    await waitFor(() => innerWidth === 1100 && innerHeight === 800);
    await waitFor(() => document.querySelector('input[aria-label="Sub-agent ID"]')?.value === "plan"
      && window.fixture.requests.length === 3 && window.fixture.requests.every(request => request.response));
    await check("real AgentsConfig renders in English with one complete editable Plan profile", await evaluate(() =>
      document.documentElement.lang === "en" && document.querySelector('[role="dialog"]')?.getAttribute("aria-label") === "Sub-agents"
      && document.querySelectorAll(".config-sidebar-group .config-sidebar-item").length === 1
      && !document.querySelector('input[aria-label="Sub-agent ID"]').disabled));
    await check("initial GETs cover profiles, feature settings and models only", await evaluate(() =>
      window.fixture.requests.every(request => request.method === "GET")
      && window.fixture.requests.map(request => request.path).sort().join(",") === "/api/models,/api/subagents/profiles,/api/subagents/settings"));
    await type('input[aria-label="Description"]', "Unsaved unrelated profile draft");
    await click({ css: ".config-sidebar-item", text: "Sub-agent runtime settings" });
    await waitFor(() => document.getElementById("subagent-runtime-global-maxConcurrent"));
    await check("sidebar opens the real runtime panel and removes profile editor/footer", await evaluate(() =>
      document.querySelector(".config-detail-title")?.textContent === "Sub-agent runtime settings"
      && !document.querySelector('input[aria-label="Sub-agent ID"]')
      && document.querySelectorAll(".config-footer").length === 1
      && document.querySelector(".config-detail .config-footer button")?.textContent === "Save runtime settings"));
    await check("all 18 runtime controls render with labels and descriptions", await evaluate(() =>
      window.fixture.fields.length === 18 && document.querySelectorAll('[id^="subagent-runtime-global-"]').length > 18
      && window.fixture.fields.every(field => {
        const id = "subagent-runtime-global-" + field.key;
        const control = document.getElementById(id);
        return control && !control.disabled && control.getAttribute("aria-label")
          && document.querySelector('label[for="' + id + '"]')
          && document.getElementById(id + "-hint") && document.getElementById(id + "-source");
      })));
    await check("global concurrency shows 4 from the global source", await evaluate(() =>
      document.getElementById("subagent-runtime-global-maxConcurrent").value === "4"
      && document.getElementById("subagent-runtime-global-maxConcurrent-source").textContent === "Source: Global settings · Value: 4"));
    await check("other defaults inherit without materializing fields in inputs", await evaluate(() =>
      window.fixture.fields.filter(field => field.key !== "maxConcurrent").every(field => {
        const control = document.getElementById("subagent-runtime-global-" + field.key);
        const source = document.getElementById(control.id + "-source").textContent;
        return control.value === "" && source.startsWith("Source: Native default")
          && (field.type !== "number" && field.type !== "text" || control.placeholder === String(window.fixture.defaults[field.key]));
      }) && document.querySelector(".config-detail .config-footer button").disabled));
    await check("mock runtime response supplies exactly 18 effective settings", await evaluate(() => {
      const response = window.fixture.requests.find(request => request.path === "/api/subagents/runtime-settings").response;
      return Object.keys(response.effective).length === 18 && response.effective.maxConcurrent === 4
        && JSON.stringify(response.values) === '{"maxConcurrent":4}' && Object.keys(response.project).length === 0;
    }));
    await checkLayout(1100, 800, "large-global");
    await type(field("global", "maxConcurrent"), "0");
    await check("invalid concurrency blocks Save and shows a validation error", await evaluate(() =>
      document.getElementById("subagent-runtime-global-maxConcurrent").getAttribute("aria-invalid") === "true"
      && Boolean(document.getElementById("subagent-runtime-global-maxConcurrent-error"))
      && document.querySelector(".config-detail .config-footer button").disabled
      && window.fixture.requests.every(request => request.method === "GET")));
    await type(field("global", "maxConcurrent"), "6");
    await check("typing changes only the draft until Save", await evaluate(() =>
      window.fixture.snapshot().global.maxConcurrent === 4 && window.fixture.requests.every(request => request.method === "GET")
      && !document.querySelector(".config-detail .config-footer button").disabled));
    await click(runtimeSave);
    await waitFor(() => window.fixture.version.runtime === 1 && document.querySelector(".config-detail .config-footer button").disabled);
    await checkPatch(1, "global", { maxConcurrent: 6 });

    await select('select[aria-label="Apply to"]', "project");
    await waitFor(() => document.getElementById("subagent-runtime-project-maxConcurrent"));
    await check("project initially inherits saved global concurrency 6 with no local override", await evaluate(() => {
      const control = document.getElementById("subagent-runtime-project-maxConcurrent");
      return control.value === "" && control.placeholder === "6"
        && document.getElementById(control.id + "-source").textContent === "Source: Global settings · Value: 6"
        && Object.keys(window.fixture.snapshot().project).length === 0
        && document.querySelector(".config-detail .config-footer button").disabled;
    }));
    win.setContentSize(760, 500);
    await waitFor(() => innerWidth === 760 && innerHeight === 500);
    await checkLayout(760, 500, "compact-project");
    await type(field("project", "maxConcurrent"), "8");
    await check("project override draft displays project source without mutating storage", await evaluate(() =>
      document.getElementById("subagent-runtime-project-maxConcurrent-source").textContent === "Source: Project settings · Value: 8"
      && Object.keys(window.fixture.snapshot().project).length === 0));
    await click(runtimeSave);
    await waitFor(() => window.fixture.version.runtime === 2 && document.querySelector(".config-detail .config-footer button").disabled);
    await checkPatch(2, "project", { maxConcurrent: 8 });
    await check("project override changes effective concurrency while global remains 6", await evaluate(() => {
      const request = window.fixture.requests.filter(request => request.method === "PUT").at(-1);
      return request.response.effective.maxConcurrent === 8 && request.response.global.maxConcurrent === 6
        && request.response.project.maxConcurrent === 8 && request.response.values.maxConcurrent === 8;
    }));
    await select('select[aria-label="Apply to"]', "global");
    await waitFor(() => document.getElementById("subagent-runtime-global-maxConcurrent"));
    await check("revisiting global retains local 6 and reports this project's effective override 8", await evaluate(() =>
      document.getElementById("subagent-runtime-global-maxConcurrent").value === "6"
      && document.getElementById("subagent-runtime-global-maxConcurrent").closest(".config-field").textContent.includes("This project overrides the global setting with: 8.")));
    await select('select[aria-label="Apply to"]', "project");
    await waitFor(() => document.getElementById("subagent-runtime-project-maxConcurrent")?.value === "8");
    await click('button[aria-label="Restore inheritance for Background concurrency"]');
    await check("Restore inheritance previews global 6 before saving the deletion", await evaluate(() => {
      const control = document.getElementById("subagent-runtime-project-maxConcurrent");
      return control.value === "" && control.placeholder === "6"
        && document.getElementById(control.id + "-source").textContent === "Source: Global settings · Value: 6"
        && window.fixture.snapshot().project.maxConcurrent === 8
        && !document.querySelector(".config-detail .config-footer button").disabled;
    }));
    await click(runtimeSave);
    await waitFor(() => window.fixture.version.runtime === 3 && document.querySelector(".config-detail .config-footer button").disabled);
    await checkPatch(3, "project", { maxConcurrent: null });
    await check("null patch deletes only project override and recomputes all effective defaults", await evaluate(() => {
      const state = window.fixture.snapshot();
      const response = window.fixture.requests.filter(request => request.method === "PUT").at(-1).response;
      return Object.keys(state.project).length === 0 && JSON.stringify(state.global) === '{"maxConcurrent":6}'
        && JSON.stringify(response.effective) === JSON.stringify({ ...window.fixture.defaults, maxConcurrent: 6 })
        && Object.keys(response.values).length === 0;
    }));
    await select('select[aria-label="Apply to"]', "global");
    await waitFor(() => document.getElementById("subagent-runtime-global-maxConcurrent"));
    await select('select[aria-label="Apply to"]', "project");
    await waitFor(() => document.getElementById("subagent-runtime-project-maxConcurrent"));
    await check("reloading project scope keeps inheritance and clean Save", await evaluate(() =>
      document.getElementById("subagent-runtime-project-maxConcurrent").value === ""
      && document.getElementById("subagent-runtime-project-maxConcurrent").placeholder === "6"
      && document.querySelector(".config-detail .config-footer button").disabled));

    await click({ css: ".config-sidebar-item", text: "Plan" });
    await waitFor(() => document.querySelector('input[aria-label="Sub-agent ID"]')?.value === "plan");
    await check("returning to Plan restores its unchanged profile, without saving unrelated draft", await evaluate(() =>
      document.querySelector('input[aria-label="Description"]').value === window.fixture.initialProfile.description
      && !document.querySelector(".config-detail-title") && window.fixture.version.profiles === 0));
    await click({ css: "summary", text: "Advanced settings" });
    await check("Plan advanced promptMode/isolation/persistSession/extensionTools are editable", await evaluate(() =>
      document.querySelector("details").open
      && ['System prompt mode', 'File isolation', 'Persist subagent session', 'Extension tool allowlist'].every(label =>
        !document.querySelector('[aria-label="' + label + '"]').disabled)
      && document.querySelector('select[aria-label="System prompt mode"]').value === "replace"
      && document.querySelector('select[aria-label="File isolation"]').value === "off"
      && document.querySelector('select[aria-label="Persist subagent session"]').value === "true"
      && document.querySelector('input[aria-label="Extension tool allowlist"]').value === "ext:fixture/original"));
    await select('select[aria-label="System prompt mode"]', "append");
    await select('select[aria-label="File isolation"]', "worktree");
    await select('select[aria-label="Persist subagent session"]', "false");
    await type('input[aria-label="Extension tool allowlist"]', "ext:fixture/read,ext:fixture/write");
    await check("advanced changes remain a draft until profile Save", await evaluate(() =>
      window.fixture.version.profiles === 0 && JSON.stringify(window.fixture.snapshot().profile) === JSON.stringify(window.fixture.initialProfile)));
    await click(".config-panel-surface > .config-footer button.config-button-primary");
    await waitFor(() => window.fixture.version.profiles === 1 && document.querySelector(".config-button.is-success"));
    let state = await snapshot();
    await check("Plan Save calls profile PUT exactly once with all four advanced edits", state.profilePuts.length === 1
      && state.profilePuts[0].body.profile.promptMode === "append" && state.profilePuts[0].body.profile.isolation === "worktree"
      && state.profilePuts[0].body.profile.persistSession === false
      && JSON.stringify(state.profilePuts[0].body.profile.extensionTools) === '["ext:fixture/read","ext:fixture/write"]', JSON.stringify(state.profilePuts));
    await check("profile save preserves every unrelated field and all runtime settings", await evaluate(() => {
      const state = window.fixture.snapshot();
      const expected = { ...window.fixture.initialProfile, promptMode: "append", isolation: "worktree", persistSession: false,
        extensionTools: ["ext:fixture/read", "ext:fixture/write"] };
      return Object.keys(expected).every(key => JSON.stringify(state.profile[key]) === JSON.stringify(expected[key]))
        && Object.keys(state.profile).length === Object.keys(expected).length
        && JSON.stringify(state.global) === '{"maxConcurrent":6}' && Object.keys(state.project).length === 0;
    }));
    await check("profile save reloads profiles and advances only its version", state.version.profiles === 1 && state.version.runtime === 3
      && state.version.settings === 0 && state.runtimePuts.length === 3 && state.settingsPuts.length === 0
      && state.profilePuts[0].versionBefore.profiles === 0 && state.profilePuts[0].versionAfter.profiles === 1
      && state.requests.at(-1).path === "/api/subagents/profiles" && state.requests.at(-1).method === "GET");
    await check("reloaded advanced controls show saved values", await evaluate(() =>
      document.querySelector('select[aria-label="System prompt mode"]').value === "append"
      && document.querySelector('select[aria-label="File isolation"]').value === "worktree"
      && document.querySelector('select[aria-label="Persist subagent session"]').value === "false"
      && document.querySelector('input[aria-label="Extension tool allowlist"]').value === "ext:fixture/read,ext:fixture/write"));
    await screenshot("compact-plan-saved");
    await check("fixture uses no session, reload IPC, backend or unexpected fetch", await evaluate(() =>
      window.fixture.unexpectedFetches.length === 0 && window.fixture.closes === 0
      && window.fixture.requests.every(request => !request.path.startsWith("/api/agent/"))
      && !document.querySelector(".agents-feature-reload-notice")));
    await check("versioned journal records every request and coherent state transitions", await evaluate(() => {
      let previous = { runtime: 0, profiles: 0, settings: 0 };
      return window.fixture.requests.every((request, index) => {
        const matches = request.sequence === index + 1 && Boolean(request.response)
          && JSON.stringify(request.versionBefore) === JSON.stringify(previous)
          && Object.keys(previous).every(key => request.versionAfter[key] === previous[key]
            + (request.method === "PUT" && request.path === "/api/subagents/" + (key === "runtime" ? "runtime-settings" : key) ? 1 : 0));
        previous = request.versionAfter;
        return matches;
      });
    }));
    await check("only documented select events were injected", await evaluate(() =>
      window.fixture.selectInjections.length === 8 && window.fixture.selectInjections.every(entry => entry.css.startsWith("select["))));
    await check("network and unexpected file loads stayed blocked and unused", unexpectedRequests.length === 0, JSON.stringify(unexpectedRequests));
    await check("renderer has no console, window or promise errors", rendererErrors.length === 0
      && await evaluate(() => window.fixture.errors.length === 0), JSON.stringify(rendererErrors));
    await click({ css: ".config-sidebar-item", text: "Sub-agent runtime settings" });
    await waitFor(() => document.getElementById("subagent-runtime-global-defaultMaxTurns"));
    await type(field("global", "defaultMaxTurns"), "0");
    await evaluate(() => { window.fixture.failNextProfileRead = true; });
    await click(runtimeSave);
    await waitFor(() => window.fixture.version.runtime === 4 && [...document.querySelectorAll("button")].some(button => button.textContent === "Reload agent profiles"));
    await check("runtime save reports a subsequent profile refresh failure without losing the saved runtime patch", await evaluate(() =>
      window.fixture.snapshot().global.defaultMaxTurns === 0
      && [...document.querySelectorAll('[role="alert"]')].some(element => element.textContent.includes("Fixture profile refresh unavailable"))));
    await click({ css: ".config-sidebar-item", text: "Plan" });
    await waitFor(() => document.querySelector('input[aria-label="Sub-agent ID"]')?.value === "plan");
    await check("failed refresh blocks stale profile edits and Save", await evaluate(() =>
      document.querySelector('input[aria-label="Description"]').disabled
      && document.querySelector(".config-panel-surface > .config-footer button.config-button-primary").disabled
      && window.fixture.version.profiles === 1));
    await click({ css: ".agents-feature-actions button", text: "Reload agent profiles" });
    await waitFor(() => !document.querySelector('input[aria-label="Description"]').disabled
      && !document.querySelector(".config-panel-surface > .config-footer button.config-button-primary").disabled);
    await check("successful retry restores profile editing without saving old data", await evaluate(() =>
      !document.querySelector(".config-panel-surface > .config-footer button.config-button-primary").disabled
      && window.fixture.version.profiles === 1
      && ![...document.querySelectorAll("button")].some(button => button.textContent === "Reload agent profiles")
      && !document.querySelector('[role="alert"]')));
    await check("intentional refresh failure and retry leave the renderer and network clean", rendererErrors.length === 0
      && unexpectedRequests.length === 0 && await evaluate(() => window.fixture.errors.length === 0 && window.fixture.unexpectedFetches.length === 0));
    clearTimeout(watchdog);
    await finish(results.every(result => result.passed) ? 0 : 1);
  } catch (error) {
    await check("browser scenario completes", false, error.stack ?? String(error));
    clearTimeout(watchdog);
    await finish(1);
  }
}

try {
  const settingsCss = await readFile(path.join(root, "app/settings.css"), "utf8");
  await build({
    stdin: { contents: fixture, loader: "tsx", resolveDir: root, sourcefile: "subagent-settings-fixture.tsx" },
    bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@": root }, outfile: path.join(temporary, "fixture.js"),
    define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent",
  });
  // The reset matches globals.css/Tailwind's border-box baseline; no layout fixes.
  await writeFile(path.join(temporary, "fixture.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'"><style>:root{--bg:#fff;--bg-panel:#f5f5f5;--border:#ccc;--text:#111;--text-muted:#444;--text-dim:#666;--accent:#245bce;--accent-hover:#1d4ed8;--accent-contrast:#fff;--bg-hover:#eee;--bg-selected:#e8e8e8;--font-mono:monospace}*{box-sizing:border-box}body{font-family:Arial;margin:0;color:var(--text)}${settingsCss}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
  await writeFile(path.join(temporary, "main.cjs"), `(${electronMain.toString()})();\n`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(temporary, "main.cjs")], {
    cwd: temporary, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout.on("data", chunk => process.stdout.write(chunk));
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    console.error("FAIL: browser process exceeded the overall 70-second deadline");
    child.kill();
  }, Math.max(1, 70000 - (Date.now() - started)));
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  console.log(`Electron exit code: ${exit.code}; signal: ${exit.signal ?? "none"}`);
  let report;
  try { report = JSON.parse(await readFile(path.join(temporary, "result.json"), "utf8")); } catch { /* Missing report is a failure. */ }
  const valid = report && report.total > 0 && report.total === report.results.length
    && report.passed === report.total && report.results.every(result => result.passed === true);
  succeeded = !timedOut && exit.code === 0 && Boolean(valid);
  process.exitCode = succeeded ? 0 : 1;
  if (!report) console.error("FAIL: Electron exited without a browser result report");
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (succeeded) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  else console.error(`Failure artifacts retained in: ${temporary} (result.json, screenshots and isolated fixture)`);
}
