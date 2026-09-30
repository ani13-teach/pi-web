"use client";

import { useEffect, useMemo, useRef } from "react";
import type { LocalFileOpenHandler } from "@/lib/file-links";

// Do not rearrange the chat (or show its narrow-screen overlay) between the
// two clicks of a double-click. This matches the default Windows interval.
const SINGLE_CLICK_DELAY_MS = 500;

export function useLocalFileClicks(onOpenFile?: LocalFileOpenHandler) {
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = null;
  }, [onOpenFile]);

  return useMemo(() => ({
    preview(filePath: string, detail: number) {
      if (!onOpenFile || detail > 1) return;
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = null;
      // Keyboard activation is not part of a pointer double-click.
      if (detail === 0) {
        onOpenFile(filePath);
        return;
      }
      // A new target supersedes the pending click, without opening a panel
      // that would cover the new target before its second click can arrive.
      pending.current = setTimeout(() => {
        pending.current = null;
        onOpenFile(filePath);
      }, SINGLE_CLICK_DELAY_MS);
    },
    system(filePath: string) {
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = null;
      onOpenFile?.(filePath, { system: true });
    },
  }), [onOpenFile]);
}
