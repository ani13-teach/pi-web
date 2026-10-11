import type { InlineExtension, LoadExtensionsResult, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createBuiltinAutomodeExtension, preferBuiltinAutomode, BUILTIN_AUTOMODE_PATH } from "./automode-builtin";
import { createBuiltinRpivTodoExtension, preferBuiltinRpivTodo } from "./rpiv-todo-builtin";
import { createDesktopCodemodeExtension } from "./codemode";
import { createProjectCommandBashExtension, preferUserBashExtension } from "./project-command-env";
import { extensionCanonicalNames, parseExtensionsSpec } from "../builtin/pi-subagents/src/resource-policy";

/** Root, child and resumed sessions receive the same ordinary capability providers.
 * Orchestration is registered separately because each session owns its own tasks.
 */
export function createDesktopSessionExtensions(
  cwd: string,
  settingsManager: SettingsManager,
  loadExtensions = true,
): InlineExtension[] {
  return [
    ...(loadExtensions ? [createDesktopCodemodeExtension(), createProjectCommandBashExtension({ cwd, settings: settingsManager }), createBuiltinRpivTodoExtension()] : []),
    createBuiltinAutomodeExtension(),
  ];
}

export const TOOL_SCOPE_GUARD_PATH = "<inline:pi-agent-tool-scope>";

/** Only security handlers are unconditional; ordinary inline capabilities obey settings. */
export function applyDesktopSessionExtensionPolicy(
  loaded: LoadExtensionsResult,
  policy?: (loaded: LoadExtensionsResult) => LoadExtensionsResult,
  ownerExtensionPaths: readonly string[] = [],
): LoadExtensionsResult {
  const preferred = preferBuiltinRpivTodo(preferBuiltinAutomode(preferUserBashExtension(loaded)));
  if (!policy) return preferred;
  const guards = preferred.extensions.filter(entry => entry.path === BUILTIN_AUTOMODE_PATH || entry.path === TOOL_SCOPE_GUARD_PATH || ownerExtensionPaths.includes(entry.path));
  const scoped = policy({ ...preferred, extensions: preferred.extensions.filter(entry => !guards.includes(entry)) });
  return { ...scoped, extensions: [...new Set([...scoped.extensions, ...guards])] };
}

export function createAgentExtensionPolicy(
  extensions: true | string[] | false,
  excludeExtensions: readonly string[] | undefined,
  cwd: string,
): (loaded: LoadExtensionsResult) => LoadExtensionsResult {
  const spec = Array.isArray(extensions) ? parseExtensionsSpec(extensions, cwd) : undefined;
  const all = extensions === true || spec?.wildcard === true;
  const excluded = new Set(excludeExtensions?.map(name => name.toLowerCase()));
  return loaded => ({ ...loaded, extensions: loaded.extensions.filter(entry => {
    const names = extensionCanonicalNames(entry.path);
    return !names.some(name => excluded.has(name)) && (all || names.some(name => spec?.names.has(name)));
  }) });
}
