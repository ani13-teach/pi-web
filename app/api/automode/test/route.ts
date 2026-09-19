/**
 * Checks one classifier model candidate.
 *
 * A wrong `provider/model` value, a missing credential and a model that cannot
 * answer with a single digit all look identical in the config file, so the
 * panel offers a real round trip with the same budget the classifier gets.
 */
import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { join } from "path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { parseModelSpec } from "@/builtin/automode/extensions/auto-mode/model.ts";

export const dynamic = "force-dynamic";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const PROBE_MAX_TOKENS = 16;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ ok: false, error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ ok: false, error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { model?: unknown; timeoutMs?: unknown };
    const spec = typeof body.model === "string" ? body.model.trim() : "";
    const parsed = parseModelSpec(spec);
    if (!parsed) {
      return NextResponse.json({ ok: false, error: "model must be a provider/model value" }, { status: 400 });
    }
    const requestedTimeout = typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
      ? Math.trunc(body.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(requestedTimeout, 1000), MAX_TIMEOUT_MS);

    const agentDir = getAgentDir();
    const modelsPath = join(agentDir, "models.json");
    const runtime = await ModelRuntime.create({
      ...(existsSync(modelsPath) ? { modelsPath } : {}),
      authPath: join(agentDir, "auth.json"),
    });
    const loadError = runtime.getError();
    if (loadError) return NextResponse.json({ ok: false, error: loadError });

    const model = runtime.getModel(parsed.provider, parsed.id);
    if (!model) {
      return NextResponse.json({
        ok: false,
        error: `${spec} is not among the configured models. Check the provider and model id.`,
      });
    }
    const resolved = await runtime.getAuth(model);
    if (!resolved?.auth.apiKey) {
      return NextResponse.json({
        ok: false,
        error: `No credentials found for "${parsed.provider}". Log in or add an API key first.`,
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const message = await completeSimple(model, {
        messages: [{
          role: "user",
          content: "Reply with a single digit: 0 or 1. Nothing else.",
          timestamp: Date.now(),
        }],
      }, {
        apiKey: resolved.auth.apiKey,
        headers: resolved.auth.headers,
        maxTokens: PROBE_MAX_TOKENS,
        timeoutMs,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startedAt;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return NextResponse.json({
          ok: false,
          latencyMs,
          error: message.errorMessage ?? (controller.signal.aborted ? `No answer within ${timeoutMs} ms` : "The model returned an error"),
        });
      }
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      return NextResponse.json({ ok: true, latencyMs, text: text.slice(0, 120) });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  }
}
