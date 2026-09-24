import type { SessionInfo } from "./types";

export interface SessionFamily {
  root: SessionInfo;
  subagents: SessionInfo[];
  latestModified: string;
}

export interface VisibleSessionRow {
  session: SessionInfo;
  family: SessionFamily;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

function resolveFamilyRoots(sessions: readonly SessionInfo[]): Map<string, string | null> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = new Map<string, string | null>();

  for (const session of sessions) {
    if (roots.has(session.id)) continue;

    const path: string[] = [];
    const visited = new Set<string>();
    let currentId = session.id;
    let rootId: string | null = null;

    while (true) {
      if (roots.has(currentId)) {
        rootId = roots.get(currentId) ?? null;
        break;
      }
      if (visited.has(currentId)) break;

      visited.add(currentId);
      path.push(currentId);
      const current = byId.get(currentId);
      if (!current) break;
      if (current.relation?.kind !== "subagent") {
        rootId = current.id;
        break;
      }
      currentId = current.relation.parentSessionId;
    }

    for (const id of path) roots.set(id, rootId);
  }

  return roots;
}

/** Groups visible main/fork sessions with every persisted subagent descendant. */
export function listSessionFamilies(sessions: readonly SessionInfo[]): SessionFamily[] {
  const rootsBySessionId = resolveFamilyRoots(sessions);
  const families = new Map<string, SessionFamily>();

  for (const session of sessions) {
    if (session.relation?.kind === "subagent") continue;
    families.set(session.id, {
      root: session,
      subagents: [],
      latestModified: session.modified,
    });
  }

  for (const session of sessions) {
    if (session.relation?.kind !== "subagent") continue;
    const rootId = rootsBySessionId.get(session.id);
    const family = rootId ? families.get(rootId) : undefined;
    if (!family) continue;
    family.subagents.push(session);
    if (session.modified > family.latestModified) family.latestModified = session.modified;
  }

  return [...families.values()].sort((a, b) => b.latestModified.localeCompare(a.latestModified));
}

/** Flattens expanded families in parent-before-child order for the virtualized list. */
export function listVisibleSessionRows(
  families: readonly SessionFamily[],
  expandedSessionIds: ReadonlySet<string>,
): VisibleSessionRow[] {
  const rows: VisibleSessionRow[] = [];

  for (const family of families) {
    const children = new Map<string, SessionInfo[]>();
    for (const subagent of family.subagents) {
      const parentId = subagent.relation?.kind === "subagent" ? subagent.relation.parentSessionId : null;
      if (!parentId) continue;
      const siblings = children.get(parentId) ?? [];
      siblings.push(subagent);
      children.set(parentId, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort((a, b) => b.modified.localeCompare(a.modified));
    }

    const stack = [{ session: family.root, depth: 0 }];
    while (stack.length > 0) {
      const { session, depth } = stack.pop()!;
      const descendants = children.get(session.id) ?? [];
      const hasChildren = descendants.length > 0;
      const expanded = hasChildren && expandedSessionIds.has(session.id);
      rows.push({ session, family, depth, hasChildren, collapsed: hasChildren && !expanded });
      if (expanded) {
        for (let i = descendants.length - 1; i >= 0; i--) {
          stack.push({ session: descendants[i], depth: depth + 1 });
        }
      }
    }
  }

  return rows;
}

/** Include every visible subagent ancestor of the given session IDs. */
export function includeSubagentAncestors(
  sessions: readonly SessionInfo[],
  ids: ReadonlySet<string>,
): Set<string> {
  const parents = new Map(sessions.map((session) => [
    session.id,
    session.relation?.kind === "subagent" ? session.relation.parentSessionId : null,
  ]));
  const result = new Set<string>();
  for (const id of ids) {
    let current: string | null = id;
    while (current && parents.has(current) && !result.has(current)) {
      result.add(current);
      current = parents.get(current) ?? null;
    }
  }
  return result;
}

export function getSessionFamily(
  sessions: readonly SessionInfo[],
  sessionId: string | null | undefined,
): SessionFamily | null {
  if (!sessionId) return null;
  return listSessionFamilies(sessions).find((family) => (
    family.root.id === sessionId
    || family.subagents.some((session) => session.id === sessionId)
  )) ?? null;
}
