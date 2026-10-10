import { createAgentEventStream } from "@/lib/agent-event-stream";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, getStartingRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  // Observers may join an existing activation but never create services.
  const subscribeExisting = () => {
    const session = getRpcSession(id);
    if (session?.isAlive()) return session.waitUntilReady().then(() => session);
    return getStartingRpcSession(id)?.then(async ({ session }) => {
      await session.waitUntilReady();
      return session;
    });
  };
  let sessionPromise = subscribeExisting();
  if (!sessionPromise) {
    const filePath = await resolveSessionPath(id);
    if (req.signal.aborted) return new Response(null, { status: 204 });
    // Activation can have completed while the history path was resolving.
    sessionPromise = subscribeExisting();
    if (!sessionPromise) {
      if (!filePath) return new Response("Session not found", { status: 404 });
      return new Response(`data: ${JSON.stringify({ type: "dormant", sessionId: id })}\n\n`, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
      });
    }
  }

  const stream = createAgentEventStream(req, id, sessionPromise);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
