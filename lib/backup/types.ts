import type { BackupEntry, BackupManifest, BackupProgress, BackupScanPreview, BackupUiState } from "../../shared/backup.ts";
export type { BackupEntry, BackupManifest, BackupRoot, BackupResource, BackupInspection, BackupDecision, BackupRestorePreview, BackupResult } from "../../shared/backup.ts";
export type SourceEntry = BackupEntry & { source?: string; data?: Buffer; dev?: number; ino?: number; mtimeMs?: number; ctimeMs?: number };
export type ResourceSnapshot = { path: string; kind: "skills" | "extensions" | "prompts" | "themes" | "agents" | "instructions"; source?: string; baseDir?: string };
export type ScanOptions = { agentDir: string; homeDir?: string; projectDirs?: string[]; externalRoots?: string[]; resourceSnapshot?: ResourceSnapshot[]; sessionDirs?: string[]; resourceWarnings?: string[]; applicationDir?: string; uiState?: BackupUiState; appVersion?: string; sdkVersion?: string; signal?: AbortSignal; progress?: (p: BackupProgress) => void; operationId?: string };
export type Collection = { manifest: BackupManifest; entries: SourceEntry[]; preview: BackupScanPreview };
export type BackupOptions = ScanOptions & { outputPath: string; password: string; confirmPassword?: string; expectedFingerprint?: string };
export type OperationOptions = { signal?: AbortSignal; progress?: (p: BackupProgress) => void; operationId?: string };
