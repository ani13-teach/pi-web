import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { getSessionListIndices } = await jiti.import("./SessionSidebar.tsx");
const { filterOrdinarySessions, listSessionFamilies } = await jiti.import("../lib/session-family.ts");
const { getProjectActivity, getRecentProjects, otherWorkspaceActivityIndicator, sessionsForProject } = await jiti.import("../lib/project-groups.ts");

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("scrolling keeps the focused session and the viewport mounted without expanding the whole window", () => {
  for (const [scrollTop, focusedIndex] of [[0, 1999], [10000, 0]]) {
    const indices = getSessionListIndices(2000, scrollTop, 335, focusedIndex);
    const firstVisible = Math.floor(scrollTop / 54);
    const lastVisible = Math.ceil((scrollTop + 335) / 54) - 1;
    for (let index = firstVisible; index <= lastVisible; index++) assert.ok(indices.includes(index));
    assert.ok(indices.includes(focusedIndex));
    assert.equal(indices.length, 24);
    assert.equal(new Set(indices).size, indices.length);
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  }
  assert.equal(getSessionListIndices(2000, 0, 335, 3).length, 23);
  const blurred = getSessionListIndices(2000, 10000, 335);
  assert.equal(blurred.length, 23);
  assert.ok(!blurred.includes(0));
});

test("session windows stay valid after a project shrinks and before the viewport is measured", () => {
  assert.deepEqual(getSessionListIndices(5, 80000, 335, 1999), [0, 1, 2, 3, 4]);
  assert.deepEqual(getSessionListIndices(0, 80000, 335, 1999), []);
  assert.equal(getSessionListIndices(2000, 0, 0).length, 28);
});

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("exposes the polled running-session set to the shell", () => {
  assert.match(source, /onRunningSessionIdsChange\?: \(ids: Set<string>\) => void/);
  assert.match(source, /onRunningSessionIdsChange\?\.\(runningSessionIds\)/);
});

test("exposes the loaded session catalog to the shell", () => {
  assert.match(source, /onSessionsChange\?: \(sessions: SessionInfo\[\]\) => void/);
  assert.match(source, /onSessionsChange\?\.\(allSessions\)/);
});

test("subagent completion stays silent and never becomes unread", () => {
  assert.match(source, /completionNotificationSuppressedSessionIds\?: string\[\]/);
  assert.match(
    source,
    /completedWithNotifications = completedInBackground\.filter\([\s\S]*?!previousSuppressedCompletionSessionIdsRef\.current\.has\(id\)[\s\S]*?!knownSubagentIds\.has\(id\)/,
  );
  assert.match(source, /completedWithNotifications\.forEach\(\(id\) => next\.add\(id\)\)/);
  assert.match(source, /if \(completedWithNotifications\.length > 0\) \{\s*onBackgroundTaskDone\?\.\(\)/);
  assert.match(
    source,
    /filter\(\(session\) => session\.relation\?\.kind !== "subagent"\)[\s\S]*?unreadEligibleIds\.has\(id\)/,
  );
});

test("collapsed workspace indicator renders a solid dot for unread and a spinning outline for running", () => {
  assert.match(source, /otherWorkspaceActivityIndicator\(projectActivity, selectedProject\?\.key\)/);
  assert.match(source, /otherWorkspaceIndicator === "unread" \? \([\s\S]*?borderRadius: "50%", background: "currentColor"/);
  assert.match(source, /\) : \(\s*<svg width="12" height="12"[\s\S]*?<path d="M21 12a9 9 0 1 1-3\.8-7\.4"[\s\S]*?<animateTransform[^>]*repeatCount="indefinite"/);
});

test("includes project activity counts in accessible labels", () => {
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{activity\.running\}\)`\}/,
  );
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{activity\.unread\}\)`\}/,
  );
});

test("formats session timestamps with the active locale", () => {
  assert.match(source, /import \{ formatRelativeTime \} from "@\/lib\/i18n\/format"/);
  assert.match(sessionItemSource, /const \{ locale, t \} = useI18n\(\)/);
  assert.match(sessionItemSource, /formatRelativeTime\(session\.modified, locale\)/);
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});

test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});

test("lifecycle refreshes bypass the cache while cross-window polling reuses it", () => {
  assert.match(source, /force \? "\/api\/sessions\?force=1" : "\/api\/sessions"/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /loadSessions\(isFirst, !isFirst\)/);
  assert.match(source, /data\.sessionListVersion !== sessionListVersionRef\.current[\s\S]*?await loadSessions\(\)/);
  assert.match(source, /Date\.now\(\) - lastCatalogRefresh >= EXTERNAL_SESSIONS_REFRESH_MS[\s\S]*?await loadSessions\(false, true\)/);
  assert.doesNotMatch(source, /sessionRefreshDone|sessionRefreshTimerRef|title=\{t\("sidebar\.refresh"\)\}/);
  assert.match(source, /loadSessions\(false, true\);[\s\S]*?onBackgroundTaskDone/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{hovered && !session\.transient && \(/);
});

test("uses ordinary sessions throughout the sidebar while preserving the shell catalog", () => {
  assert.match(source, /const ordinarySessions = useMemo\(\(\) => filterOrdinarySessions\(allSessions\), \[allSessions\]\)/);
  assert.match(source, /setAllSessions\(data\.sessions\)/);
  assert.match(source, /onSessionsChange\?\.\(allSessions\)/);
  assert.match(source, /const projects = getRecentProjects\(ordinarySessions\)/);
  assert.match(source, /const recentProjects = getRecentProjects\(ordinarySessions\)/);
  assert.match(source, /getProjectActivity\(ordinarySessions, runningSessionIds, unreadSessionIds\)/);
  assert.match(source, /const filteredSessions = selectedProject\s*\? sessionsForProject\(ordinarySessions, selectedProject\.key\)\s*: ordinarySessions/);
  assert.match(source, /const sessionFamilies = listSessionFamilies\(filteredSessions\)/);
  assert.match(source, /const visibleSessions = sessionFamilies\.map\(\(family\) => family\.root\)/);
  assert.match(source, /!loading && !error && sessionFamilies\.length === 0/);
  assert.match(source, /height: visibleSessions\.length \* SESSION_LIST_ITEM_HEIGHT/);
  assert.match(source, /visibleSessions\.findIndex\(\(session\) => session\.id === focusedSessionId\)/);
  assert.match(source, /session=\{session\}\s*isSelected=\{session\.id === selectedSessionId\}\s*isRunning=\{runningSessionIds\.has\(session\.id\)\}\s*isUnread=\{unreadSessionIds\.has\(session\.id\)\}/);
  assert.match(source, /onClick=\{\(\) => handleSelectSessionFromList\(session\)\}/);
  assert.doesNotMatch(source, /includeSubagentAncestors|expandedSessionIds|onToggleCollapse|latestModified|expandSubagents|collapseSubagents/);
  assert.doesNotMatch(sessionItemSource, /\b(?:hasChildren|collapsed|depth)\??:/);
});

test("ordinary project lists, activity counts and empty states exclude hidden subagents", () => {
  const session = (id, cwd, modified, relation) => ({
    id, cwd, projectRoot: cwd, projectKey: cwd, modified, created: modified,
    path: `/tmp/${id}.jsonl`, firstMessage: id, messageCount: 1,
    ...(relation ? { relation } : {}),
  });
  const root = session("root", "/main", "2026-01-01");
  const fork = session("fork", "/other", "2026-01-03", { kind: "fork", originSessionId: root.id });
  const child = session("child", "/main", "2026-01-05", { kind: "subagent", parentSessionId: root.id });
  const orphan = session("orphan", "/hidden-only", "2026-01-06", { kind: "subagent", parentSessionId: "missing" });
  const ordinary = filterOrdinarySessions([child, root, orphan, fork]);
  assert.deepEqual(getRecentProjects(ordinary).map(({ root }) => root), ["/other", "/main"]);
  const activity = getProjectActivity(ordinary, new Set([child.id, orphan.id, fork.id]), new Set([child.id, orphan.id, root.id]));
  assert.deepEqual(activity.get("/main"), { running: 0, unread: 1 });
  assert.deepEqual(activity.get("/other"), { running: 1, unread: 0 });
  assert.equal(activity.has("/hidden-only"), false);
  const hiddenActivity = getProjectActivity(ordinary, new Set([child.id, orphan.id]), new Set([child.id, orphan.id]));
  assert.equal(otherWorkspaceActivityIndicator(hiddenActivity, "/main"), null);
  assert.deepEqual(listSessionFamilies(sessionsForProject(ordinary, "/hidden-only")), []);
  assert.deepEqual(listSessionFamilies(filterOrdinarySessions([child, orphan])), []);
});
