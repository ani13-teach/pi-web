import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { encodeFilePathForApi } from "../lib/file-paths.ts";
import type { ParamsOf } from "../shared/contract.ts";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_PATH_LENGTH = 4096;
const AUTHORIZATION_TIMEOUT_MS = 10_000;

interface LocalFileOpenDependencies {
  request: (method: "http.request", params: ParamsOf<"http.request">, timeoutMs: number) => Promise<{ status: number }>;
  openPath: (filePath: string) => Promise<string>;
  showItemInFolder: (filePath: string) => void;
  assertAvailable?: () => void;
  stat?: (filePath: string) => Promise<{ isFile: () => boolean; isDirectory: () => boolean }>;
  realpath?: (filePath: string) => Promise<string>;
}

function validatePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_PATH_LENGTH || CONTROL_CHARACTERS.test(value)) {
    throw new Error("Invalid local file path");
  }
  // Drive-rooted local paths are the only Windows roots accepted: no UNC,
  // device namespaces, drive-relative paths, URLs or alternate data streams.
  const driveRooted = /^[A-Za-z]:[\\/]/.test(value);
  if (/^[\\/]{2}/.test(value) || !isAbsolute(value) ||
      (process.platform === "win32" && !driveRooted) ||
      (driveRooted ? value.slice(2) : value).includes(":")) {
    throw new Error("Only absolute local file paths are supported");
  }
  if (process.platform === "win32") {
    const parts = value.slice(3).split(/[\\/]/);
    if (/[<>"|?*]/.test(value) || parts.some((part) =>
      (part !== "." && part !== ".." && /[. ]$/.test(part)) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error("Invalid local file path");
    }
  }
  return normalize(value);
}

/** Authorize the canonical path, never falling back to an alias on denial. */
export async function openLocalFile(options: unknown, dependencies: LocalFileOpenDependencies): Promise<void> {
  dependencies.assertAvailable?.();
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Invalid local file open options");
  }
  const input = options as { filePath?: unknown; sourceSessionId?: unknown };
  const requestedPath = validatePath(input.filePath);
  const sessionId = input.sourceSessionId;
  if (sessionId != null && (typeof sessionId !== "string" || !sessionId || sessionId.length > 1024 ||
      CONTROL_CHARACTERS.test(sessionId))) {
    throw new Error("Invalid source session ID");
  }
  const statFile = dependencies.stat ?? stat;
  const resolvePath = dependencies.realpath ?? realpath;
  const requestedStat = await statFile(requestedPath);
  const isDirectory = requestedStat.isDirectory();
  if (!requestedStat.isFile() && !isDirectory) throw new Error("Not a regular file or directory");
  const target = validatePath(await resolvePath(requestedPath));
  const assertSameType = async (): Promise<void> => {
    const targetStat = await statFile(target);
    if (isDirectory ? !targetStat.isDirectory() : !targetStat.isFile()) {
      throw new Error("Local file type changed during authorization");
    }
  };
  await assertSameType();

  dependencies.assertAvailable?.();
  const query = `?type=meta${typeof sessionId === "string" ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`;
  const result = await dependencies.request("http.request", {
    url: `/api/files/${encodeFilePathForApi(target)}${query}`,
    method: "GET",
  }, AUTHORIZATION_TIMEOUT_MS);
  if (result.status !== 200) throw new Error(`Local file access denied (${result.status})`);

  // Reject path or type changes during the backend round trip. The shell must
  // receive the very same canonical path that the metadata request authorized.
  if (normalize(await resolvePath(target)) !== target) throw new Error("Local file changed during authorization");
  await assertSameType();
  dependencies.assertAvailable?.();
  if (isDirectory) {
    const error = await dependencies.openPath(target);
    if (error) throw new Error(error);
  } else {
    dependencies.showItemInFolder(target);
  }
}
