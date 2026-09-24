import type { TaskStatus } from "../tool/types.js";

export const I18N_NAMESPACE = "@juicesharp/rpiv-todo";

// Pi's installed rpiv-i18n plugin publishes a live, process-wide snapshot.
// The original rpiv-todo is loaded before Pi Web replaces its session binding,
// so its locale strings are already registered there. Reading this snapshot
// avoids loading a second copy of the SDK from the bundled backend (which
// cannot resolve the user's npm plugin directory), while preserving live
// /languages updates. Without rpiv-i18n, use the original English fallbacks.
type I18nSnapshot = { namespaces?: Record<string, Record<string, string>> };
export function t(key: string, fallback: string): string {
  const snapshot = (globalThis as unknown as Record<symbol, I18nSnapshot | undefined>)[Symbol.for("rpiv-i18n")];
  const value = snapshot?.namespaces?.[I18N_NAMESPACE]?.[key];
  return typeof value === "string" ? value : fallback;
}

export function formatStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "pending": return t("status.pending", "pending");
    case "in_progress": return t("status.in_progress", "in progress");
    case "completed": return t("status.completed", "completed");
    case "deleted": return t("status.deleted", "deleted");
  }
}
