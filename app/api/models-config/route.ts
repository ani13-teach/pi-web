import { NextResponse } from "next/server";
import { readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { syncEnabledModelsWithModelsConfig } from "@/lib/enabled-models-sync";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(readModelsConfig());
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    writeModelsConfig(body);
    // `enabledModels` is a hard whitelist, so a provider or model saved here stays
    // invisible in pi and in the picker until the whitelist mentions it. Reconcile
    // after the write so the new definitions are visible without hand-editing
    // settings.json. This never throws; see lib/enabled-models-sync.ts.
    const enabledModelsSync = await syncEnabledModelsWithModelsConfig();
    return NextResponse.json({ success: true, enabledModelsSync });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
