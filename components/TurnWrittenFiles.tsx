"use client";

import { useI18n } from "@/hooks/useI18n";
import { useLocalFileClicks } from "@/hooks/useLocalFileClicks";
import { getFileName } from "@/lib/file-paths";
import type { LocalFileOpenHandler } from "@/lib/file-links";
import type { WrittenFile } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";

/**
 * Lists the files a turn actually wrote, as buttons that open each one in the
 * preview pane. Entries come from the turn's successful `write`/`edit` tool
 * calls — the reply text is never scanned for paths.
 */
export function TurnWrittenFiles({ files, onOpenFile }: {
  files: WrittenFile[];
  onOpenFile?: LocalFileOpenHandler;
}) {
  const { t } = useI18n();
  const fileClicks = useLocalFileClicks(onOpenFile);
  if (files.length === 0) return null;

  return (
    <div aria-label={t("chat.filesWritten")} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 }}>
      {files.map(({ filePath }) => {
        const name = getFileName(filePath);
        return (
          <button
            key={filePath}
            type="button"
            title={`${filePath}\n${t("chat.localFileOpenHint")}`}
            aria-label={t("chat.openWrittenFile", { name })}
            onClick={(event) => fileClicks.preview(filePath, event.detail)}
            onDoubleClick={() => fileClicks.system(filePath)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--text)",
              background: "var(--bg-subtle)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            {getFileIcon(name, 12)}
            <span>{name}</span>
          </button>
        );
      })}
    </div>
  );
}
