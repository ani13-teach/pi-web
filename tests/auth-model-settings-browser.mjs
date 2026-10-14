import {build} from "esbuild";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {mkdtemp,writeFile,readFile,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const temporary=await mkdtemp(path.join(tmpdir(),"pi-auth-settings-"));
const output=path.join(root,"docs/validation/auth-models",new Date().toISOString().replace(/[:.]/g,"-"));
await mkdir(output,{recursive:true});
const inputs={};
for(const file of ["components/ModelsConfig.tsx","components/AuthModelsManager.tsx","components/auth-model-drafts.ts","components/SettingsUi.tsx","app/settings.css","app/globals.css","lib/auth-model-types.ts"]) inputs[file]=createHash("sha256").update(await readFile(path.join(root,file))).digest("hex");

// Real component fixture; SettingsPanel-equivalent inert header. No backend loaded.
const fixture="import React from \"react\";\nimport {createRoot} from \"react-dom/client\";\nimport {ModelsConfig} from \"@/components/ModelsConfig\";\nimport {I18nProvider} from \"@/hooks/useI18n\";\nconst clone=v=>JSON.parse(JSON.stringify(v));\nlocalStorage.clear();localStorage.setItem(\"pi-locale\",\"zh-CN\");\nlocalStorage.setItem(\"pi-web:settings-navigation\",JSON.stringify({section:\"models\",selections:{models:JSON.stringify({type:\"oauth\",providerId:\"openai-codex\"})}}));\nconst ids=[\"gpt-5.3-codex\",\"gpt-5.3-codex-mini\",\"code-cn\",\"gpt-5-codex-enterprise-experimental-very-long-model-identifier-2026-08-31\",\"gpt-5.4\",\"gpt-5.4-mini\",\"gpt-5.2\",\"fast-cn\",\"research-preview\",\"context-cn\"];\nconst names=[\"GPT-5.3 Codex\",\"GPT-5.3 Codex Mini\",\"中文代码推理模型\",\"长名称模型 · 高级代码审阅与复杂推理能力测试\",\"GPT-5.4\",\"GPT-5.4 Mini\",\"GPT-5.2\",\"快速轻量模型\",\"Experimental Research\",\"实验性超长上下文模型\"];\nconst nativeModels=names.map((name,i)=>({id:ids[i],name,contextWindow:i===9?1048576:272000,maxTokens:32768}));\nconst apiModels=[{id:\"api-small\",name:\"API 中文小模型\",contextWindow:128000,maxTokens:8192},{id:\"api-large\",name:\"API Large Model\",contextWindow:256000,maxTokens:16384}];\nlet state={config:{providers:{\"openai-codex\":{modelOverrides:{\"gpt-5.3-codex\":{contextWindow:333000,maxTokens:22222,headers:{\"x-fixture\":\"preserved\"}},\"gpt-5.3-codex-mini\":{contextWindow:64000,maxTokens:5555,headers:{\"x-fixture\":\"mini-preserved\"}}}},\"fixture-api\":{modelOverrides:{\"api-small\":{contextWindow:90000,maxTokens:8192,headers:{\"x-fixture\":\"api-preserved\"}}}}}},selections:{\"openai-codex\":[ids[0],ids[2],ids[4]],\"fixture-api\":[\"api-small\"]},version:0,configVersion:0};\nwindow.fixture={requests:[],unexpectedFetches:[],errors:[],events:0,closes:0,saveMode:\"success\",failCatalog:1,ids,snapshot:()=>clone(state)};\nwindow.addEventListener(\"pi-model-settings-changed\",()=>window.fixture.events++);\nwindow.addEventListener(\"error\",e=>window.fixture.errors.push(e.message));window.addEventListener(\"unhandledrejection\",e=>window.fixture.errors.push(String(e.reason)));\nwindow.EventSource=class{constructor(){window.fixture.errors.push(\"EventSource attempted\");throw new Error(\"EventSource forbidden\");}};\nwindow.fetch=async(input,init={})=>{\n const url=new URL(typeof input===\"string\"?input:input.url,\"https://fixture.invalid\"),method=(init.method||\"GET\").toUpperCase(),body=init.body?JSON.parse(String(init.body)):null;\n const req={sequence:window.fixture.requests.length+1,path:url.pathname,method,body,versionBefore:state.version,configVersionBefore:state.configVersion};window.fixture.requests.push(req);\n let result,status=200;\n if(url.origin!==\"https://fixture.invalid\"){window.fixture.unexpectedFetches.push(req);throw new Error(\"External request forbidden\");}\n if(method===\"GET\"&&url.pathname===\"/api/models-config\")result=clone(state.config);\n else if(method===\"GET\"&&url.pathname===\"/api/auth/providers\")result={oauthProviders:[{id:\"openai-codex\",name:\"OpenAI Codex\",usesCallbackServer:true,loggedIn:true}],apiKeyProviders:[{id:\"fixture-api\",displayName:\"API 测试服务商\",configured:true,modelCount:2}]};\n else if(method===\"GET\"&&url.pathname===\"/api/models-config/auth-models\"){\n if(window.fixture.failCatalog>0){window.fixture.failCatalog--;status=503;result={error:\"Fixture catalog unavailable\"};}\n else{const entry=(p,models)=>({selectedIds:clone(state.selections[p]),models:models.map(m=>({...m,contextWindow:state.config.providers?.[p]?.modelOverrides?.[m.id]?.contextWindow??m.contextWindow,enabled:state.selections[p].includes(m.id)}))});result={providers:{\"openai-codex\":entry(\"openai-codex\",nativeModels),\"fixture-api\":entry(\"fixture-api\",apiModels)}};}\n }else if(method===\"PUT\"&&url.pathname===\"/api/models-config\"){\n if(Object.keys(body||{}).sort().join(\",\")!==\"authModelSelections,config\"||!body.config||!body.authModelSelections){window.fixture.unexpectedFetches.push(req);throw new Error(\"Invalid envelope\");}\n if(window.fixture.saveMode===\"failure\"){status=500;result={success:false,error:\"Fixture save failed\"};}\n else if(window.fixture.saveMode===\"partial\"){state.config=clone(body.config);state.configVersion++;status=500;result={success:false,partialSave:true,error:\"Fixture selection failure after config write\"};}\n else{state.config=clone(body.config);state.selections={...state.selections,...clone(body.authModelSelections)};state.version++;state.configVersion++;result={success:true};}\n }else{window.fixture.unexpectedFetches.push(req);throw new Error(\"Unexpected request \"+method+\" \"+url.pathname);}\n req.versionAfter=state.version;req.configVersionAfter=state.configVersion;req.status=status;req.response=clone(result);\n return new Response(JSON.stringify(result),{status,headers:{\"Content-Type\":\"application/json\"}});\n};\nlocalStorage.setItem(\"pi-web:provider-usage:openai-codex\",JSON.stringify({providerId:\"openai-codex\",status:\"ready\",report:{capturedAt:1786080000000,buckets:[{id:\"session\",label:\"5 小时额度\",remaining:72,unit:\"percent\"},{id:\"weekly\",label:\"本周额度\",remaining:84,unit:\"percent\"}],metrics:[]}}));\nfunction App(){return <I18nProvider><div role=\"dialog\" aria-modal=\"true\" aria-label=\"设置\" className=\"settings-dialog-backdrop\"><div className=\"settings-dialog-surface\"><div className=\"settings-dialog-header\"><strong className=\"settings-dialog-title\">设置</strong><select aria-label=\"设置\" className=\"settings-mobile-section-picker\" defaultValue=\"models\"><option value=\"models\">模型</option></select><nav aria-label=\"设置\" className=\"settings-section-tabs\">{[\"通用\",\"模型\",\"技能\",\"代理\",\"插件\",\"MCP\",\"自动模式\",\"备份\"].map(label=><button key={label} className=\"settings-section-tab\" aria-current={label===\"模型\"?\"page\":undefined}><span>{label}</span></button>)}</nav><button className=\"config-close-button settings-dialog-close\" aria-label=\"关闭\" onClick={()=>window.fixture.closes++}>×</button></div><main className=\"settings-dialog-main\"><div className=\"settings-section-host\"><ModelsConfig embedded onClose={()=>window.fixture.closes++}/></div></main></div></div></I18nProvider>};\ncreateRoot(document.getElementById(\"root\")).render(<App/>);\n";
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
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  const output = process.argv[2];
  const inputHashes = JSON.parse(fs.readFileSync(path.join(__dirname, "inputs.json"), "utf8"));
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
      fs.writeFileSync(path.join(output, filename), (await win.webContents.capturePage()).toPNG());
      screenshots.push(filename);
    } catch (error) { console.error("Screenshot failed: " + error.message); }
  };
  const finish = async code => {
    if (finished) return;
    finished = true;
    let fixtureState;
    try {
      fixtureState = await evaluate?.(() => ({ requests: window.fixture?.requests,
        state: window.fixture?.snapshot(), events: window.fixture?.events, closes: window.fixture?.closes,
        unexpectedFetches: window.fixture?.unexpectedFetches, errors: window.fixture?.errors,
        selectInjections: window.fixture?.selectInjections, html: document.getElementById("root").innerHTML }));
    } catch (error) { rendererErrors.push("Diagnostic snapshot: " + error.message); }
    const passed = results.filter(result => result.passed).length;
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
      inputHashes, passed, total: results.length, results, screenshots, unexpectedRequests, rendererErrors, fixtureState,
    }, null, 2));
    console.log(`${passed}/${results.length} auth model settings browser checks passed`);
    console.log("Fixture saved version: " + JSON.stringify(fixtureState?.state?.version));
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
  }, 120000);
  try {
    await app.whenReady();
    const htmlUrl = pathToFileURL(path.join(__dirname, "fixture.html")).href;
    const jsUrl = pathToFileURL(path.join(__dirname, "fixture.js")).href;
    const spriteUrl = pathToFileURL(path.join(__dirname, "provider-icons.svg")).href;
    // Only these two generated files can load. CSP separately denies connections.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const baseUrl = details.url.split("#")[0];
      if (baseUrl.endsWith("/provider-icons.svg") && baseUrl !== spriteUrl) return callback({ redirectURL: spriteUrl });
      const allowed = details.url === htmlUrl || details.url === jsUrl || baseUrl === spriteUrl;
      if (!allowed) unexpectedRequests.push(details.url);
      callback({ cancel: !allowed });
    });
    win = new BrowserWindow({
      width: 1440, height: 900, useContentSize: true, show: true,
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
    const save=".config-footer .config-button-primary", search=".auth-model-search input";
    const context=(id,p="openai-codex")=>'[id="auth-context-'+p+'-'+id+'"]';
    const row=(id,p="openai-codex")=>".auth-model-row:has("+context(id,p)+")";
    const expectIds=async(name,ids,p="openai-codex")=>{const actual=await evaluate(()=>[...document.querySelectorAll(".auth-model-row")].filter(r=>r.querySelector("input[type=checkbox]").checked).map(r=>r.querySelector(".auth-model-context input").id));await check(name,JSON.stringify(actual.sort())===JSON.stringify(ids.map(id=>"auth-context-"+p+"-"+id).sort()),JSON.stringify(actual));};
    const bulk=async index=>click(".auth-model-bulk button:nth-child("+index+")");
    const provider=async name=>{await click({css:".config-sidebar-text",text:name});await waitFor(()=>document.querySelector(".auth-model-search input"));};
    const layout=async(w,h,name)=>{win.setContentSize(w,h);await waitFor((w,h)=>innerWidth===w&&innerHeight===h,w,h);await click(".settings-dialog-title");await evaluate(()=>document.querySelector(".config-detail").scrollTop=0);await settle();const observed=await evaluate(()=>{const css=["html","body",".settings-dialog-surface",".config-panel-surface",".config-detail",".auth-model-manager",".auth-model-row",".config-footer"];const overflow=css.flatMap(c=>[...document.querySelectorAll(c)].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>({css:c,client:e.clientWidth,scroll:e.scrollWidth})));const b=document.querySelector(".config-footer .config-button-primary"),r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return{width:innerWidth,height:innerHeight,overflow,footerVisible:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,footerHit:hit===b||b.contains(hit)};});await check(name+" exact viewport",observed.width===w&&observed.height===h,JSON.stringify(observed));await check(name+" no horizontal overflow",observed.overflow.length===0,JSON.stringify(observed.overflow));await check(name+" footer visible without scrolling",observed.footerVisible&&observed.footerHit,JSON.stringify(observed));await screenshot(name+"-top");await evaluate(()=>{const d=document.querySelector(".config-detail");d.scrollTop=d.scrollHeight;});await settle();await screenshot(name+"-bottom");};
    await win.loadFile(path.join(__dirname,"fixture.html"));win.setContentSize(1440,900);
    await waitFor(()=>document.querySelector(".auth-model-error button"));
    await check("initial catalog failure offers retry, no stale rows",await evaluate(()=>!!document.querySelector(".auth-model-error[role=alert]")&&document.querySelectorAll(".auth-model-row").length===0));await screenshot("catalog-initial-failure-1440x900");
    await click(".auth-model-error button");await waitFor(()=>document.querySelectorAll(".auth-model-row").length===10);
    await check("all 10 auth models visible including 7 outside whitelist",await evaluate(()=>document.querySelectorAll(".auth-model-row").length===10&&document.querySelectorAll(".auth-model-choice input:checked").length===3));
    await check("cached ready usage renders without network query",await evaluate(()=>document.body.innerText.includes("72%")&&!window.fixture.requests.some(r=>r.path.includes("provider-usage"))));
    await check("override-only providers not duplicated in navigation",await evaluate(()=>document.querySelectorAll(".config-sidebar-list .config-sidebar-item").length===2&&!document.querySelector(".models-sidebar-indented-item")));
    await layout(1440,900,"light-1440x900");
    await layout(820,720,"baseline-light-820x720");await layout(560,850,"baseline-light-560x850");
    await evaluate(()=>{document.documentElement.classList.add("dark");document.documentElement.dataset.theme="dark";});await layout(1440,900,"baseline-dark-1440x900");
    await evaluate(()=>{document.documentElement.classList.remove("dark");document.documentElement.dataset.theme="light";});win.setContentSize(1440,900);await waitFor(()=>innerWidth===1440&&innerHeight===900);
    await click(row("gpt-5.3-codex-mini")+" input[type=checkbox]");await expectIds("single select includes previously hidden model",["gpt-5.3-codex","gpt-5.3-codex-mini","code-cn","gpt-5.4"]);
    await click(row("gpt-5.3-codex-mini")+" input[type=checkbox]");await expectIds("single deselect restores baseline",["gpt-5.3-codex","code-cn","gpt-5.4"]);
    await type(search,"mini");await check("search shows 2 matching models",await evaluate(()=>document.querySelectorAll(".auth-model-row").length===2));await bulk(1);await expectIds("select search results checks both matching rows",["gpt-5.3-codex-mini","gpt-5.4-mini"]);
    await type(search,"");await expectIds("clearing search retains matching and nonmatching selections",["gpt-5.3-codex","gpt-5.3-codex-mini","code-cn","gpt-5.4","gpt-5.4-mini"]);
    await type(search,"mini");await bulk(2);await type(search,"");await expectIds("clear results affects matching rows only",["gpt-5.3-codex","code-cn","gpt-5.4"]);
    await type(search,"no-such-model");await check("no results disables bulk actions",await evaluate(()=>document.querySelectorAll(".auth-model-row").length===0&&[...document.querySelectorAll(".auth-model-bulk button")].every(b=>b.disabled)));await type(search,"");
    for(const invalid of ["0","-1","1.5","abc","9007199254740992"]){await type(context("gpt-5.3-codex"),invalid);await check("invalid context "+invalid+" blocks save",await evaluate(css=>document.querySelector(css).getAttribute("aria-invalid")==="true"&&document.querySelector(".auth-model-field-error")&&document.querySelector(".config-footer .config-button-primary").disabled&&window.fixture.requests.every(r=>r.method==="GET"),context("gpt-5.3-codex")));}
    await screenshot("invalid-context");await type(context("gpt-5.3-codex"),"400000");await check("valid context enables save but does not write storage",await evaluate(()=>!document.querySelector(".config-footer .config-button-primary").disabled&&window.fixture.snapshot().config.providers["openai-codex"].modelOverrides["gpt-5.3-codex"].contextWindow===333000));
    await click(row("gpt-5.3-codex-mini")+" .auth-model-reset");await check("reset previews blank inheritance",await evaluate(css=>document.querySelector(css).value==="",context("gpt-5.3-codex-mini")));
    await click(row("gpt-5.3-codex-mini")+" input[type=checkbox]");await provider("API 测试服务商");await check("API-key provider has 2 editable catalog rows",await evaluate(()=>document.querySelectorAll(".auth-model-row").length===2));await type(context("api-small","fixture-api"),"110000");await click(row("api-large","fixture-api")+" input[type=checkbox]");await provider("OpenAI Codex");await expectIds("switch provider retains auth selection draft",["gpt-5.3-codex","gpt-5.3-codex-mini","code-cn","gpt-5.4"]);await check("switch provider retains auth context/reset drafts",await evaluate(()=>document.getElementById("auth-context-openai-codex-gpt-5.3-codex").value==="400000"&&document.getElementById("auth-context-openai-codex-gpt-5.3-codex-mini").value===""));
    await provider("API 测试服务商");await expectIds("API selections persist through switching",["api-small","api-large"],"fixture-api");await check("API context persists through switching",await evaluate(()=>document.getElementById("auth-context-fixture-api-api-small").value==="110000"));await provider("OpenAI Codex");

    const providerHeaders=await evaluate(()=>[...document.querySelectorAll(".config-detail .config-detail-header .config-section-title")].map(e=>e.textContent));
    await check("switching providers leaves exactly one provider authentication detail",providerHeaders.length===1,JSON.stringify(providerHeaders));
    await evaluate(()=>window.fixture.saveMode="failure");await click(save);await waitFor(()=>document.querySelector(".config-footer [role=alert]"));await check("failed save reports error, retains draft and emits no event",await evaluate(()=>!document.querySelector(".config-button.is-success")&&!document.querySelector(".config-footer .config-button-primary").disabled&&window.fixture.events===0&&window.fixture.snapshot().version===0&&document.getElementById("auth-context-openai-codex-gpt-5.3-codex").value==="400000"));await screenshot("save-failure-draft");
    await evaluate(()=>window.fixture.saveMode="partial");await click(save);await waitFor(()=>window.fixture.snapshot().configVersion===1);await check("partialSave reports failure and retains draft for retry",await evaluate(()=>!!document.querySelector(".config-footer [role=alert]")&&!document.querySelector(".config-button.is-success")&&!document.querySelector(".config-footer .config-button-primary").disabled&&window.fixture.events===0&&window.fixture.snapshot().version===0&&document.getElementById("auth-context-openai-codex-gpt-5.3-codex").value==="400000"));await screenshot("partial-save-draft");
    await evaluate(()=>window.fixture.saveMode="success");await click(save);await waitFor(()=>window.fixture.snapshot().version===1&&document.querySelectorAll(".auth-model-row").length===10&&!document.querySelector(".auth-model-message[role=status]"));
    await check("successful save sends identical envelopes on retry, event once",await evaluate(()=>{const req=window.fixture.requests.filter(r=>r.method==="PUT");return req.length===3&&req.every(r=>Object.keys(r.body).sort().join(",")==="authModelSelections,config")&&JSON.stringify(req[0].body)===JSON.stringify(req[1].body)&&JSON.stringify(req[1].body)===JSON.stringify(req[2].body)&&window.fixture.events===1&&document.querySelector(".config-button.is-success");}));
    await check("save envelope persists both provider selections and API context metadata",await evaluate(()=>{const s=window.fixture.snapshot(),o=s.config.providers["fixture-api"].modelOverrides["api-small"];return JSON.stringify([...s.selections["openai-codex"]].sort())===JSON.stringify(["gpt-5.3-codex","gpt-5.3-codex-mini","code-cn","gpt-5.4"].sort())&&JSON.stringify([...s.selections["fixture-api"]].sort())===JSON.stringify(["api-small","api-large"].sort())&&o.contextWindow===110000&&o.maxTokens===8192&&o.headers["x-fixture"]==="api-preserved";}));
    await check("reset removes only context, retains headers and maxTokens",await evaluate(()=>{const o=window.fixture.snapshot().config.providers["openai-codex"].modelOverrides;return o["gpt-5.3-codex"].contextWindow===400000&&o["gpt-5.3-codex"].maxTokens===22222&&o["gpt-5.3-codex"].headers["x-fixture"]==="preserved"&&!Object.hasOwn(o["gpt-5.3-codex-mini"],"contextWindow")&&o["gpt-5.3-codex-mini"].maxTokens===5555&&o["gpt-5.3-codex-mini"].headers["x-fixture"]==="mini-preserved";}));
    await check("refresh reflects saved context and selection count",await evaluate(()=>document.querySelector(".auth-model-current").textContent.includes("400,000")&&document.querySelectorAll(".auth-model-choice input:checked").length===4));await evaluate(()=>document.querySelector(".auth-model-manager").scrollIntoView({block:"start"}));await settle();await screenshot("save-success-refreshed");
    await check("save causes no override-only duplicate provider navigation",await evaluate(()=>document.querySelectorAll(".config-sidebar-list .config-sidebar-item").length===2));
    await bulk(2);await check("select none warns and retains all catalog rows",await evaluate(()=>!!document.querySelector(".auth-model-warning[role=status]")&&document.querySelectorAll(".auth-model-row").length===10&&document.querySelectorAll(".auth-model-choice input:checked").length===0));await evaluate(()=>document.querySelector(".auth-model-warning").scrollIntoView({block:"nearest"}));await settle();await screenshot("none-selected-warning");
    await evaluate(()=>window.fixture.failCatalog=1);await click(save);await waitFor(()=>window.fixture.snapshot().version===2&&document.querySelector(".auth-model-error button"));await check("saved selection plus refresh failure shows retry, not stale catalog",await evaluate(()=>window.fixture.events===2&&!!document.querySelector(".auth-model-error[role=alert]")&&document.querySelectorAll(".auth-model-row").length===0&&window.fixture.snapshot().selections["openai-codex"].length===0));await screenshot("saved-catalog-refresh-failed");await click(".auth-model-error button");await waitFor(()=>document.querySelectorAll(".auth-model-row").length===10);await expectIds("retry reflects persisted empty whitelist",[]);
    await bulk(1);await expectIds("select all covers all ten catalog models",await evaluate(()=>window.fixture.ids));
    await click(search);await key("Tab");const focusState=await evaluate(()=>{const e=document.activeElement,c=getComputedStyle(e);return{tag:e.tagName,html:e.outerHTML,expected:e===document.querySelector(".auth-model-bulk button:nth-child(2)"),focusVisible:e.matches(":focus-visible"),outlineStyle:c.outlineStyle,outlineWidth:c.outlineWidth,boxShadow:c.boxShadow};});await check("Tab reaches enabled clear-all with visible keyboard focus",focusState.expected&&focusState.focusVisible&&(focusState.outlineStyle!=="none"||focusState.boxShadow!=="none"),JSON.stringify(focusState));await screenshot("keyboard-focus");
    await layout(820,720,"light-820x720");await layout(560,850,"light-560x850");
    await evaluate(()=>{document.documentElement.classList.add("dark");document.documentElement.dataset.theme="dark";});await layout(1440,900,"dark-1440x900");await layout(560,850,"dark-560x850");
    await check("only mocked settings requests, no real auth/model/usage requests",await evaluate(()=>window.fixture.unexpectedFetches.length===0&&window.fixture.closes===0&&window.fixture.requests.every(r=>["/api/models-config","/api/auth/providers","/api/models-config/auth-models"].includes(r.path)))&&unexpectedRequests.length===0,JSON.stringify(unexpectedRequests));
    await check("no renderer errors or unhandled rejections",rendererErrors.length===0&&await evaluate(()=>window.fixture.errors.length===0),JSON.stringify([...new Set(rendererErrors)]));
    clearTimeout(watchdog);await finish(results.every(r=>r.passed)?0:1);
  }catch(error){await check("browser scenario completes",false,error.stack??String(error));clearTimeout(watchdog);await finish(1);}
}

try {
 const globals=await readFile(path.join(root,"app/globals.css"),"utf8"),settings=await readFile(path.join(root,"app/settings.css"),"utf8");
 const theme=globals.slice(globals.indexOf(":root,"),globals.indexOf('[data-theme="mist"]'));
 await build({stdin:{contents:fixture,loader:"tsx",resolveDir:root,sourcefile:"auth-model-settings-fixture.tsx"},bundle:true,platform:"browser",format:"iife",jsx:"automatic",alias:{"@":root},outfile:path.join(temporary,"fixture.js"),define:{"process.env.NODE_ENV":JSON.stringify("test")},logLevel:"silent"});
 const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;self&#39;; style-src &#39;unsafe-inline&#39;; connect-src &#39;none&#39;; img-src file:"><style>'+theme+'*{box-sizing:border-box}html,body{height:100%;width:100%;margin:0}body{font-family:Arial,"Microsoft YaHei",sans-serif;color:var(--text);background:var(--bg);font-size:14px}:root{--font-mono:Consolas,monospace}button,input,select{font:inherit}button{cursor:pointer}'+settings+'</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>';
 await writeFile(path.join(temporary,"provider-icons.svg"),await readFile(path.join(root,"public/provider-icons.svg")));
 await writeFile(path.join(temporary,"fixture.html"),html);await writeFile(path.join(temporary,"inputs.json"),JSON.stringify(inputs));await writeFile(path.join(temporary,"main.cjs"),"("+electronMain.toString()+")();\n");
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(createRequire(import.meta.url)("electron"),[path.join(temporary,"main.cjs"),output],{cwd:temporary,env,stdio:["ignore","pipe","pipe"],windowsHide:true});child.stdout.on("data",c=>process.stdout.write(c));child.stderr.on("data",c=>process.stderr.write(c));
 const timer=setTimeout(()=>{console.error("Overall Electron timeout");child.kill();},135000);const exit=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
 let report;try{report=JSON.parse(await readFile(path.join(output,"result.json"),"utf8"));}catch{}
 console.log("Electron exit: "+JSON.stringify(exit));console.log("Retained evidence: "+output);console.log("Isolated fixture: "+temporary);process.exitCode=exit.code===0&&report?.total>0&&report?.passed===report?.total?0:1;
}catch(error){console.error(error.stack??error);process.exitCode=1;console.error("Artifacts retained: "+output+" ; "+temporary);}
