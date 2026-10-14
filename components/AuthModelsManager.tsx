"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AuthModelProviderCatalog } from "@/lib/auth-model-types";
import { ConfigButton } from "./SettingsUi";
import { authContextValue, isValidAuthContext } from "./auth-model-drafts";

interface Props {
  providerId: string;
  catalog?: AuthModelProviderCatalog;
  selectedIds?: string[];
  overrides?: Record<string, unknown>;
  contextDrafts?: Record<string, string>;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onRetry: () => void;
  onSelectionChange: (ids: string[]) => void;
  onContextChange: (id: string, value: string) => void;
}

export function AuthModelsManager({
  providerId, catalog, selectedIds, overrides, contextDrafts, loading, error, busy,
  onRetry, onSelectionChange, onContextChange,
}: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const selected = new Set(selectedIds ?? catalog?.selectedIds ?? []);
  const models = catalog?.models ?? [];
  const term = query.trim().toLocaleLowerCase();
  const shown = models.filter(model => !term || `${model.id} ${model.name}`.toLocaleLowerCase().includes(term));
  const selectedCount = models.filter(model => selected.has(model.id)).length;
  const toggle = (id: string) => onSelectionChange(selected.has(id)
    ? [...selected].filter(value => value !== id) : [...selected, id]);
  const selectShown = (enabled: boolean) => {
    const next = new Set(selected);
    for (const model of shown) {
      if (enabled) next.add(model.id); else next.delete(model.id);
    }
    onSelectionChange([...next]);
  };

  return (
    <section className="auth-model-manager" aria-labelledby={`auth-model-title-${providerId}`}>
      <div className="auth-model-heading">
        <div>
          <h3 id={`auth-model-title-${providerId}`}>{t("authModels.title")}</h3>
          <p>{t("authModels.description")}</p>
        </div>
        {catalog && <span className="auth-model-count">{t("authModels.count", { selected: selectedCount, total: models.length })}</span>}
      </div>
      {loading && <p className="auth-model-message" role="status">{t("authModels.loading")}</p>}
      {!loading && error && (
        <div className="auth-model-error" role="alert">
          <span>{t("authModels.loadFailed")}</span>
          <ConfigButton size="small" onClick={onRetry} disabled={busy}>{t("authModels.retry")}</ConfigButton>
        </div>
      )}
      {!loading && !error && models.length === 0 && <p className="auth-model-message">{t("authModels.empty")}</p>}
      {!loading && !error && models.length > 0 && (
        <>
          <div className="auth-model-toolbar">
            <div className="auth-model-search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
              <input type="search" value={query} onChange={event => setQuery(event.target.value)}
                aria-label={t("authModels.search")} placeholder={t("authModels.search")} />
            </div>
            <div className="auth-model-bulk">
              <ConfigButton size="small" variant="ghost" disabled={busy || shown.length === 0 || shown.every(model => selected.has(model.id))}
                onClick={() => selectShown(true)}>{t(term ? "authModels.selectResults" : "authModels.selectAll")}</ConfigButton>
              <ConfigButton size="small" variant="ghost" disabled={busy || !shown.some(model => selected.has(model.id))}
                onClick={() => selectShown(false)}>{t(term ? "authModels.clearResults" : "authModels.clearAll")}</ConfigButton>
            </div>
          </div>
          <div className="auth-model-table">
            <div className="auth-model-table-head" aria-hidden="true">
              <span>{t("authModels.whitelist")}</span>
              <span>{t("authModels.context")}</span>
              <span />
            </div>
            {shown.length === 0 && <p className="auth-model-message">{t("authModels.noResults")}</p>}
            {shown.map(model => {
              const value = contextDrafts?.[model.id] ?? authContextValue(overrides, model.id);
              const valid = isValidAuthContext(value);
              const inputId = `auth-context-${providerId}-${model.id}`;
              return (
                <div className="auth-model-row" key={model.id} data-enabled={selected.has(model.id)}>
                  <label className="auth-model-choice">
                    <input type="checkbox" checked={selected.has(model.id)} disabled={busy}
                      onChange={() => toggle(model.id)} aria-label={t("authModels.include", { model: model.name || model.id })} />
                    <span className="auth-model-name">
                      <strong>{model.name || model.id}</strong>
                      {model.name !== model.id && <code>{model.id}</code>}
                    </span>
                  </label>
                  <div className="auth-model-context">
                    <span className="auth-model-mobile-label">{t("authModels.context")}</span>
                    <input id={inputId} type="text" inputMode="numeric" value={value} disabled={busy}
                      aria-label={t("authModels.contextFor", { model: model.name || model.id })}
                      aria-invalid={!valid} aria-describedby={!valid ? inputId + "-error" : undefined}
                      placeholder={t("authModels.followDefault")}
                      onChange={event => onContextChange(model.id, event.target.value)} />
                    {!valid ? <span className="auth-model-field-error" id={inputId + "-error"}>{t("authModels.invalidContext")}</span>
                      : <span className="auth-model-current">{t("authModels.current", { value: model.contextWindow.toLocaleString() })}</span>}
                  </div>
                  <ConfigButton size="small" variant="ghost" className="auth-model-reset" disabled={busy || value === ""}
                    onClick={() => onContextChange(model.id, "")} aria-label={t("authModels.resetFor", { model: model.name || model.id })}>
                    {t("authModels.reset")}
                  </ConfigButton>
                </div>
              );
            })}
          </div>
          {selectedCount === 0 && <p className="auth-model-warning" role="status">{t("authModels.noneSelected")}</p>}
          <div className="auth-model-notes">
            <p>{t("authModels.contextHelp")}</p>
            <details><summary>{t("authModels.scopeTitle")}</summary><p>{t("authModels.scopeHelp")}</p></details>
          </div>
        </>
      )}
    </section>
  );
}
