import { createEventBus, DefaultResourceLoader, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { DefaultResourceLoaderOptions, ResourceLoaderReloadOptions } from "../builtin/pi-subagents/src/desktop-host";
import { projectTrustReloadOptions } from "./project-trust";
import { filteredSubagentLoaderOptions } from "./extension-loader-options";

type InitialLoader = { loader: ResourceLoader; extensionPaths: string[] };

/** Keep the original policy and one SDK loader throughout the session.
 * SDK 1.1.0 retains the constructor's additionalExtensionPaths array by reference.
 * Updating our session-owned array lets its normal reload clear extension caches
 * and reset module state. Regression tests guard this pinned-SDK integration.
 */
export class FilteredResourceLoader implements ResourceLoader {
  private readonly current: ResourceLoader;
  private readonly options: DefaultResourceLoaderOptions;
  private readonly extensionPaths: string[];

  constructor(options: DefaultResourceLoaderOptions, initial?: InitialLoader) {
    this.options = {
      ...options,
      additionalExtensionPaths: options.additionalExtensionPaths ? [...options.additionalExtensionPaths] : undefined,
      extensionFactories: options.extensionFactories ? [...options.extensionFactories] : undefined,
      eventBus: options.eventBus ?? createEventBus(),
    };
    this.extensionPaths = initial?.extensionPaths ?? [];
    // Construction is inert. No extension imports happen before reload filters.
    this.current = initial?.loader ?? new DefaultResourceLoader({
      ...this.options, noExtensions: true, additionalExtensionPaths: this.extensionPaths,
    });
  }

  async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
    const settingsManager = this.options.settingsManager;
    if (!settingsManager) throw new Error("FilteredResourceLoader requires a settingsManager");
    const filtered = await filteredSubagentLoaderOptions(this.options, settingsManager);
    this.extensionPaths.splice(0, this.extensionPaths.length, ...(filtered.additionalExtensionPaths ?? []));
    await this.current.reload(options ?? projectTrustReloadOptions(this.options.cwd, this.options.agentDir));
  }

  getExtensions() { return this.current.getExtensions(); }
  getSkills() { return this.current.getSkills(); }
  getPrompts() { return this.current.getPrompts(); }
  getThemes() { return this.current.getThemes(); }
  getAgentsFiles() { return this.current.getAgentsFiles(); }
  getSystemPrompt() { return this.current.getSystemPrompt(); }
  getSystemPromptSource() { return this.current.getSystemPromptSource(); }
  getAppendSystemPrompt() { return this.current.getAppendSystemPrompt(); }
  getAppendSystemPromptSources() { return this.current.getAppendSystemPromptSources(); }
  extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]) { this.current.extendResources(paths); }
}
