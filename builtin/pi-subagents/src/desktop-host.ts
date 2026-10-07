import type { AgentSession, DefaultResourceLoader, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agent-manager.js";

// The SDK does not re-export these option interfaces. Derive them from its
// public class instead of depending on unexported SDK subpaths.
export type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
export type ResourceLoaderReloadOptions = NonNullable<Parameters<DefaultResourceLoader["reload"]>[0]>;

export interface DesktopChildInfo {
  parentContext: ExtensionContext;
  agentId?: string;
  profile: string;
  description: string;
  task: string;
  configCwd: string;
  tools: string[];
  loadExtensions: boolean;
  loadSkills: boolean;
  systemPrompt: string;
}

export interface DesktopHost {
  readonly cwd: string;
  /** May be implemented by the host as a live getter. */
  readonly maxConcurrent?: number;
  onManager(manager: AgentManager): void;
  bindChild(session: AgentSession, info: DesktopChildInfo): Promise<void>;
  shutdownChild(session: AgentSession): Promise<void>;
  resourceLoaderOptions?(configCwd: string, options: DefaultResourceLoaderOptions): DefaultResourceLoaderOptions | Promise<DefaultResourceLoaderOptions>;
  reloadOptions?(configCwd: string): ResourceLoaderReloadOptions;
}

// Each Desktop root imports the single-file bundle with a unique query. This
// module and every relative dependency therefore belong to that root only.
export let host: DesktopHost | undefined;

export function configureDesktopHost(value?: DesktopHost): void {
  host = value;
}

export function desktopCwd(): string {
  return host?.cwd ?? process.cwd();
}
