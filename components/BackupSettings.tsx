"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

interface BackupBridge {
  backupScan(options: { includePrivate: boolean; includeSessions: boolean; includeCustomizations: boolean; includeProject: boolean }): Promise<{ cancelled?: boolean; token?: string; preview?: ScanPreview }>;
  backupExport(options: { password: string; token: string }): Promise<{ cancelled?: boolean; entries?: number; bytes?: number; warnings?: string[] }>;
  backupInspect(password: string): Promise<{ cancelled?: boolean; token?: string; preview?: Preview }>;
  backupRestore(options: { token: string; password: string; overwrite: boolean }): Promise<{ restored: number; skipped: number; warnings: string[] }>;
}
type Preview = { includePrivate: boolean; entries: { path: string; size: number; kind: string }[]; warnings: string[] };
type ScanPreview = { entries: number; bytes: number; kinds: Record<string, number>; warnings: string[] };

const passwordStyle = {
  width: "100%", maxWidth: 420, minWidth: 0, height: 34, padding: "0 9px",
  border: "1px solid var(--border)", borderRadius: 5,
  background: "var(--bg)", color: "var(--text)", fontSize: 12,
};

export function BackupSettings() {
  const { t } = useI18n();
  // Passwords stay in component state; navigation unmounts this component.
  const [exportPassword, setExportPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [includePrivate, setIncludePrivate] = useState(false);
  const [includeSessions, setIncludeSessions] = useState(false);
  const [includeCustomizations, setIncludeCustomizations] = useState(false);
  const [includeProject, setIncludeProject] = useState(false);
  const [inspection, setInspection] = useState<{ token: string; preview: Preview } | null>(null);
  const [scan, setScan] = useState<{ token: string; preview: ScanPreview } | null>(null);
  const [busy, setBusy] = useState<"scan" | "export" | "inspect" | "restore" | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ label: string; warnings: string[]; restored: boolean } | null>(null);
  const bridge = typeof window === "undefined" ? undefined : window.piDesktop as (typeof window.piDesktop & Partial<BackupBridge>) | undefined;
  const available = Boolean(bridge?.backupScan && bridge.backupExport && bridge.backupInspect && bridge.backupRestore);

  const clearPreview = () => { setInspection(null); setResult(null); };
  const changePrivacy = (value: boolean) => {
    setScan(null); setIncludePrivate(value);
    if (!value) { setIncludeSessions(false); setIncludeCustomizations(false); setIncludeProject(false); }
  };

  const scanBackup = async () => {
    if (!bridge?.backupScan || busy) return;
    setScan(null); setBusy("scan"); setError(""); setResult(null);
    try {
      const response = await bridge.backupScan({ includePrivate, includeSessions: includePrivate && includeSessions,
        includeCustomizations: includePrivate && includeCustomizations, includeProject: includePrivate && includeProject });
      if (!response.cancelled && response.token && response.preview)
        setScan({ token: response.token, preview: response.preview });
    } catch { setError(t("backup.scanFailed")); }
    finally { setBusy(null); }
  };

  const exportBackup = async () => {
    if (!bridge?.backupExport || busy || !scan || exportPassword.length < 8 || exportPassword !== confirmPassword) return;
    setBusy("export"); setError(""); setResult(null);
    try {
      const response = await bridge.backupExport({ password: exportPassword, token: scan.token });
      if (!response.cancelled) setScan(null);
      if (!response.cancelled) setResult({
        label: t("backup.exportResult", { count: response.entries ?? 0, bytes: response.bytes ?? 0 }),
        warnings: response.warnings ?? [], restored: false,
      });
    } catch { setError(t("backup.exportFailed")); }
    finally { setExportPassword(""); setConfirmPassword(""); setBusy(null); }
  };

  const inspectBackup = async () => {
    if (!bridge?.backupInspect || busy || importPassword.length < 8) return;
    clearPreview(); setBusy("inspect"); setError("");
    try {
      const response = await bridge.backupInspect(importPassword);
      if (response.cancelled) setImportPassword("");
      else if (response.token && response.preview) setInspection({ token: response.token, preview: response.preview });
      else throw new Error("Invalid inspection result");
    } catch { setImportPassword(""); setError(t("backup.inspectFailed")); }
    finally { setBusy(null); }
  };

  const restoreBackup = async () => {
    if (!bridge?.backupRestore || !inspection || importPassword.length < 8 || busy) return;
    setBusy("restore"); setError("");
    try {
      const response = await bridge.backupRestore({ token: inspection.token, password: importPassword, overwrite: false });
      setResult({ label: t("backup.restoreResult", { restored: response.restored, skipped: response.skipped }), warnings: response.warnings, restored: true });
    } catch { setError(t("backup.restoreFailed")); }
    finally { setInspection(null); setImportPassword(""); setBusy(null); }
  };

  const kinds = inspection && Object.entries(inspection.preview.entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    return counts;
  }, {}));

  return (
    <div className="settings-general">
      <h2 className="settings-general-title">{t("backup.title")}</h2>
      {!available ? <p role="status" className="settings-general-description">{t("backup.desktopOnly")}</p> : <>
        <section className="settings-general-section">
          <h3 className="settings-general-heading">{t("backup.export")}</h3>
          <p className="settings-general-description">{t("backup.exportHint")}</p>
          <div className="settings-shell-option">
            <span>{t("backup.private", { value: includePrivate ? t("backup.yes") : t("backup.no") })}</span>
            <ConfigSwitch checked={includePrivate} disabled={busy !== null} label={t("backup.privateToggle")} onChange={changePrivacy} />
          </div>
          {!includePrivate ? <p className="settings-general-description">{t("backup.publicHint")}</p> : <>
            <p className="settings-general-description">{t("backup.privateHint")}</p>
            {([
              ["sessions", includeSessions, setIncludeSessions],
              ["customizations", includeCustomizations, setIncludeCustomizations],
              ["project", includeProject, setIncludeProject],
            ] as const).map(([key, checked, setChecked]) => <div key={key} className="settings-shell-option">
              <span>{t(`backup.${key}`)}</span>
              <ConfigSwitch checked={checked} disabled={busy !== null} label={t(`backup.${key}`)} onChange={(value) => { setScan(null); setChecked(value); }} />
            </div>)}
          </>}
          <div className="settings-chat-options">
            <ConfigButton disabled={busy !== null} onClick={() => void scanBackup()}>{busy === "scan" ? t("backup.scanning") : t("backup.scan")}</ConfigButton>
            {scan && <div role="status" className="settings-general-description">
              <p>{t("backup.scanSummary", { count: scan.preview.entries, bytes: scan.preview.bytes })}</p>
              <p>{t("backup.types")}: {Object.entries(scan.preview.kinds).map(([kind, count]) => `${kind} (${count})`).join(", ") || t("backup.empty")}</p>
              {scan.preview.warnings.length > 0 && <ul>{scan.preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
            </div>}
            <label className="config-field">
              <span className="config-field-label">{t("backup.password")}</span>
              <input type="password" autoComplete="new-password" value={exportPassword} disabled={busy !== null} onChange={(event) => setExportPassword(event.target.value)} style={passwordStyle} />
            </label>
            <label className="config-field">
              <span className="config-field-label">{t("backup.confirmPassword")}</span>
              <input type="password" autoComplete="new-password" value={confirmPassword} disabled={busy !== null} onChange={(event) => setConfirmPassword(event.target.value)} style={passwordStyle} />
            </label>
            {exportPassword && exportPassword.length < 8 && <p role="alert" className="settings-general-error">{t("backup.passwordLength")}</p>}
            {confirmPassword && exportPassword !== confirmPassword && <p role="alert" className="settings-general-error">{t("backup.passwordMismatch")}</p>}
            <ConfigButton variant="primary" disabled={busy !== null || !scan || exportPassword.length < 8 || exportPassword !== confirmPassword} onClick={() => void exportBackup()}>
              {busy === "export" ? t("backup.exporting") : t("backup.saveFile")}
            </ConfigButton>
          </div>
        </section>

        <section className="settings-general-section">
          <h3 className="settings-general-heading">{t("backup.import")}</h3>
          <p className="settings-general-description">{t("backup.importHint")}</p>
          <div className="settings-chat-options">
            <label className="config-field">
              <span className="config-field-label">{t("backup.password")}</span>
              <input type="password" autoComplete="off" value={importPassword} disabled={busy !== null} onChange={(event) => { setImportPassword(event.target.value); clearPreview(); }} style={passwordStyle} />
            </label>
            <ConfigButton disabled={busy !== null || importPassword.length < 8} onClick={() => void inspectBackup()}>
              {busy === "inspect" ? t("backup.inspecting") : t("backup.chooseFile")}
            </ConfigButton>
          </div>
          {inspection && <div className="settings-general-section">
            <h3 className="settings-general-heading">{t("backup.preview")}</h3>
            <p className="settings-general-description">{t("backup.previewSummary", { count: inspection.preview.entries.length, sensitivity: t(inspection.preview.includePrivate ? "backup.sensitive" : "backup.notSensitive") })}</p>
            <p className="settings-general-description">{t("backup.types")}: {kinds?.map(([kind, count]) => `${kind} (${count})`).join(", ") || t("backup.empty")}</p>
            {inspection.preview.warnings.length > 0 && <ul className="settings-general-description">{inspection.preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
            <p className="settings-general-description">{t("backup.conflicts")}</p>
            <ConfigButton variant="primary" disabled={busy !== null} onClick={() => void restoreBackup()}>
              {busy === "restore" ? t("backup.restoring") : t("backup.restore")}
            </ConfigButton>
          </div>}
        </section>
        {error && <p role="alert" className="settings-general-error">{error}</p>}
        {result && <div role="status">
          <p className="settings-general-description">{result.label}</p>
          {result.warnings.length > 0 && <ul className="settings-general-description">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          {result.restored && <p className="settings-general-description">{t("backup.restartHint")}</p>}
        </div>}
      </>}
    </div>
  );
}
