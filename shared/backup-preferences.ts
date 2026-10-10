import type { BackupUiState } from "./backup";
/** Virtual preview resource: preferences are not filesystem/archive entries. */
export const BACKUP_UI_RESOURCE_ID = "ui-preferences";
/** User preferences only: never profile data, draft text, usage caches or credentials. */
export const BACKUP_PREFERENCE_KEYS = [
  "pi-theme", "pi-locale", "pi-sound-enabled", "pi-quote-selection-enabled", "pi-sidebar-width",
  "pi-right-panel-width", "pi-chat-content-width", "pi-chat-content-font-size", "pi-model-favorites",
  "pi-thinking-expanded", "pi-tool-preset", "pi-web:file-explorer:open", "pi-web:settings-navigation",
  "pi-web:last-open-by-workspace", "pi-web:last-custom-cwd", "pi-web:unread-session-ids",
] as const;
export function validateBackupUiState(value: unknown): BackupUiState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid backup preferences");
  const state: BackupUiState = {};
  let bytes = 0;
  for (const [key, item] of Object.entries(value)) {
    if (!(BACKUP_PREFERENCE_KEYS as readonly string[]).includes(key) || typeof item !== "string" || item.length > 1024 * 1024 || (bytes += item.length) > 4 * 1024 * 1024)
      throw new Error("Invalid backup preferences");
    state[key] = item;
  }
  return state;
}
export function readBackupUiState(storage?: Pick<Storage, "getItem">): BackupUiState {
  const target = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  const state: BackupUiState = {};
  if (target) for (const key of BACKUP_PREFERENCE_KEYS) { const value = target.getItem(key); if (value !== null) state[key] = value; }
  return validateBackupUiState(state);
}
