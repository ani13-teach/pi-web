"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { readBackupUiState } from "@/shared/backup-preferences";
import type { BackupDecision, BackupProgress, BackupRestorePreview, BackupRestoreResource } from "@/shared/backup";
import type { DesktopBridge } from "@/shared/contract";
import { ConfigButton } from "./SettingsUi";

type Scan = Awaited<ReturnType<DesktopBridge["backupScan"]>>;
type Project = Awaited<ReturnType<DesktopBridge["backupSelectProjects"]>>["projects"][number];
type Inspection = { token: string; name: string; preview?: BackupRestorePreview; legacy?: boolean };
type Operation = { id: string; cancelled: boolean; committed?: boolean };
type Busy = "projects" | "scan" | "export" | "select" | "unlock" | "mapping" | "restore";

const passwordStyle = {
  width: "100%", maxWidth: 420, minWidth: 0, height: 34, padding: "0 9px",
  border: "1px solid var(--border)", borderRadius: 5,
  background: "var(--bg)", color: "var(--text)", fontSize: 12,
};

function validPassword(password: string) {
  return password.length >= 8 && password.length <= 1024;
}

function defaultDecision(resource: BackupRestoreResource): BackupDecision {
  // Unknown kinds and anything executable/security-related must be explicitly enabled.
  const knownData = ["session", "sessions", "auth", "models", "settings", "ui", "themes", "memory"];
  return {
    resourceId: resource.id, conflict: "keep",
    activation: !resource.executable && !resource.securityPolicy && resource.mapped && !resource.blocked
      && resource.availability === "offlineReady" && knownData.includes(resource.kind) ? "enable" : "defer",
  };
}

function restoreBlocked(preview: BackupRestorePreview, decisions: Record<string, BackupDecision>) {
  return preview.resources.some((resource) => {
    const decision = decisions[resource.id] ?? defaultDecision(resource);
    return decision.activation !== "defer" && (resource.blocked || !resource.mapped);
  });
}

export function BackupSettings() {
  const { t } = useI18n();
  const bridge: DesktopBridge | undefined = typeof window === "undefined" ? undefined : window.piDesktop;
  const available = Boolean(bridge);
  const [exportPassword, setExportPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [scan, setScan] = useState<Scan | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [decisions, setDecisions] = useState<Record<string, BackupDecision>>({});
  const [configurationConsent, setConfigurationConsent] = useState(false);
  const [acknowledgeWarnings, setAcknowledgeWarnings] = useState(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<{ label: string; warnings: string[]; restored: boolean } | null>(null);
  const mounted = useRef(false);
  const ownedTokens = useRef(new Set<string>());
  const ownedOperation = useRef<Operation | null>(null);

  const clearPasswords = () => { setExportPassword(""); setConfirmPassword(""); setImportPassword(""); };

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = available ? bridge!.onBackupProgress((update) => {
      if (mounted.current && ownedOperation.current?.id === update.operationId && !ownedOperation.current.cancelled)
        setProgress(update);
    }) : undefined;
    return () => {
      mounted.current = false;
      unsubscribe?.();
      clearPasswords();
      // StrictMode's initial cleanup has no owned operation/tokens. Never cancel globally.
      const operation = ownedOperation.current;
      ownedOperation.current = null;
      if (operation) {
        operation.cancelled = true;
        void bridge?.backupCancel({ operationId: operation.id }).catch(() => {});
      }
      const tokens = [...ownedTokens.current];
      ownedTokens.current.clear();
      for (const token of tokens) void bridge?.backupCancel({ token }).catch(() => {});
    };
  }, [bridge, available]);

  const releaseToken = async (token: string) => {
    ownedTokens.current.delete(token);
    await bridge!.backupCancel({ token });
  };
  const adoptToken = async (token: string, operation: Operation) => {
    if (!isCurrent(operation)) { await bridge!.backupCancel({ token }); return false; }
    ownedTokens.current.add(token);
    return true;
  };
  const begin = (kind: Busy): Operation | null => {
    if (!available || !mounted.current || ownedOperation.current) return null;
    const operation = { id: globalThis.crypto.randomUUID(), cancelled: false };
    ownedOperation.current = operation;
    setBusy(kind); setError(""); setNotice(""); setResult(null); setProgress(null);
    return operation;
  };
  const isCurrent = (operation: Operation) => mounted.current && ownedOperation.current === operation && !operation.cancelled;
  const finish = (operation: Operation) => {
    if (ownedOperation.current !== operation) return;
    ownedOperation.current = null;
    if (mounted.current) { setBusy(null); setProgress(null); }
  };
  const fail = (operation: Operation, key: string, cause: unknown) => {
    if (!mounted.current || ownedOperation.current !== operation || operation.cancelled && !(cause instanceof Error && /Recovery required/i.test(cause.message))) return;
    // Include actionable bridge feedback, but never echo a password in an IPC error.
    let detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    for (const secret of [exportPassword, confirmPassword, importPassword])
      if (secret) detail = detail.split(secret).join("[redacted]");
    setError(`${t(key)}${detail ? ` ${detail.slice(0, 800)}` : ""}`);
  };
  const discardScan = async () => {
    if (scan) { setScan(null); await releaseToken(scan.token); }
    setAcknowledgeWarnings(false);
  };
  const applyPreview = (preview: BackupRestorePreview, preserve = false) => {
    setDecisions((previous) => Object.fromEntries(preview.resources.map((resource) => [resource.id,
      preserve && previous[resource.id] ? previous[resource.id] : defaultDecision(resource)])));
  };

  const selectProjects = async () => {
    const operation = begin("projects"); if (!operation) return;
    try {
      const response = await bridge!.backupSelectProjects();
      if (response.cancelled) { if (isCurrent(operation)) setNotice(t("backup.cancelled")); return; }
      // A native picker can resolve after navigation/cancellation: release its new tokens too.
      const accepted: Project[] = [];
      for (const project of response.projects) if (await adoptToken(project.token, operation)) accepted.push(project);
      if (!isCurrent(operation)) return;
      await discardScan();
      for (const project of projects) await releaseToken(project.token);
      if (isCurrent(operation)) setProjects(accepted);
    } catch (cause) { fail(operation, "backup.projectsFailed", cause); }
    finally { finish(operation); }
  };
  const removeProject = async (project: Project) => {
    const operation = begin("projects"); if (!operation) return;
    try {
      await discardScan(); await releaseToken(project.token);
      if (isCurrent(operation)) setProjects((current) => current.filter((item) => item.token !== project.token));
    } catch (cause) { fail(operation, "backup.projectsFailed", cause); }
    finally { finish(operation); }
  };
  const scanBackup = async () => {
    const operation = begin("scan"); if (!operation) return;
    try {
      await discardScan();
      if (!isCurrent(operation)) return;
      const response = await bridge!.backupScan({ projectTokens: projects.map((project) => project.token),
        uiState: readBackupUiState(), operationId: operation.id });
      if (!response.token || !response.preview) throw new Error(t("backup.invalidResponse"));
      if (await adoptToken(response.token, operation)) setScan(response);
    } catch (cause) { fail(operation, "backup.scanFailed", cause); }
    finally { finish(operation); }
  };
  const exportBackup = async () => {
    if (!scan || scan.preview.blockers.length || !validPassword(exportPassword) || !validPassword(confirmPassword)
      || exportPassword !== confirmPassword || (scan.preview.warnings.length > 0 && !acknowledgeWarnings)) return;
    const operation = begin("export"); if (!operation) return;
    try {
      const response = await bridge!.backupExport({ token: scan.token, password: exportPassword, confirmPassword,
        operationId: operation.id, acknowledgeWarnings });
      if (!mounted.current || ownedOperation.current !== operation) return;
      if (response.cancelled) { setNotice(t("backup.cancelled")); return; }
      setNotice("");
      if (typeof response.entries !== "number" || typeof response.bytes !== "number") throw new Error(t("backup.invalidResponse"));
      operation.committed = true;
      setScan(null); await releaseToken(scan.token);
      if (mounted.current && ownedOperation.current === operation) setResult({ label: t("backup.exportResult", { count: response.entries, bytes: response.bytes }),
        warnings: response.warnings ?? [], restored: false });
    } catch (cause) { fail(operation, "backup.exportFailed", cause); }
    finally { setExportPassword(""); setConfirmPassword(""); finish(operation); }
  };
  const selectArchive = async () => {
    const operation = begin("select"); if (!operation) return;
    setImportPassword(""); setConfigurationConsent(false); setDecisions({});
    try {
      if (inspection) { setInspection(null); await releaseToken(inspection.token); }
      if (!isCurrent(operation)) return;
      const response = await bridge!.backupInspect({ kind: "select" });
      if (response.cancelled) { if (isCurrent(operation)) setNotice(t("backup.cancelled")); return; }
      if (!response.token || !response.name) throw new Error(t("backup.invalidResponse"));
      if (await adoptToken(response.token, operation)) setInspection({ token: response.token, name: response.name });
    } catch (cause) { fail(operation, "backup.inspectFailed", cause); }
    finally { finish(operation); }
  };
  const unlockArchive = async () => {
    if (!inspection || importPassword.length < 1 || importPassword.length > 1024) return;
    const operation = begin("unlock"); if (!operation) return;
    try {
      const response = await bridge!.backupInspect({ kind: "unlock", token: inspection.token,
        password: importPassword, operationId: operation.id });
      // Main retains only a short-lived key. Restore never receives this password.
      setImportPassword("");
      if (!isCurrent(operation)) return;
      if (response.cancelled) { setNotice(t("backup.cancelled")); return; }
      if (!response.preview) throw new Error(t("backup.invalidResponse"));
      setInspection({ ...inspection, preview: response.preview, legacy: response.legacy });
      applyPreview(response.preview); setConfigurationConsent(false);
    } catch (cause) { fail(operation, "backup.inspectFailed", cause); }
    finally { setImportPassword(""); finish(operation); }
  };
  const mapRoot = async (rootId: string) => {
    if (!inspection?.preview) return;
    const operation = begin("mapping"); if (!operation) return;
    try {
      const response = await bridge!.backupSelectMappingTarget({ token: inspection.token, rootId });
      if (!isCurrent(operation)) return;
      if (response.cancelled) { setNotice(t("backup.cancelled")); return; }
      if (!response.preview) throw new Error(t("backup.invalidResponse"));
      setInspection({ ...inspection, preview: response.preview }); applyPreview(response.preview, true);
    } catch (cause) { fail(operation, "backup.mappingFailed", cause); }
    finally { finish(operation); }
  };
  const restoreBackup = async () => {
    if (!inspection?.preview || !configurationConsent || restoreBlocked(inspection.preview, decisions)) return;
    const operation = begin("restore"); if (!operation) return;
    try {
      const response = await bridge!.backupRestore({ token: inspection.token,
        decisions: inspection.preview.resources.map((resource) => decisions[resource.id] ?? defaultDecision(resource)),
        configurationConsent, operationId: operation.id, planFingerprint: inspection.preview.fingerprint });
      if (!mounted.current || ownedOperation.current !== operation) return;
      setNotice("");
      if (response.committed === false) throw new Error(t("backup.notCommitted"));
      operation.committed = true;
      if (![response.restored, response.skipped, response.deferred].every((count) => Number.isInteger(count) && count >= 0))
        throw new Error(t("backup.invalidResponse"));
      setInspection(null); setDecisions({}); setConfigurationConsent(false);
      await releaseToken(inspection.token);
      if (mounted.current && ownedOperation.current === operation) setResult({ label: t("backup.restoreResult", {
        restored: response.restored, skipped: response.skipped, deferred: response.deferred }), warnings: response.warnings, restored: true });
      // Main applies validated UI keys and schedules reload; no manual copying or network installs.
    } catch (cause) { fail(operation, "backup.restoreFailed", cause); }
    finally { setImportPassword(""); finish(operation); }
  };
  const cancel = async () => {
    const operation = ownedOperation.current; if (!operation || operation.cancelled) return;
    operation.cancelled = true;
    clearPasswords(); setScan(null); setInspection(null); setProjects([]); setDecisions({});
    setConfigurationConsent(false); setAcknowledgeWarnings(false); setResult(null);
    const tokens = [...ownedTokens.current]; ownedTokens.current.clear();
    try {
      await bridge!.backupCancel({ operationId: operation.id, token: tokens[0] });
      await Promise.all(tokens.slice(1).map((token) => bridge!.backupCancel({ token })));
      if (mounted.current && !operation.committed) setNotice(t("backup.cancelled"));
    } catch (cause) {
      if (mounted.current) setError(t("backup.cancelFailed"));
      // Keep failed releases owned so unmount can retry, never expand cancellation scope.
      for (const token of tokens) ownedTokens.current.add(token);
    }
  };
  const changeDecision = (resource: BackupRestoreResource, patch: Partial<BackupDecision>) => {
    setDecisions((current) => ({ ...current, [resource.id]: { ...(current[resource.id] ?? defaultDecision(resource)), ...patch, resourceId: resource.id } }));
  };
  const warnings = (items: string[]) => items.length > 0 && <ul className="settings-general-description">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
  const exportDisabled = busy !== null || !scan || scan.preview.blockers.length > 0 || !validPassword(exportPassword)
    || !validPassword(confirmPassword) || exportPassword !== confirmPassword || (scan.preview.warnings.length > 0 && !acknowledgeWarnings);

  return <div className="settings-general">
    <h2 className="settings-general-title">{t("backup.title")}</h2>
    {!available ? <p role="status" className="settings-general-description">{t("backup.desktopOnly")}</p> : <>
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("backup.export")}</h3>
        <p className="settings-general-description">{t("backup.exportHint")}</p>
        <ConfigButton disabled={busy !== null} onClick={() => void selectProjects()}>{t("backup.selectProjects")}</ConfigButton>
        <ul>{projects.map((project) => <li key={project.token}>{project.label} <ConfigButton size="small" disabled={busy !== null} onClick={() => void removeProject(project)}>{t("backup.removeProject")}</ConfigButton></li>)}</ul>
        <div className="settings-chat-options">
          <ConfigButton disabled={busy !== null} onClick={() => void scanBackup()}>{busy === "scan" ? t("backup.scanning") : t("backup.scan")}</ConfigButton>
          {scan && <div role="status" className="settings-general-description">
            <p>{t("backup.scanSummary", { count: scan.preview.entries, bytes: scan.preview.bytes })}</p>
            <p>{t("backup.types")}: {Object.entries(scan.preview.kinds).map(([kind, count]) => `${kind} (${count})`).join(", ") || t("backup.empty")}</p>
            <h4>{t("backup.roots")}</h4><ul>{scan.preview.roots.map((root) => <li key={root.id}>{root.label} · {root.kind} · {root.originalPath}</li>)}</ul>
            <h4>{t("backup.resources")}</h4><ul>{scan.preview.resources.map((resource) => <li key={resource.id}>{resource.label} · {resource.kind} · {resource.relativePath} · {t(`backup.availability.${resource.availability}`)}</li>)}</ul>
            {warnings(scan.preview.warnings)}
            {scan.preview.blockers.length > 0 && <div role="alert"><strong>{t("backup.blockers")}</strong>{warnings(scan.preview.blockers)}</div>}
            {scan.preview.warnings.length > 0 && <label><input type="checkbox" checked={acknowledgeWarnings} disabled={busy !== null} onChange={(event) => setAcknowledgeWarnings(event.target.checked)} />{t("backup.ackWarnings")}</label>}
          </div>}
          <label className="config-field"><span className="config-field-label">{t("backup.password")}</span>
            <input type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={exportPassword} disabled={busy !== null} onChange={(event) => setExportPassword(event.target.value)} style={passwordStyle} /></label>
          <label className="config-field"><span className="config-field-label">{t("backup.confirmPassword")}</span>
            <input type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={confirmPassword} disabled={busy !== null} onChange={(event) => setConfirmPassword(event.target.value)} style={passwordStyle} /></label>
          {exportPassword && !validPassword(exportPassword) && <p role="alert">{t("backup.passwordLength")}</p>}
          {confirmPassword && exportPassword !== confirmPassword && <p role="alert">{t("backup.passwordMismatch")}</p>}
          <ConfigButton variant="primary" disabled={exportDisabled} onClick={() => void exportBackup()}>{busy === "export" ? t("backup.exporting") : t("backup.saveFile")}</ConfigButton>
        </div>
      </section>
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("backup.import")}</h3>
        <p className="settings-general-description">{t("backup.importHint")}</p>
        <ConfigButton disabled={busy !== null} onClick={() => void selectArchive()}>{t("backup.chooseFile")}</ConfigButton>
        {inspection && <p className="settings-general-description">{inspection.name}</p>}
        {inspection && !inspection.preview && <div className="settings-chat-options">
          <label className="config-field"><span className="config-field-label">{t("backup.password")}</span>
            <input type="password" autoComplete="off" minLength={1} maxLength={1024} value={importPassword} disabled={busy !== null} onChange={(event) => setImportPassword(event.target.value)} style={passwordStyle} /></label>
          <ConfigButton disabled={busy !== null || !importPassword || importPassword.length > 1024} onClick={() => void unlockArchive()}>{busy === "unlock" ? t("backup.inspecting") : t("backup.unlock")}</ConfigButton>
        </div>}
        {inspection?.preview && <div className="settings-general-section">
          <h3 className="settings-general-heading">{t("backup.preview")}</h3>
          {inspection.legacy && <p>{t("backup.legacy")}</p>}
          {warnings(inspection.preview.warnings)}
          <h4>{t("backup.roots")}</h4>
          <ul>{inspection.preview.roots.map((root) => {
            const unmapped = inspection.preview!.resources.some((resource) => resource.rootId === root.id && !resource.mapped);
            return <li key={root.id}>{root.label} · {root.kind} · {root.originalPath}
              {(root.kind === "project" || root.kind === "external" && inspection.preview!.resources.some(resource=>resource.rootId===root.id && resource.entries>0)) && <ConfigButton disabled={busy !== null} onClick={() => void mapRoot(root.id)}>{t("backup.mapRoot")}</ConfigButton>}
            </li>;
          })}</ul>
          <h4>{t("backup.resources")}</h4>
          <p>{t("backup.decisionHint")}</p>
          {inspection.preview.resources.map((resource) => {
            const decision = decisions[resource.id] ?? defaultDecision(resource);
            return <fieldset key={resource.id} disabled={busy !== null} style={{ marginBottom: 12 }}>
              <legend>{resource.kind === "ui" ? t("backup.preferences") : resource.label}</legend>
              <p>{resource.kind} · {resource.relativePath} · {t(`backup.availability.${resource.availability}`)}</p>
              <p>{t("backup.resourceSummary", { count: resource.entries, existing: resource.existing })}</p>
              <p>{t(resource.mapped ? "backup.mapped" : "backup.unmapped")} · {t(resource.blocked ? "backup.blocked" : "backup.notBlocked")}</p>
              {warnings(resource.warnings)}
              {resource.extraFiles.length > 0 && <><p>{t("backup.extraFiles")}</p>{warnings(resource.extraFiles)}</>}
              <label>{t("backup.conflict")} <select value={decision.conflict} onChange={(event) => changeDecision(resource, { conflict: event.target.value === "replace" ? "replace" : "keep" })}>
                <option value="keep">{t("backup.keep")}</option><option value="replace">{t("backup.replace")}</option>
              </select></label>
              <label style={{ display: "block" }}><input type="checkbox" checked={decision.activation === "enable"} onChange={(event) => changeDecision(resource, { activation: event.target.checked ? "enable" : "defer" })} />
                {t(resource.executable || resource.securityPolicy ? "backup.enableRisky" : "backup.enableResource")}</label>
              <p>{t(decision.activation === "defer" ? "backup.deferredResource" : "backup.enabledResource")}</p>
            </fieldset>;
          })}
          <p>{t("backup.reinstallHint")}</p>
          <label><input type="checkbox" checked={configurationConsent} disabled={busy !== null} onChange={(event) => setConfigurationConsent(event.target.checked)} />{t("backup.configurationConsent")}</label>
          {restoreBlocked(inspection.preview, decisions) && <p role="alert">{t("backup.restoreBlocked")}</p>}
          <ConfigButton variant="primary" disabled={busy !== null || !configurationConsent || restoreBlocked(inspection.preview, decisions)} onClick={() => void restoreBackup()}>{busy === "restore" ? t("backup.restoring") : t("backup.restore")}</ConfigButton>
        </div>}
      </section>
      {busy && <div role="status">
        <p>{progress ? t(`backup.phase.${progress.phase}`) : t("backup.working")}</p>
        {progress && <><progress max={Math.max(1, progress.total)} value={Math.max(0, Math.min(progress.completed, progress.total))} aria-label={t("backup.progress")} /><span>{progress.completed} / {progress.total}</span></>}
        <ConfigButton onClick={() => void cancel()}>{t("backup.cancel")}</ConfigButton>
      </div>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert" className="settings-general-error">{error}</p>}
      {result && <div role="status"><p>{result.label}</p>{warnings(result.warnings)}
        {result.restored && <><p>{t("backup.restartHint")}</p><p>{t("backup.reinstallHint")}</p></>}
      </div>}
    </>}
  </div>;
}
