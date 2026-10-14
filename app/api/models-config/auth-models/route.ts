import { NextResponse } from "next/server";
import { AuthModelConfigError, getAuthModelCatalog } from "@/lib/auth-model-catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getAuthModelCatalog());
  } catch (error) {
    return NextResponse.json({
      error: error instanceof AuthModelConfigError ? error.message : "Model catalog could not be read; no model request was made",
    }, { status: error instanceof AuthModelConfigError ? error.status : 500 });
  }
}
