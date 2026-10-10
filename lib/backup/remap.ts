import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BackupDecision, BackupManifest } from "./types.ts";
/** Rewrite structured, known path fields only. Never rewrite chat text or scripts. */
export async function remapStagedPaths(manifest: BackupManifest, stageDir: string, roots: Record<string, string>, decisions: BackupDecision[] = []): Promise<BackupManifest> {
  const result = structuredClone(manifest);
  const bindings = manifest.roots.filter(r => r.originalPath && roots[r.id]).map(r => [path.resolve(r.originalPath), path.resolve(roots[r.id])] as const).sort((a,b) => b[0].length - a[0].length);
  const remap = (v: unknown) => {
    if (typeof v !== "string" || !path.isAbsolute(v)) return v;
    for (const [from,to] of bindings) { const rel = path.relative(from,v); if (rel === "" || rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)) return path.join(to,rel); }
    return v;
  };
  for (const [index, e] of result.entries.entries()) {
    const file = path.join(stageDir, String(index)); if (e.size > 32 * 1024 ** 2) continue;
    let next: string | undefined;
    if (["settings", "models", "auth"].includes(e.kind) && e.relativePath.endsWith(".json")) {
      let value: Record<string, unknown>;
      try { value = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>; }
      catch { throw new Error("Invalid restored configuration JSON"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid restored configuration object");
      if (e.relativePath.endsWith("settings.json")) {
        const sourceRoot = manifest.roots.find(r => r.id === e.rootId)!;
        const sourceBase = sourceRoot.kind === "project" ? path.join(sourceRoot.originalPath,".pi") : sourceRoot.originalPath;
        const consent = new Map(decisions.map(d => [d.resourceId,d]));
        let unresolvedReference = false;
        for (const key of ["extensions", "skills", "prompts", "themes"]) if (Array.isArray(value[key])) {
          for (const item of value[key] as unknown[]) {
            if (typeof item !== "string") { unresolvedReference=true; continue; }
            const raw=item.replace(/^[!+-]/,"");
            const fromHome=manifest.roots.find(r=>r.kind==="home")?.originalPath;
            if (!sourceBase || /^[a-z]+:/i.test(raw) && !path.isAbsolute(raw) || raw.startsWith("~") && !fromHome) { unresolvedReference=true; continue; }
            const original=path.resolve(sourceBase,raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(fromHome!,raw.slice(2)) : raw);
            const dependencies=manifest.resources.filter(r=>{const descriptor=manifest.roots.find(root=>root.id===r.rootId);if(!descriptor?.originalPath)return false;const candidate=path.resolve(descriptor.originalPath,r.relativePath);const rel=path.relative(candidate,original);return rel==="" || rel!==".." && !rel.startsWith(".."+path.sep) && !path.isAbsolute(rel);});
            if (!dependencies.length || dependencies.some(r=>consent.get(r.id)?.activation!=="enable" || !roots[r.rootId] || r.availability!=="offlineReady")) unresolvedReference=true;
          }
          value[key] = (value[key] as unknown[]).map(item => {
            if (typeof item !== "string") return item;
            const prefix=/^[!+-]/.test(item)?item[0]:"", raw=item.slice(prefix.length);
            const fromHome=manifest.roots.find(r=>r.kind==="home")?.originalPath;
            const original=path.resolve(sourceBase,raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(fromHome??sourceBase,raw.slice(2)) : raw);
            return prefix + String(remap(original));
          });
        }
        if (unresolvedReference) {
          result.resources.find(r=>r.id===e.resourceId)!.availability="unresolved";
          result.warnings.push("Configuration deferred: referenced tools are not approved/mapped or their dependencies are unavailable: " + e.relativePath);
        }
        for (const key of ["sessionDir"]) if (key in value) value[key] = remap(value[key]);
        if (Array.isArray(value.packages)) {
          let unresolvedPackage=false;
          value.packages = value.packages.map(p => {
            const originalSource=typeof p === "string" ? p : p && typeof p === "object" ? (p as Record<string,unknown>).source : undefined;
            const captured=manifest.resources.find(r=>{
              const descriptor=manifest.roots.find(root=>root.id===r.rootId), origin=descriptor?.originalPath;
              const rel=origin&&sourceBase?path.relative(sourceBase,origin):"..";
              const scoped=rel!==".." && !rel.startsWith(".."+path.sep) && !path.isAbsolute(rel);
              return typeof originalSource === "string" && scoped && r.kind!=="package" && r.source===originalSource && r.availability==="offlineReady" && roots[r.rootId] && consent.get(r.id)?.activation==="enable";
            });
            if (typeof originalSource !== "string") { unresolvedPackage=true; return p; }
            const remote=/^(?:npm:|git:|https?:|github:|git@)/.test(originalSource);
            const fromHome=manifest.roots.find(root=>root.kind==="home")?.originalPath;
            const originalLocal=remote?undefined:path.resolve(sourceBase,originalSource.startsWith("~/")||originalSource.startsWith("~\\")?path.join(fromHome??sourceBase,originalSource.slice(2)):originalSource);
            const localResource=originalLocal?manifest.resources.find(resource=>{const descriptor=manifest.roots.find(root=>root.id===resource.rootId);if(!descriptor?.originalPath)return false;const base=path.resolve(descriptor.originalPath,resource.relativePath),rel=path.relative(base,originalLocal);return resource.kind!=="package" && (rel==="" || rel!==".." && !rel.startsWith(".."+path.sep) && !path.isAbsolute(rel));}):undefined;
            const approvedLocal=localResource && roots[localResource.rootId] && consent.get(localResource.id)?.activation==="enable" && localResource.availability==="offlineReady";
            if (!remote && !approvedLocal) unresolvedPackage=true;
            const source=captured ? path.join(roots[captured.rootId],captured.relativePath) : originalLocal ? remap(originalLocal) : originalSource;
            return typeof p === "string" ? source : p && typeof p === "object" ? {...p,source}:p;
          });
          if (unresolvedPackage || (value.packages as unknown[]).some(p => /^(?:npm:|git:|https?:|github:|git@)/.test(typeof p === "string" ? p : String(p && typeof p === "object" ? (p as Record<string, unknown>).source ?? "" : "")))) {
            const resource = result.resources.find(r => r.id === e.resourceId)!;
            resource.availability = "unresolved";
            result.warnings.push("Configuration deferred: package sources require explicit reinstallation outside restore: " + e.relativePath);
          }
        }
      }
      next = JSON.stringify(value);
    } else if (e.kind === "session" && e.relativePath.endsWith(".jsonl")) {
      const lines = (await fs.readFile(file, "utf8")).split("\n"); let changed = false;
      for (let i=0;i<lines.length;i++) {
        if (!lines[i]) continue;
        try {
          const row = JSON.parse(lines[i]) as Record<string, unknown>;
          if (row.type === "session") { row.cwd = remap(row.cwd); if (row.parentSession) row.parentSession = remap(row.parentSession); lines[i] = JSON.stringify(row); changed = true; }
          if (row.type === "custom" && row.customType === "pi-web:subagent" && row.data && typeof row.data === "object") { const data = row.data as Record<string, unknown>; if (data.parentSessionPath) data.parentSessionPath = remap(data.parentSessionPath); lines[i]=JSON.stringify(row);changed=true; }
        } catch { /* historical text rows remain byte-for-byte */ }
      }
      if (changed) next = lines.join("\n");
    }
    if (next !== undefined) { const bytes = Buffer.from(next); const h = await fs.open(file,"r+"); try { await h.truncate(0); await h.writeFile(bytes); await h.sync(); } finally { await h.close(); } e.size = bytes.length; e.sha256 = createHash("sha256").update(bytes).digest("hex"); }
  }
  if (result.uiState) {
    for (const key of ["pi-web:last-custom-cwd"]) if (result.uiState[key]) result.uiState[key] = remap(result.uiState[key]) as string;
    for (const key of ["pi-web:last-open-by-workspace"]) if (result.uiState[key]) {
      try { const parsed = JSON.parse(result.uiState[key]); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result.uiState[key] = JSON.stringify(Object.fromEntries(Object.entries(parsed).map(([k,v]) => [remap(k), v]))); } catch { /* unknown preference remains unchanged */ }
    }
  }
  return result;
}
