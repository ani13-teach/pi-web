"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi, getFileDirectory, getFileName, joinFilePath, normalizeFilePathSlashes } from "@/lib/file-paths";
import { FolderIcon, getFileIcon } from "./FileIcons";

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface Props {
  filePath: string;
  sourceSessionId?: string | null;
  onOpenFile: (filePath: string, fileName: string) => void;
  onReveal: (filePath: string) => void;
}

export function LinkedFileExplorer({ filePath, sourceSessionId, onOpenFile, onReveal }: Props) {
  const { t } = useI18n();
  const [requestedPath, setRequestedPath] = useState(filePath);
  const [refresh, setRefresh] = useState(0);
  const [address, setAddress] = useState(filePath);
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDirectory("");
    setEntries([]);
    setSelectedName(null);
    const params = new URLSearchParams();
    if (sourceSessionId) params.set("sessionId", sourceSessionId);

    void (async () => {
      params.set("type", "meta");
      const metaResponse = await fetch(`/api/files/${encodeFilePathForApi(requestedPath)}?${params}`, { signal: controller.signal });
      const meta = await metaResponse.json() as { isDir?: boolean; error?: string };
      if (!metaResponse.ok || meta.error) throw new Error(meta.error ?? `HTTP ${metaResponse.status}`);
      if (controller.signal.aborted) return;
      if (typeof meta.isDir !== "boolean") throw new Error(t("files.invalidMetadata"));
      const target = normalizeFilePathSlashes(requestedPath);
      const parent = meta.isDir ? target : getFileDirectory(target);
      if (!parent) throw new Error(t("files.noParentDirectory"));
      setDirectory(parent);
      setAddress(parent);
      params.set("type", "list");
      const listResponse = await fetch(`/api/files/${encodeFilePathForApi(parent)}?${params}`, { signal: controller.signal });
      const list = await listResponse.json() as { entries?: FileEntry[]; path?: string; error?: string };
      if (!listResponse.ok || list.error) throw new Error(list.error ?? `HTTP ${listResponse.status}`);
      if (controller.signal.aborted) return;
      const currentDirectory = normalizeFilePathSlashes(list.path ?? parent);
      const nextEntries = list.entries ?? [];
      setDirectory(currentDirectory);
      setAddress(currentDirectory);
      setEntries(nextEntries);
      const targetName = getFileName(target);
      const match = nextEntries.find((entry) => /^[a-zA-Z]:\//.test(target)
        ? entry.name.toLowerCase() === targetName.toLowerCase()
        : entry.name === targetName);
      setSelectedName(!meta.isDir && match ? match.name : null);
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [requestedPath, sourceSessionId, refresh, t]);

  const navigate = (path: string) => {
    if (!path.trim()) return;
    setLoading(true);
    setError(null);
    setSelectedName(null);
    setRequestedPath(path.trim());
    setAddress(path.trim());
    setRefresh((value) => value + 1);
  };
  const normalizedDirectory = normalizeFilePathSlashes(directory);
  const isRoot = /^(?:[a-zA-Z]:\/?|\/|\/\/[^/]+\/[^/]+\/*)$/.test(normalizedDirectory);
  const parentDirectory = isRoot ? "" : getFileDirectory(directory);
  const selected = entries.find((entry) => entry.name === selectedName && !entry.isDir);
  const buttonStyle = { width: 30, height: 30, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer" } as const;

  return (
    <section aria-label={t("files.explorer")} style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0, color: "var(--text)", fontSize: 12 }}>
      <form onSubmit={(event) => { event.preventDefault(); navigate(address); }} style={{ display: "flex", alignItems: "center", gap: 6, padding: 8, borderBottom: "1px solid var(--border)", minWidth: 0 }}>
        <button type="button" title={t("files.parentDirectory")} aria-label={t("files.parentDirectory")} disabled={loading || !parentDirectory} onClick={() => navigate(parentDirectory)} style={{ ...buttonStyle, opacity: loading || !parentDirectory ? 0.4 : 1 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 12 6-6 6 6M12 6v14" /></svg>
        </button>
        <input aria-label={t("files.location")} value={address} onChange={(event) => setAddress(event.target.value)} style={{ minWidth: 0, width: "100%", flex: 1, height: 30, padding: "0 8px", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, fontSize: 12 }} />
        <button type="button" title={t("i18n.refresh")} aria-label={t("i18n.refresh")} onClick={() => setRefresh((value) => value + 1)} style={buttonStyle}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></svg>
        </button>
        <button type="button" title={t("files.viewContents")} aria-label={t("files.viewContents")} disabled={loading || !!error || !selected} onClick={() => { if (selected) onOpenFile(joinFilePath(directory, selected.name), selected.name); }} style={{ ...buttonStyle, opacity: loading || !!error || !selected ? 0.4 : 1 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h6" /></svg>
        </button>
      </form>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 8 }}>
        {loading ? <div role="status" style={{ padding: 8, color: "var(--text-dim)" }}>{t("files.loading")}</div> : error ? <div role="alert" style={{ padding: 8, color: "#f87171", overflowWrap: "anywhere" }}>{error}</div> : entries.length === 0 ? <div role="status" style={{ padding: 8, color: "var(--text-dim)" }}>{t("files.emptyDirectory")}</div> : (
          <div role="listbox" aria-label={t("files.explorer")}>
            {entries.map((entry) => {
              const fullPath = joinFilePath(directory, entry.name);
              return (
                <button key={entry.name} type="button" role="option" aria-selected={entry.name === selectedName} title={fullPath}
                  onClick={() => { if (entry.isDir) navigate(fullPath); else setSelectedName(entry.name); }}
                  onDoubleClick={() => { if (!entry.isDir) onReveal(fullPath); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, height: 32, width: "100%", padding: "0 8px", border: "none", borderRadius: 4, background: entry.name === selectedName ? "var(--bg-selected)" : "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 12 }}>
                  <span style={{ display: "flex", flexShrink: 0 }}>{entry.isDir ? <FolderIcon size={16} /> : getFileIcon(entry.name, 16)}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{entry.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
