/**
 * Ships pi-automode with the app.
 *
 * Auto mode used to exist only as a globally installed Pi plugin under
 * `~/.pi/agent/extensions/pi-automode`. Pi Desktop now carries its own copy in
 * `builtin/automode/` and injects it as an inline extension, so a fresh install
 * has auto mode without a second install step.
 *
 * The vendored copy resolves its configuration file the same way the plugin
 * does (`~/.pi/agent/extensions/pi-automode/config.json`, hard-coded in
 * `builtin/automode/extensions/auto-mode/constants.ts`), so the Automode
 * settings panel drives whichever copy is live.
 */
import type { InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { createPiAutomode } from "../builtin/automode/extensions/index.ts";

export const BUILTIN_AUTOMODE_NAME = "pi-desktop-automode";
/** Extension path Pi assigns to a named inline factory (`<inline:${name}>`). */
export const BUILTIN_AUTOMODE_PATH = `<inline:${BUILTIN_AUTOMODE_NAME}>`;
export const BUILTIN_AUTOMODE_VERSION = "1.14.0";
/** See builtin/automode/VENDOR.md for the commit and the local patch on top. */
export const BUILTIN_AUTOMODE_BASED_ON = "czottmann/pi-automode 011bd1f + local changes";

/** Directory name of the plugin this build replaces; used to recognize the duplicate. */
const PLUGIN_DIR_SEGMENT = "pi-automode";

export function createBuiltinAutomodeExtension(): InlineExtension {
  return { name: BUILTIN_AUTOMODE_NAME, factory: createPiAutomode() };
}

/**
 * Keep the built-in copy and drop a globally installed one.
 *
 * Two copies would register the same commands and the same `automode_inspect`
 * tool twice, and both would run their own classifier. The built-in copy wins
 * because it is the one this build keeps in step with the settings panel.
 */
export function preferBuiltinAutomode(base: LoadExtensionsResult): LoadExtensionsResult {
  const hasBuiltin = base.extensions.some((extension) => extension.path === BUILTIN_AUTOMODE_PATH);
  if (!hasBuiltin) return base;
  const duplicates = new Set(
    base.extensions
      .filter((extension) => extension.path !== BUILTIN_AUTOMODE_PATH)
      .filter((extension) =>
        extension.path.replaceAll("\\", "/").split("/").includes(PLUGIN_DIR_SEGMENT))
      .map((extension) => extension.path),
  );
  if (duplicates.size === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !duplicates.has(extension.path)),
    errors: base.errors.filter((error) => {
      if (duplicates.has(error.path)) return false;
      if (error.path !== BUILTIN_AUTOMODE_PATH) return true;
      // The dropped copy still collides on tool names; that diagnostic is stale.
      return ![...duplicates].some((duplicate) => error.error.includes(duplicate));
    }),
  };
}
