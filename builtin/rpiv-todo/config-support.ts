// Minimal subset of @juicesharp/rpiv-config 2.9.0 needed by rpiv-todo.
// Keep its XDG/legacy lookup and guidance validation without depending on a
// globally installed rpiv package in the desktop bundle.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface GuidanceFields {
  promptSnippet?: string;
  promptGuidelines?: string[];
  description?: string;
}

function readConfig<T>(path: string): T {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}) as T;
  } catch (error) {
    console.warn(`rpiv-config: invalid JSON at ${path}, using default ({}) — ${(error as Error).message}`);
    return {} as T;
  }
}

export function loadJsonConfigWithLegacyFallback<T>(name: string): T {
  const legacy = join(homedir(), ".config", name, "config.json");
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const expanded = xdg === "~" ? homedir() : xdg?.startsWith("~/") ? join(homedir(), xdg.slice(2)) : xdg;
  const path = expanded && isAbsolute(expanded) ? join(expanded, name, "config.json") : legacy;
  return existsSync(path) ? readConfig<T>(path) : existsSync(legacy) ? readConfig<T>(legacy) : {} as T;
}

export function validateGuidanceFields(fields: unknown): GuidanceFields {
  if (!fields || typeof fields !== "object") return {};
  const g = fields as Record<string, unknown>;
  const result: GuidanceFields = {};
  if (typeof g.promptSnippet === "string" && g.promptSnippet.length > 0) result.promptSnippet = g.promptSnippet;
  if (Array.isArray(g.promptGuidelines) && g.promptGuidelines.length > 0 &&
      g.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)) result.promptGuidelines = g.promptGuidelines;
  if (typeof g.description === "string" && g.description.length > 0) result.description = g.description;
  return result;
}
