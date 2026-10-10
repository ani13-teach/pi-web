import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { within } from "./platform.ts";
import type { BackupOptions, ScanOptions, OperationOptions, BackupDecision, BackupInspection } from "./types.ts";
import { collectBackup } from "./discovery.ts";
import { readArchive, writeArchive } from "./archive.ts";
import { buildRestorePlan, planRestore } from "./restore-plan.ts";
import { ensurePrivateDirectory, executeRestore, recoverTransactions, type UiParticipant } from "./transaction.ts";
import { remapStagedPaths } from "./remap.ts";
export { scanBackup, collectBackup } from "./discovery.ts";
export { planRestore, recoverTransactions, readArchive };
export type * from "./types.ts";
export async function createBackup(o: BackupOptions) {
  if (typeof o.password !== "string" || !o.password || o.password.length > 1024) throw new Error("A password is required");
  if (o.confirmPassword !== undefined && o.password !== o.confirmPassword) throw new Error("Passwords do not match");
  const collection = await collectBackup(o);
  if (collection.preview.blockers.length) throw new Error("Backup incomplete: " + collection.preview.blockers.join("; "));
  if (o.expectedFingerprint && o.expectedFingerprint !== collection.preview.fingerprint) throw new Error("Backup sources changed; scan again");
  const actualOutput = path.join(await fs.realpath(path.dirname(path.resolve(o.outputPath))),path.basename(o.outputPath));
  const sourceRoots = [await fs.realpath(o.agentDir)];
  const roots=new Map(collection.manifest.roots.map(root=>[root.id,root]));
  for (const resource of collection.manifest.resources) {
    const root=roots.get(resource.rootId)!;
    if (root.originalPath && resource.kind!=="package") sourceRoots.push(await fs.realpath(path.join(root.originalPath,resource.relativePath)));
  }
  if(sourceRoots.some(root=>within(root,actualOutput))) throw new Error("Backup destination must be outside collected source roots");
  return writeArchive({ outputPath: o.outputPath, password: o.password, collection, signal: o.signal, progress: o.progress, operationId: o.operationId });
}
export async function inspectBackup(o: { archivePath: string; password: string } & OperationOptions): Promise<BackupInspection> {
  const result = await readArchive(o); try { const { key: _key, ...inspection } = result; return inspection; } finally { result.key.fill(0); }
}
export async function restoreBackup(o: { agentDir: string; homeDir?: string; archivePath: string; password?: string; key?: Buffer; archiveHash?: string; mappings?: Record<string,string>; decisions: BackupDecision[]; configurationConsent: boolean; expectedFingerprint?: string; ui?: UiParticipant } & OperationOptions) {
  const stage = path.join(o.agentDir,".backup-restore-full-" + randomUUID());
  await ensurePrivateDirectory(stage);
  let ownedKey: Buffer | undefined;
  try {
    const archive = await readArchive({ archivePath: o.archivePath, password: o.password, key: o.key, stageDir: stage, signal: o.signal, progress: o.progress, operationId: o.operationId });
    ownedKey = archive.key;
    if (o.archiveHash && o.archiveHash !== archive.archiveHash) throw new Error("Backup changed after preview");
    const currentUiState=o.ui ? await o.ui.read() : undefined;
    const original = await buildRestorePlan({ manifest: archive.manifest, currentUiState, agentDir: o.agentDir, homeDir: o.homeDir, mappings: o.mappings, signal: o.signal });
    if (o.expectedFingerprint && original.preview.fingerprint !== o.expectedFingerprint) throw new Error("Restore targets changed; inspect again");
    const manifest = await remapStagedPaths(archive.manifest,stage,original.roots,o.decisions);
    const transformed = await planRestore({ manifest, currentUiState, agentDir: o.agentDir, homeDir: o.homeDir, mappings: o.mappings, signal: o.signal });
    const check = await planRestore({ manifest: archive.manifest, currentUiState, agentDir:o.agentDir, homeDir:o.homeDir, mappings:o.mappings, signal:o.signal });
    if (check.fingerprint !== original.preview.fingerprint) throw new Error("Restore targets changed while preparing");
    return await executeRestore({ ...o, manifest, stageDir:stage, expectedFingerprint:transformed.fingerprint });
  } finally { if (ownedKey && ownedKey !== o.key) ownedKey.fill(0); await fs.rm(stage,{recursive:true,force:true}); }
}
