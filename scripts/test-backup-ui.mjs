/**
 * Standalone, real Electron rendering of BackupSettings with a synthetic-only bridge.
 * Run: node scripts/test-backup-ui.mjs
 * Requires installed esbuild/Electron and an existing dist/renderer/assets CSS build.
 * Only screenshots/report persist (.tmp-shot/backup-*); all browser data is temporary.
 * No desktop main/preload, backup backend, native picker, archive or user profile is loaded.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, ".tmp-shot");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pi-backup-ui-"));
const electron = path.join(root, "node_modules/electron/dist/electron.exe");

// Serialized into the renderer bundle. All paths/tokens below are inert fixture strings.
function installSyntheticBridge() {
  const root = { id: "fixture-agent", kind: "agent", label: "合成全局配置", originalPath: "C:/synthetic-only/agent" };
  const projectRoot = { id: "fixture-project", kind: "project", label: "合成项目工具", originalPath: "C:/synthetic-only/project" };
  const resource = (id, kind, extra = {}) => ({
    id, rootId: root.id, relativePath: `${id}/fixture.json`, label: `合成 ${id}`,
    kind, executable: false, sensitive: false, availability: "offlineReady", ...extra,
  });
  const resources = [
    resource("settings-fixture", "settings"),
    resource("plugin-fixture", "extensions", { executable: true, relativePath: "extensions/fixture/index.js" }),
    resource("policy-fixture", "security", { securityPolicy: true, relativePath: "security/policy.json" }),
    resource("mapping-fixture", "skills", { rootId: projectRoot.id, executable: true }),
    resource("blocked-fixture", "extensions", { executable: true, availability: "unresolved" }),
  ];
  const preview = {
    fingerprint: "synthetic-restore-plan-v1", roots: [root, projectRoot], warnings: ["合成恢复警告：不会读取真实备份，也不会安装依赖。"],
    resources: resources.map((item, index) => ({ ...item, entries: 2, existing: 1, extraFiles: index === 1 ? ["fixture-target-only.txt"] : [],
      mapped: index !== 3, blocked: index === 4, warnings: item.executable || item.securityPolicy ? ["合成风险：请逐项核对可执行内容或安全策略。"] : [] })),
  };
  const state = { scanBlocked: false, calls: [], restoreRequests: [], exportCalls: 0 };
  const record = (method, detail = {}) => state.calls.push({ method, ...detail });
  const bridge = Object.freeze({
    async backupSelectProjects() { record("backupSelectProjects"); return { projects: [{ token: "synthetic-project-token", label: "合成项目（不访问磁盘）" }] }; },
    async backupScan(options) {
      record("backupScan", { projectTokens: options.projectTokens });
      return { token: "synthetic-scan-token", preview: {
        entries: 10, bytes: 2048, kinds: { settings: 2, extensions: 4, security: 2, skills: 2 }, roots: [root, projectRoot], resources,
        warnings: ["合成扫描警告：外部工具依赖需人工核对。"],
        blockers: state.scanBlocked ? ["合成阻断项：此资源来源尚未解决。"] : [], fingerprint: "synthetic-scan-v1",
      } };
    },
    async backupExport() { state.exportCalls++; throw new Error("Synthetic export intentionally forbidden: this test never exports archives"); },
    async backupInspect(options) {
      record("backupInspect", { kind: options.kind });
      if (options.kind === "select") return { token: "synthetic-archive-token", name: "synthetic-only.pibackup" };
      if (options.kind !== "unlock" || options.token !== "synthetic-archive-token" || options.password !== "fixture-restore-password") throw new Error("Invalid synthetic unlock request");
      return { preview: structuredClone(preview), legacy: false };
    },
    async backupSelectMappingTarget(options) {
      record("backupSelectMappingTarget", { rootId: options.rootId });
      for (const item of preview.resources) if (item.rootId === options.rootId) item.mapped = true;
      preview.fingerprint = "synthetic-restore-plan-v2";
      return { preview: structuredClone(preview) };
    },
    async backupRestore(options) {
      record("backupRestore"); state.restoreRequests.push(structuredClone(options));
      return { committed: true, restored: options.decisions.filter(item => item.activation === "enable").length,
        skipped: 0, deferred: options.decisions.filter(item => item.activation === "defer").length,
        warnings: ["仅合成恢复结果；没有写入任何真实资源。"] };
    },
    async backupCancel(options) { record("backupCancel", { token: options.token, operationId: options.operationId }); },
    onBackupProgress() { record("onBackupProgress"); return () => record("unsubscribeProgress"); },
  });
  Object.defineProperty(window, "piDesktop", { value: bridge, writable: false, configurable: false });
  window.__backupFixture = state;
  // Make accidental backend or network access fail loudly, even if the component changes.
  window.fetch = async () => { throw new Error("Network forbidden by backup UI fixture"); };
  window.XMLHttpRequest = class { constructor() { throw new Error("XHR forbidden by backup UI fixture"); } };
  window.WebSocket = class { constructor() { throw new Error("WebSocket forbidden by backup UI fixture"); } };
  window.EventSource = class { constructor() { throw new Error("EventSource forbidden by backup UI fixture"); } };
  localStorage.clear();
  localStorage.setItem("pi-locale", "zh-CN");
  localStorage.setItem("pi-theme", "light");
  document.documentElement.dataset.theme = "light";
}

// Bundled independently as main.cjs; never imports the production desktop entry.
async function runElectron(config) {
  const { app, BrowserWindow, session, nativeTheme } = require("electron");
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const assertions = [], screenshots = [], runtimeErrors = [];
  let win;
  const report = { command: "node scripts/test-backup-ui.mjs", inputs: config.inputs, css: config.css, assertions, screenshots, runtimeErrors,
    limitations: ["独立组件容器，不是完整设置导航窗口。", "合成桥仅验证渲染与现有交互门槛；不验证真实备份加密、文件选择、磁盘读写或恢复事务。", "未确认风险资源允许暂缓，最终确认可以只恢复安全资源；测试沿用此现有逻辑，不强制所有风险资源启用。"] };
  app.setPath("userData", path.join(config.temporary, "userData"));
  app.setPath("sessionData", path.join(config.temporary, "sessionData"));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  const evaluate = expression => win.webContents.executeJavaScript(expression, true);
  const pause = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const check = async (name, expression) => {
    const value = await evaluate(expression);
    const passed = value === true;
    assertions.push({ name, passed, ...(passed ? {} : { actual: value }) });
    console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
    if (!passed) throw new Error(`Assertion failed: ${name}; actual=${JSON.stringify(value)}`);
  };
  const act = async expression => { await evaluate(expression); await pause(); };
  const wait = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const click = async text => act(`(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw new Error('Missing button'); button.click(); })()`);
  const password = async (index, value) => act(`(() => { const input = document.querySelectorAll('input[type=password]')[${index}]; if (!input) throw new Error('Missing password'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const buttonDisabled = text => `(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw new Error('Missing expected button'); return button.disabled === true; })()`;
  const checkbox = async selector => act(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const geometry = async name => check(`${name}：没有水平溢出`, `(() => {
    const nodes = [document.documentElement, document.body, document.querySelector('.backup-settings'), ...document.querySelectorAll('.backup-settings *')];
    const failures = nodes.filter(node => node.getClientRects().length && !node.closest('details:not([open]) > :not(summary)') && node.scrollWidth > node.clientWidth + 2 && getComputedStyle(node).display !== 'inline');
    return failures.length === 0 || failures.map(node => ({tag: node.tagName, class: node.className, width: node.clientWidth, scroll: node.scrollWidth}));
  })()`);
  const shot = async name => {
    await pause();
    const file = path.join(config.output, `backup-${name}.png`);
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) throw new Error("Empty screenshot");
    await fs.writeFile(file, image.toPNG());
    screenshots.push({ file, ...image.getSize() });
  };
  const resize = async (width, height) => { win.setContentSize(width, height); await wait(`innerWidth === ${width} && innerHeight === ${height}`); await pause(); };
  const scrollTo = async selector => act(`(() => { const container = document.querySelector('.backup-settings'), target = document.querySelector(${JSON.stringify(selector)}); container.scrollTop = container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top; })()`);
  try {
    await app.whenReady();
    nativeTheme.themeSource = "light";
    const isolated = session.fromPartition("backup-ui-fixture");
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("file:") && !details.url.startsWith("devtools:") }));
    win = new BrowserWindow({ show: true, width: 1080, height: 700, useContentSize: true, autoHideMenuBar: true,
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.on("console-message", details => { if (details.level === "error") runtimeErrors.push(details.message); });
    win.webContents.on("render-process-gone", (_event, details) => runtimeErrors.push(JSON.stringify(details)));
    await win.loadFile(config.html);
    await wait("document.querySelector('h2')?.textContent === '备份'");
    await check("初始标题为备份", "document.querySelector('h2').textContent === '备份'");
    await check("初始仅两个创建密码输入", "document.querySelectorAll('input[type=password]').length === 2");
    await check("初始保存备份禁用", buttonDisabled("保存备份"));
    await check("未选文件不显示恢复密码或解锁按钮", "!document.querySelector('.backup-unlock') && ![...document.querySelectorAll('button')].some(item => item.textContent === '解锁并验证')");
    await check("宽屏密码为双列", "(() => { const [a,b] = [...document.querySelectorAll('.backup-passwords input')].map(item => item.getBoundingClientRect()); return Math.abs(a.top-b.top) < 2 && b.left > a.right; })()");
    await check("真实主题与当前设置样式生效", "(() => { const styles = getComputedStyle(document.querySelector('.backup-input')); return styles.height === '36px' && getComputedStyle(document.documentElement).getPropertyValue('--text').trim().length > 0; })()");
    await geometry("初始宽屏");
    await shot("wide-light");
    await resize(420, 760);
    await check("窄屏密码实际变为单列", "(() => { const [a,b] = [...document.querySelectorAll('.backup-passwords input')].map(item => item.getBoundingClientRect()); return b.top > a.bottom && Math.abs(a.left-b.left) < 2 && Math.abs(a.width-b.width) < 2; })()");
    await geometry("初始窄屏");
    await shot("narrow-light");
    await resize(1080, 700);
    const lightColor = await evaluate("getComputedStyle(document.querySelector('.backup-settings')).color");
    await act("document.documentElement.dataset.theme = 'dark'; document.documentElement.classList.add('dark')");
    await check("暗色主题实际改变前景颜色", `getComputedStyle(document.querySelector('.backup-settings')).color !== ${JSON.stringify(lightColor)}`);
    await geometry("初始暗色");
    await shot("wide-dark");
    await act("document.documentElement.dataset.theme = 'light'; document.documentElement.classList.remove('dark')");
    await password(0, "fixture-pass-123"); await password(1, "fixture-pass-123");
    await check("密码有效但未扫描仍禁用保存", buttonDisabled("保存备份"));
    await click("选择项目"); await wait("document.querySelector('.backup-projects') !== null");
    await check("项目仅来自合成选择桥", "window.__backupFixture.calls.some(item => item.method === 'backupSelectProjects') && document.querySelector('.backup-projects').textContent.includes('合成项目')");
    await click("扫描内容"); await wait("document.querySelector('.backup-scan') !== null && !document.querySelector('.backup-progress')");
    await check("扫描传递合成项目token", "JSON.stringify(window.__backupFixture.calls.find(item => item.method === 'backupScan').projectTokens) === JSON.stringify(['synthetic-project-token'])");
    await check("匹配有效密码仍需确认扫描警告", buttonDisabled("保存备份"));
    await checkbox(".backup-scan input[type=checkbox]");
    await password(0, "1234567"); await password(1, "1234567");
    await check("已扫描且已确认警告但七字符密码仍禁用", buttonDisabled("保存备份"));
    await password(0, "12345678"); await password(1, "87654321");
    await check("八字符密码不匹配仍禁用", buttonDisabled("保存备份"));
    await password(1, "12345678");
    await check("扫描加匹配八字符密码加警告确认才启用", `!${buttonDisabled("保存备份")}`);
    await password(0, "x".repeat(1025)); await password(1, "x".repeat(1025));
    await check("超过1024字符仍禁用", buttonDisabled("保存备份"));
    await password(0, "12345678"); await password(1, "12345678");
    await checkbox(".backup-scan input[type=checkbox]");
    await check("撤销扫描警告确认再次禁用", buttonDisabled("保存备份"));
    await shot("scan-warning");
    await act("window.__backupFixture.scanBlocked = true");
    await click("扫描内容"); await wait("document.querySelector('.backup-scan [role=alert]') !== null && !document.querySelector('.backup-progress')");
    await checkbox(".backup-scan input[type=checkbox]");
    await check("有阻断项即使密码与警告满足仍禁用", buttonDisabled("保存备份"));
    await act("document.querySelector('.backup-scan details summary').click()");
    await check("展开后资源清单真实可见", "document.querySelector('.backup-scan details').open && document.querySelector('.backup-scan details li').checkVisibility({contentVisibilityAuto:true})");
    await shot("scan-expanded");
    await act("document.querySelector('.backup-scan details summary').click()");
    await check("折叠后仅清单隐藏", "!document.querySelector('.backup-scan details').open && !document.querySelector('.backup-scan details li').checkVisibility({contentVisibilityAuto:true})");
    await check("折叠时扫描警告与阻断项仍显示", "(() => { const scan = document.querySelector('.backup-scan'); return [...scan.querySelectorAll('li')].filter(item => !item.closest('details')).length === 2 && [...scan.querySelectorAll('li')].filter(item => !item.closest('details')).every(item => item.getBoundingClientRect().height > 0) && scan.querySelector('[role=alert]').textContent.includes('合成阻断项'); })()");
    await geometry("扫描折叠宽屏");
    await shot("scan-collapsed-blocked");
    await resize(420, 760); await geometry("扫描窄屏"); await shot("scan-narrow");
    await resize(1080, 700);
    await click("选择备份文件"); await wait("document.querySelector('.backup-unlock') !== null");
    await check("选择合成文件后才出现第三个密码输入", "document.querySelectorAll('input[type=password]').length === 3 && document.querySelector('.backup-filename').textContent === 'synthetic-only.pibackup'");
    await check("空恢复密码不可解锁", buttonDisabled("解锁并验证"));
    await password(2, "fixture-restore-password"); await click("解锁并验证");
    await wait("document.querySelectorAll('.backup-resource').length === 5 && !document.querySelector('.backup-progress')");
    await check("解锁后隐藏恢复密码输入", "!document.querySelector('.backup-unlock') && document.querySelectorAll('input[type=password]').length === 2");
    await check("安全数据默认启用且可执行与安全策略逐项暂缓", "(() => { const checks = [...document.querySelectorAll('.backup-resource input[type=checkbox]')]; return checks[0].checked && checks.slice(1).every(item => !item.checked); })()");
    await check("无最终consent时不允许恢复", buttonDisabled("确认恢复"));
    await scrollTo(".backup-preview"); await geometry("恢复预览宽屏"); await shot("restore-preview");
    await resize(420, 760); await geometry("恢复预览窄屏"); await shot("restore-preview-narrow");
    await resize(1080, 700);
    await checkbox(".backup-resource:nth-of-type(2) input[type=checkbox]");
    await check("单独启用插件不连带启用安全策略", "(() => { const checks = [...document.querySelectorAll('.backup-resource input[type=checkbox]')]; return checks[1].checked && !checks[2].checked; })()");
    await checkbox(".backup-resource:nth-of-type(3) input[type=checkbox]");
    await check("风险逐项确认后仍需最终consent", buttonDisabled("确认恢复"));
    await checkbox(".backup-consent input");
    await check("consent允许恢复已确认项，未确认风险继续暂缓", `!${buttonDisabled("确认恢复")}`);
    await checkbox(".backup-resource:nth-of-type(4) input[type=checkbox]");
    await check("显式选择未映射资源会阻止恢复", buttonDisabled("确认恢复"));
    await check("未映射阻断提示显示", "document.querySelector('.backup-preview [role=alert]')?.getBoundingClientRect().height > 0");
    await click("选择/更改恢复目录"); await wait("window.__backupFixture.calls.some(item => item.method === 'backupSelectMappingTarget') && !document.querySelector('.backup-progress')");
    await check("合成映射解除未映射阻断并保留选择", `!${buttonDisabled("确认恢复")} && [...document.querySelectorAll('.backup-resource input[type=checkbox]')].slice(1,4).every(item => item.checked)`);
    await checkbox(".backup-resource:nth-of-type(5) input[type=checkbox]");
    await check("选择已阻断资源后最终consent也无法绕过", buttonDisabled("确认恢复"));
    await scrollTo(".backup-resource:nth-of-type(5)"); await shot("restore-blocked");
    await checkbox(".backup-resource:nth-of-type(5) input[type=checkbox]");
    await checkbox(".backup-consent input");
    await check("撤销最终consent再次禁止恢复", buttonDisabled("确认恢复"));
    await checkbox(".backup-consent input");
    await check("暂缓阻断项且最终consent后允许恢复", `!${buttonDisabled("确认恢复")}`);
    await shot("restore-consent");
    await click("确认恢复"); await wait("window.__backupFixture.restoreRequests.length === 1 && !document.querySelector('.backup-progress')");
    await check("仅合成恢复调用收到准确逐资源决策与最新指纹", "(() => { const request = window.__backupFixture.restoreRequests[0]; return request.configurationConsent === true && request.planFingerprint === 'synthetic-restore-plan-v2' && request.decisions.length === 5 && request.decisions.filter(item => item.activation === 'enable').length === 4 && request.decisions.find(item => item.resourceId === 'blocked-fixture').activation === 'defer' && !('password' in request); })()");
    await check("合成恢复结果呈现且清理预览", "!document.querySelector('.backup-preview') && document.querySelector('.backup-feedback').textContent.includes('已恢复 4 项')");
    await check("从未调用任何导出（包括合成导出）", "window.__backupFixture.exportCalls === 0");
    await check("所有桥调用均为明确合成方法", "window.__backupFixture.calls.every(item => ['backupSelectProjects','backupScan','backupInspect','backupSelectMappingTarget','backupRestore','backupCancel','onBackupProgress','unsubscribeProgress'].includes(item.method))");
    report.bridgeCalls = await evaluate("window.__backupFixture.calls");
    if (runtimeErrors.length) throw new Error(`Renderer errors: ${runtimeErrors.join('; ')}`);
    report.passed = true;
    console.log(`Backup UI: ${assertions.length}/${assertions.length} passed; ${screenshots.length} screenshots`);
  } catch (error) {
    report.passed = false; report.failure = error.stack || String(error);
    console.error(report.failure);
    if (win && !win.isDestroyed()) { try { await shot("failure"); } catch {} }
  } finally {
    await fs.writeFile(path.join(config.output, "backup-ui-report.json"), JSON.stringify(report, null, 2));
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(report.passed ? 0 : 1);
  }
}

try {
  await fs.access(electron);
  const assets = path.join(root, "dist/renderer/assets");
  const css = (await fs.readdir(assets)).filter(name => name.endsWith(".css")).sort().map(name => path.join(assets, name));
  if (!css.length) throw new Error("Missing built renderer CSS. Run the existing UI build first; this script never rebuilds production files.");
  // Append the actual current source stylesheet to avoid a stale build hiding recent UI changes.
  css.push(path.join(root, "app/settings.css"));
  const inputs = await Promise.all(["scripts/test-backup-ui.mjs", "components/BackupSettings.tsx", "shared/backup.ts", "hooks/useI18n.tsx", "lib/i18n/messages/backup.ts", ...css.map(file => path.relative(root, file))].map(async file => ({
    file, sha256: createHash("sha256").update(await fs.readFile(path.join(root, file))).digest("hex"),
  })));
  await fs.mkdir(output, { recursive: true });
  // Do not let a previous report/failure image masquerade as this run's evidence.
  await Promise.all(["backup-ui-report.json", "backup-failure.png"].map(name => fs.rm(path.join(output, name), { force: true })));
  const entry = path.join(temporary, "renderer.tsx");
  await fs.writeFile(entry, `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { BackupSettings } from ${JSON.stringify(path.join(root, "components/BackupSettings.tsx"))};\nimport { I18nProvider } from ${JSON.stringify(path.join(root, "hooks/useI18n.tsx"))};\n(${installSyntheticBridge.toString()})();\ncreateRoot(document.getElementById('root')).render(<I18nProvider><BackupSettings /></I18nProvider>);\n`);
  await build({ absWorkingDir: root, entryPoints: [entry], outfile: path.join(temporary, "renderer.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", nodePaths: [path.join(root, "node_modules")], alias: { "@": root }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning" });
  const html = path.join(temporary, "index.html");
  const escapeAttribute = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  await fs.writeFile(html, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">${css.map(file => `<link rel="stylesheet" href="${escapeAttribute(pathToFileURL(file).href)}">`).join("")}<style>/* Harness geometry only. All component rules and theme tokens are actual project CSS. */html,body,#root{width:100%;height:100%;margin:0}body{background:var(--bg);color:var(--text)}#root{box-sizing:border-box;padding:24px;display:flex;justify-content:center;align-items:flex-start}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`);
  const main = path.join(temporary, "main.cjs");
  await build({ stdin: { contents: `(${runElectron.toString()})(${JSON.stringify({ temporary, output, html, inputs, css })}).catch(error => {console.error(error);require('electron').app.exit(1)});`, resolveDir: root }, outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "warning" });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/ELECTRON_RUN_AS_NODE|(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|CLIENT_KEY|NPM_CONFIG_USERCONFIG|^(?:PI_|XDG_|OPENAI|ANTHROPIC|GOOGLE|GEMINI|AWS_|AZURE_|GCP_|CLOUDSDK_|VERTEX_))/i.test(key)) delete env[key];
  Object.assign(env, { HOME: temporary, USERPROFILE: temporary, APPDATA: path.join(temporary, "appdata"), LOCALAPPDATA: path.join(temporary, "localappdata"), TEMP: path.join(temporary, "tmp"), TMP: path.join(temporary, "tmp") });
  for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.TEMP]) await fs.mkdir(directory, { recursive: true });
  const child = spawn(electron, [main], { cwd: temporary, env, stdio: "inherit", windowsHide: false });
  const timeout = setTimeout(() => { console.error("Backup UI Electron timeout (120 seconds)"); child.kill(); }, 120_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
    process.exitCode = Number(code);
  } finally { clearTimeout(timeout); }
} finally {
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
