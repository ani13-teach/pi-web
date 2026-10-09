import { NextResponse } from "next/server";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  readSubagentRuntimeSettings,
  writeSubagentRuntimeSettings,
  type RuntimeSettingsScope,
} from "@/lib/subagent-runtime-settings";

export const dynamic = "force-dynamic";

async function validateCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd || !isAbsolute(cwd)) {
    throw new Error("Valid absolute cwd directory required");
  }
  try {
    if (!statSync(cwd).isDirectory()) throw new Error("Valid absolute cwd directory required");
  } catch {
    throw new Error("Valid absolute cwd directory required");
  }
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("Access denied");
  return cwd;
}

function validateScope(scope: unknown): RuntimeSettingsScope {
  if (scope !== "global" && scope !== "project") throw new Error("scope must be global or project");
  return scope;
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const query = new URL(req.url).searchParams;
    const cwd = await validateCwd(query.get("cwd"));
    const scope = validateScope(query.get("scope") ?? "global");
    return NextResponse.json(readSubagentRuntimeSettings(cwd, scope));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
    const input = body as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (!["cwd", "scope", "patch"].includes(key)) throw new Error(`Unknown input field: ${key}`);
    }
    const cwd = await validateCwd(input.cwd);
    const scope = validateScope(input.scope);
    if (!input.patch || typeof input.patch !== "object" || Array.isArray(input.patch)) {
      throw new Error("patch must be a JSON object");
    }
    return NextResponse.json(writeSubagentRuntimeSettings(cwd, scope, input.patch as Record<string, unknown>));
  } catch (error) {
    return errorResponse(error);
  }
}
