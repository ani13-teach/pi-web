import { getCurrentTools } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent, ResourceLoader, InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Canonical name of an extension for `extensions: [...]` allowlist matching.
 * Lowercased — extension names match case-insensitively so `extensions: [Mcp]`
 * resolves the same as `[mcp]`. Tool names within `ext:foo/bar` are not affected.
 * Directory extensions (`foo/index.ts`) resolve to the parent directory name;
 * single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
  if (extPath.startsWith("builtin:")) return extPath.slice(8).toLowerCase();
  if (extPath.startsWith("<inline:") && extPath.endsWith(">")) {
    const name = extPath.slice(8, -1).toLowerCase();
    return name === "pi-desktop-rpiv-todo" ? "rpiv-todo" : name === "pi-web-project-command-environment" ? "bash" : name;
  }
  const base = basename(extPath);
  const name = base === "index.ts" || base === "index.js"
    ? basename(dirname(extPath))
    : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

/**
 * The unscoped, lowercased npm short name of the pi package that DECLARES
 * `extPath` as an extension entry — or undefined if the entry doesn't belong to
 * such a package.
 *
 * Climbs from the entry's directory looking for the package that owns it, and
 * stays strictly within that package's tree by stopping at two structural
 * boundaries — no hardcoded depth:
 *   - the FIRST `package.json` found (the package root); the entry's own
 *     manifest always sits at the root, above the entry, below any node_modules.
 *   - a `node_modules` directory: a package never spans one (it's where OTHER
 *     packages live), so reaching it means we've climbed out of the package —
 *     stop before reading a consumer's or parent package's manifest.
 * The name is then taken only when that root's `pi.extensions` manifest actually
 * lists this entry. That "declares this entry" check is deliberate: our own test
 * fixtures live under this repo, whose root manifest declares `./src/index.ts`
 * as `@tintinweb/pi-subagents`, so a looser rule would misattribute every
 * co-located file to `pi-subagents`.
 */
function extensionPackageName(extPath: string): string | undefined {
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }
    // First package.json wins — it's the package root; decide here.
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/**
 * All names an extension answers to for allowlist matching (lowercased): its
 * path-derived {@link extensionCanonicalName} plus, when a pi package manifest
 * declares this entry, that package's unscoped short name (`@scope/foo` → `foo`).
 * #143: an extension installed via `pi.extensions: ["./src/index.ts"]` would
 * otherwise only ever match as `src` (the source directory), never by its
 * package name. The path-derived name is preserved, so it keeps matching too.
 */
export function extensionCanonicalNames(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extPath.startsWith("builtin:") || extPath.startsWith("<inline:") ? undefined : extensionPackageName(extPath);
  return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

/**
 * Classify `extensions: string[]` frontmatter entries for the loader-level filter.
 *
 * An entry is a PATH iff it contains a path separator or starts with `~`; otherwise
 * it is a NAME. `"*"` sets the wildcard flag (keep all default-discovered extensions).
 *
 * Path entries are resolved (`~` expanded, made absolute against `cwd`) into `paths`
 * — and their canonical name is also added to `names`. The loader override matches
 * everything by canonical name, so path-loaded extensions are matched via their name
 * rather than their post-staging `Extension.path`.
 */
export function parseExtensionsSpec(
  entries: string[],
  cwd: string,
): { names: Set<string>; paths: string[]; wildcard: boolean } {
  const names = new Set<string>();
  const paths: string[] = [];
  let wildcard = false;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") {
      wildcard = true;
      continue;
    }
    const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
    if (!isPathEntry) {
      names.add(entry.toLowerCase());
      continue;
    }
    let p = entry;
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = homedir() + p.slice(1);
    }
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    paths.push(abs);
    names.add(extensionCanonicalName(abs));
  }
  return { names, paths, wildcard };
}

/**
 * Parse raw `ext:` selector strings (from the `tools:` CSV) into the set of
 * extension names to keep loaded and a per-extension tool-narrowing map.
 *
 * `ext:foo` → `extNames` has `foo`, no narrowing entry (all of foo's tools).
 * `ext:foo/bar` → `extNames` has `foo`, `narrowing.foo` has `bar` (only `bar`).
 * A name lands in `narrowing` only when a `/tool` form is seen, so a bare
 * `ext:foo` alongside `ext:foo/bar` leaves narrowing in effect (narrowing wins).
 * The split is on the first `/`; extension canonical names never contain `/`.
 */
export function parseExtSelectors(entries: string[]): {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
} {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (!raw) continue;
    const body = raw.slice("ext:".length);
    const slash = body.indexOf("/");
    // Extension name matches case-insensitively (matches the loader-side canonical
    // name). Tool names are case-preserved — they're matched against pi-mono's
    // registered identifiers, which are case-sensitive.
    const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
    if (!name) continue;
    extNames.add(name);
    if (slash === -1) continue;
    const tool = body.slice(slash + 1).trim();
    if (!tool) continue;
    let set = narrowing.get(name);
    if (!set) {
      set = new Set();
      narrowing.set(name, set);
    }
    set.add(tool);
  }
  return { extNames, narrowing };
}

/**
 * Keep a subagent's tool scope correct as extensions register tools over time.
 *
 * Extensions may call `registerTool` long after load — pi-mcp from `session_start`,
 * context-mode from `before_agent_start` — so scope has to be re-derived rather than
 * snapshotted. `registerTool` writes into the very `extension.tools` maps this reads,
 * so `inScope()` sees late arrivals on the next call.
 *
 * Two enforcement points, because neither covers the whole picture:
 *
 *   - `turn_end` re-narrows the ACTIVE set. pi emits `turn_end` immediately before
 *     `prepareNextTurn` re-snapshots `agent.state.tools`, and session listeners run
 *     synchronously, so the narrow lands in time for turns 2..N.
 *   - `beforeToolCall` blocks out-of-scope calls. Turn 1 cannot be narrowed at all:
 *     `before_agent_start` fires INSIDE `prompt()` and may widen the tool set, but
 *     `createContextSnapshot()` freezes that turn's tools immediately after — there
 *     is no hook in between. A call-time check is the only correct guard there.
 *
 * Both are installed on the session and deliberately NOT unsubscribed: they must
 * outlive the `runAgent` call so resumed/steered turns stay scoped. pi's `dispose()`
 * clears `_eventListeners`, so they die with the session rather than leaking.
 *
 * Only meaningful when extensions are loaded — under `noExtensions`/`isolated` the
 * static `allowedToolNames` allowlist already gates the registry itself.
 */
export function installExtensionToolScope(
  session: AgentSession,
  ctx: {
    loader: ResourceLoader;
    toolNames: string[];
    disallowedSet: Set<string> | undefined;
    extNames: Set<string>;
    narrowing: Map<string, Set<string>>;
    /**
     * Injected `customTools` to keep active regardless of the built-in list.
     *
     * Two kinds arrive here and they are blocked for different reasons: opt-in
     * nested-delegation tools share EXCLUDED_TOOL_NAMES' names, and
     * StructuredOutput is simply not a built-in, so neither survives a `keep`
     * seeded from `toolNames`.
     */
    readmitToolNames: Set<string>;
    defaultToolNames?: () => readonly string[] | undefined;
    guard?: ToolScopeGuard;
  },
): () => void {
  const { loader, toolNames, disallowedSet, extNames, narrowing, readmitToolNames } = ctx;

  // The names allowed right now. Mirrors the `ext:` opt-in flip: when any `ext:`
  // selector is present, extension tools become an explicit allowlist — a loaded
  // extension not named by a selector contributes nothing (its handlers still ran),
  // and `ext:foo/bar` narrows `foo` to just `bar`.
  const inScope = (): Set<string> => {
    const keep = new Set(toolNames.filter((t) => !disallowedSet?.has(t)));
    const optInActive = extNames.size > 0;
    for (const extension of loader.getExtensions().extensions) {
      const canons = extensionCanonicalNames(extension.path);
      if (optInActive && !canons.some((c) => extNames.has(c))) continue;
      // First alias that carries a narrowing set — a user won't narrow one
      // extension under two different names, so first-match is correct.
      const narrowed = canons.map((c) => narrowing.get(c)).find(Boolean);
      for (const name of extension.tools.keys()) {
        if (narrowed && !narrowed.has(name)) continue;
        if (disallowedSet?.has(name)) continue;
        // Registration supplies the capability; activation follows the same opt-in setting as the root.
        if (name === "codemode" && !toolNames.includes(name) && !optInActive && !ctx.defaultToolNames?.()?.includes(name)) continue;
        keep.add(name);
      }
    }

    // Injected tools are legitimately active for this agent — re-admit them so
    // the renarrow keeps them in the active set and beforeToolCall doesn't
    // block them. Already vetted against `disallowed_tools` by the caller,
    // which is the only place that knows which kind may be taken back.
    for (const name of readmitToolNames) keep.add(name);
    return keep;
  };

  // Status views must use the same live scope as execution, not merely the SDK registry.
  (session as ScopeAwareSession)[TOOL_SCOPE_CHECK] = name => inScope().has(name);

  const renarrow = () => {
    const allowed = inScope();
    const current = session.getActiveToolNames();
    // Capability scope is not model exposure. Keep indirect tools callable through
    // discovery without declaring all of them, and preserve explicit tool_search loads.
    const active = new Set(current);
    const next = session.getAllTools().filter(tool => allowed.has(tool.name) && tool.exposure !== "hidden"
      && (!(tool.exposure === "codemode" || tool.exposure === "deferred") || active.has(tool.name) || toolNames.includes(tool.name)))
      .map(tool => tool.name);
    // setActiveToolsByName unconditionally rebuilds the system prompt, so skip
    // the no-op that steady-state turns would otherwise pay for every turn.
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) {
      session.setActiveToolsByName(next);
    }
  };

  ctx.guard?.setScope(inScope);

  // Activate what registered during session_start (eager MCP servers); pi would
  // otherwise leave only its four default built-ins active at turn 1.
  renarrow();

  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") renarrow();
  });

  // A before_agent_start handler or extension command can register tools after
  // turn-end. Reconcile before the SDK rebuilds its authoritative request loadout.
  const priorPrepareRequest = session.agent.prepareRequest;
  session.agent.prepareRequest = async (request, signal) => {
    renarrow();
    const prepared = await priorPrepareRequest?.(request, signal);
    const context = prepared?.context ?? request.context;
    // SDK prompt projections can retain a before_agent_start snapshot. The
    // request loadout must be filtered too; agent-loop records its tool delta.
    const allowed = inScope();
    const toolsRemoved = getCurrentTools(context.messages).filter(tool => !allowed.has(tool.name)).map(tool => ({ name: tool.name }));
    const update = toolsRemoved.length ? { role: "system" as const, content: "", toolsRemoved, timestamp: Date.now() } : undefined;
    if (update) session.sessionManager.appendMessage(update);
    return { ...prepared, context: { ...context,
      messages: update ? [...context.messages, update] : context.messages,
      tools: context.tools?.filter(tool => allowed.has(tool.name)),
    } };
  };

  const priorBeforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    if (!inScope().has(context.toolCall.name)) {
      return {
        block: true,
        reason: `Tool "${context.toolCall.name}" is not available to this subagent.`,
      };
    }
    return priorBeforeToolCall?.(context, signal);
  };
  return renarrow;
}


const TOOL_SCOPE_CHECK = Symbol.for("pi-desktop:tool-scope-check");
type ScopeAwareSession = AgentSession & { [TOOL_SCOPE_CHECK]?: (name: string) => boolean };
export function isToolInSessionScope(session: object, name: string): boolean {
  return (session as ScopeAwareSession)[TOOL_SCOPE_CHECK]?.(name) ?? true;
}

export interface ToolScopeGuard {
  extension: InlineExtension;
  setScope(scope: () => Set<string>): void;
}
/** Also checks nested ctx.executeTool calls, which do not use agent.beforeToolCall. */
export function createToolScopeGuard(): ToolScopeGuard {
  let scope: (() => Set<string>) | undefined;
  return {
    setScope(value) { scope = value; },
    extension: { name: "pi-agent-tool-scope", hidden: true, factory(pi) {
      pi.on("tool_call", (event) => {
        if (scope && !scope().has(event.toolName)) return { block: true, reason: `Tool "${event.toolName}" is not available in this agent's configured scope.` };
      });
    } },
  };
}
