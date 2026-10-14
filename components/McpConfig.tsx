"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  MCP_REDACTED,
  type McpAction, type McpConfigEntry, type McpExposure, type McpMutation,
  type McpOverview, type McpScope, type McpServerState, type McpSessionView,
} from "../lib/mcp-types";
import {
  ConfigButton, ConfigDetail, ConfigDetailActions, ConfigDetailHeader,
  ConfigDetailHeaderInfo, ConfigDetailStack, ConfigDetailTitle, ConfigEmptyState,
  ConfigField, ConfigFooter, ConfigListAction, ConfigPanelShell, ConfigSidebar,
  ConfigSidebarGroupLabel, ConfigSidebarItem, ConfigSidebarList, ConfigSidebarText,
  ConfigSplitView, ConfigStatusDot, ConfigSwitch,
} from "./SettingsUi";

// Pure renderer helpers: tested without reading configuration or connecting to servers.
export type McpDraft = {
  name: string; transport: "command" | "url"; endpoint: string; args: string;
  advanced: string; enabled: boolean; exposure: McpExposure;
};
const SIMPLE_KEYS = new Set(["command", "url", "args", "enabled", "exposure"]);

export function mcpDraftFrom(entry?: McpConfigEntry): McpDraft {
  const config = entry?.config ?? {};
  const transport = typeof config.url === "string" ? "url" : "command";
  const value = config[transport];
  return {
    name: entry?.name ?? "", transport,
    endpoint: typeof value === "string" && value !== MCP_REDACTED ? value : "",
    args: config.args === MCP_REDACTED ? "" : JSON.stringify(config.args ?? []),
    advanced: JSON.stringify(Object.fromEntries(Object.entries(config).filter(([key]) => !SIMPLE_KEYS.has(key))), null, 2),
    enabled: config.enabled !== false,
    exposure: (["codemode", "deferred", "direct", "hidden"] as unknown[]).includes(config.exposure)
      ? config.exposure as McpExposure : "codemode",
  };
}

function safeJson(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(safeJson);
  if (value && typeof value === "object") return Object.entries(value).every(([key, child]) =>
    !["__proto__", "constructor", "prototype"].includes(key) && safeJson(child));
  return true;
}

export function buildMcpConfig(draft: McpDraft, original?: McpConfigEntry):
  { config: Record<string, unknown>; error?: never } | { error: string; config?: never } {
  let args: unknown;
  let advanced: unknown;
  try { args = !draft.args.trim() && original?.config.args === MCP_REDACTED ? MCP_REDACTED : JSON.parse(draft.args); advanced = JSON.parse(draft.advanced); }
  catch { return { error: "jsonInvalid" }; }
  if (args !== MCP_REDACTED && (!Array.isArray(args) || !args.every((value) => typeof value === "string"))) return { error: "argsInvalid" };
  if (!advanced || typeof advanced !== "object" || Array.isArray(advanced) || !safeJson(advanced)) return { error: "advancedInvalid" };
  const extra = advanced as Record<string, unknown>;
  if (Object.keys(extra).some((key) => SIMPLE_KEYS.has(key))) return { error: "advancedReserved" };
  for (const key of ["env", "headers"]) {
    const value = extra[key];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.values(value).every((child) => typeof child === "string"))) return { error: "advancedInvalid" };
  }
  const endpoint = draft.endpoint.trim() || (original?.config[draft.transport] === MCP_REDACTED ? MCP_REDACTED : "");
  // The server merges patches: changing or removing existing transport fields needs delete/recreate.
  if (original && mcpDraftFrom(original).transport !== draft.transport) return { error: "transportLocked" };
  const config: Record<string, unknown> = { ...original?.config, ...extra, enabled: draft.enabled, exposure: draft.exposure };
  if (!original?.overrideOnly || endpoint) {
    if (!endpoint) return { error: "endpointRequired" };
    config[draft.transport] = endpoint;
    if (draft.transport === "command") config.args = args;
  }
  if (config.command !== undefined && config.url !== undefined) return { error: "transportLocked" };
  return { config };
}

export function mcpReady(server: McpServerState, session: McpSessionView | null): boolean {
  if (!session?.runtimeActive || session.provider !== "builtin" || !server.enabled || server.state !== "connected") return false;
  const active = new Set(session.activeTools);
  const indirect = active.has("codemode") || active.has("tool_search");
  return server.tools.some(tool => tool.callable !== false && (tool.exposure === "direct" ? active.has(tool.registeredName ?? tool.name)
    : (tool.exposure === "codemode" || tool.exposure === "deferred") && indirect))
    || (server.hasResources && server.resourcesCallable !== false && server.exposure !== "hidden" && (server.exposure === "direct"
      ? active.has("read_mcp_resource") || active.has("list_mcp_resources") : indirect));
}

export function mcpLastCall(server: McpServerState): "unverified" | "success" | "failure" {
  return server.lastCall ? (server.lastCall.success ? "success" : "failure") : "unverified";
}

export function mcpApiUrl(cwd: string | null, sessionId: string | null): string {
  const query = new URLSearchParams();
  if (cwd) query.set("cwd", cwd);
  if (sessionId) query.set("sessionId", sessionId);
  return `/api/mcp${query.size ? `?${query}` : ""}`;
}

export function createMcpRequestGate() {
  let generation = 0;
  let controller: AbortController | null = null;
  return {
    next() {
      controller?.abort();
      controller = new AbortController();
      const current = ++generation;
      const signal = controller.signal;
      return { signal, isCurrent: () => generation === current && !signal.aborted };
    },
    cancel() { ++generation; controller?.abort(); controller = null; },
  };
}

export function mcpHttpError(status: number): string {
  // Never show arbitrary server/HTTP text: it may contain credentials or remote results.
  return status === 409 ? "conflict" : "requestFailed";
}
export function mcpEnvironment(advanced: string): [string, string][] | null {
  try {
    const config = JSON.parse(advanced);
    if (!config || typeof config !== "object" || Array.isArray(config)) return null;
    if (config.env === undefined) return [];
    if (!config.env || typeof config.env !== "object" || Array.isArray(config.env)
      || !Object.values(config.env).every(value => typeof value === "string")) return null;
    return Object.entries(config.env) as [string, string][];
  } catch { return null; }
}

export function updateMcpEnvironment(advanced: string, name: string, value: string): string | null {
  const entries = mcpEnvironment(advanced);
  if (!entries || !name || ["__proto__", "constructor", "prototype"].includes(name)) return null;
  const config = JSON.parse(advanced);
  const next = entries.map(([key, previous]) => [key, key === name ? value : previous]);
  if (!entries.some(([key]) => key === name)) next.push([name, value]);
  return JSON.stringify({ ...config, env: Object.fromEntries(next) }, null, 2);
}
export function mcpAdvancedConfigText(advanced: string): string {
  try {
    const config = JSON.parse(advanced);
    if (!config || typeof config !== "object" || Array.isArray(config)) return advanced;
    const { env: _env, ...extra } = config;
    return JSON.stringify(extra, null, 2);
  } catch { return advanced; }
}

export function mergeMcpAdvancedConfig(text: string, previous: string): string | null {
  try {
    const extra = JSON.parse(text);
    if (!extra || typeof extra !== "object" || Array.isArray(extra) || !safeJson(extra) || "env" in extra) return null;
    const old = JSON.parse(previous);
    return JSON.stringify({ ...extra, ...(old?.env !== undefined ? { env: old.env } : {}) }, null, 2);
  } catch { return null; }
}
// End pure renderer helpers.

function McpIcon({ kind = "cube" }: { kind?: "cube" | "command" | "settings" | "status" | "search" | "info" | "chevron" }) {
  const paths = {
    cube: <><path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z" /><path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5" /></>,
    command: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
    settings: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><circle cx="12" cy="12" r="3" /></>,
    status: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
    chevron: <path d="m9 6 6 6-6 6" />,
  };
  return <svg className="mcp-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

function McpSection({ title, kind, children }: { title: string; kind: "cube" | "command" | "settings"; children: ReactNode }) {
  return <section className="mcp-form-section"><h3><McpIcon kind={kind} />{title}</h3>{children}</section>;
}

interface Props {
  cwd: string | null;
  sessionId: string | null;
  onReloaded: () => void;
  active?: boolean;
}

export function McpConfig(props: Props) {
  const { t } = useI18n();
  const [scope, setScope] = useState<McpScope>("global");
  const [hasDraftChanges, setHasDraftChanges] = useState(false);
  const effectiveScope = props.cwd ? scope : "global";
  const chooseScope = (next: McpScope) => {
    if (next === effectiveScope || (hasDraftChanges && !window.confirm(t("mcp.discardConfirm")))) return;
    setHasDraftChanges(false);
    setScope(next);
  };
  return (
    <div className="mcp-settings">
      <McpScopeEditor key={JSON.stringify([props.cwd, props.sessionId, effectiveScope])} {...props} scope={effectiveScope} onDirtyChange={setHasDraftChanges}
        scopeControls={<>
          <div className="mcp-scope-bar" role="group" aria-label={t("mcp.scope")}>
            <ConfigButton aria-pressed={effectiveScope === "global"} onClick={() => chooseScope("global")}>{t("mcp.global")}</ConfigButton>
            <ConfigButton aria-pressed={effectiveScope === "project"} disabled={!props.cwd} onClick={() => chooseScope("project")}>{t("mcp.project")}</ConfigButton>
          </div>
          {!props.cwd && <p className="mcp-sidebar-hint mcp-hint">{t("mcp.noProject")}</p>}
        </>} />
    </div>
  );
}

function McpScopeEditor({ cwd, sessionId, onReloaded, active = true, scope, onDirtyChange, scopeControls }: Props & { scope: McpScope; onDirtyChange: (dirty: boolean) => void; scopeControls: ReactNode }) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<McpOverview | null>(null);
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [original, setOriginal] = useState<McpConfigEntry | undefined>();
  const [revision, setRevision] = useState<string | null>(null);
  const [selectedRuntime, setSelectedRuntime] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [working, setWorking] = useState(false);
  const [confirmation, setConfirmation] = useState<{ kind: "delete" | "apply" | "retry" | "saveApply"; sessionId?: string; name?: string; revision?: string } | null>(null);
  const [tab, setTab] = useState<"basic" | "advanced" | "runtime">("basic");
  const [search, setSearch] = useState("");
  const [envName, setEnvName] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [advancedText, setAdvancedText] = useState<string | null>(null);
  const [advancedInvalid, setAdvancedInvalid] = useState(false);
  const confirmElement = useRef<HTMLElement | null>(null);
  const initializedSelection = useRef(false);
  const gate = useRef(createMcpRequestGate());
  const lock = useRef(false);
  const mounted = useRef(false);
  const callback = useRef(onReloaded);
  callback.current = onReloaded;
  const lastSession = useRef<{ generation: number } | null>(null);
  const view = overview?.config[scope] ?? null;
  const session = overview?.session ?? null;
  const runtime = session?.snapshot?.servers ?? [];
  const runtimeOnly = runtime.filter(item => !view?.servers.some(entry => entry.name === item.name));
  const server = runtime.find((item) => item.name === (draft?.name || selectedRuntime));
  const dirty = draft !== null && (advancedInvalid || !!envName || !!envValue || JSON.stringify(draft) !== JSON.stringify(mcpDraftFrom(original)));
  const editable = !!view?.editable && active && !working && error !== "conflict";
  const draftComplete = !advancedInvalid && !envName && !envValue;
  const canApply = !!session?.runtimeActive && session.provider !== "external"
    && session.provider !== "disabled" && session.applyState !== "applying" && session.applyState !== "queued";

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  // Select the first configuration once; polling must never replace an edited draft.
  useEffect(() => {
    if (!view || initializedSelection.current) return;
    initializedSelection.current = true;
    if (view.servers[0]) {
      setOriginal(view.servers[0]); setDraft(mcpDraftFrom(view.servers[0])); setRevision(view.revision);
    }
  }, [view]);

  useEffect(() => {
    if (!confirmation) return;
    const previous = document.activeElement as HTMLElement | null;
    confirmElement.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
    confirmElement.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [confirmation]);

  const accept = useCallback((body: McpOverview) => {
    setOverview(body);
    const current = body.session;
    if (current) {
      const previous = lastSession.current;
      if (previous && current.applyState === "idle"
        && previous.generation !== current.generation) callback.current();
      if (current.applyState === "idle" || !previous) lastSession.current = { generation: current.generation };
    }
  }, []);

  const load = useCallback(async () => {
    if (lock.current || !mounted.current) return;
    const request = gate.current.next();
    try {
      const response = await fetch(mcpApiUrl(cwd, sessionId), { signal: request.signal });
      if (!response.ok) throw new Error(mcpHttpError(response.status));
      const body = await response.json() as McpOverview;
      if (!body?.config?.global || !Array.isArray(body.affectedSessions)) throw new Error("requestFailed");
      if (request.isCurrent() && mounted.current) { accept(body); return body; }
    } catch (cause) {
      if (request.isCurrent() && mounted.current) setError(cause instanceof Error && cause.message === "conflict" ? "conflict" : "requestFailed");
    }
  }, [cwd, sessionId, accept]);

  useEffect(() => {
    if (!active) return;
    mounted.current = true;
    setWorking(lock.current);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await load();
      if (mounted.current) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { mounted.current = false; clearTimeout(timer); gate.current.cancel(); };
  }, [active, load]);

  const mutate = async (body: McpMutation | McpAction, method: "PUT" | "POST", after?: (body: McpOverview) => void) => {
    if (lock.current || !mounted.current) return;
    lock.current = true;
    setWorking(true); setError(null);
    const request = gate.current.next();
    try {
      const target = "sessionId" in body ? body.sessionId : sessionId;
      const response = await fetch(mcpApiUrl(cwd, target), {
        method, signal: request.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(mcpHttpError(response.status));
      const result = await response.json() as McpOverview;
      if (!result?.config?.global || !Array.isArray(result.affectedSessions)) throw new Error("requestFailed");
      if (!request.isCurrent() || !mounted.current) return;
      if (target === sessionId) accept(result);
      after?.(result);
      return result;
    } catch (cause) {
      if (request.isCurrent() && mounted.current) setError(cause instanceof Error && cause.message === "conflict" ? "conflict" : "requestFailed");
    } finally {
      lock.current = false;
      if (mounted.current) { setWorking(false); void load(); }
    }
  };

  const edit = (entry?: McpConfigEntry) => {
    if (working || (dirty && !window.confirm(t("mcp.discardConfirm")) )) return;
    setConfirmation(null);
    setDraft(mcpDraftFrom(entry)); setOriginal(entry); setRevision(view?.revision ?? null);
    setSelectedRuntime(null); setSaved(false); setTab("basic"); setEnvName(""); setEnvValue(""); setAdvancedText(null); setAdvancedInvalid(false);
  };
  const update = (patch: Partial<McpDraft>) => { setConfirmation(null); setDraft((value) => value ? { ...value, ...patch } : value); setSaved(false); };
  const save = async (applyAfter = false) => {
    if (!draft || !revision || !editable || !draftComplete) return;
    const name = draft.name.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name)) { setError("nameInvalid"); return; }
    if (!original && view?.servers.some((item) => item.name === name)) { setError("duplicateName"); return; }
    // A project may override an existing global server without copying its transport or credentials.
    const inherited = !original && scope === "project" && !draft.endpoint.trim()
      && overview?.config.global.servers.some(item => item.name === name)
      ? { name, config: {}, overrideOnly: true } : original;
    const result = buildMcpConfig(draft, inherited);
    if (result.error) { setError(result.error); return; }
    const resultBody = await mutate({ scope, revision, name: original?.name ?? name, operation: "upsert", config: result.config }, "PUT", (body) => {
      const nextView = body.config[scope];
      const next = nextView?.servers.find((entry) => entry.name === name);
      if (next) { setOriginal(next); setDraft(mcpDraftFrom(next)); setRevision(nextView?.revision ?? null); }
      setSaved(true);
    });
    if (resultBody && applyAfter) action("apply");
  };
  const action = (action: McpAction["action"], target = sessionId, name?: string) => {
    if (!target) return;
    void mutate({ action, sessionId: target, ...(name ? { name } : {}) }, "POST");
  };
  const confirm = () => {
    if (!confirmation || working) return;
    const choice = confirmation;
    setConfirmation(null);
    if (choice.kind === "delete" && choice.name && choice.revision) {
      void mutate({ scope, revision: choice.revision, name: choice.name, operation: "delete" }, "PUT", () => {
        setDraft(null); setOriginal(undefined); setRevision(null); setSaved(true);
      });
    } else if (choice.kind === "saveApply") void save(true);
    else if (choice.kind === "apply") action("apply", choice.sessionId);
    else if (choice.kind === "retry" && choice.name) action("retry", choice.sessionId, choice.name);
  };
  const refresh = async () => {
    if (dirty && !window.confirm(t("mcp.discardConfirm"))) return;
    setConfirmation(null); setError(null); setSaved(false); setEnvName(""); setEnvValue(""); setAdvancedText(null); setAdvancedInvalid(false);
    const body = await load();
    if (!body) return;
    const nextView = body.config[scope];
    const next = nextView?.servers.find(entry => entry.name === original?.name) ?? nextView?.servers[0];
    setDraft(next ? mcpDraftFrom(next) : null); setOriginal(next); setRevision(nextView?.revision ?? null);
    setSelectedRuntime(null); setTab("basic");
  };

  const env = draft ? mcpEnvironment(draft.advanced) : null;
  const updateEnv = (name: string, value: string) => {
    if (!draft) return;
    const next = updateMcpEnvironment(draft.advanced, name, value);
    if (next !== null) update({ advanced: next });
  };
  const connectionLabel = server ? t(`mcp.state.${server.state}`) : t("mcp.unknownConnection");
  const checkDisabled = !active || working || !session?.runtimeActive || session.provider !== "builtin";
  const applyReason = !session ? t("mcp.noSession") : !canApply ? t(`mcp.provider.${session.provider}`) : t("mcp.applyConfirm");
  const configLabel = dirty ? t("mcp.unsaved") : !overview ? t("mcp.loading") : !session ? t("mcp.configStored") : session.pending ? t("mcp.pending") : t("mcp.applied");
  const runtimePanel = <>
    <p className="mcp-hint">{session ? t(`mcp.provider.${session.provider}`) : t("mcp.noSession")}</p>
    {server ? <section className="mcp-server-status" aria-label={t("mcp.connection")}>
      <h3><McpIcon kind="status" />{t("mcp.connection")}</h3>
      <div className="mcp-runtime-grid">
        <p>{t(`mcp.source.${server.scope}`)} · {connectionLabel}</p>
        <p>{t(mcpReady(server, session) ? "mcp.ready" : "mcp.notReady")}</p>
        <p>{t("mcp.tools", { count: server.tools.length })}</p>
        <p>{t(`mcp.lastCall.${mcpLastCall(server)}`)}</p>
        {server.hasResources && <p>{t("mcp.resources", { count: server.resourceCount })}</p>}
      </div>
      {server.error && <p className="mcp-warning">{t("mcp.runtimeError")}</p>}
      {server.state === "needs-auth" && <p className="mcp-hint">{t("mcp.loginHint")}</p>}
      <ConfigButton disabled={!active || working || !session?.runtimeActive || session.provider !== "builtin" || !server.enabled || server.state === "disabled"} onClick={() => setConfirmation({ kind: "retry", sessionId: session?.id, name: server.name })}>{t("mcp.retry")}</ConfigButton>
    </section> : <p className="mcp-hint">{t("mcp.notLoaded")}</p>}
    <p className="mcp-hint">{t("mcp.checkHint")}</p>
    {session && <p className="mcp-hint">{t(`mcp.applyState.${session.applyState}`)}</p>}
    {(session?.error || session?.snapshot?.errors.length) ? <p className="mcp-warning">{t("mcp.runtimeError")}</p> : null}
    {!!overview?.affectedSessions.length && <details className="mcp-help">
      <summary>{t("mcp.affected", { count: overview.affectedSessions.length })}</summary>
      {overview.affectedSessions.map((item) => <div className="mcp-affected" key={item.id}>
        <code>{item.id}</code><span>{t(item.pending ? "mcp.pending" : "mcp.applied")}{item.busy ? ` · ${t("mcp.busy")}` : ""}</span>
        <ConfigButton size="small" disabled={!active || working} onClick={() => setConfirmation({ kind: "apply", sessionId: item.id })}>{t("mcp.applyThis")}</ConfigButton>
      </div>)}
    </details>}
  </>;

  return (
    <ConfigPanelShell embedded title={t("mcp.title")} onClose={() => {}}>
      <ConfigSplitView>
        <ConfigSidebar>
          {scopeControls}
          <label className="mcp-search"><McpIcon kind="search" />
            <input aria-label={t("mcp.search")} placeholder={t("mcp.search")} value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <div className="mcp-service-lists">
            <ConfigSidebarGroupLabel>{t("mcp.configured")}</ConfigSidebarGroupLabel>
            <ConfigSidebarList>
              {view?.servers.filter(entry => entry.name.toLowerCase().includes(search.toLowerCase())).map((entry) => {
                const live = runtime.find(item => item.name === entry.name);
                return <ConfigSidebarItem key={entry.name} active={original?.name === entry.name} disabled={working} onClick={() => edit(entry)}>
                  <span className="mcp-list-icon"><McpIcon /></span>
                  <span className="mcp-list-copy"><ConfigSidebarText>{entry.name}</ConfigSidebarText>
                    <span className="mcp-list-meta">{entry.config.enabled === false ? t("mcp.state.disabled") : live ? t(`mcp.state.${live.state}`) : t("mcp.configOnly")}</span>
                  </span>
                  <McpIcon kind="chevron" />
                </ConfigSidebarItem>;
              })}
              {view && !view.servers.some(entry => entry.name.toLowerCase().includes(search.toLowerCase())) && <p className="mcp-sidebar-hint mcp-hint">{t(search ? "mcp.noResults" : "mcp.noServers")}</p>}
            </ConfigSidebarList>
            {!!runtimeOnly.length && <>
              <ConfigSidebarGroupLabel>{t("mcp.runtimeEntries")}</ConfigSidebarGroupLabel>
              <ConfigSidebarList>
                {runtimeOnly.filter(item => item.name.toLowerCase().includes(search.toLowerCase())).map((item) => <ConfigSidebarItem key={item.name} active={selectedRuntime === item.name} disabled={working} onClick={() => {
                  if (dirty && !window.confirm(t("mcp.discardConfirm"))) return;
                  setConfirmation(null); setDraft(null); setOriginal(undefined); setSelectedRuntime(item.name); setTab("runtime"); setEnvName(""); setEnvValue(""); setAdvancedText(null); setAdvancedInvalid(false);
                }}><ConfigStatusDot active={item.state === "connected"} /><span className="mcp-list-copy"><ConfigSidebarText>{item.name}</ConfigSidebarText><span className="mcp-list-meta">{t(`mcp.state.${item.state}`)}</span></span></ConfigSidebarItem>)}
              </ConfigSidebarList>
            </>}
          </div>
          <ConfigListAction disabled={!editable} onClick={() => edit()}>{t("mcp.add")}</ConfigListAction>
        </ConfigSidebar>
        <ConfigDetail>
          <ConfigDetailStack>
            <div className={`mcp-notice${dirty ? " is-draft" : ""}`} role="status">
              <McpIcon kind="info" /><strong>{configLabel}</strong>
              <span>{t("mcp.saveHint")}</span>
            </div>
            {scope === "project" && !overview?.projectTrusted && <p className="mcp-warning">{t("mcp.untrusted")}</p>}
            {view && !view.editable && <p className="mcp-warning">{t("mcp.configUnavailable")}</p>}
            {draft || selectedRuntime ? <>
              <ConfigDetailHeader>
                <ConfigDetailHeaderInfo>
                  <span className="mcp-server-icon"><McpIcon /></span>
                  <div className="mcp-heading-copy"><ConfigDetailTitle>{original?.name ?? selectedRuntime ?? t("mcp.add")}</ConfigDetailTitle>
                    <span className="mcp-heading-meta">{selectedRuntime ? t("mcp.runtimeReadOnly") : t(draft?.transport === "command" ? "mcp.commandTransport" : "mcp.urlTransport")}</span>
                  </div>
                </ConfigDetailHeaderInfo>
                <ConfigDetailActions>
                  <ConfigButton title={checkDisabled ? (session ? t(`mcp.provider.${session.provider}`) : t("mcp.noSession")) : t("mcp.checkHint")} disabled={checkDisabled} onClick={() => action("check")}>{t("mcp.check")}</ConfigButton>
                  {original && <ConfigButton variant="ghost" size="small" disabled={!editable} onClick={() => setConfirmation({ kind: "delete", name: original.name, revision: revision ?? undefined })}>{t("mcp.delete")}</ConfigButton>}
                </ConfigDetailActions>
              </ConfigDetailHeader>
              {draft && <div className="mcp-detail-tabs" role="tablist" aria-label={t("mcp.serverSettings")}>
                {(["basic", "advanced", "runtime"] as const).map((value) => <button key={value} type="button" role="tab" id={`mcp-tab-${scope}-${value}`} aria-selected={tab === value} aria-controls={`mcp-panel-${scope}`} tabIndex={tab === value ? 0 : -1}
                  onKeyDown={(event) => {
                    const tabs = ["basic", "advanced", "runtime"] as const;
                    let next = tabs.indexOf(value);
                    if (event.key === "ArrowRight") next = (next + 1) % 3;
                    else if (event.key === "ArrowLeft") next = (next + 2) % 3;
                    else if (event.key === "Home") next = 0;
                    else if (event.key === "End") next = 2;
                    else return;
                    event.preventDefault(); setTab(tabs[next]);
                    document.getElementById(`mcp-tab-${scope}-${tabs[next]}`)?.focus();
                  }} onClick={() => setTab(value)}><McpIcon kind={value === "basic" ? "cube" : value === "advanced" ? "settings" : "status"} />{t(`mcp.${value}Tab`)}</button>)}
              </div>}
              <div className="mcp-tab-content" id={`mcp-panel-${scope}`} role={draft ? "tabpanel" : undefined} aria-labelledby={draft ? `mcp-tab-${scope}-${tab}` : undefined}>
                {draft && tab === "basic" && <div className="mcp-form-grid">
                  <div className="mcp-form-column">
                    <McpSection title={t("mcp.basicInfo")} kind="cube">
                      <ConfigField label={t("mcp.nameLabel")}><input className="mcp-input" title={t("mcp.name")} aria-label={t("mcp.name")} value={draft.name} disabled={!!original || !editable} onChange={(event) => update({ name: event.target.value })} /></ConfigField>
                      <ConfigField label={t("mcp.transport")}><select className="mcp-input" aria-label={t("mcp.transport")} value={draft.transport} disabled={!!original || !editable} title={original ? t("mcp.transportLocked") : undefined} onChange={(event) => update({ transport: event.target.value as McpDraft["transport"], endpoint: "" })}>
                        <option value="command">{t("mcp.commandTransport")}</option><option value="url">{t("mcp.urlTransport")}</option>
                      </select></ConfigField>
                      {original?.overrideOnly && <p className="mcp-hint">{t("mcp.overrideOnly")}</p>}
                    </McpSection>
                    <McpSection title={t(draft.transport === "command" ? "mcp.launchConfig" : "mcp.remoteConfig")} kind="command">
                      <ConfigField label={t(draft.transport === "command" ? "mcp.command" : "mcp.url")}>
                        <input className="mcp-input mcp-mono" aria-label={t(draft.transport === "command" ? "mcp.command" : "mcp.url")} spellCheck={false} autoComplete="off" value={draft.endpoint} disabled={!editable}
                          placeholder={original?.config[draft.transport] === MCP_REDACTED ? t("mcp.secretPlaceholder") : undefined}
                          onChange={(event) => update({ endpoint: event.target.value })} />
                      </ConfigField>
                      {draft.transport === "command" && <ConfigField label={t("mcp.argsLabel")}><textarea className="mcp-input mcp-json" title={t("mcp.args")} aria-label={t("mcp.args")} spellCheck={false} placeholder={original?.config.args === MCP_REDACTED ? t("mcp.secretPlaceholder") : undefined} value={draft.args} disabled={!editable} onChange={(event) => update({ args: event.target.value })} /></ConfigField>}
                    </McpSection>
                  </div>
                  <div className="mcp-form-column">
                    <McpSection title={t("mcp.env")} kind="cube">
                      <div className="mcp-env-head"><span>{t("mcp.variableName")}</span><span>{t("mcp.variableValue")}</span></div>
                      {env?.map(([name, value]) => <div className="mcp-env-row" key={name}>
                        <span className="mcp-env-key" title={name}>{name}</span>
                        <input type="password" className="mcp-input" aria-label={`${t("mcp.variableValue")} ${name}`} autoComplete="new-password" value={value === MCP_REDACTED ? "" : value} placeholder={value === MCP_REDACTED ? t("mcp.secretPlaceholder") : undefined} disabled={!editable} onChange={(event) => updateEnv(name, event.target.value || ((original?.config.env as Record<string, unknown> | undefined)?.[name] === MCP_REDACTED ? MCP_REDACTED : ""))} />
                      </div>)}
                      {env === null ? <p className="mcp-warning">{t("mcp.envInvalid")}</p> : <>
                        {!env.length && <p className="mcp-hint">{t("mcp.envEmpty")}</p>}
                        <div className="mcp-env-row mcp-env-new">
                          <input className="mcp-input mcp-mono" aria-label={t("mcp.variableName")} placeholder="VARIABLE_NAME" value={envName} disabled={!editable} onChange={(event) => { setConfirmation(null); setEnvName(event.target.value); }} />
                          <input type="password" className="mcp-input" aria-label={t("mcp.variableValue")} autoComplete="new-password" placeholder={t("mcp.variableValue")} value={envValue} disabled={!editable} onChange={(event) => { setConfirmation(null); setEnvValue(event.target.value); }} />
                        </div>
                        <ConfigButton size="small" disabled={!editable || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName) || ["__proto__", "constructor", "prototype"].includes(envName) || env.some(([key]) => key === envName)} onClick={() => { updateEnv(envName, envValue); setEnvName(""); setEnvValue(""); }}>{t("mcp.addEnv")}</ConfigButton>
                      </>}
                      <p className="mcp-hint">{t(envName || envValue ? "mcp.envPending" : "mcp.envHint")}</p>
                    </McpSection>
                    <McpSection title={t("mcp.availability")} kind="settings">
                      <div className="mcp-enable-row"><span>{t("mcp.enabled")}</span><ConfigSwitch checked={draft.enabled} disabled={!editable} label={t("mcp.enabled")} onChange={(enabled) => update({ enabled })} /></div>
                      <ConfigField label={t("mcp.exposure")}><select className="mcp-input" aria-label={t("mcp.exposure")} value={draft.exposure} disabled={!editable} onChange={(event) => update({ exposure: event.target.value as McpExposure })}>
                        {(["codemode", "deferred", "direct", "hidden"] as const).map((value) => <option key={value} value={value}>{t(`mcp.exposure.${value}`)}</option>)}
                      </select></ConfigField>
                      <p className="mcp-hint">{t("mcp.enabledHint")}</p>
                    </McpSection>
                  </div>
                </div>}
                {draft && tab === "advanced" && <McpSection title={t("mcp.advanced")} kind="settings">
                  <p className="mcp-hint">{t("mcp.advancedHint")}</p><p className="mcp-hint">{t("mcp.secretHint")}</p>
                  <p className="mcp-hint">{t("mcp.envManaged")}</p>
                  <textarea className="mcp-input mcp-json mcp-advanced" aria-label={t("mcp.advanced")} aria-invalid={advancedInvalid || undefined} spellCheck={false} autoComplete="off" value={advancedText ?? mcpAdvancedConfigText(draft.advanced)} disabled={!editable} onChange={(event) => {
                    const text = event.target.value; setAdvancedText(text);
                    const merged = mergeMcpAdvancedConfig(text, draft.advanced); setAdvancedInvalid(merged === null);
                    if (merged !== null) update({ advanced: merged });
                  }} />
                  {advancedInvalid && <p className="mcp-warning" role="alert">{t("mcp.extraJsonInvalid")}</p>}
                  {original && <p className="mcp-hint">{t("mcp.transportLocked")}</p>}
                </McpSection>}
                {(tab === "runtime" || selectedRuntime) && runtimePanel}
              </div>
            </> : <ConfigEmptyState><McpIcon /><span>{t(overview ? "mcp.selectEntry" : "mcp.loading")}</span>{overview && <ConfigButton disabled={!editable} onClick={() => edit()}>{t("mcp.add")}</ConfigButton>}</ConfigEmptyState>}
            <details className="mcp-help">
              <summary>{t("mcp.configDetails")}</summary>
              {view && <p className="mcp-path">{view.path}</p>}
              <p className="mcp-hint">{t("mcp.description")}</p>
              <p className="mcp-hint">{session ? t(`mcp.provider.${session.provider}`) : t("mcp.noSession")}</p>
            </details>
            {confirmation && <section ref={confirmElement} tabIndex={-1} className="mcp-confirm" role="alertdialog" aria-label={t(`mcp.${confirmation.kind}Confirm`)}>
              <p>{t(`mcp.${confirmation.kind}Confirm`)}</p>
              {confirmation.name && <strong>{confirmation.name}</strong>}
              <div className="mcp-actions"><ConfigButton variant={confirmation.kind === "delete" ? "danger" : "primary"} disabled={working || !active} onClick={confirm}>{t("mcp.confirm")}</ConfigButton>
                <ConfigButton disabled={working} onClick={() => setConfirmation(null)}>{t("mcp.cancel")}</ConfigButton></div>
            </section>}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>
      <ConfigFooter status={<div className="mcp-footer-copy">
        <div className="mcp-connection-status"><McpIcon kind="status" /><span>{t("mcp.connection")}</span><span className={`mcp-connection-badge${server?.state === "connected" ? " is-connected" : ""}`}>{connectionLabel}</span></div>
        <span role={error ? "alert" : "status"} className={error ? "mcp-warning" : "mcp-hint"}>{error ? t(`mcp.${error}`) : working ? t("mcp.working") : saved ? t("mcp.saved") : dirty ? t("mcp.unsaved") : !canApply ? (session ? t(`mcp.provider.${session.provider}`) : t("mcp.noSession")) : ""}</span>
      </div>}>
        <ConfigButton disabled={!active || working} onClick={() => void refresh()}>{t("mcp.refresh")}</ConfigButton>
        <ConfigButton disabled={!draft || !editable || !draftComplete || (!dirty && !!original)} onClick={() => void save()}>{t("mcp.save")}</ConfigButton>
        {session?.applyState === "queued" ? <ConfigButton disabled={!active || working} onClick={() => action("cancel-apply")}>{t("mcp.cancelApply")}</ConfigButton>
          : <ConfigButton variant="primary" title={applyReason} disabled={!active || working || !canApply || (dirty && (!draft || !editable || !draftComplete))} onClick={() => setConfirmation({ kind: dirty ? "saveApply" : "apply", sessionId: session?.id })}>{t(dirty ? "mcp.saveApply" : "mcp.apply")}</ConfigButton>}
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
