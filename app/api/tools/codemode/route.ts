import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readCodemodeEnabled, writeCodemodeEnabled } from "@/lib/codemode-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ enabled: await readCodemodeEnabled() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
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
    if (!body || typeof body !== "object" || typeof (body as { enabled?: unknown }).enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    return NextResponse.json({ enabled: await writeCodemodeEnabled((body as { enabled: boolean }).enabled) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
