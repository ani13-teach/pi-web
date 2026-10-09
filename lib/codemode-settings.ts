import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

function parseSettings(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid settings.json: expected an object");
  }
  const settings = parsed as Record<string, unknown>;
  if (settings.defaultTools !== undefined && (
    !Array.isArray(settings.defaultTools)
    || settings.defaultTools.some((name) => typeof name !== "string")
  )) {
    throw new Error("Invalid settings.json: defaultTools must be an array of strings");
  }
  return settings;
}

/** Preserve allowlists and modifiers instead of replacing the user's tool selection. */
export function updateCodemodeDefaultTools(
  current: readonly string[] | undefined,
  enabled: boolean,
): string[] {
  const entries = current ?? [];
  const isAllowlist = current !== undefined && (
    entries.length === 0 || entries.some((name) => !name.startsWith("+") && !name.startsWith("-"))
  );
  const next = entries.filter((name) => !["codemode", "+codemode", "-codemode"].includes(name));
  if (enabled) next.push(isAllowlist ? "codemode" : "+codemode");
  else if (!isAllowlist) next.push("-codemode");
  else if (next.length > 0 && next.every((name) => name.startsWith("+") || name.startsWith("-"))) {
    // Removing the last plain name must not turn an allowlist into modifiers
    // that unexpectedly restore all the default coding tools.
    return (SettingsManager.inMemory({ defaultTools: [...entries] }).getDefaultTools() ?? [])
      .filter((name) => name !== "codemode");
  }
  return next;
}

export async function readCodemodeEnabled(
  settingsPath = join(getAgentDir(), "settings.json"),
): Promise<boolean> {
  if (!existsSync(settingsPath)) return false;
  const release = await lockfile.lock(settingsPath, { realpath: false, retries: 10 });
  try {
    const settings = parseSettings(settingsPath);
    const tools = SettingsManager.inMemory({ defaultTools: settings.defaultTools as string[] | undefined }).getDefaultTools();
    return tools?.includes("codemode") === true;
  } finally {
    await release();
  }
}

export async function writeCodemodeEnabled(
  enabled: boolean,
  settingsPath = join(getAgentDir(), "settings.json"),
): Promise<boolean> {
  mkdirSync(dirname(settingsPath), { recursive: true });
  try {
    writeFileSync(settingsPath, "{}", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const release = await lockfile.lock(settingsPath, { realpath: false, retries: 10 });
  try {
    const settings = parseSettings(settingsPath);
    settings.defaultTools = updateCodemodeDefaultTools(settings.defaultTools as string[] | undefined, enabled);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    chmodSync(settingsPath, 0o600);
  } finally {
    await release();
  }
  return enabled;
}
