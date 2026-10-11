import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DefaultPackageManager, type SettingsManager } from "@earendil-works/pi-coding-agent";
import type { DefaultResourceLoaderOptions } from "../builtin/pi-subagents/src/desktop-host";
import { getProjectTrustStatus } from "./project-trust";

/** Exclude another installation BEFORE its extension factory can execute. */
export function isSubagentsSource(path: string, source = ""): boolean {
  if (/(?:^|[/\\])pi-subagents(?:[/\\]|$)/i.test(path) || /(?:^|[/@])pi-subagents(?:@|$)/i.test(source.replace(/^npm:/, ""))) return true;
  let dir = dirname(path);
  while (dir !== dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        return typeof pkg.name === "string" && pkg.name.split("/").at(-1) === "pi-subagents";
      } catch { return false; }
    }
    dir = dirname(dir);
  }
  return false;
}

/** Resolve without importing, then load only approved files and registered built-ins.
 * Keep the caller's noExtensions policy distinct from the SDK mode used to
 * prevent a second, unfiltered discovery pass.
 */
export async function filteredSubagentLoaderOptions(
  options: DefaultResourceLoaderOptions,
  settingsManager: SettingsManager,
): Promise<DefaultResourceLoaderOptions> {
  const trusted = getProjectTrustStatus(options.cwd, options.agentDir).trusted;
  // Resolve settings under the same trust decision as the SDK. In particular,
  // untrusted project settings must not enable/disable built-ins or packages.
  settingsManager.setProjectTrusted(trusted);
  await settingsManager.reload();
  const builtinExtensions = (options.extensionFactories ?? []).flatMap((extension) =>
    typeof extension !== "function" && extension.builtin === true ? [extension.name] : []);
  const manager = new DefaultPackageManager({
    cwd: options.cwd, agentDir: options.agentDir, settingsManager, builtinExtensions,
  });
  const disabledBuiltins = new Set(options.disabledBuiltinExtensions ?? []);
  const isBuiltinPath = (path: string) => path.startsWith("builtin:");
  const discovered = options.noExtensions ? [] : (await manager.resolve(async () => "skip")).extensions;
  const explicit = options.additionalExtensionPaths?.length
    ? (await manager.resolveExtensionSources(options.additionalExtensionPaths, { temporary: true })).extensions
    : [];
  const insideProject = (path: string) => {
    const local = relative(options.cwd, resolve(path));
    return local === "" || (!local.startsWith("..") && !isAbsolute(local));
  };
  // Built-in IDs are not filesystem paths. Explicit file paths are labelled
  // "temporary" by the SDK, so inspect their original source when gating trust.
  const safeExplicit = trusted ? explicit : explicit.filter((entry) =>
    isBuiltinPath(entry.path) ||
    ![entry.path, entry.metadata.source, entry.metadata.baseDir].some((path) => path && insideProject(path)));
  const paths = [...safeExplicit, ...discovered].filter((entry) => entry.enabled
    && (isBuiltinPath(entry.path)
      ? !disabledBuiltins.has(entry.path.slice("builtin:".length))
      : (entry.metadata.scope !== "project" || trusted)
        && !isSubagentsSource(entry.path, entry.metadata.source)));
  return { ...options, noExtensions: true, additionalExtensionPaths: [...new Set(paths.map((entry) => entry.path))] };
}
