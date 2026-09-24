import type { SessionInfo } from "./types";

// Pi's Agent tool stores the parent path in the session header and names the
// child "profile#run-id-prefix"; unlike the built-in extension it has no
// pi-web:subagent entry in the child file.
export function nativeSubagentRelation(
  initialName: string | undefined,
  parentSessionId: string | undefined,
  parentRunIds: readonly string[] = [],
): SessionInfo["relation"] | undefined {
  if (!parentSessionId) return undefined;
  const match = /^([a-z][a-z0-9-]*)#([0-9a-f]{8})$/.exec(initialName ?? "");
  if (!match) return undefined;
  if (!parentRunIds.some((id) => id.startsWith(`${match[2]}-`))) return undefined;
  return {
    kind: "subagent",
    parentSessionId,
    profile: match[1],
    description: initialName!,
  };
}
