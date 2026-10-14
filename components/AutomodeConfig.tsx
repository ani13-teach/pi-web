"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import { formatModelSpecLabel } from "@/lib/model-label";
import {
  buildPatch,
  changedKeys,
  draftFrom,
  numberErrors,
  REASONING_LEVELS,
  type Draft,
  type EffectiveValues,
} from "./automode-draft";
import {
  collectModelOptions,
  modelSpecOf,
  splitModelSpec,
  type ModelOption,
} from "./automode-model-options";
import { ModelSelector } from "./ModelSelector";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

/**
 * The auto-mode settings page.
 *
 * Empty fields inherit their value; only edited fields are saved.
 * Runtime diagnostics stay out of the settings form.
 */

interface AutomodeResponse {
  trusted: boolean;
  global: { values: Record<string, unknown>; error: string | null };
  project: { values: Record<string, unknown>; error: string | null };
  effective: EffectiveValues;
  defaults: Record<string, number | boolean | object>;
  diagnostics: string[];
}

type Scope = "global" | "project";
type TestKey = "primary" | `fallback-${number}`;

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
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testing, setTesting] = useState<TestKey | null>(null);
  const [results, setResults] = useState<Partial<Record<TestKey, { ok: boolean; text: string }>>>({});

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
    setModelsLoading(true);
    void (async () => {
      // `models.json` holds the custom gateways, `/api/models` is where built-in
      // providers (openai-codex and friends) come from. Either one failing still
      // leaves a usable picker.
      const [modelsConfig, registry] = await Promise.all([
        getJson("/api/models-config"),
        getJson(`/api/models?cwd=${encodeURIComponent(cwd ?? "")}`),
      ]);
      if (cancelled) return;
      setModelOptions(collectModelOptions(modelsConfig, registry));
      setModelsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [cwd]);

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
    setSaved(false);
  };

  const dirty = draft && baseline ? changedKeys(draft, baseline) : [];

  const save = async () => {
    if (!draft || !baseline || dirty.length === 0) return;
    const errors = numberErrors(draft, t);
    if (errors.length > 0) {
      setAdvancedOpen(true);
      setSaveError(errors.join("；"));
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/automode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, patch: buildPatch(draft, baseline) }),
      });
      const body = await response.json() as {
        error?: string;
        global?: AutomodeResponse["global"];
        project?: AutomodeResponse["project"];
        effective?: EffectiveValues;
        diagnostics?: string[];
      };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      const next = state
        ? {
            ...state,
            global: body.global ?? state.global,
            project: body.project ?? state.project,
            effective: body.effective ?? state.effective,
            diagnostics: body.diagnostics ?? state.diagnostics,
          }
        : null;
      if (next) setState(next);
      setSaved(true);
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
  const placeholder = (value: string | number | null) => value === null || value === "" ? t("automode.inherited") : String(value);

  return (
    <div className="settings-general automode-settings">
      <div className="automode-content">
        <div className="automode-form">
          <header className="automode-header">
            <div>
              <h2 className="settings-general-title">{t("common.autoMode")}</h2>
              <p className="settings-general-description">{t("automode.description")}</p>
            </div>
            {state && (
              <label className="automode-scope">
                <span>{t("automode.scope")}</span>
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as Scope)}
                  className="automode-input"
                >
                  <option value="global">{t("automode.scopeGlobal")}</option>
                  <option value="project" disabled={!cwd || !state.trusted}>
                    {t("automode.scopeProject")}
                  </option>
                </select>
              </label>
            )}
          </header>

          {loadError && <p role="alert" className="settings-general-error">{t("automode.loadFailed", { error: loadError })}</p>}
          {!state && !loadError && <p className="settings-general-description">{t("i18n.loading")}</p>}

          {state && effective && draft && baseline && (
            <>
              {cwd && !state.trusted && <p className="settings-general-description">{t("automode.untrusted")}</p>}
              {state.diagnostics.length > 0 && (
                <ul className="settings-general-error">
                  {state.diagnostics.map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}

              <section className="automode-enabled">
                <div>
                  <h3 className="settings-general-heading">{t("automode.enabled")}</h3>
                  <p className="settings-general-description">{t("automode.enabledHint")}</p>
                </div>
                <ConfigSwitch
                  checked={draft.enabled}
                  label={t("automode.enabled")}
                  onChange={(next) => update("enabled", next)}
                />
              </section>

              <section className="settings-general-section">
                <h3 className="settings-general-heading">{t("automode.models")}</h3>
                <div className="automode-models">
                  <div className="automode-field">
                    <span className="automode-label">{t("automode.primaryModel")}</span>
                    <div className="automode-primary-row">
                      <ModelSpecField
                        label={t("automode.primaryModel")}
                        value={draft.classifierModel}
                        options={modelOptions}
                        loading={modelsLoading}
                        emptyLabel={t("automode.inherited")}
                        onChange={(spec) => update("classifierModel", spec)}
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
                    {!draft.classifierModel.trim() && effective.classifierModel && (
                      <p className="settings-general-description">
                        {t("automode.inheritedModel", { model: formatModelSpecLabel(effective.classifierModel) })}
                      </p>
                    )}
                    <ResultLine result={results.primary} />
                  </div>

                  <div className="automode-field">
                    <div className="automode-fallback-header">
                      <span className="automode-label">{t("automode.fallbackModels")}</span>
                      <ConfigButton
                        variant="ghost"
                        size="small"
                        onClick={() => update("classifierFallbackModels", [...draft.classifierFallbackModels, ""])}
                      >
                        <span aria-hidden="true">＋</span>{t("automode.addFallback")}
                      </ConfigButton>
                    </div>
                    {draft.classifierFallbackModels.map((spec, index) => (
                      <div key={`fallback-${index}`} className="automode-fallback">
                        <div className="automode-fallback-row">
                          <span className="automode-order">{index + 1}</span>
                          <ModelSpecField
                            label={t("automode.fallbackModel", { index: index + 1 })}
                            value={spec}
                            options={modelOptions}
                            loading={modelsLoading}
                            emptyLabel={t("automode.emptyFallback")}
                            onChange={(next) => setFallback(index, next)}
                          />
                          <div className="automode-row-actions">
                            <ConfigButton className="automode-icon-button" variant="ghost" size="small" title={t("automode.moveUp")} aria-label={t("automode.moveUp")} disabled={index === 0} onClick={() => moveFallback(index, -1)}>↑</ConfigButton>
                            <ConfigButton className="automode-icon-button" variant="ghost" size="small" title={t("automode.moveDown")} aria-label={t("automode.moveDown")} disabled={index === draft.classifierFallbackModels.length - 1} onClick={() => moveFallback(index, 1)}>↓</ConfigButton>
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
                              className="automode-icon-button"
                              title={t("automode.remove")}
                              aria-label={t("automode.remove")}
                              onClick={() => update("classifierFallbackModels", draft.classifierFallbackModels.filter((_, i) => i !== index))}
                            >
                              ✕
                            </ConfigButton>
                          </div>
                        </div>
                        <div className="automode-fallback-result">
                          <ResultLine result={results[`fallback-${index}`]} />
                        </div>
                      </div>
                    ))}
                    <details className="automode-help">
                      <summary>{t("automode.fallbackRules")}</summary>
                      <p className="settings-general-description">{t("automode.fallbackHint")}</p>
                    </details>
                  </div>
                </div>
              </section>

              <details className="automode-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
                <summary>{t("automode.advanced")}</summary>
                <section className="settings-general-section">
                  <h3 className="settings-general-heading">{t("automode.budget")}</h3>
                  <div className="automode-budget-grid">
                    <label className="automode-field">
                      <span className="automode-label">{t("automode.reasoning")}</span>
                      <select
                        value={draft.classifierReasoningLevel}
                        onChange={(event) => update("classifierReasoningLevel", event.target.value)}
                        className="automode-input"
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
                      onChange={(value) => update("classifierTimeoutMs", value)}
                    />
                    <NumberField
                      label={t("automode.maxTokens")}
                      hint={t("automode.maxTokensHint", { value: String(state.defaults.fastClassifierMaxTokens) })}
                      value={draft.fastClassifierMaxTokens}
                      inheritedValue={placeholder(effective.fastClassifierMaxTokens)}
                      onChange={(value) => update("fastClassifierMaxTokens", value)}
                    />
                    <NumberField
                      label={t("automode.transcriptUser")}
                      hint={t("automode.transcriptHint", { value: String(state.defaults.maxUserTranscriptTokens) })}
                      value={draft.maxUserTranscriptTokens}
                      inheritedValue={placeholder(effective.maxUserTranscriptTokens)}
                      onChange={(value) => update("maxUserTranscriptTokens", value)}
                    />
                    <NumberField
                      label={t("automode.transcriptTool")}
                      hint={t("automode.transcriptHint", { value: String(state.defaults.maxToolTranscriptTokens) })}
                      value={draft.maxToolTranscriptTokens}
                      inheritedValue={placeholder(effective.maxToolTranscriptTokens)}
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
                  <div className="automode-field automode-paths">
                    <span className="automode-label">{t("automode.deniedPaths")}</span>
                    <textarea
                      aria-label={t("automode.deniedPaths")}
                      value={draft.deniedPaths}
                      onChange={(event) => update("deniedPaths", event.target.value)}
                      rows={4}
                      className="automode-input automode-textarea"
                    />
                    <p className="settings-general-description">{t("automode.deniedPathsHint")}</p>
                  </div>
                </section>

              </details>
            </>
          )}
        </div>
      </div>

      {state && effective && draft && baseline && (
        <footer className="automode-footer">
          <div className="automode-footer-inner">
            <div className="automode-footer-actions">
              <ConfigButton variant="primary" disabled={dirty.length === 0 || saving} onClick={() => void save()}>
                {saving ? t("automode.saving") : t("i18n.save")}
              </ConfigButton>
              <ConfigButton
                variant="secondary"
                disabled={dirty.length === 0 || saving}
                onClick={() => { if (baseline) setDraft(baseline); setSaveError(null); setSaved(false); }}
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
            {saved && (
              <p className="settings-general-description">
                {t("automode.saved")}
                {" "}
                {t("agents.reloadRequired")}
              </p>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}

/**
 * One model field: a picker over everything the classifier can resolve, with a
 * plain text input as the fallback for the case where neither model source
 * answered. A spec that is no longer offered (a model deleted from
 * `models.json`) still shows as the current value — otherwise an untouched
 * setting would read as "nothing chosen".
 */
function ModelSpecField({ label, value, options, loading, emptyLabel, onChange }: {
  label: string;
  value: string;
  options: ModelOption[];
  loading: boolean;
  emptyLabel: string;
  onChange: (spec: string) => void;
}) {
  const { t } = useI18n();
  const current = value.trim();
  const selectedLabel = !loading && current && !options.some(
    (option) => modelSpecOf(option.provider, option.modelId) === current,
  )
    ? t("automode.modelUnavailable", { model: formatModelSpecLabel(current) })
    : undefined;

  if (!loading && options.length === 0) {
    return (
      <input
        aria-label={label}
        value={value}
        placeholder={emptyLabel}
        onChange={(event) => onChange(event.target.value)}
        className="automode-input"
      />
    );
  }

  return (
    <ModelSelector
      options={options}
      value={splitModelSpec(value)}
      onChange={(provider, modelId) => onChange(modelSpecOf(provider, modelId))}
      onClear={() => onChange("")}
      emptyLabel={loading ? t("i18n.loading") : emptyLabel}
      selectedLabel={selectedLabel}
      disabled={loading}
      ariaLabel={label}
      titleText={t("automode.pickModel")}
      variant="field"
      placement="auto"
    />
  );
}

/** A failed lookup is not an error here: the picker falls back to a text field. */
async function getJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function ResultLine({ result }: { result?: { ok: boolean; text: string } }) {
  if (!result) return null;
  return (
    <p role="status" className={`automode-result${result.ok ? "" : " is-error"}`}>
      {result.text}
    </p>
  );
}

function NumberField({ label, hint, value, inheritedValue, onChange }: {
  label: string;
  hint: string;
  value: string;
  inheritedValue: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="automode-field">
      <span className="automode-label">
        {label}
      </span>
      <input
        type="number"
        aria-label={label}
        value={value}
        placeholder={inheritedValue}
        onChange={(event) => onChange(event.target.value)}
        className="automode-input"
      />
      <span className="automode-hint">{hint}</span>
    </label>
  );
}
