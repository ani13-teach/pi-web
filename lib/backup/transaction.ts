import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { BackupDecision, BackupManifest, BackupResult, OperationOptions } from "./types.ts";
import { BACKUP_UI_RESOURCE_ID, validateBackupUiState } from "../../shared/backup-preferences.ts";
import { allowedRelative, buildRestorePlan, validateRestoreManifest, type PlanOptions } from "./restore-plan.ts";
import { abort, checkParents, checkIdentity, copyPrivate, digest, durableWrite, fileState, maybeStat, permissions, protect, renameNoReplace, replaceJournal, restorePermissions, sameIdentity, syncDirectory, verifyParents, verifyPrivate, within, type FileState, type Identity, type Permissions } from "./platform.ts";

export type UiParticipant = { read: () => Promise<Record<string, string>>; write: (state: Record<string, string>) => Promise<void> };
export type RestoreOptions = PlanOptions & OperationOptions & { stageDir: string; decisions: BackupDecision[]; configurationConsent: boolean; expectedFingerprint?: string; ui?: UiParticipant; fault?: (phase: string) => void | Promise<void> };
type Step = { index: number; target: string; root: string; parent: string; workspace: string; workspaceIdentity: Identity; parentIdentity: Identity; old: FileState | null; oldPermissions?: Permissions; newHash: string; newSize: number; state: "prepared" | "intent" | "applied"; newIdentity: Identity; sensitive: boolean };
type Journal = { version: 1; id: string; agentDir: string; manifest: BackupManifest; roots: Record<string, string>; state: "preparing" | "applying" | "committed" | "rolledback"; steps: Step[]; dirs: { path: string; identity: Identity }[]; ui?: { old: Record<string, string>; next: Record<string, string>; intent: boolean; applied: boolean }; sequence: number; };
const TXDIR = ".backup-transactions";
export async function ensurePrivateDirectory(dir: string) {
  await checkParents(path.dirname(dir));
  if (!(await maybeStat(dir))) await fs.mkdir(dir, { mode: 0o700 });
  await protect(dir, true);
}
async function save(dir: string, journal: Journal) {
  journal.sequence++;
  const body = JSON.stringify(journal), envelope = JSON.stringify({ hash: digest(body), body });
  const temp = path.join(dir, "journal-" + randomUUID() + ".tmp");
  await durableWrite(temp, envelope);
  try { await replaceJournal(temp, path.join(dir, "journal.json")); } finally { await fs.rm(temp, { force: true }); }
}
async function readJournal(dir: string, agentDir: string): Promise<Journal> {
  await verifyPrivate(dir, true); const f = path.join(dir, "journal.json"); await verifyPrivate(f);
  const st = await fs.lstat(f); if (st.size > 64 * 1024 ** 2) throw new Error("Oversized recovery journal");
  const envelope = JSON.parse(await fs.readFile(f, "utf8")) as { hash: string; body: string };
  if (typeof envelope.body !== "string" || digest(envelope.body) !== envelope.hash) throw new Error("Corrupt recovery journal");
  const j = JSON.parse(envelope.body) as Journal;
  if (j.version !== 1 || !/^[a-f0-9-]{36}$/.test(j.id) || path.basename(dir) !== j.id || j.agentDir !== path.resolve(agentDir) || !["preparing", "applying", "committed", "rolledback"].includes(j.state) || !Array.isArray(j.steps) || !Array.isArray(j.dirs)) throw new Error("Invalid recovery journal");
  validateRestoreManifest(j.manifest);
  for (const [id, root] of Object.entries(j.roots)) {
    if (!j.manifest.roots.some(r => r.id === id) || !path.isAbsolute(root)) throw new Error("Invalid recovery mapping");
    await checkParents(root, true);
  }
  for (const step of j.steps) {
    const e = j.manifest.entries[step.index], r = e && j.manifest.roots.find(r => r.id === e.rootId);
    if (!e || !r || !allowedRelative(r, e.relativePath) || step.root !== j.roots[e.rootId] || step.target !== path.resolve(step.root, e.relativePath) || step.parent !== path.dirname(step.target) || !within(step.root, step.target) || path.dirname(step.workspace) !== step.parent || path.basename(step.workspace) !== `.pi-backup-${j.id}-${step.index}` || step.newHash !== e.sha256 || step.newSize !== e.size) throw new Error("Unsafe recovery path");
    await checkParents(step.parent); await checkIdentity(step.parent, step.parentIdentity);
    if (await maybeStat(step.workspace)) { await checkIdentity(step.workspace, step.workspaceIdentity); await verifyPrivate(step.workspace, true); }
    else if (!["committed", "rolledback"].includes(j.state)) throw new Error("Missing recovery workspace");
  }
  for (const d of j.dirs) if (!Object.values(j.roots).some(r => within(r, d.path))) throw new Error("Unsafe recovery directory");
  if (j.ui) { validateBackupUiState(j.ui.old); validateBackupUiState(j.ui.next); }
  return j;
}
async function currentMatches(p: string, hash: string, identity?: Identity) {
  const state = await fileState(p); return state && state.hash === hash && (!identity || sameIdentity(state, identity)) ? state : null;
}
async function cleanup(dir: string, j: Journal) {
  for (const step of j.steps) {
    if (!(await maybeStat(step.workspace))) continue;
    await checkIdentity(step.workspace, step.workspaceIdentity); await verifyPrivate(step.workspace, true);
    await fs.rm(step.workspace, { recursive: true }); await syncDirectory(step.parent);
  }
  await fs.rm(dir, { recursive: true }); await syncDirectory(path.dirname(dir));
}
async function rollback(dir: string, j: Journal, ui?: UiParticipant) {
  if (j.ui?.intent) {
    if (!ui) throw new Error("UI recovery requires the preference participant");
    const current = validateBackupUiState(await ui.read());
    if (JSON.stringify(current) !== JSON.stringify(j.ui.old) && JSON.stringify(current) !== JSON.stringify(j.ui.next) && j.ui.applied) throw new Error("Preferences changed outside the transaction");
    await ui.write(j.ui.old);
    if (digest(JSON.stringify(await ui.read())) !== digest(JSON.stringify(j.ui.old))) throw new Error("Preference rollback verification failed");
    j.ui.intent = false; j.ui.applied = false; await save(dir, j);
  }
  for (const step of [...j.steps].reverse()) {
    await checkParents(step.parent); await checkIdentity(step.parent, step.parentIdentity); await checkIdentity(step.workspace, step.workspaceIdentity);
    const oldFile = path.join(step.workspace, "old"), newFile = path.join(step.workspace, "new");
    const current = await fileState(step.target), saved = await fileState(oldFile);
    if (saved) {
      if (!step.old || saved.hash !== step.old.hash || !sameIdentity(saved, step.old)) throw new Error("Recovery original changed");
      if (current) {
        if (current.hash !== step.newHash || !sameIdentity(current, step.newIdentity)) throw new Error("Recovery target changed externally");
        if (await maybeStat(newFile)) throw new Error("Ambiguous recovery new file");
        await renameNoReplace(step.target, newFile);
      }
      await renameNoReplace(oldFile, step.target);
      if (step.oldPermissions) await restorePermissions(step.target, step.oldPermissions);
    } else if (step.old) {
      if (!current || current.hash !== step.old.hash || !sameIdentity(current, step.old)) throw new Error("Original missing or changed during recovery");
    } else if (current) {
      if (current.hash !== step.newHash || !sameIdentity(current, step.newIdentity)) throw new Error("New target changed externally");
      if (await maybeStat(newFile)) throw new Error("Ambiguous recovery new file");
      await renameNoReplace(step.target, newFile);
    }
    step.state = "prepared"; await save(dir, j);
  }
  j.state = "rolledback"; await save(dir, j);
  await cleanup(dir, j);
  for (const item of [...j.dirs].reverse()) {
    const s = await maybeStat(item.path); if (s && sameIdentity(s, item.identity) && s.isDirectory() && !s.isSymbolicLink()) await fs.rmdir(item.path).catch(e => { if (!["ENOTEMPTY", "ENOENT"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; });
  }
}
async function makeParents(p: string, root: string, j: Journal, dir: string) {
  const missing: string[] = []; let current = p;
  while (!(await maybeStat(current))) { if (!within(root, current)) throw new Error("Missing unauthorized parent"); missing.push(current); current = path.dirname(current); }
  await checkParents(current);
  for (const d of missing.reverse()) { await fs.mkdir(d, { mode: 0o700 }); const s = await fs.lstat(d); j.dirs.push({ path: d, identity: { dev: s.dev, ino: s.ino } }); await save(dir, j); }
  await checkParents(p);
}
export async function executeRestore(o: RestoreOptions): Promise<BackupResult> {
  abort(o.signal);
  const currentUiState = o.ui ? validateBackupUiState(await o.ui.read()) : undefined;
  const plan = await buildRestorePlan({...o,currentUiState});
  if (o.expectedFingerprint && o.expectedFingerprint !== plan.preview.fingerprint) throw new Error("Restore targets changed; inspect the plan again");
  const decisions = new Map(o.decisions.map(d => [d.resourceId, d]));
  const resourceById = new Map(o.manifest.resources.map(resource=>[resource.id,resource]));
  const validIds = new Set(plan.preview.resources.map(resource=>resource.id));
  if (decisions.size !== o.decisions.length || o.decisions.some(d => !validIds.has(d.resourceId) || !["keep", "replace"].includes(d.conflict) || !["defer", "enable"].includes(d.activation))) throw new Error("Invalid restore decisions");
  const selected = new Set<string>(); const warnings: string[] = [...o.manifest.warnings]; let skipped = 0, deferred = 0;
  for (const r of plan.preview.resources) {
    if (r.kind === "package" && r.entries === 0) { if(r.availability!=="offlineReady")warnings.push("Package dependency requires explicit reinstallation: " + r.label); continue; }
    const d = decisions.get(r.id);
    if (d?.conflict === "keep" && plan.resourceExists[r.id]) { skipped += r.entries; continue; }
    if (!d || d.activation !== "enable" || !r.mapped || r.availability !== "offlineReady" || !o.configurationConsent && ["auth", "models", "settings"].includes(r.kind)) { deferred += r.entries || 1; warnings.push("Not restored: " + r.label); continue; }
    if (r.blocked) throw new Error("Blocked restore resource: " + r.label);
    selected.add(r.id);
  }
  const items = plan.entries.filter(e => selected.has(o.manifest.entries[e.index].resourceId));
  const useUi = Boolean(o.manifest.uiState && selected.has(BACKUP_UI_RESOURCE_ID) && o.configurationConsent);
  if (useUi && !o.ui) throw new Error("Preference participant is required");
  const agentDir = path.resolve(o.agentDir); await checkParents(agentDir);
  const base = path.join(agentDir, TXDIR); await ensurePrivateDirectory(base);
  const id = randomUUID(), dir = path.join(base, id); await ensurePrivateDirectory(dir);
  const j: Journal = { version: 1, id, agentDir, manifest: o.manifest, roots: plan.roots, state: "preparing", steps: [], dirs: [], sequence: 0, ...(useUi ? { ui: { old: currentUiState!, next: validateBackupUiState({...currentUiState,...o.manifest.uiState}), intent: false, applied: false } } : {}) };
  await save(dir, j);
  const progress = (phase: "stage" | "commit" | "rollback", completed: number) => o.progress?.({ operationId: o.operationId ?? id, phase, completed, total: items.length });
  let committed = false, commitAttempted = false;
  try {
    for (const [n, item] of items.entries()) {
      abort(o.signal); await verifyParents(item.parents);
      await makeParents(path.dirname(item.target), item.root, j, dir);
      const workspace = path.join(path.dirname(item.target), `.pi-backup-${id}-${item.index}`);
      await fs.mkdir(workspace, { mode: 0o700 }); await protect(workspace, true);
      const ws = await fs.lstat(workspace), parent = await fs.lstat(path.dirname(item.target));
      const entry = o.manifest.entries[item.index], resource = resourceById.get(entry.resourceId)!;
      const next = await copyPrivate(path.join(o.stageDir, String(item.index)), path.join(workspace, "new"), { hash: entry.sha256, size: entry.size });
      const step: Step = { index: item.index, target: item.target, root: item.root, parent: path.dirname(item.target), workspace, workspaceIdentity: { dev: ws.dev, ino: ws.ino }, parentIdentity: { dev: parent.dev, ino: parent.ino }, old: item.state, oldPermissions: item.state ? { mode: item.state.mode, uid: item.state.uid, gid: item.state.gid, ...(item.state.acl ? { acl: item.state.acl } : {}) } : undefined, newHash: entry.sha256, newSize: entry.size, state: "prepared", newIdentity: { dev: next.dev, ino: next.ino }, sensitive: resource.sensitive };
      j.steps.push(step); await save(dir, j); progress("stage", n + 1); await o.fault?.("prepared");
    }
    j.state = "applying"; await save(dir, j);
    for (const [n, step] of j.steps.entries()) {
      abort(o.signal); await checkParents(step.parent); await checkIdentity(step.parent, step.parentIdentity); await checkIdentity(step.workspace, step.workspaceIdentity);
      const current = await fileState(step.target);
      if (JSON.stringify(current) !== JSON.stringify(step.old)) throw new Error("Restore target changed after staging");
      step.state = "intent"; await save(dir, j); await o.fault?.("intent");
      if (current) {
        // Move the original intact, same volume and no-clobber. It remains recoverable
        // even if the process terminates before the new file is published.
        await renameNoReplace(step.target, path.join(step.workspace, "old"));
        const old = await fileState(path.join(step.workspace, "old"));
        if (!old || old.hash !== current.hash || !sameIdentity(old, current)) throw new Error("Original changed while moving");
      }
      await o.fault?.("original-moved");
      await renameNoReplace(path.join(step.workspace, "new"), step.target);
      await o.fault?.("published");
      if (step.sensitive) await verifyPrivate(step.target);
      else if (step.oldPermissions) await restorePermissions(step.target, step.oldPermissions);
      if (!(await currentMatches(step.target, step.newHash, step.newIdentity))) throw new Error("Published content changed");
      step.state = "applied"; await save(dir, j); progress("commit", n + 1); await o.fault?.("applied");
    }
    abort(o.signal);
    if (j.ui) {
      j.ui.intent = true; await save(dir, j); await o.fault?.("ui-intent");
      await o.ui!.write(j.ui.next);
      if (digest(JSON.stringify(await o.ui!.read())) !== digest(JSON.stringify(j.ui.next))) throw new Error("Preference write verification failed");
      j.ui.applied = true; await save(dir, j); await o.fault?.("ui-applied");
    }
    await o.fault?.("before-commit"); commitAttempted = true; j.state = "committed"; await o.fault?.("commit-persist"); await save(dir, j); committed = true;
    await o.fault?.("committed"); await cleanup(dir, j);
    return { restored: items.length + (useUi ? Object.keys(o.manifest.uiState!).length : 0), skipped, deferred, warnings, ...(useUi ? { uiState: j.ui!.next } : {}), committed: true };
  } catch (error) {
    if (committed) return { restored: items.length + (useUi ? Object.keys(o.manifest.uiState!).length : 0), skipped, deferred, ...(useUi ? {uiState:j.ui!.next}:{}), warnings: [...warnings, "Data committed; transaction cleanup will continue at startup."], committed: true };
    if (commitAttempted) throw new Error("Recovery required: commit durability is uncertain. Journal retained; backend must remain stopped.");
    // A fault fixture can simulate process death without performing in-process rollback.
    if ((error as { simulatedCrash?: boolean })?.simulatedCrash) throw error;
    progress("rollback", 0);
    try { await rollback(dir, j, o.ui); }
    catch { throw new Error("Recovery required: rollback incomplete. Original data and journal retained; backend must remain stopped."); }
    throw error;
  }
}
export async function recoverTransactions(o: { agentDir: string; ui?: UiParticipant }): Promise<{ recovered: number; blocked: boolean; warnings: string[] }> {
  const agentDir = path.resolve(o.agentDir), base = path.join(agentDir, TXDIR); let recovered = 0; const warnings: string[] = [];
  if (!(await maybeStat(base))) return { recovered, blocked: false, warnings };
  await checkParents(base); await verifyPrivate(base, true);
  for (const name of (await fs.readdir(base)).sort()) {
    if (!/^[a-f0-9-]{36}$/.test(name)) { warnings.push("Unrecognized recovery entry; manual review required."); continue; }
    const dir = path.join(base, name);
    try { const j = await readJournal(dir, agentDir); if (j.state === "committed" || j.state === "rolledback") await cleanup(dir, j); else await rollback(dir, j, o.ui); recovered++; }
    catch { warnings.push("Recovery required for transaction " + name + "; journal and original data retained."); }
  }
  return { recovered, blocked: warnings.length > 0, warnings };
}
