/**
 * The bar that appears when the backend process is gone.
 *
 * Why this exists: the window keeps running when the process behind it dies, so
 * without this the app just looks broken — panels fail and nothing says why.
 *
 * Two rules shaped the behaviour:
 *   - a crash is usually transient, so the first one is retried silently and the
 *     window is reloaded to rebuild every subscription (EventSource and the
 *     in-flight fetches are dead otherwise, and the transcript would sit there
 *     half-drawn); the user sees nothing in the common case;
 *   - only if that fails does the bar show up, still offering a way out (retry)
 *     plus the recent output, so a failure can be reported.
 *
 * Everything here talks to the main process through the preload bridge. It must
 * never use /api/*: those requests go to the process that just died.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { BackendPush, DesktopBridge } from "../shared/contract";

/**
 * How long "we already tried that" stays true: one silent retry per this
 * window. Kept in sessionStorage because a successful silent retry reloads the
 * window and component memory does not survive that — without it, a crash loop
 * would look like a first crash forever.
 */
const RETRY_WINDOW_MS = 5 * 60_000;
const RETRY_MARK = "pi-desktop:backend-retry-at";
const LOG_LINES = 20;

function lastSilentRetryAt(): number {
  try {
    return Number(sessionStorage.getItem(RETRY_MARK) ?? "") || 0;
  } catch {
    return 0;
  }
}

function markSilentRetry(at: number): void {
  try {
    sessionStorage.setItem(RETRY_MARK, String(at));
  } catch {
    // storage blocked: the retry window simply does not persist
  }
}

function bridge(): DesktopBridge | undefined {
  return (window as { piDesktop?: DesktopBridge }).piDesktop;
}

export function BackendRecoveryBar() {
  /** Non-null while the bar is showing; the text explains the last failure. */
  const [failure, setFailure] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);

  const log = useRef<string[]>([]);

  const recover = useCallback(async (): Promise<boolean> => {
    try {
      await bridge()?.restartBackend();
      window.location.reload();
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    const api = bridge();
    if (!api) return;

    return api.onPush((push: BackendPush) => {
      if (push.type === "backend.log") {
        log.current = [...log.current, push.message].slice(-LOG_LINES);
        return;
      }
      if (push.type !== "backend.down") return;

      // One silent retry per window. Crashes closer together than that are not a
      // hiccup, so stop pretending and hand the decision to the user.
      const now = Date.now();
      if (now - lastSilentRetryAt() >= RETRY_WINDOW_MS) {
        markSilentRetry(now);
        void recover().then((ok) => {
          // The reload above means success; reaching here means it did not work.
          if (!ok) setFailure(push.reason);
        });
        return;
      }
      setAttempts(0);
      setFailure(push.reason);
    });
  }, [recover]);

  const retry = useCallback(() => {
    setAttempts((count) => count + 1);
    void recover();
  }, [recover]);

  const copyDiagnostics = useCallback(() => {
    const api = bridge();
    const report = [
      `Pi Desktop ${api?.app.version ?? "?"} (${api?.app.platform ?? "?"})`,
      `backend stopped: ${failure ?? "unknown"}`,
      `retry attempts in this window: ${attempts}`,
      "--- backend output (last lines) ---",
      ...log.current,
    ].join("\n");
    void navigator.clipboard?.writeText(report).catch(() => {});
  }, [attempts, failure]);

  if (failure === null) return null;

  return (
    <div data-backend-recovery="down" style={barStyle}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#e06c75", flex: "0 0 auto" }} />
      <span style={{ fontWeight: 600, flex: "0 0 auto" }}>后台进程已停止</span>
      <span
        title={failure}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--text-dim)",
          flex: "1 1 auto",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {attempts > 0 ? `已重试 ${attempts} 次 · ` : ""}
        {failure}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
        <button type="button" onClick={retry} style={primaryButton}>
          重启后台
        </button>
        <button type="button" onClick={copyDiagnostics} style={secondaryButton}>
          复制诊断信息
        </button>
      </span>
    </div>
  );
}

const buttonBase = {
  font: "inherit",
  fontSize: 13,
  fontWeight: 600,
  padding: "6px 12px",
  borderRadius: 8,
  cursor: "pointer",
} as const;

const primaryButton = {
  ...buttonBase,
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  color: "var(--accent-contrast)",
} as const;

const secondaryButton = {
  ...buttonBase,
  background: "transparent",
  border: "1px solid var(--border)",
  color: "var(--text)",
} as const;

const barStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  height: 48,
  flex: "0 0 auto",
  padding: "0 14px 0 12px",
  background: "var(--bg-panel)",
  borderBottom: "1px solid var(--border)",
  boxShadow: "inset 3px 0 0 #e06c75",
  color: "var(--text)",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontSize: 14,
} as const;
