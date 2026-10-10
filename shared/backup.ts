/** JSON-only backup contract shared by Electron, renderer and archive modules. */
export type BackupRoot = { id: string; kind: "agent" | "home" | "project" | "external" | "ui"; label: string; originalPath: string };
export type BackupResource = {
  id: string; rootId: string; relativePath: string; label: string; kind: string;
  executable: boolean; sensitive: boolean; securityPolicy?: boolean;
  availability: "offlineReady" | "requiresReinstall" | "unresolved";
  source?: string; version?: string; requiredRootIds?: string[];
};
export type BackupEntry = { path: string; rootId: string; resourceId: string; relativePath: string; size: number; sha256: string; kind: string };
export type BackupManifest = {
  formatVersion: 2; archiveId: string; appVersion: string; sdkVersion: string; createdAt: string;
  roots: BackupRoot[]; resources: BackupResource[]; entries: BackupEntry[]; warnings: string[];
  uiState?: Record<string, string>;
};
export type BackupScanPreview = {
  entries: number; bytes: number; kinds: Record<string, number>; warnings: string[]; blockers: string[];
  roots: BackupRoot[]; resources: BackupResource[]; fingerprint: string;
};
export type BackupInspection = { manifest: BackupManifest; archiveHash: string; legacy: boolean; warnings: string[] };
export type BackupRestoreResource = BackupResource & {
  entries: number; existing: number; extraFiles: string[]; mapped: boolean; blocked: boolean; warnings: string[];
};
export type BackupRestorePreview = {
  resources: BackupRestoreResource[]; roots: BackupRoot[]; warnings: string[]; fingerprint: string;
};
export type BackupDecision = { resourceId: string; conflict: "keep" | "replace"; activation: "defer" | "enable" };
export type BackupProgress = { operationId: string; phase: "scan" | "export" | "verify" | "stage" | "commit" | "rollback" | "done"; completed: number; total: number };
export type BackupUiState = Record<string, string>;
export type BackupResult = { restored: number; skipped: number; deferred: number; warnings: string[]; uiState?: BackupUiState; committed?: boolean };
export interface BackupBridge {
  backupSelectProjects(): Promise<{ cancelled?: boolean; projects: { token: string; label: string }[] }>;
  backupScan(options: { projectTokens: string[]; operationId: string; uiState: BackupUiState }): Promise<{ token: string; preview: BackupScanPreview }>;
  backupExport(options: { token: string; password: string; confirmPassword: string; operationId: string; acknowledgeWarnings: boolean }): Promise<{ cancelled?: boolean; entries?: number; bytes?: number; warnings?: string[] }>;
  backupInspect(options: { kind: "select" } | { kind: "unlock"; token: string; password: string; operationId: string }): Promise<{ cancelled?: boolean; token?: string; name?: string; preview?: BackupRestorePreview; legacy?: boolean }>;
  backupSelectMappingTarget(options: { token: string; rootId: string }): Promise<{ cancelled?: boolean; preview?: BackupRestorePreview }>;
  backupRestore(options: { token: string; decisions: BackupDecision[]; configurationConsent: boolean; operationId: string; planFingerprint: string }): Promise<BackupResult>;
  backupCancel(options: { operationId?: string; token?: string }): Promise<void>;
  onBackupProgress(listener: (progress: BackupProgress) => void): () => void;
}
