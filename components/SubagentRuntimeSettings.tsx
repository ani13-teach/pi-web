"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  DEFAULT_SUBAGENT_RUNTIME_SETTINGS,
  RUNTIME_SETTING_FIELDS,
  type RuntimeSettingsScope,
  type SubagentRuntimeSettings as RuntimeSettings,
  type SubagentRuntimeSettingsResponse,
} from "@/lib/subagent-runtime-schema";
import { ConfigButton, ConfigDetailStack, ConfigDetailTitle, ConfigField, ConfigFooter } from "./SettingsUi";

type RuntimeKey = keyof RuntimeSettings;
export type RuntimeDraft = Partial<Record<RuntimeKey, string | null>>;
export type RuntimePatch = { [K in RuntimeKey]?: RuntimeSettings[K] | null };
type ValidationError = "number" | "text" | "select" | "boolean";
type RuntimeSource = "global" | "project" | "legacy" | "default";

/** Drafts contain only edits, never a copy of the effective defaults. */
export function updateRuntimeDraft(draft: RuntimeDraft, data: SubagentRuntimeSettingsResponse, key: RuntimeKey, input: string | null): RuntimeDraft {
  const next = { ...draft };
  const value = input === "" ? null : input;
  const local = data.values[key];
  if ((value === null && local === undefined) || (value !== null && local !== undefined && value === String(local))) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

export function buildRuntimePatch(data: SubagentRuntimeSettingsResponse, draft: RuntimeDraft): {
  patch: RuntimePatch;
  errors: Partial<Record<RuntimeKey, ValidationError>>;
} {
  const patch: RuntimePatch = {};
  const errors: Partial<Record<RuntimeKey, ValidationError>> = {};
  for (const field of RUNTIME_SETTING_FIELDS) {
    const raw = draft[field.key];
    if (raw === undefined) continue;
    if (raw === null || raw === "") {
      if (data.values[field.key] !== undefined) patch[field.key] = null;
      continue;
    }
    let value: string | number | boolean = raw;
    if (field.type === "number") {
      value = Number(raw);
      if (!/^[+-]?\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
        errors[field.key] = "number";
        continue;
      }
    } else if (field.type === "boolean") {
      if (raw !== "true" && raw !== "false") {
        errors[field.key] = "boolean";
        continue;
      }
      value = raw === "true";
    } else if (field.type === "select") {
      if (!field.options?.includes(raw)) {
        errors[field.key] = "select";
        continue;
      }
    } else {
      value = raw.trim();
      if (!value) {
        errors[field.key] = "text";
        continue;
      }
    }
    if (value !== data.values[field.key]) Object.assign(patch, { [field.key]: value });
  }
  return { patch, errors };
}

/** Recompute inheritance after a local deletion instead of showing the old effective value. */
export function runtimeInheritedValue(data: SubagentRuntimeSettingsResponse, key: RuntimeKey): { value: RuntimeSettings[RuntimeKey]; source: RuntimeSource } {
  if (data.scope === "project" && data.global[key] !== undefined) return { value: data.global[key], source: "global" };
  if (key === "maxConcurrent" && data.legacyMaxConcurrent !== undefined) return { value: data.legacyMaxConcurrent, source: "legacy" };
  return { value: DEFAULT_SUBAGENT_RUNTIME_SETTINGS[key], source: "default" };
}

export function runtimeFieldState(data: SubagentRuntimeSettingsResponse, draft: RuntimeDraft, key: RuntimeKey) {
  const local = draft[key] !== undefined ? draft[key] : data.values[key] === undefined ? null : String(data.values[key]);
  const inherited = runtimeInheritedValue(data, key);
  const source: RuntimeSource = local === null ? inherited.source : data.scope;
  const value = local === null ? inherited.value : local;
  const automatic = key === "workflowsEnabled" && local === null && inherited.source === "default";
  return { local, source, value, automatic };
}

/** These request helpers are shared by the component and its executable tests. */
export async function readRuntimeSettings(cwd: string, scope: RuntimeSettingsScope, signal: AbortSignal): Promise<SubagentRuntimeSettingsResponse> {
  const response = await fetch(`/api/subagents/runtime-settings?cwd=${encodeURIComponent(cwd)}&scope=${scope}`, { signal });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  if (data.scope !== scope) throw new Error("Unexpected runtime settings scope");
  return data as SubagentRuntimeSettingsResponse;
}

export async function saveRuntimeSettings(cwd: string, scope: RuntimeSettingsScope, data: SubagentRuntimeSettingsResponse, draft: RuntimeDraft): Promise<SubagentRuntimeSettingsResponse> {
  const { patch, errors } = buildRuntimePatch(data, draft);
  if (Object.keys(errors).length) throw new Error("Invalid runtime settings");
  if (!Object.keys(patch).length) return data;
  const response = await fetch("/api/subagents/runtime-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, scope, patch }),
  });
  const saved = await response.json();
  if (!response.ok || saved.error) throw new Error(saved.error ?? `HTTP ${response.status}`);
  if (saved.scope !== scope) throw new Error("Unexpected runtime settings scope");
  return saved as SubagentRuntimeSettingsResponse;
}

const inputStyle: CSSProperties = {
  width: "100%", minWidth: 0, height: 34, padding: "0 9px",
  border: "1px solid var(--border)", borderRadius: 5,
  background: "var(--bg)", color: "var(--text)", fontSize: 12,
};
const hintStyle: CSSProperties = { color: "var(--text-dim)", fontSize: 11, margin: 0, overflowWrap: "anywhere" };

export function SubagentRuntimeSettings({ cwd, onSaved }: { cwd: string; onSaved: () => void }) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [scope, setScope] = useState<RuntimeSettingsScope>("global");
  const [data, setData] = useState<SubagentRuntimeSettingsResponse | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuntimeDraft>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [retry, setRetry] = useState(0);
  const selectionKey = JSON.stringify([cwd, scope]);
  const selectionRef = useRef(selectionKey);
  selectionRef.current = selectionKey;
  const generation = useRef(0);
  const savingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const request = ++generation.current;
    const current = () => !controller.signal.aborted && generation.current === request && selectionRef.current === selectionKey;
    setLoading(true);
    setData(null);
    setLoadedKey(null);
    setDraft({});
    setLoadError(null);
    setSaveError(null);
    setSavedOk(false);
    setSaving(false);
    savingRef.current = false;
    void readRuntimeSettings(cwd, scope, controller.signal).then((next) => {
      if (!current()) return;
      setData(next);
      setLoadedKey(selectionKey);
    }).catch((cause: unknown) => {
      if (current()) setLoadError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => {
      controller.abort();
      if (generation.current === request) generation.current++;
    };
  }, [cwd, scope, selectionKey, retry]);

  const ready = !loading && !loadError && data !== null && loadedKey === selectionKey;
  const disabled = !ready || saving;
  const validation: ReturnType<typeof buildRuntimePatch> = data ? buildRuntimePatch(data, draft) : { patch: {}, errors: {} };
  const invalid = Object.keys(validation.errors).length > 0;
  const dirty = Object.keys(validation.patch).length > 0;

  const update = (key: RuntimeKey, value: string | null) => {
    if (disabled || savingRef.current || !data) return;
    setDraft((previous) => updateRuntimeDraft(previous, data, key, value));
    setSaveError(null);
    setSavedOk(false);
  };

  const save = async () => {
    if (!ready || savingRef.current || !data || invalid || !dirty) return;
    const request = generation.current;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    const current = () => generation.current === request && selectionRef.current === selectionKey;
    try {
      const saved = await saveRuntimeSettings(cwd, scope, data, draft);
      if (!current()) return;
      setData(saved);
      setDraft({});
      setSavedOk(true);
      onSaved();
    } catch (cause) {
      if (current()) setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current()) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  const displayValue = (value: string | number | boolean) => {
    if (value === true || value === "true") return t("agents.runtime.enabled");
    if (value === false || value === "false") return t("agents.runtime.disabled");
    return String(value);
  };

  return (
    <ConfigDetailStack className="is-fill" aria-busy={loading || saving}>
      <ConfigDetailTitle>{t("agents.runtime.title")}</ConfigDetailTitle>
      <p style={hintStyle}>{t("agents.runtime.description")}</p>
      <ConfigField label={t("agents.runtime.scope")}>
        <select aria-label={t("agents.runtime.scope")} value={scope} disabled={saving} style={{ ...inputStyle, maxWidth: 320 }} onChange={(event) => {
          if (savingRef.current) return;
          setDraft({});
          setScope(event.target.value as RuntimeSettingsScope);
        }}>
          <option value="global">{t("agents.runtime.scope.global")}</option>
          <option value="project">{t("agents.runtime.scope.project")}</option>
        </select>
      </ConfigField>
      <p style={hintStyle}>{t("agents.runtime.precedence")}</p>
      {ready && data && <p style={hintStyle}>{t("agents.runtime.filePath")} <code style={{ userSelect: "text" }}>{data.filePath}</code></p>}
      {(loading || loadedKey !== selectionKey) && !loadError && <p role="status">{t("agents.runtime.loading")}</p>}
      {loadError && <div role="alert" style={{ color: "var(--danger, #d55)" }}>
        <p>{t("agents.runtime.readFailed", { error: loadError })}</p>
        <ConfigButton onClick={() => setRetry((previous) => previous + 1)}>{t("agents.runtime.retry")}</ConfigButton>
      </div>}
      {ready && data && <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 20, alignItems: "start" }}>
        {RUNTIME_SETTING_FIELDS.map((field) => {
          const state = runtimeFieldState(data, draft, field.key);
          const label = t(`agents.runtime.field.${field.key}`);
          const id = `subagent-runtime-${scope}-${field.key}`;
          const error = validation.errors[field.key];
          const controlStyle = { ...inputStyle, ...(disabled ? { background: "var(--bg-panel)", color: "var(--text-dim)" } : {}) };
          return <ConfigField key={field.key} label={<label htmlFor={id}>{label}</label>}>
            {field.type === "boolean" || field.type === "select" ? (
              <select id={id} aria-label={label} aria-describedby={`${id}-hint ${id}-source`} value={state.local ?? ""} disabled={disabled} style={controlStyle} onChange={(event) => update(field.key, event.target.value)}>
                <option value="">{t("agents.runtime.inherit")}</option>
                {field.type === "boolean" ? <>
                  <option value="true">{t("agents.runtime.enabled")}</option>
                  <option value="false">{t("agents.runtime.disabled")}</option>
                </> : field.options?.map((option) => <option key={option} value={option}>{t(`agents.runtime.option.${option}`)}</option>)}
              </select>
            ) : (
              <input id={id} aria-label={label} aria-describedby={`${id}-hint ${id}-source${error ? ` ${id}-error` : ""}`} aria-invalid={Boolean(error)} type="text" inputMode={field.type === "number" ? "numeric" : undefined} value={state.local ?? ""} placeholder={displayValue(runtimeInheritedValue(data, field.key).value)} disabled={disabled} style={controlStyle} onChange={(event) => update(field.key, event.target.value)} />
            )}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 }}>
              <span id={`${id}-source`} style={hintStyle}>{t("agents.runtime.source", { source: t(`agents.runtime.source.${state.source}`) })} · {state.automatic ? t("agents.runtime.automatic") : t("agents.runtime.value", { value: displayValue(state.value) })}</span>
              <ConfigButton size="small" variant="ghost" disabled={disabled || state.local === null} aria-label={t("agents.runtime.inheritField", { field: label })} onClick={() => update(field.key, null)}>{t("agents.runtime.restoreInheritance")}</ConfigButton>
            </div>
            <p id={`${id}-hint`} style={{ ...hintStyle, marginTop: 5 }}>{t(`agents.runtime.hint.${field.key}`)}</p>
            {scope === "global" && data.project[field.key] !== undefined && <p style={{ ...hintStyle, marginTop: 5 }}>{t("agents.runtime.projectOverride", { value: displayValue(data.effective[field.key]) })}</p>}
            {error && <p id={`${id}-error`} role="alert" style={{ ...hintStyle, color: "var(--danger, #d55)", marginTop: 5 }}>{t(`agents.runtime.validation.${error}`, { min: field.min ?? "", max: field.max ?? "" })}</p>}
          </ConfigField>;
        })}
      </div>}
      <div style={{ marginTop: "auto" }}>
        {saveError && <p role="alert" style={{ color: "var(--danger, #d55)" }}>{t("agents.runtime.saveFailed", { error: saveError })}</p>}
        <ConfigFooter status={<span role="status" style={{ whiteSpace: "normal" }}>{t(savedOk ? "agents.runtime.saved" : "agents.runtime.reloadHint")}</span>}>
          <ConfigButton variant="primary" disabled={disabled || invalid || !dirty} onClick={() => void save()}>{t(saving ? "agents.runtime.saving" : "agents.runtime.save")}</ConfigButton>
        </ConfigFooter>
      </div>
    </ConfigDetailStack>
  );
}
