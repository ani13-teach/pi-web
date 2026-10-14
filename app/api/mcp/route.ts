import { NextResponse } from "next/server";
import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { samePath } from "@/lib/paths";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { getLiveRpcSessions, getRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { getDesktopMcpRuntime, getMcpSettingsRoots } from "@/lib/mcp-runtime";
import { McpConfigError, mutateMcpConfig, readMcpConfigView } from "@/lib/mcp-config-store";
import type { McpAction, McpMutation, McpOverview } from "@/lib/mcp-types";

export const dynamic = "force-dynamic";

function fail(status: number, code: string, message: string): never { throw new McpConfigError(status, code, message); }
function validId(id: unknown): id is string { return typeof id === "string" && id.length > 0 && id.length <= 200 && /^[a-zA-Z0-9_-]+$/.test(id); }
async function contextFor(req: Request, target?: string) {
  const query = new URL(req.url).searchParams;
  const id = target ?? query.get("sessionId");
  if (id !== null && id !== undefined && !validId(id)) fail(400, "MCP_SESSION_INVALID", "会话标识无效。");
  const session = id ? getRpcSession(id) : undefined;
  const live = session?.isAlive() ? session : undefined;
  let cwd = query.get("cwd") || undefined;
  let agentDir = getAgentDir();
  if (live) {
    const roots = getMcpSettingsRoots(live.configurationRoot, live.inner.settingsManager);
    if (!target && cwd && !samePath(cwd, live.cwd) && !samePath(cwd, roots.cwd)) fail(403, "MCP_PROJECT_MISMATCH", "会话与项目不匹配，请重新选择。");
    cwd = roots.cwd; agentDir = roots.agentDir;
  } else if (cwd) {
    if (!isAbsolute(cwd)) fail(400, "MCP_PROJECT_INVALID", "项目目录无效。");
    cwd = resolve(cwd);
    try { if (!statSync(cwd).isDirectory()) fail(400, "MCP_PROJECT_INVALID", "项目目录无效。"); }
    catch { fail(400, "MCP_PROJECT_INVALID", "项目目录无效。"); }
    if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) fail(403, "MCP_PROJECT_DENIED", "当前项目不在允许访问的范围内。");
  }
  const projectTrusted = cwd ? getProjectTrustStatus(cwd, agentDir).trusted : false;
  return { id: id ?? null, session: live, agentDir, cwd, projectTrusted };
}
async function overview(context: Awaited<ReturnType<typeof contextFor>>): Promise<McpOverview> {
  const { agentDir, cwd, projectTrusted, session } = context;
  const [global, project] = await Promise.all([
    readMcpConfigView({ agentDir, cwd, projectTrusted, scope: "global" }),
    cwd ? readMcpConfigView({ agentDir, cwd, projectTrusted, scope: "project" }) : Promise.resolve(null),
  ]);
  const affectedSessions = getLiveRpcSessions().filter(item => {
    const roots = getMcpSettingsRoots(item.configurationRoot, item.inner.settingsManager);
    return samePath(roots.agentDir, agentDir) && !item.isChatOnly();
  }).map(item => { const view = item.getMcpSessionView(); return { id: view.id, busy: view.busy, pending: view.pending }; });
  return { config: { global, project }, projectTrusted, configRoot: cwd ?? null,
    session: session ? session.getMcpSessionView() : context.id ? {
      id: context.id, runtimeActive: false, busy: false, provider: "unloaded", generation: 0,
      appliedRevision: null, pending: true, applyState: "idle", activeTools: [], snapshot: null,
    } : null, affectedSessions };
}
function errorResponse(error: unknown) {
  if (error instanceof McpConfigError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  // Neither SDK errors nor user JSON may echo credentials into a renderer response.
  return NextResponse.json({ error: "MCP 操作未完成，请检查配置和会话状态后重试。", code: "MCP_OPERATION_FAILED" }, { status: 500 });
}
function authorized(req: Request, mutation = false) {
  if (!isApiRequestAllowed(req)) fail(403, "MCP_UNTRUSTED_REQUEST", "不允许此来源的请求。");
  if (mutation && !hasJsonContentType(req)) fail(415, "MCP_JSON_REQUIRED", "请求必须使用 JSON 格式。");
}
async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const limit = 256 * 1024;
  const declared = Number(req.headers.get("content-length"));
  if (declared > limit) fail(413, "MCP_TOO_LARGE", "配置内容过大。");
  const reader = req.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder();
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) {
          await reader.cancel().catch(() => {});
          fail(413, "MCP_TOO_LARGE", "配置内容过大。");
        }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail(400, "MCP_JSON_INVALID", "请求格式无效。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "MCP_JSON_INVALID", "请求格式无效。");
  return value as Record<string, unknown>;
}
export async function GET(req: Request) {
  try { authorized(req); return NextResponse.json(await overview(await contextFor(req))); }
  catch (error) { return errorResponse(error); }
}
export async function PUT(req: Request) {
  try {
    authorized(req, true);
    const body = await jsonBody(req);
    if (!["global", "project"].includes(String(body.scope)) || !["upsert", "delete"].includes(String(body.operation))
      || typeof body.revision !== "string" || typeof body.name !== "string") fail(400, "MCP_CONFIG_INVALID", "配置参数无效。");
    const context = await contextFor(req);
    await mutateMcpConfig(context, body as unknown as McpMutation);
    return NextResponse.json(await overview(context));
  } catch (error) { return errorResponse(error); }
}
async function performAction(session: AgentSessionWrapper, body: McpAction): Promise<void> {
  switch (body.action) {
    case "apply": await session.requestMcpApply(); return;
    case "cancel-apply": session.cancelMcpApply(); return;
    case "check": {
      const runtime = getDesktopMcpRuntime(session.sessionId);
      if (!runtime) fail(409, "MCP_NOT_LOADED", "当前会话尚未加载桌面 MCP 模块。");
      await runtime.check(5000); return;
    }
    case "retry": {
      if (session.getMcpSessionView().busy) fail(409, "MCP_SESSION_BUSY", "会话仍在运行任务，请稍后重连。");
      if (!validId(body.name)) fail(400, "MCP_NAME_INVALID", "请选择要重连的服务器。");
      const runtime = getDesktopMcpRuntime(session.sessionId);
      if (!runtime) fail(409, "MCP_NOT_LOADED", "当前会话尚未加载桌面 MCP 模块。");
      await session.retryMcpServer(body.name); return;
    }
  }
}
export async function POST(req: Request) {
  try {
    authorized(req, true);
    const body = await jsonBody(req);
    if (!validId(body.sessionId) || !["apply", "cancel-apply", "check", "retry"].includes(String(body.action))) fail(400, "MCP_ACTION_INVALID", "操作参数无效。");
    const context = await contextFor(req, body.sessionId);
    if (!context.session) fail(409, "MCP_SESSION_DORMANT", "此会话尚未运行，下次启动时会加载配置。");
    await performAction(context.session, body as unknown as McpAction);
    return NextResponse.json(await overview(context));
  } catch (error) { return errorResponse(error); }
}
