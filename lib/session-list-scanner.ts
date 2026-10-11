// Cache session-list metadata without building the SDK's unused allMessagesText.
// New and changed files still require a full scan; unchanged files only need stat.
// ponytail: size/mtime fingerprints miss same-size edits with restored mtime;
// use content hashes if detecting those edits becomes necessary.
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { readSubagentRun, SUBAGENT_META_TYPE, SUBAGENT_STATUS_TYPE, SUBAGENT_RESULT_TYPE } from "./subagents";
import type { SessionEntry, SessionInfo } from "./types";

type SubagentRelation = Extract<NonNullable<SessionInfo["relation"]>, { kind: "subagent" }>;

export interface ScannedSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	parentSessionPath?: string;
	initialAgentName?: string;
	agentRunIds?: string[];
	subagentRelation?: SubagentRelation;
}

interface Fingerprint {
	size: number;
	mtimeMs: number;
}

interface IndexEntry {
	fp: Fingerprint;
	info: ScannedSessionInfo;
}

type RawEntry = Record<string, unknown>;

function isRecord(value: unknown): value is RawEntry {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// v3 includes source-validated subagent identity and lifecycle summaries.
const INDEX_FORMAT_VERSION = 3;

function isSubagentRelation(value: unknown): value is SubagentRelation {
	return isRecord(value) && value.kind === "subagent"
		&& typeof value.parentSessionId === "string"
		&& typeof value.profile === "string" && typeof value.description === "string"
		&& ["queued", "running", "completed", "failed", "aborted", "interrupted"].includes(value.status as string);
}

declare global {
	var __piWebScanIndex: Map<string, IndexEntry> | undefined;
	var __piWebScanIndexLoaded: boolean | undefined;
	var __piWebScanIndexVersion: number | undefined;
	var __piWebScanIndexSaveQueued: boolean | undefined;
}

function parseLine(line: string): RawEntry | null {
	if (!line.trim()) return null;
	try {
		const entry = JSON.parse(line) as RawEntry;
		return entry && typeof entry === "object" ? entry : null;
	} catch {
		return null;
	}
}

function extractTextContent(message: RawEntry): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				!!block &&
				typeof block === "object" &&
				(block as RawEntry).type === "text" &&
				typeof (block as RawEntry).text === "string",
		)
		.map((block) => block.text)
		.join(" ");
}

function activityTimeOf(entry: RawEntry): number | undefined {
	const message = entry.message as RawEntry | undefined;
	if (
		!message ||
		typeof message.role !== "string" ||
		!("content" in message) ||
		(message.role !== "user" && message.role !== "assistant")
	) {
		return undefined;
	}
	if (typeof message.timestamp === "number") return message.timestamp;
	const t = new Date(entry.timestamp as string).getTime();
	return Number.isNaN(t) ? undefined : t;
}

// Uses the SDK's buildSessionInfo() semantics for displayed metadata.
export async function scanSessionFileInfo(
	filePath: string,
): Promise<ScannedSessionInfo | null> {
	try {
		const stats = await stat(filePath);
		let header: RawEntry | null = null;
		let name: string | undefined;
		let messageCount = 0;
		let firstMessage = "";
		let lastActivityTime: number | undefined;
		let initialAgentName: string | undefined;
		let firstNameSeen = false;
		const agentRunIds: string[] = [];
		let subagentRelation: SubagentRelation | undefined;

		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			const entry = parseLine(line);
			if (!entry) continue;

			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}

			if (entry.type === "session_info") {
				if (!firstNameSeen) {
					firstNameSeen = true;
					if (typeof entry.name === "string" && /^[a-z][a-z0-9-]*#[0-9a-f]{8}$/.test(entry.name)) {
						initialAgentName = entry.name;
					}
				}
				name =
					typeof entry.name === "string" && entry.name.trim()
						? entry.name.trim()
						: undefined;
			}
			if (entry.type === "custom" && entry.customType === "subagents:record" && isRecord(entry.data) &&
				typeof entry.data.id === "string" && /^[0-9a-f]{8}-/.test(entry.data.id)) {
				agentRunIds.push(entry.data.id);
			}
			// Reuse the scan already needed for display metadata. Keep only identity
			// and status, never task text, resource snapshots or result payloads.
			if (entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE && typeof header.parentSession === "string") {
				const run = readSubagentRun([entry as unknown as SessionEntry], header.id as string, filePath, header.parentSession);
				if (run) subagentRelation = {
					kind: "subagent", parentSessionId: run.parentSessionId,
					profile: run.profile, description: run.description,
					status: subagentRelation?.status ?? "interrupted",
				};
			}
			if (subagentRelation && entry.type === "custom" && isRecord(entry.data) && entry.data.version === 1) {
				const status = entry.data.status;
				if (entry.customType === SUBAGENT_STATUS_TYPE && (status === "queued" || status === "running")) {
					subagentRelation.status = status;
				} else if (entry.customType === SUBAGENT_RESULT_TYPE && (status === "completed" || status === "failed" || status === "aborted")) {
					subagentRelation.status = status;
				}
			}
			if (entry.type !== "message") continue;
			messageCount++;

			const activityTime = activityTimeOf(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const message = entry.message as RawEntry | undefined;
			if (
				!message ||
				typeof message.role !== "string" ||
				!("content" in message)
			)
				continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;
			if (!firstMessage && message.role === "user") firstMessage = textContent;
		}

		if (!header) return null;

		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath =
			typeof header.parentSession === "string"
				? header.parentSession
				: undefined;
		const headerTime =
			typeof header.timestamp === "string"
				? new Date(header.timestamp).getTime()
				: NaN;
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		return {
			path: filePath,
			id: header.id as string,
			cwd,
			name,
			parentSessionPath,
			...(parentSessionPath && initialAgentName ? { initialAgentName } : {}),
			...(agentRunIds.length ? { agentRunIds } : {}),
			...(subagentRelation ? { subagentRelation } : {}),
			created: new Date(header.timestamp as string),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
		};
	} catch {
		return null;
	}
}

async function enumerateSessionFiles(sessionsDir: string): Promise<string[]> {
	let dirs: Dirent[];
	try {
		const entries = await readdir(sessionsDir, { withFileTypes: true });
		dirs = entries.filter(
			(entry) => entry.isDirectory() || entry.isSymbolicLink(),
		);
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const dir of dirs) {
		const dirPath = join(sessionsDir, dir.name);
		try {
			for (const f of await readdir(dirPath)) {
				if (f.endsWith(".jsonl")) files.push(join(dirPath, f));
			}
		} catch {
			// unreadable project dir: same skip-as-absent semantics as the SDK
		}
	}
	return files;
}

const MAX_CONCURRENT_SCANS = 10;

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>) {
	let next = 0;
	const inFlight = new Set<Promise<void>>();
	while (next < items.length || inFlight.size > 0) {
		while (next < items.length && inFlight.size < MAX_CONCURRENT_SCANS) {
			const item = items[next++];
			const task = worker(item).finally(() => inFlight.delete(task));
			inFlight.add(task);
		}
		if (inFlight.size > 0) await Promise.race(inFlight);
	}
}

function getIndex(): Map<string, IndexEntry> {
	// HMR can preserve globals from an older scanner implementation. Never
	// stamp those incomplete summaries with the new persisted format version.
	if (globalThis.__piWebScanIndexVersion !== INDEX_FORMAT_VERSION) {
		globalThis.__piWebScanIndex = undefined;
		globalThis.__piWebScanIndexLoaded = undefined;
		globalThis.__piWebScanIndexVersion = INDEX_FORMAT_VERSION;
	}
	if (!globalThis.__piWebScanIndex) globalThis.__piWebScanIndex = new Map();
	return globalThis.__piWebScanIndex;
}

function indexFilePath(): string {
	return join(getAgentDir(), "pi-web-session-index.json");
}

function loadPersistedIndex(): void {
	const index = getIndex();
	if (globalThis.__piWebScanIndexLoaded) return;
	globalThis.__piWebScanIndexLoaded = true;
	const path = indexFilePath();
	if (!existsSync(path)) return;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed) || parsed.version !== INDEX_FORMAT_VERSION || !isRecord(parsed.entries)) return;
		for (const [pathKey, entry] of Object.entries(parsed.entries)) {
			if (!isRecord(entry) || !isRecord(entry.fp) || !isRecord(entry.info)) continue;
			const { fp, info } = entry;
			if (
				typeof fp.size !== "number" || !Number.isSafeInteger(fp.size) || fp.size < 0 ||
				typeof fp.mtimeMs !== "number" || !Number.isFinite(fp.mtimeMs) ||
				info.path !== pathKey ||
				typeof info.id !== "string" ||
				typeof info.cwd !== "string" ||
				typeof info.firstMessage !== "string" ||
				(info.name !== undefined && typeof info.name !== "string") ||
				(info.parentSessionPath !== undefined && typeof info.parentSessionPath !== "string") ||
				(info.initialAgentName !== undefined && typeof info.initialAgentName !== "string") ||
				(info.agentRunIds !== undefined && (!Array.isArray(info.agentRunIds) || !info.agentRunIds.every((id) => typeof id === "string"))) ||
				(info.subagentRelation !== undefined && (typeof info.parentSessionPath !== "string" || !isSubagentRelation(info.subagentRelation))) ||
				typeof info.messageCount !== "number" || !Number.isSafeInteger(info.messageCount) || info.messageCount < 0 ||
				typeof info.created !== "string" || typeof info.modified !== "string"
			) continue;
			const created = new Date(info.created);
			const modified = new Date(info.modified);
			if (!Number.isFinite(created.getTime()) || !Number.isFinite(modified.getTime())) continue;
			index.set(pathKey, {
				fp: { size: fp.size, mtimeMs: fp.mtimeMs },
				info: {
					path: pathKey,
					id: info.id,
					cwd: info.cwd,
					name: info.name,
					parentSessionPath: info.parentSessionPath,
					...(info.initialAgentName ? { initialAgentName: info.initialAgentName } : {}),
					...(info.agentRunIds ? { agentRunIds: info.agentRunIds } : {}),
					...(info.subagentRelation ? { subagentRelation: info.subagentRelation as SubagentRelation } : {}),
					firstMessage: info.firstMessage,
					messageCount: info.messageCount,
					created,
					modified,
				},
			});
		}
	} catch {
		// corrupt index => cold rebuild, never an error surfaced to callers
	}
}

function queueIndexPersist(): void {
	if (globalThis.__piWebScanIndexSaveQueued) return;
	globalThis.__piWebScanIndexSaveQueued = true;
	queueMicrotask(() => {
		globalThis.__piWebScanIndexSaveQueued = undefined;
		try {
			const entries: Record<string, IndexEntry> = {};
			for (const [pathKey, entry] of getIndex()) entries[pathKey] = entry;
			writePrivateFileAtomicSync(
				indexFilePath(),
				JSON.stringify({ version: INDEX_FORMAT_VERSION, entries }),
			);
		} catch {
			// persistence is best-effort; the in-memory index remains authoritative
		}
	});
}

/**
 * Incremental equivalent of SessionManager.listAll(): rescans only files whose
 * (size, mtimeMs) changed since the last pass. Output ordering matches the SDK
 * catalogue (modified descending).
 */
export async function listSessionsIncremental(): Promise<ScannedSessionInfo[]> {
	loadPersistedIndex();

	const sessionsDir = join(getAgentDir(), "sessions");
	const files = await enumerateSessionFiles(sessionsDir);

	const index = getIndex();
	const present = new Set(files);
	const stale: string[] = [];
	for (const known of index.keys()) {
		if (!present.has(known)) stale.push(known);
	}
	for (const pathKey of stale) index.delete(pathKey);

	const fingerprints = await Promise.all(
		files.map(async (filePath) => {
			try {
				const s = await stat(filePath);
				return {
					filePath,
					fp: { size: s.size, mtimeMs: s.mtimeMs } as Fingerprint,
				};
			} catch {
				return { filePath, fp: null as Fingerprint | null };
			}
		}),
	);

	// SDK 1.1 discovers candidates by filesystem mtime, then filename descending.
	// Its later metadata-date sort is stable, so preserve this order for ties.
	fingerprints.sort((a, b) =>
		(b.fp?.mtimeMs ?? Number.NEGATIVE_INFINITY) - (a.fp?.mtimeMs ?? Number.NEGATIVE_INFINITY)
		|| basename(b.filePath).localeCompare(basename(a.filePath)),
	);

	const changed: Array<{ filePath: string; fp: Fingerprint; resultIndex: number }> = [];
	const results: (ScannedSessionInfo | null)[] = new Array(files.length).fill(null);
	for (const [resultIndex, { filePath, fp }] of fingerprints.entries()) {
		if (!fp) {
			index.delete(filePath);
			continue;
		}
		const cached = index.get(filePath);
		if (
			cached &&
			cached.fp.size === fp.size &&
			cached.fp.mtimeMs === fp.mtimeMs
		) {
			results[resultIndex] = cached.info;
			continue;
		}
		changed.push({ filePath, fp, resultIndex });
	}

	await runPool(changed, async ({ filePath, fp, resultIndex }) => {
		const info = await scanSessionFileInfo(filePath);
		if (info) {
			index.set(filePath, { fp, info });
			results[resultIndex] = info;
		} else {
			index.delete(filePath);
		}
	});

	if (changed.length > 0 || stale.length > 0) queueIndexPersist();

	// Preserve catalogue order for timestamp ties, independently of cache hits
	// and the order in which concurrent file reads complete.
	return results.filter((info) => info !== null)
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Test seam: drop all in-memory index state. */
export function resetSessionScanIndexForTests(): void {
	globalThis.__piWebScanIndex = undefined;
	globalThis.__piWebScanIndexLoaded = undefined;
	globalThis.__piWebScanIndexVersion = undefined;
	globalThis.__piWebScanIndexSaveQueued = undefined;
}
