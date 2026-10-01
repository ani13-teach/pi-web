import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electron = require("electron");
const temporary = await mkdtemp(path.join(tmpdir(), "pi-model-favorites-"));
const started = Date.now();

const fixture = `
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelSelector } from "@/components/ModelSelector";
import { ToolDescription } from "@/components/ToolDefinitionsPanel";
import { I18nProvider } from "@/hooks/useI18n";
localStorage.setItem("pi-locale", "en");
const options = [
  { provider: "fixture-a", modelId: "shared-id", name: "Shared Model" },
  { provider: "fixture-b", modelId: "shared-id", name: "Shared Model" },
  ...Array.from({ length: 8 }, (_, i) => ({
    provider: i % 2 ? "fixture-b" : "fixture-a",
    modelId: "unique-" + i, name: "Unique Model " + i,
  })),
];
window.fixture = { changes: [], clears: [], generation: crypto.randomUUID() };
function Fixture() {
  const [values, setValues] = useState([null, null]);
  const [disabled, setDisabled] = useState(false);
  useEffect(() => { window.fixture.ready = true; }, []);
  return <main>
    {values.map((value, index) => <section key={index} data-picker={index}>
      <ModelSelector options={options} value={value} variant="field" placement="auto"
        ariaLabel={"Fixture selector " + index} disabled={index === 1 && disabled}
        emptyLabel="Fixture default"
        onChange={(provider, modelId) => {
          window.fixture.changes.push({ index, provider, modelId });
          setValues(current => current.map((v, i) => i === index ? { provider, modelId } : v));
        }}
        onClear={index === 0 ? () => {
          window.fixture.clears.push(index);
          setValues(current => current.map((v, i) => i === index ? null : v));
        } : undefined} />
    </section>)}
    <button id="disable-second" onClick={() => setDisabled(current => !current)}>Toggle disabled</button>
    <div id="tool-label-layout" style={{ width: 160, flexShrink: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
      <ToolDescription name="Agent" description={"Delegate a focused task to a configured subagent.\\n- reviewer: Review (Tools: read; Model: " + "long-channel-".repeat(12) + "/" + "long-model-id-".repeat(20) + ")"} />
    </div>
  </main>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);
`;

// This function runs only in the disposable Electron process, never in the app.
async function electronMain() {
  const { app, BrowserWindow, session } = require("electron");
  const path = require("node:path");
  const fs = require("node:fs");
  const { pathToFileURL } = require("node:url");
  app.setPath("userData", path.join(__dirname, "user-data"));
  app.setPath("sessionData", path.join(__dirname, "session-data"));
  app.setPath("crashDumps", path.join(__dirname, "crash-dumps"));
  app.commandLine.appendSwitch("disable-background-networking");
  const results = [];
  let win;
  let unexpectedRequests = [];
  let rendererErrors = [];
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    const passed = results.filter(result => result.passed).length;
    fs.writeFileSync(path.join(__dirname, "result.json"), JSON.stringify({ passed, total: results.length, results }));
    console.log(`${passed}/${results.length} model selector browser checks passed`);
    app.exit(code);
  };
  const watchdog = setTimeout(() => {
    console.error("FAIL: Electron browser checks timed out");
    finish(1);
  }, 45000);
  const check = (name, condition, detail = "") => {
    const passed = Boolean(condition);
    results.push({ name, passed, detail: passed ? "" : detail });
    console.log(`${passed ? "PASS" : "FAIL"}: ${name}${!passed && detail ? " -- " + detail : ""}`);
  };
  try {
    await app.whenReady();
    // No server, backend, preload, or agent. Only the generated file:// fixture is allowed.
    const htmlUrl = pathToFileURL(path.join(__dirname, "fixture.html")).href;
    const jsUrl = pathToFileURL(path.join(__dirname, "fixture.js")).href;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url === htmlUrl || details.url === jsUrl;
      if (!allowed) unexpectedRequests.push(details.url);
      callback({ cancel: !allowed });
    });
    win = new BrowserWindow({
      width: 1100, height: 800, show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => { if (url !== htmlUrl) event.preventDefault(); });
    win.webContents.on("console-message", (details) => {
      if (details.level === "error") rendererErrors.push(details.message);
    });
    const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
    const settle = () => evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const ready = () => evaluate(async () => {
      const deadline = performance.now() + 5000;
      while (!window.fixture?.ready) {
        if (performance.now() > deadline) throw new Error("Fixture did not mount");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    });
    const click = async (target) => {
      const point = await evaluate((target) => {
        const picker = document.querySelector(`[data-picker="${target.picker ?? 0}"]`);
        let element;
        if (target.css) element = document.querySelector(target.css);
        else if (target.toggle) element = picker.querySelector("button[aria-haspopup]");
        else {
          const option = [...picker.querySelectorAll('[role="option"]')].find(button => {
            const expectedTitle = target.provider ? `${target.name} (${target.provider})` : target.name;
            return button.querySelector("span[title]")?.title === expectedTitle;
          });
          element = target.star ? option?.parentElement.querySelector("button[aria-pressed]") : option;
        }
        if (!element) throw new Error("Click target missing: " + JSON.stringify(target));
        element.scrollIntoView({ block: "nearest" });
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      }, target);
      win.webContents.sendInputEvent({ type: "mouseMove", ...point });
      win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      await settle();
    };
    const snapshot = (picker = 0) => evaluate((picker) => {
      const root = document.querySelector(`[data-picker="${picker}"]`);
      const panel = root.querySelector('[role="listbox"]');
      const favorite = panel?.querySelector("[data-model-favorites]");
      const rows = [...(panel?.querySelectorAll('[role="option"]') ?? [])].filter(button => button.parentElement.querySelector("button[aria-pressed]")).map(button => {
        const group = button.closest("[data-model-favorites]");
        const title = button.querySelector("span[title]").title;
        const provider = button.querySelector("span[title]").lastElementChild?.textContent.slice(1, -1);
        return { title, provider, favorite: Boolean(group), pressed: button.parentElement.querySelector("button[aria-pressed]").getAttribute("aria-pressed") };
      });
      return {
        open: root.querySelector("button[aria-haspopup]").getAttribute("aria-expanded") === "true",
        disabled: root.querySelector("button[aria-haspopup]").disabled,
        hasFavorite: Boolean(favorite), rows,
        favoriteFirst: Boolean(favorite && [...favorite.parentElement.children].filter(element => element.querySelector("button[aria-pressed]"))[0] === favorite),
        text: panel?.textContent ?? "", changes: window.fixture.changes, clears: window.fixture.clears,
        currentTitle: root.querySelector("button[aria-haspopup] span[title]")?.title,
        currentChannels: [...root.querySelectorAll("button[aria-haspopup] span[title] > span")].map(span => span.textContent),
      };
    }, picker);
    const search = async (query) => {
      await click({ css: '[data-picker="0"] input' });
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
      await settle();
      if (query) await win.webContents.insertText(query);
      await settle();
    };
    await win.loadFile(path.join(__dirname, "fixture.html"));
    await ready();
    await settle();
    const originalGeneration = await evaluate(() => window.fixture.generation);
    check("long Agent model and channel wrap without horizontal overflow in a narrow detail", await evaluate(() => {
      const container = document.getElementById("tool-label-layout");
      const label = container.querySelector("span[title]");
      return label?.title.startsWith("long-model-id-") && label.title.includes("(long-channel-")
        && getComputedStyle(label).whiteSpace === "normal" && container.scrollWidth <= container.clientWidth;
    }));
    check("isolated fresh storage has no favorites", await evaluate(() => localStorage.getItem("pi-model-favorites") === null));
    await click({ toggle: true });
    let state = await snapshot();
    check("initial list has all ten models and no favorites section", state.open && !state.hasFavorite && state.rows.length === 10);
    check("ordinary rows show their own channel even without favorites", state.rows.every(row => row.title.endsWith(` (${row.provider})`) && ["fixture-a", "fixture-b"].includes(row.provider)));
    check("unselected default label does not invent a channel", state.currentTitle === "Fixture default" && state.currentChannels.length === 0);
    check("ten models expose the search input", await evaluate(() => Boolean(document.querySelector('[data-picker="0"] input'))));
    await click({ name: "Shared Model", provider: "fixture-a", star: true });
    state = await snapshot();
    check("star click leaves the list open without onChange", state.open && state.changes.length === 0);
    check("favorite section is first and model is not duplicated", state.favoriteFirst && state.rows.length === 10 && state.rows.filter(row => row.provider === "fixture-a" && row.title.startsWith("Shared Model")).length === 1);
    check("favorite displays its provider with pressed star", state.rows.some(row => row.title === "Shared Model (fixture-a)" && row.favorite && row.pressed === "true"));
    check("same ID in the other provider remains unfavorited", state.rows.some(row => row.title === "Shared Model (fixture-b)" && row.provider === "fixture-b" && !row.favorite && row.pressed === "false"));
    await click({ name: "Shared Model", provider: "fixture-b", star: true });
    state = await snapshot();
    check("both providers can independently favorite the same ID", state.rows.filter(row => row.favorite).length === 2 && state.rows.length === 10);
    await click({ name: "Shared Model", provider: "fixture-a", star: true });
    state = await snapshot();
    check("unfavorite returns model to its original provider group", state.rows.some(row => row.title === "Shared Model (fixture-a)" && row.provider === "fixture-a" && !row.favorite && row.pressed === "false") && state.rows.filter(row => row.favorite).length === 1);
    await click({ picker: 1, toggle: true });
    state = await snapshot(1);
    check("second already-mounted selector receives favorites", state.rows.filter(row => row.favorite).length === 1 && state.rows.some(row => row.title === "Shared Model (fixture-b)" && row.pressed === "true"));
    await click({ picker: 1, name: "Shared Model", provider: "fixture-a", star: true });
    await click({ picker: 0, toggle: true });
    state = await snapshot();
    check("favorite changes synchronize back from second selector", state.rows.filter(row => row.favorite).length === 2);
    await search("shared");
    state = await snapshot();
    check("search filters names and retains matching favorites", state.hasFavorite && state.rows.length === 2 && state.rows.every(row => row.favorite));
    await search("unique-3");
    state = await snapshot();
    check("model ID search hides nonmatching favorites", !state.hasFavorite && state.rows.length === 1 && state.rows[0].title === "Unique Model 3 (fixture-b)");
    await search("no-fixture-model-exists");
    state = await snapshot();
    check("no-result search has no favorites and correct empty text", !state.hasFavorite && state.rows.length === 0 && state.text.includes("No matching models"));
    await search("");
    state = await snapshot();
    check("clearing search restores all models and favorites", state.rows.length === 10 && state.rows.filter(row => row.favorite).length === 2);
    for (let index = 0; index < 8; index++) await click({ name: "Unique Model " + index, provider: index % 2 ? "fixture-b" : "fixture-a", star: true });
    state = await snapshot();
    check("all models favorited without duplicate or empty-list warning", state.rows.length === 10 && state.rows.every(row => row.favorite && row.pressed === "true") && !state.text.includes("No available models") && !state.text.includes("No matching models"));
    check("all star operations preserve onChange and open list", state.open && state.changes.length === 0);
    await click({ name: "Shared Model", provider: "fixture-b" });
    state = await snapshot();
    check("model name selects the exact provider and ID and closes list", !state.open && state.changes.length === 1 && state.changes[0].provider === "fixture-b" && state.changes[0].modelId === "shared-id" && state.changes[0].index === 0);
    check("closed button shows the selected channel exactly once with full tooltip", state.currentTitle === "Shared Model (fixture-b)" && state.currentChannels.length === 1 && state.currentChannels[0] === "(fixture-b)");
    await click({ toggle: true });
    await click({ name: "Fixture default" });
    state = await snapshot();
    check("default option calls onClear without onChange and closes", !state.open && state.clears.length === 1 && state.changes.length === 1);
    await click({ css: "#disable-second" });
    await click({ picker: 1, toggle: true });
    state = await snapshot(1);
    check("disabled selector cannot open or select", state.disabled && !state.open && state.changes.length === 1);
    const beforeReload = await evaluate(() => JSON.parse(localStorage.getItem("pi-model-favorites")));
    check("favorites persist as ten provider-ID pairs", beforeReload.length === 10 && new Set(beforeReload.map(model => JSON.stringify([model.provider, model.modelId]))).size === 10);
    const loaded = new Promise((resolve, reject) => {
      win.webContents.once("did-finish-load", resolve);
      win.webContents.once("did-fail-load", (_event, code, description) => reject(new Error(`Reload failed: ${code} ${description}`)));
    });
    win.webContents.reload();
    await loaded;
    await ready();
    await settle();
    check("reload creates a genuinely new fixture document", await evaluate(generation => window.fixture.generation !== generation && window.fixture.changes.length === 0 && window.fixture.clears.length === 0, originalGeneration));
    await click({ toggle: true });
    state = await snapshot();
    check("reload restores all favorite models from browser storage", state.favoriteFirst && state.rows.length === 10 && state.rows.every(row => row.favorite && row.pressed === "true"));
    await click({ picker: 1, toggle: true });
    state = await snapshot(1);
    check("reload restores favorites in the second selector too", state.rows.length === 10 && state.rows.every(row => row.favorite && row.pressed === "true"));
    await click({ picker: 0, toggle: true });
    await evaluate(() => {
      const option = [...document.querySelectorAll('[data-picker="0"] [role="option"]')]
        .find(button => button.querySelector('span[title]')?.title === "Shared Model (fixture-b)");
      option.parentElement.querySelector('button[aria-pressed]').focus();
    });
    const pressKey = async (keyCode) => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode });
      if (keyCode === "Return") win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode });
      await settle();
    };
    await pressKey("Return");
    check("keyboard Enter unfavorites and retains focus on the same model star", await evaluate(() => {
      const button = document.activeElement;
      return button?.dataset.modelFavoriteKey === JSON.stringify(["fixture-b", "shared-id"])
        && button.getAttribute("aria-pressed") === "false";
    }));
    await pressKey("Space");
    check("keyboard Space favorites again and retains focus", await evaluate(() => {
      const button = document.activeElement;
      return button?.dataset.modelFavoriteKey === JSON.stringify(["fixture-b", "shared-id"])
        && button.getAttribute("aria-pressed") === "true";
    }));
    await pressKey("Escape");
    state = await snapshot();
    check("Escape closes the list after keyboard favorite changes without selecting", !state.open && state.changes.length === 0);
    check("fixture made no network or unexpected file requests", unexpectedRequests.length === 0, JSON.stringify(unexpectedRequests));
    check("renderer reported no errors", rendererErrors.length === 0, rendererErrors.join("; "));
    clearTimeout(watchdog);
    finish(results.every(result => result.passed) ? 0 : 1);
  } catch (error) {
    check("browser scenario completes", false, error.stack ?? String(error));
    clearTimeout(watchdog);
    finish(1);
  }
}

try {
  await build({
    stdin: { contents: fixture, loader: "tsx", resolveDir: root, sourcefile: "model-favorites-fixture.tsx" },
    bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@": root }, outfile: path.join(temporary, "fixture.js"),
    define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent",
  });
  await writeFile(path.join(temporary, "fixture.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'"><style>:root{--bg:#fff;--bg-panel:#f5f5f5;--border:#ccc;--text:#111;--text-muted:#444;--text-dim:#666;--accent:#b51c42;--bg-hover:#eee;--bg-selected:#faf0f3;--font-mono:monospace}body{font-family:Arial;margin:24px}main{display:flex;align-items:flex-start;gap:32px}section{width:320px}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
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
    console.error("FAIL: browser process exceeded the overall 55-second deadline");
    child.kill();
  }, Math.max(1, 55000 - (Date.now() - started)));
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  console.log(`Electron exit code: ${exit.code}; signal: ${exit.signal ?? "none"}`);
  let report;
  try { report = JSON.parse(await readFile(path.join(temporary, "result.json"), "utf8")); } catch { /* Missing report must not pass. */ }
  const valid = report && report.total > 0 && report.passed === report.total;
  process.exitCode = timedOut || exit.code === null ? 1 : exit.code !== 0 ? exit.code : valid ? 0 : 1;
  if (!report) console.error("FAIL: Electron exited without a browser result report");
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
