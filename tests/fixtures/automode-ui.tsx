import React from "react";
import { createRoot } from "react-dom/client";
import { AutomodeConfig } from "../../components/AutomodeConfig";
import { I18nProvider } from "../../hooks/useI18n";

// Entirely synthetic: never contacts the backend or user configuration.
const models = [
  { provider: "KBQ", modelId: "glm-primary", name: "[0.12]glm-5.3-flash" },
  { provider: "KBQ", modelId: "glm-backup", name: "[0.2]glm-5.3-flash" },
  { provider: "KBQ", modelId: "glm-special", name: "[特价]glm-5.3-flash" },
  { provider: "KBQ", modelId: "deepseek", name: "DeepSeek V4.1 Flash" },
  { provider: "蓝色鲸鱼", modelId: "deepseek", name: "DeepSeek V4.1 Flash" },
];
const effective = {
  enabled: true, classifierModel: "KBQ/glm-primary",
  classifierFallbackModels: ["KBQ/glm-backup", "KBQ/glm-special", "KBQ/deepseek", "蓝色鲸鱼/deepseek"],
  classifierReasoningLevel: null, classifierTimeoutMs: 15000,
  fastClassifierMaxTokens: 1024, maxUserTranscriptTokens: 2048, maxToolTranscriptTokens: 2048,
  classifyReadOnlyTools: false, allowInsideWorkingDirectory: false,
  deniedPaths: [], log: { enabled: true, classifierIo: false }, ruleCounts: {},
};
const defaults = {
  classifierTimeoutMs: 15000, fastClassifierMaxTokens: 1024,
  maxUserTranscriptTokens: 2048, maxToolTranscriptTokens: 2048,
};
const fixture: any = {
  requests: [], trusted: true, modelsEmpty: false, loadFail: false, testFail: false,
  reloads: 0, current: structuredClone(effective),
};
(window as any).fixture = fixture;
window.fetch = async (input, init) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  fixture.requests.push({ url, method: init?.method ?? "GET", body });
  const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status }));
  if (url === "/api/models-config") return json({});
  if (url.startsWith("/api/models?")) return json({ modelList: fixture.modelsEmpty ? [] : models.map(model => ({ ...model, id: model.modelId })) });
  if (url === "/api/automode/test") {
    return fixture.testFail ? json({ ok: false, error: "模拟连接失败" }, 500) : json({ ok: true, latencyMs: 125, text: "allow" });
  }
  if (url.startsWith("/api/automode")) {
    if (fixture.loadFail) return json({ error: "模拟加载失败" }, 500);
    if (init?.method === "PUT") Object.assign(fixture.current, body.patch);
    return json({
      trusted: fixture.trusted, global: { values: {}, error: null },
      project: { values: {}, error: null }, effective: fixture.current, defaults, diagnostics: [],
    });
  }
  if (url === "/api/agent/mock-session") return json({ success: true, data: {} });
  throw new Error("Unexpected fixture request: " + url);
};
localStorage.setItem("pi-locale", "zh-CN");
const root = createRoot(document.getElementById("root")!);
let revision = 0;
fixture.mount = (options = {}) => {
  Object.assign(fixture, { trusted: true, modelsEmpty: false, loadFail: false, testFail: false, current: structuredClone(effective) }, options);
  root.render(
    <I18nProvider key={++revision}>
      <AutomodeConfig cwd="C:/mock-project" sessionId="mock-session" onReloaded={() => { fixture.reloads++; }} />
    </I18nProvider>
  );
};
fixture.mount();
