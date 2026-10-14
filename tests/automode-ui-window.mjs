/**
 * Isolated UI checks + screenshots, no real config, model calls or session.
 * Run: npm run build:ui && node tests/automode-ui-window.mjs
 */
import { build } from "esbuild";
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(join(tmpdir(), "pi-automode-ui-"));
const artifacts = join(root, ".artifacts", "automode-ui");
await mkdir(artifacts, { recursive: true });
const cssFiles = (await readdir(join(root, "dist/renderer/assets"))).filter(name => /^index-.*\.css$/.test(name));
if (cssFiles.length !== 1) throw new Error("Run npm run build:ui first");
await build({
  entryPoints: [join(root, "tests/fixtures/automode-ui.tsx")], outfile: join(dir, "fixture.js"),
  bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@": root }, define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(join(dir, "index.html"), `<!doctype html><html><head><meta charset="UTF-8">
<link rel="stylesheet" href="${pathToFileURL(join(root, "dist/renderer/assets", cssFiles[0])).href}">
<style>body{margin:0;background:var(--bg);font-family:Arial,"Microsoft YaHei",sans-serif}#root{height:100vh}</style>
</head><body><div id="root"></div><script src="./fixture.js"></script></body></html>`);

const checks = async function () {
  let assertions = 0;
  const assert = (value, message) => { assertions++; if (!value) throw new Error(message); };
  const wait = async (fn) => {
    for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); }
    throw new Error("Timed out waiting for UI");
  };
  const settle = () => new Promise(r => setTimeout(r, 50));
  const $ = selector => document.querySelector(selector);
  const all = selector => [...document.querySelectorAll(selector)];
  const button = text => {
    const found = all("button").find(el => el.textContent.trim() === text);
    assert(found, "Missing button: " + text + "; found: " + all("button").map(el => el.textContent.trim()).join(" | "));
    return found;
  }
  const rows = () => all(".automode-fallback-row");
  const advance = () => $(".automode-advanced");
  const setInput = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const fixture = window.fixture;
  await wait(() => rows().length === 4 && document.documentElement.lang === "zh-CN");
  assert(!advance().open, "Advanced settings should start collapsed");
  assert(!$(".automode-help").open, "Fallback help should start collapsed");
  assert(button("保存").disabled, "Clean draft must not be saved");
  button("＋加一个备用模型").click();
  await wait(() => rows().length === 5);
  assert(rows()[4].querySelector(".model-selector button").textContent.includes("不用这条"), "Empty row picker");
  rows()[4].querySelector('[aria-label="删掉"]').click();
  await wait(() => rows().length === 4);
  assert(button("保存").disabled, "Add then remove restores clean draft");
  rows()[0].querySelector('[aria-label="下移"]').click();
  await settle();
  assert(rows()[0].textContent.includes("[特价]"), "Fallback order moves");
  button("放弃这次修改").click();
  await settle();
  assert(rows()[0].textContent.includes("[0.2]"), "Discard restores order");
  const primary = $(".automode-primary-row .model-selector button");
  primary.click();
  await wait(() => $('[role="listbox"]'));
  const option = all('[role="option"]').find(el => el.textContent.includes("[特价]"));
  assert(option, "Model picker options accessible");
  option.click();
  await settle();
  assert($(".automode-primary-row").textContent.includes("[特价]"), "Picking model updates field");
  button("放弃这次修改").click();
  await settle();
  $(".automode-primary-row .config-button").click();
  await wait(() => $(".automode-result"));
  assert($(".automode-result").textContent.includes("125"), "Model test success feedback");
  fixture.testFail = true;
  $(".automode-primary-row .config-button").click();
  await wait(() => $(".automode-result.is-error"));
  assert($(".automode-result").textContent.includes("模拟连接失败"), "Model test error feedback");
  fixture.testFail = false;
  $('[role="switch"][aria-label="启用自动模式"]').click();
  await settle();
  button("保存").click();
  await wait(() => fixture.requests.some(r => r.method === "PUT"));
  await wait(() => all("button").find(el => el.textContent.trim() === "保存")?.disabled);
  const save = fixture.requests.find(r => r.method === "PUT").body;
  assert(save.scope === "global" && JSON.stringify(save.patch) === '{"enabled":false}', "Only edited value saved to selected scope");
  button("重新加载会话").click();
  await wait(() => fixture.reloads === 1);
  advance().querySelector("summary").click();
  await settle();
  assert(advance().open, "Advanced controls expand");
  const number = $('input[type="number"]');
  setInput(number, "-1");
  await settle();
  advance().querySelector("summary").click();
  await settle();
  assert(!advance().open, "Advanced controls collapse without losing draft");
  const writes = fixture.requests.filter(r => r.method === "PUT").length;
  button("保存").click();
  await settle();
  assert(advance().open && $('[role="alert"]'), "Invalid hidden setting expands and shows error");
  assert(fixture.requests.filter(r => r.method === "PUT").length === writes, "Invalid draft is not saved");
  button("放弃这次修改").click();
  await settle();
  assert(!$('[role="alert"]') && button("保存").disabled, "Discard clears invalid draft");
  $('[role="switch"][aria-label="记日志"]').click();
  await settle();
  assert($('[role="switch"][aria-label="连收发的原文一起记"]').disabled, "Log IO depends on log switch");
  button("放弃这次修改").click();
  await settle();
  $(".automode-content").scrollTop = 10000;
  await settle();
  assert($(".automode-footer").getBoundingClientRect().bottom <= innerHeight + 1, "Footer stays visible while scrolling");
  const scope = $(".automode-scope select");
  scope.value = "project";
  scope.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  $('[role="switch"][aria-label="启用自动模式"]').click();
  await settle();
  button("保存").click();
  await wait(() => fixture.requests.filter(r => r.method === "PUT").length === writes + 1);
  assert(fixture.requests.filter(r => r.method === "PUT").at(-1).body.scope === "project", "Project scope preserved");

  fixture.mount({ trusted: false, modelsEmpty: true });
  await wait(() => $(".automode-primary-row input"));
  assert($(".automode-scope option[value=project]").disabled, "Untrusted project cannot be selected");
  setInput($(".automode-primary-row input"), "mock/custom");
  await settle();
  assert(!button("保存").disabled, "Text fallback editable when model list unavailable");
  fixture.mount({ loadFail: true });
  await wait(() => $('[role="alert"]')?.textContent.includes("模拟加载失败"));
  assert(!$(".automode-footer"), "Load failure shows no editable controls");
  fixture.mount();
  await wait(() => rows().length === 4 && $(".automode-primary-row .model-selector button") && !$(".automode-scope option[value=project]").disabled);
  await settle();
  assert(!advance().open && button("保存").disabled, "Remounted fixture starts clean and collapsed");
  $(".automode-content").scrollTop = 0;
  return { passed: true, assertions, requests: fixture.requests.length };
};

const geometry = function () {
  const nodes = [...document.querySelectorAll(".automode-content, .automode-footer, .automode-fallback-row, .automode-input")];
  for (const el of nodes) {
    if (!el.getClientRects().length) continue;
    const rect = el.getBoundingClientRect();
    if (rect.left < -1 || rect.right > innerWidth + 1) throw new Error("Horizontal overflow: " + el.className);
  }
  const scroll = document.querySelector(".automode-content");
  if (scroll.scrollWidth > scroll.clientWidth + 1) throw new Error("Content scrolls horizontally");
  return true;
};

await writeFile(join(dir, "runner.cjs"), `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises');
app.setPath('userData', ${JSON.stringify(join(dir, "user-data"))});
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  const errors=[];
  win.webContents.on('console-message',event=>{if(event.level === 'error')errors.push(event.message)});
  try {
    await win.loadFile(${JSON.stringify(join(dir, "index.html"))});
    const result=await win.webContents.executeJavaScript('('+ ${JSON.stringify(checks.toString())} +')()');
    await win.webContents.executeJavaScript('('+ ${JSON.stringify(geometry.toString())} +')()');
    await new Promise(r=>setTimeout(r,200));
    await fs.writeFile(${JSON.stringify(join(artifacts, "desktop.png"))}, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.querySelector('.automode-advanced').querySelector('summary').click()");
    await new Promise(r=>setTimeout(r,150));
    await win.webContents.executeJavaScript('('+ ${JSON.stringify(geometry.toString())} +')()');
    await fs.writeFile(${JSON.stringify(join(artifacts, "advanced.png"))}, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.documentElement.setAttribute('data-theme','dark')");
    await new Promise(r=>setTimeout(r,200));
    await fs.writeFile(${JSON.stringify(join(artifacts, "dark.png"))}, (await win.webContents.capturePage()).toPNG());
    win.setContentSize(390,844);
    await win.webContents.executeJavaScript("document.documentElement.setAttribute('data-theme','light')");
    await new Promise(r=>setTimeout(r,150));
    await win.webContents.executeJavaScript('('+ ${JSON.stringify(geometry.toString())} +')()');
    await fs.writeFile(${JSON.stringify(join(artifacts, "narrow.png"))}, (await win.webContents.capturePage()).toPNG());
    await fs.writeFile(${JSON.stringify(join(dir, "result.json"))},JSON.stringify({...result,errors}));
    app.exit(errors.length?1:0);
  } catch(error) {
    await fs.writeFile(${JSON.stringify(join(dir, "result.json"))},JSON.stringify({passed:false,error:String(error.stack ?? error),errors}));
    app.exit(1);
  }
});
`);
const require = createRequire(import.meta.url);
const executable = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const code = await new Promise((done, reject) => {
    const child = spawn(executable, [join(dir, "runner.cjs")], { env, stdio: "inherit" });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated UI test timed out")); }, 45000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); done(code); });
  });
  console.log(await readFile(join(dir, "result.json"), "utf8"));
  console.log("Screenshots: " + artifacts);
  if (code !== 0) process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
