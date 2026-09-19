"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  buildPatch,
  changedKeys,
  draftFrom,
  numberErrors,
  parseSessionStatus,
  REASONING_LEVELS,
  sessionLine,
  type Draft,
  type EffectiveValues,
  type SessionStatus,
} from "./automode-draft";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

/**
 * The auto-mode settings page.
 *
 * The panel never guesses which file a value comes from: `GET /api/automode`
 * returns the raw contents of both configuration files plus the effective
 * values the vendored extension computes, and every row shows both. Empty
 * number and text fields mean "this layer says nothing", so the inherited value
 * (shown as the placeholder) stays in force. Only fields the user actually
 * changed are sent, so touching one switch never rewrites the whole file.
 */

interface AutomodeResponse {
  cwd: string;
  builtin: { version: string; basedOn: string };
  plugin: { path: string; installed: boolean; active: boolean };
  paths: { global: string; project: string };
  trusted: boolean;
  global: { values: Record<string, unknown>; error: string | null };
  project: { values: Record<string, unknown>; error: string | null };
  effective: EffectiveValues;
  sources: Record<string, SourceKind>;
  defaults: Record<string, number | boolean | object>;
  diagnostics: string[];
}

type Scope = "global" | "project";
type SourceKind = "project" | "global" | "default" | "merged";
type TestKey = "primary" | `fallback-${number}`;

const inputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: 34,
  padding: "0 9px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
};

interface Props {
  cwd: string | null;
  sessionId: string | null;
  onReloaded: () => void;
}

export function AutomodeConfig({ cwd, sessionId, onReloaded }: Props) {
  const { t } = useI18n();
  const [state, setState] = useState<AutomodeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("global");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [testing, setTesting] = useState<TestKey | null>(null);
  const [results, setResults] = useState<Partial<Record<TestKey, { ok: boolean; text: string }>>>({});
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);
  const [sessionStatusNonce, setSessionStatusNonce] = useState(0);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch(`/api/automode?cwd=${encodeURIComponent(cwd ?? "")}`);
      const body = await response.json() as AutomodeResponse & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      setState(body);
      return body;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/models?cwd=${encodeURIComponent(cwd ?? "")}`);
        const body = await response.json() as { modelList?: { id: string; provider: string }[] };
        if (cancelled || !Array.isArray(body.modelList)) return;
        setModels(body.modelList.map((model) => `${model.provider}/${model.id}`).sort());
      } catch {
        // The picker is a convenience; a free-text field still works.
      }
    })();
    return () => { cancelled = true; };
  }, [cwd]);

  const applyState = useCallback((next: AutomodeResponse) => {
    setState(next);
  }, []);

  // The file values above are what a new session would get. What the session on
  // screen is doing can differ (it may have been switched off in the chat), so
  // it is read separately and never presented as if it came from the file.
  useEffect(() => {
    if (!sessionId) {
      setSessionStatus(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/state`);
        const body = await response.json() as {
          state?: { extensionStatuses?: { key: string; text: string }[] };
        };
        const line = body.state?.extensionStatuses?.find((entry) => entry.key === "pi-automode");
        if (!cancelled) setSessionStatus(parseSessionStatus(line?.text));
      } catch {
        if (!cancelled) setSessionStatus(null);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, sessionStatusNonce]);

  useEffect(() => {
    if (!state) return;
    const values = scope === "project" ? state.project.values : state.global.values;
    const nextDraft = draftFrom(values, state.effective);
    setDraft(nextDraft);
    setBaseline(nextDraft);
    // Re-derive the editor whenever the scope or the loaded state changes.
  }, [scope, state]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setSaveError(null);
    setSavedPath(null);
  };

  const dirty = draft && baseline ? changedKeys(draft, baseline) : [];

  const save = async () => {
    if (!draft || !baseline || dirty.length === 0) return;
    const errors = numberErrors(draft, t);
    if (errors.length > 0) {
      setSaveError(errors.join("；"));
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSavedPath(null);
    try {
      const response = await fetch("/api/automode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, patch: buildPatch(draft, baseline) }),
      });
      const body = await response.json() as {
        error?: string;
        saved?: { path: string };
        global?: AutomodeResponse["global"];
        project?: AutomodeResponse["project"];
        effective?: EffectiveValues;
        sources?: Record<string, SourceKind>;
        diagnostics?: string[];
      };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      const next = state
        ? {
            ...state,
            global: body.global ?? state.global,
            project: body.project ?? state.project,
            effective: body.effective ?? state.effective,
            sources: body.sources ?? state.sources,
            diagnostics: body.diagnostics ?? state.diagnostics,
          }
        : null;
      if (next) applyState(next);
      setSavedPath(body.saved?.path ?? null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const reloadSession = async () => {
    if (!sessionId) return;
    setReloading(true);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      onReloaded();
      setSessionStatusNonce((current) => current + 1);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setReloading(false);
    }
  };

  const runTest = async (key: TestKey, spec: string) => {
    const model = spec.trim();
    if (!model) return;
    setTesting(key);
    setResults((current) => ({ ...current, [key]: undefined }));
    try {
      const response = await fetch("/api/automode/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, timeoutMs: Number(draft?.classifierTimeoutMs) || undefined }),
      });
      const body = await response.json() as { ok?: boolean; latencyMs?: number; text?: string; error?: string };
      setResults((current) => ({
        ...current,
        [key]: body.ok
          ? { ok: true, text: t("automode.testOk", { ms: body.latencyMs ?? 0, text: body.text ?? "" }) }
          : { ok: false, text: t("automode.testFailed", { error: body.error ?? `HTTP ${response.status}` }) },
      }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [key]: { ok: false, text: t("automode.testFailed", { error: error instanceof Error ? error.message : String(error) }) },
      }));
    } finally {
      setTesting(null);
    }
  };

  const setFallback = (index: number, value: string) => {
    if (!draft) return;
    const next = [...draft.classifierFallbackModels];
    next[index] = value;
    update("classifierFallbackModels", next);
  };

  const moveFallback = (index: number, delta: number) => {
    if (!draft) return;
    const next = [...draft.classifierFallbackModels];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved ?? "");
    update("classifierFallbackModels", next);
  };

  const effective = state?.effective;
  const sourceLabel = (key: string): string => {
    const source = state?.sources[key] ?? "default";
    return t(`automode.source.${source}`);
  };
  const placeholder = (value: string | number | null) => value === null || value === "" ? t("automode.inherited") : String(value);

  return (
    <div className="settings-general">
      <h2 className="settings-general-title">{t("common.autoMode")}</h2>
      <p className="settings-general-description">{t("automode.description")}</p>

      {loadError && <p role="alert" className="settings-general-error">{t("automode.loadFailed", { error: loadError })}</p>}
      {!state && !loadError && <p className="settings-general-description">{t("i18n.loading")}</p>}

      {state && effective && draft && baseline && (
        <>
          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("automode.status")}</h3>
            <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 14px", margin: 0, fontSize: 12 }}>
              <dt style={{ color: "var(--text-muted)" }}>{t("automode.builtinVersion")}</dt>
              <dd style={{ margin: 0 }}>{state.builtin.version} <span style={{ color: "var(--text-dim)" }}>({state.builtin.basedOn})</span></dd>
              <dt style={{ color: "var(--text-muted)" }}>{t("automode.pluginCopy")}</dt>
              <dd style={{ margin: 0 }}>
                {state.plugin.installed
                  ? t("automode.pluginInstalled", { path: state.plugin.path })
                  : t("automode.pluginAbsent")}
              </dd>
              <dt style={{ color: "var(--text-muted)" }}>{t("automode.globalFile")}</dt>
              <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{state.paths.global}</dd>
              <dt style={{ color: "var(--text-muted)" }}>{t("automode.projectFile")}</dt>
              <dd style={{ margin: 0, overflowWrap: "anywhere" }}>
                {cwd ? state.paths.project : t("automode.noProject")}
                {cwd && !state.trusted ? ` · ${t("automode.untrusted")}` : ""}
              </dd>
              <dt style={{ color: "var(--text-muted)" }}>{t("automode.nowInForce")}</dt>
              <dd style={{ margin: 0 }}>
                {effective.enabled ? t("automode.on") : t("automode.off")}
                {" · "}
                {effective.classifierModel ?? t("automode.noModel")}
              </dd>
              {sessionId && (
                <>
                  <dt style={{ color: "var(--text-muted)" }}>{t("automode.session")}</dt>
                  <dd style={{ margin: 0 }}>{sessionLine(sessionStatus, effective.enabled, t)}</dd>
                </>
              )}
            </dl>
            {state.diagnostics.length > 0 && (
              <ul style={{ margin: "10px 0 0", paddingLeft: 18, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6 }}>
                {state.diagnostics.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("automode.scope")}</h3>
            <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
              {(["global", "project"] as const).map((option) => {
                const disabled = option === "project" && (!cwd || !state.trusted);
                return (
                  <label key={option} style={{ display: "flex", alignItems: "center", gap: 6, opacity: disabled ? 0.5 : 1 }}>
                    <input
                      type="radio"
                      name="automode-scope"
                      checked={scope === option}
                      disabled={disabled}
                      onChange={() => setScope(option)}
                    />
                    {option === "global" ? t("automode.scopeGlobal") : t("automode.scopeProject")}
                  </label>
                );
              })}
            </div>
            <p className="settings-general-description">
              {scope === "project"
                ? t("automode.scopeProjectHint", { path: state.paths.project })
                : t("automode.scopeGlobalHint")}
              {" "}
              {t("automode.blankMeansInherited")}
            </p>
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("automode.switch")}</h3>
            <div className="settings-chat-options">
              <div className="settings-chat-option settings-chat-switch-option">
                <span>{t("automode.enabled")}</span>
                <ConfigSwitch
                  checked={draft.enabled}
                  label={t("automode.enabled")}
                  onChange={(next) => update("enabled", next)}
                />
              </div>
            </div>
            <p className="settings-general-description">{t("automode.enabledHint")}</p>
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("automode.models")}</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "grid", gap: 5 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("automode.primaryModel")}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    aria-label={t("automode.primaryModel")}
                    list="automode-model-options"
                    value={draft.classifierModel}
                    placeholder={placeholder(effective.classifierModel)}
                    onChange={(event) => update("classifierModel", event.target.value)}
                    style={inputStyle}
                  />
                  <ConfigButton
                    variant="secondary"
                    size="small"
                    disabled={!draft.classifierModel.trim() || testing !== null}
                    onClick={() => void runTest("primary", draft.classifierModel)}
                  >
                    {testing === "primary" ? t("automode.testing") : t("automode.test")}
                  </ConfigButton>
                </div>
                <ResultLine result={results.primary} />
              </div>

              <div style={{ display: "grid", gap: 5 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("automode.fallbackModels")}</span>
                {draft.classifierFallbackModels.map((spec, index) => (
                  <div key={`fallback-${index}`} style={{ display: "grid", gap: 3 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span style={{ width: 18, color: "var(--text-dim)", fontSize: 11 }}>{index + 1}</span>
                      <input
                        aria-label={t("automode.fallbackModel", { index: index + 1 })}
                        list="automode-model-options"
                        value={spec}
                        onChange={(event) => setFallback(index, event.target.value)}
                        style={inputStyle}
                      />
                      <ConfigButton variant="ghost" size="small" title={t("automode.moveUp")} aria-label={t("automode.moveUp")} disabled={index === 0} onClick={() => moveFallback(index, -1)}>↑</ConfigButton>
                      <ConfigButton variant="ghost" size="small" title={t("automode.moveDown")} aria-label={t("automode.moveDown")} disabled={index === draft.classifierFallbackModels.length - 1} onClick={() => moveFallback(index, 1)}>↓</ConfigButton>
                      <ConfigButton
                        variant="secondary"
                        size="small"
                        disabled={!spec.trim() || testing !== null}
                        onClick={() => void runTest(`fallback-${index}`, spec)}
                      >
                        {testing === `fallback-${index}` ? t("automode.testing") : t("automode.test")}
                      </ConfigButton>
                      <ConfigButton
                        variant="ghost"
                        size="small"
                        title={t("automode.remove")}
                        aria-label={t("automode.remove")}
                        onClick={() => update("classifierFallbackModels", draft.classifierFallbackModels.filter((_, i) => i !== index))}
                      >
                        ✕
                      </ConfigButton>
                    </div>
                    <div style={{ paddingLeft: 24 }}>
                      <ResultLine result={results[`fallback-${index}`]} />
                    </div>
                  </div>
                ))}
                <div>
                  <ConfigButton
                    variant="secondary"
                    size="small"
                    onClick={() => update("classifierFallbackModels", [...draft.classifierFallbackModels, ""])}
                  >
                    {t("automode.addFallback")}
                  </ConfigButton>
                </div>
                <p className="settings-general-description">{t("automode.fallbackHint")}</p>
              </div>
            </div>
            <datalist id="automode-model-options">
              {models.map((spec) => <option key={spec} value={spec} />)}
            </datalist>
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("automode.budget")}</h3>
            <div style={{ display: "grid", gap: 12 }}>
              <label style={{ display: "grid", gap: 5 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("automode.reasoning")}</span>
                <select
                  value={draft.classifierReasoningLevel}
                  onChange={(event) => update("classifierReasoningLevel", event.target.value)}
                  style={{ ...inputStyle, height: 34 }}
                >
                  <option value="">{t("automode.reasoningServer")}</option>
                  {REASONING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </label>

              <NumberField
                label={t("automode.timeout")}
                hint={t("automode.timeoutHint", { value: String(state.defaults.classifierTimeoutMs) })}
                value={draft.classifierTimeoutMs}
                inheritedValue={placeholder(effective.classifierTimeoutMs)}
                inheritedFrom={sourceLabel("classifierTimeoutMs")}
                onChange={(value) => update("classifierTimeoutMs", value)}
              />
              <NumberField
                label={t("automode.maxTokens")}
                hint={t("automode.maxTokensHint", { value: String(state.defaults.fastClassifierMaxTokens) })}
                value={draft.fastClassifierMaxTokens}
                inheritedValue={placeholder(effective.fastClassifierMaxTokens)}
                inheritedFrom={sourceLabel("fastClassifierMaxTokens")}
                onChange={(value) => update("fastClassifierMaxTokens", value)}
              />
              <NumberField
                label={t("automode.transcriptUser")}
                hint={t("automode.transcriptHint", { value: String(state.defaults.maxUserTranscriptTokens) })}
                value={draft.maxUserTranscriptTokens}
                inheritedValue={placeholder(effective.maxUserTranscriptTokens)}
                inheritedFrom={sourceLabel("maxUserTranscriptTokens")}
                onChange={(value) => update("maxUserTranscriptTokens", value)}
              />
              <NumberField
                label={t("automode.transcriptTool")}
                hint={t("automode.transcriptHint", { value: String(state.defaults.maxToolTranscriptTokens) })}
                value={draft.maxToolTranscriptTokens}
                inheritedValue={placeholder(effective.maxToolTranscriptTokens)}
                inheritedFrom={sourceLabel("maxToolTranscriptTokens")}
                onChange={(value) => update("maxToolTranscriptTokens", value)}
              />
            </div>
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("automode.behavior")}</h3>
            <div className="settings-chat-options">
              <div className="settings-chat-option settings-chat-switch-option">
                <span>{t("automode.classifyReadOnly")}</span>
                <ConfigSwitch
                  checked={draft.classifyReadOnlyTools}
                  label={t("automode.classifyReadOnly")}
                  onChange={(next) => update("classifyReadOnlyTools", next)}
                />
              </div>
              <div className="settings-chat-option settings-chat-switch-option">
                <span>{t("automode.allowInside")}</span>
                <ConfigSwitch
                  checked={draft.allowInsideWorkingDirectory}
                  label={t("automode.allowInside")}
                  onChange={(next) => update("allowInsideWorkingDirectory", next)}
                />
              </div>
              <div className="settings-chat-option settings-chat-switch-option">
                <span>{t("automode.logEnabled")}</span>
                <ConfigSwitch
                  checked={draft.logEnabled}
                  label={t("automode.logEnabled")}
                  onChange={(next) => update("logEnabled", next)}
                />
              </div>
              <div className="settings-chat-option settings-chat-switch-option">
                <span>{t("automode.logIo")}</span>
                <ConfigSwitch
                  checked={draft.logClassifierIo}
                  disabled={!draft.logEnabled}
                  label={t("automode.logIo")}
                  onChange={(next) => update("logClassifierIo", next)}
                />
              </div>
            </div>
            <p className="settings-general-description">{t("automode.behaviorHint")}</p>
            <div style={{ display: "grid", gap: 5, marginTop: 12 }}>
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("automode.deniedPaths")}</span>
              <textarea
                aria-label={t("automode.deniedPaths")}
                value={draft.deniedPaths}
                onChange={(event) => update("deniedPaths", event.target.value)}
                rows={4}
                style={{ ...inputStyle, height: "auto", padding: 9, lineHeight: 1.5, fontFamily: "var(--font-mono)", resize: "vertical" }}
              />
              <p className="settings-general-description">{t("automode.deniedPathsHint")}</p>
            </div>
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("automode.effective")}</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
                  <th style={{ padding: "4px 8px 4px 0", fontWeight: 500 }}>{t("automode.effectiveField")}</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>{t("automode.effectiveValue")}</th>
                  <th style={{ padding: "4px 0 4px 8px", fontWeight: 500 }}>{t("automode.effectiveSource")}</th>
                </tr>
              </thead>
              <tbody>
                {([
                  ["enabled", effective.enabled ? t("automode.on") : t("automode.off")],
                  ["classifierModel", effective.classifierModel ?? t("automode.noModel")],
                  ["classifierFallbackModels", effective.classifierFallbackModels.length > 0 ? effective.classifierFallbackModels.join(", ") : t("automode.none")],
                  ["classifierReasoningLevel", effective.classifierReasoningLevel ?? t("automode.reasoningServer")],
                  ["classifierTimeoutMs", `${effective.classifierTimeoutMs} ms`],
                  ["fastClassifierMaxTokens", String(effective.fastClassifierMaxTokens)],
                  ["maxUserTranscriptTokens", String(effective.maxUserTranscriptTokens)],
                  ["maxToolTranscriptTokens", String(effective.maxToolTranscriptTokens)],
                  ["classifyReadOnlyTools", effective.classifyReadOnlyTools ? t("automode.yes") : t("automode.no")],
                  ["allowInsideWorkingDirectory", effective.allowInsideWorkingDirectory ? t("automode.yes") : t("automode.no")],
                  ["log", effective.log.enabled ? (effective.log.classifierIo ? t("automode.logIoOn") : t("automode.on")) : t("automode.off")],
                  ["deniedPaths", effective.deniedPaths.length > 0 ? effective.deniedPaths.join(", ") : t("automode.none")],
                ] as [string, string][]).map(([key, value]) => (
                  <tr key={key} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "5px 8px 5px 0", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{key}</td>
                    <td style={{ padding: "5px 8px", overflowWrap: "anywhere" }}>{value}</td>
                    <td style={{ padding: "5px 0 5px 8px", color: "var(--text-muted)" }}>{sourceLabel(key)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="settings-general-description">
              {t("automode.ruleCounts", {
                environment: effective.ruleCounts.environment ?? 0,
                allow: effective.ruleCounts.allow ?? 0,
                protectedPaths: effective.ruleCounts.protectedPaths ?? 0,
                softDeny: effective.ruleCounts.softDeny ?? 0,
                hardDeny: effective.ruleCounts.hardDeny ?? 0,
                deny: effective.ruleCounts.permissionDeny ?? 0,
                ask: effective.ruleCounts.permissionAsk ?? 0,
              })}
            </p>
          </section>

          <section className="settings-general-section">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <ConfigButton variant="primary" disabled={dirty.length === 0 || saving} onClick={() => void save()}>
                {saving ? t("automode.saving") : t("i18n.save")}
              </ConfigButton>
              <ConfigButton
                variant="secondary"
                disabled={dirty.length === 0 || saving}
                onClick={() => { if (baseline) setDraft(baseline); setSaveError(null); setSavedPath(null); }}
              >
                {t("automode.discard")}
              </ConfigButton>
              <ConfigButton
                variant="secondary"
                disabled={!sessionId || reloading}
                title={sessionId ? t("i18n.reloadSession") : t("automode.noSession")}
                onClick={() => void reloadSession()}
              >
                {reloading ? t("i18n.reloading") : t("i18n.reloadSession")}
              </ConfigButton>
              {dirty.length > 0 && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("automode.unsaved", { count: dirty.length })}</span>}
            </div>
            {saveError && <p role="alert" className="settings-general-error" style={{ whiteSpace: "pre-wrap" }}>{saveError}</p>}
            {savedPath && (
              <p className="settings-general-description">
                {t("automode.saved", { path: savedPath })}
                {" "}
                {t("agents.reloadRequired")}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ResultLine({ result }: { result?: { ok: boolean; text: string } }) {
  if (!result) return null;
  return (
    <p role="status" style={{ margin: 0, fontSize: 11, color: result.ok ? "var(--text-muted)" : "var(--danger, #e88)" }}>
      {result.text}
    </p>
  );
}

function NumberField({ label, hint, value, inheritedValue, inheritedFrom, onChange }: {
  label: string;
  hint: string;
  value: string;
  inheritedValue: string;
  inheritedFrom: string;
  onChange: (value: string) => void;
}) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
        {label}
        <span style={{ color: "var(--text-dim)" }}>{` · ${inheritedFrom}`}</span>
      </span>
      <input
        type="number"
        aria-label={label}
        value={value}
        placeholder={inheritedValue}
        onChange={(event) => onChange(event.target.value)}
        style={inputStyle}
      />
      <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{hint}</span>
    </label>
  );
}
