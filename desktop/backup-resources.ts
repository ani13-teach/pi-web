import path from "node:path";
import type { ResultOf } from "../shared/contract";
/** Pure cached getters only: no new session, reload, imports or package resolution. */
export function loadedBackupResources(sessions: Iterable<{ cwd: string; sessionFile: string; inner: unknown }>): ResultOf<"backup.resources"> {
  const resources: ResultOf<"backup.resources">["resources"] = [], sessionDirs = new Set<string>(), warnings: string[] = [];
  type Loader = { getSkills?: () => { skills: { filePath?: string; baseDir?: string }[] }; getPrompts?: () => { prompts: { filePath?: string }[] }; getExtensions?: () => { extensions: { path?: string; resolvedPath?: string }[] }; getThemes?: () => { themes: { filePath?: string; source?: string }[] }; getAgentsFiles?: () => { agentsFiles: { path: string }[] }; getSystemPromptSource?: () => { path: string } | undefined; getAppendSystemPromptSources?: () => { path: string }[] };
  for (const session of sessions) {
    if (session.sessionFile) sessionDirs.add(path.dirname(session.sessionFile));
    const inner = session.inner as { resourceLoader?: Loader; settingsManager?: { getSessionDir?: () => string | undefined } };
    const configured = inner.settingsManager?.getSessionDir?.(); if (configured) sessionDirs.add(path.resolve(session.cwd, configured));
    const loader = inner.resourceLoader; if (!loader) { warnings.push("A loaded session has no readable resource snapshot."); continue; }
    const add = (p: string | undefined, kind: ResultOf<"backup.resources">["resources"][number]["kind"], baseDir?: string) => {
      if (p && path.isAbsolute(p)) resources.push({ path: p, kind, baseDir, cwd: session.cwd });
    };
    try {
      for (const s of loader.getSkills?.().skills ?? []) add(s.filePath, "skills", s.baseDir);
      for (const p of loader.getPrompts?.().prompts ?? []) add(p.filePath, "prompts");
      for (const e of loader.getExtensions?.().extensions ?? []) add(e.resolvedPath ?? e.path, "extensions");
      for (const a of loader.getAgentsFiles?.().agentsFiles ?? []) add(a.path, "instructions");
      add(loader.getSystemPromptSource?.()?.path, "instructions");
      for (const a of loader.getAppendSystemPromptSources?.() ?? []) add(a.path, "instructions");
      if ((loader.getThemes?.().themes ?? []).some(t => !t.filePath)) warnings.push("Theme snapshots without source paths require declaration-based collection.");
      for (const t of loader.getThemes?.().themes ?? []) add(t.filePath, "themes");
    } catch { warnings.push("A resource snapshot could not be read completely."); }
  }
  return { resources, sessionDirs: [...sessionDirs], warnings: [...new Set(warnings)] };
}
