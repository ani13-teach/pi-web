import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildBranchQuestions } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";

/**
 * The question directory: every user message on the active branch, oldest first,
 * as text-only previews.
 *
 * Kept separate from `/context` (which is capped by `tail` and carries whole
 * messages) because this list has to cover the entire branch: a chat window that
 * holds only the newest entries would otherwise report an incomplete list, or
 * none at all when one long turn fills the window by itself.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const leafId = new URL(req.url).searchParams.get("leafId") ?? undefined;

  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? SessionManager.open(filePath!);
    return NextResponse.json({
      questions: buildBranchQuestions(sm.getEntries() as never, leafId ?? null),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
