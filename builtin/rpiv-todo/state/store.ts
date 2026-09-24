import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Per-session live state. Each extension factory instance owns its UI binding;
 * this map partitions task data by session id.
 *
 * The Map is the single mutation seam — only `commitState` / `replaceState` /
 * `evictSession` write it; the reducer (`state/state-reducer.ts`) stays pure.
 */
const sessions = new Map<string, TaskState>();

/**
 * Session-id extractor. Structural ctx type (no Pi-runtime import) —
 * mirrors `replay.ts`'s ctx shape so `state/` stays Pi-import-free. Returns
 * `… ?? ""` so an unknown/empty session resolves to "" rather than undefined
 * (keeps the key a plain string for callers).
 */
export function sid(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

/** Fresh, non-aliasing EMPTY_STATE copy (never returns `EMPTY_STATE.tasks`). */
function freshState(): TaskState {
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

/** Get-or-read a session's slot: the committed slot by identity, or a fresh
 * EMPTY_STATE copy (not stored) when the slot is absent. */
function slotFor(sessionId: string): TaskState {
	return sessions.get(sessionId) ?? freshState();
}

/**
 * Live tasks accessor for a session. Returned `readonly Task[]` so callers
 * (overlay render hook, `/todos` command, `renderCall` subject lookup) cannot
 * mutate the live slot. Consumers must not cast back.
 */
export function getTodos(sessionId: string): readonly Task[] {
	return slotFor(sessionId).tasks;
}

export function getNextId(sessionId: string): number {
	return slotFor(sessionId).nextId;
}

/** Snapshot accessor used by reducer callers to pass canonical state in. */
export function getState(sessionId: string): TaskState {
	return slotFor(sessionId);
}

/**
 * Replay seam. Lifecycle handlers in `index.ts` call this on
 * `session_start` / `session_compact` / `session_tree` after
 * `replayFromBranch` decodes the latest snapshot, keyed to the session.
 */
export function replaceState(sessionId: string, next: TaskState): void {
	sessions.set(sessionId, next);
}

/**
 * Post-reducer commit seam. Tool `execute()` calls this with the reducer's
 * `state` output to publish the new canonical state to live readers (overlay,
 * `/todos`, `renderCall`), keyed to the calling session.
 */
export function commitState(sessionId: string, next: TaskState): void {
	sessions.set(sessionId, next);
}

/** Drop a session's slot on `session_shutdown`. No-op if the slot is absent. */
export function evictSession(sessionId: string): void {
	sessions.delete(sessionId);
}

/**
 * Test-setup reset; clears all session slots.
 */
export function __resetState(): void {
	sessions.clear();
}
