import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { getSessionFamily, includeSubagentAncestors, listSessionFamilies, listVisibleSessionRows } = await createJiti(import.meta.url).import("./session-family.ts");

function session(id, modified, relation) {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/tmp",
    created: modified,
    modified,
    messageCount: 1,
    firstMessage: id,
    ...(relation ? { relation } : {}),
  };
}

test("groups nested subagents under their main session and uses family activity for sorting", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const child = session("child", "2026-01-04T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Explore", status: "completed",
  });
  const grandchild = session("grandchild", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "child", profile: "review", description: "Review", status: "running",
  });
  const newerRoot = session("newer-root", "2026-01-02T00:00:00.000Z");

  const families = listSessionFamilies([main, child, grandchild, newerRoot]);
  assert.deepEqual(families.map((family) => family.root.id), ["main", "newer-root"]);
  assert.deepEqual(families[0].subagents.map((item) => item.id), ["child", "grandchild"]);
  assert.equal(getSessionFamily([main, child, grandchild], "grandchild")?.root.id, "main");
});

test("starts folded, keeps family activity ordering, and sorts siblings by modified time", () => {
  const root = session("root", "2026-01-01T00:00:00.000Z");
  const older = session("older", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "root", profile: "a", description: "A", status: "completed",
  });
  const newer = session("newer", "2026-01-05T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "root", profile: "b", description: "B", status: "completed",
  });
  const other = session("other", "2026-01-04T00:00:00.000Z");
  const families = listSessionFamilies([older, other, root, newer]);
  const folded = listVisibleSessionRows(families, new Set());
  assert.deepEqual(folded.map((row) => row.session.id), ["root", "other"]);
  assert.equal(folded[0].family.latestModified, newer.modified);
  assert.deepEqual([folded[0].depth, folded[0].hasChildren, folded[0].collapsed], [0, true, true]);
  const expanded = listVisibleSessionRows(families, new Set(["root"]));
  assert.deepEqual(expanded.map((row) => row.session.id), ["root", "newer", "older", "other"]);
  assert.deepEqual(expanded.map((row) => row.depth), [0, 1, 1, 0]);
  assert.equal(expanded[0].collapsed, false);
  assert.deepEqual(listVisibleSessionRows(families, new Set()).map((row) => row.session.id), ["root", "other"]);
});

test("expands nested children only when every ancestor is expanded", () => {
  const root = session("root", "2026-01-01T00:00:00.000Z");
  const child = session("child", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "root", profile: "a", description: "A", status: "completed",
  });
  const grandchild = session("grandchild", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "child", profile: "b", description: "B", status: "completed",
  });
  const families = listSessionFamilies([grandchild, root, child]);
  const expanded = new Set(["root", "child"]);
  assert.deepEqual(listVisibleSessionRows(families, expanded).map((row) => row.session.id), ["root", "child", "grandchild"]);
  assert.deepEqual(listVisibleSessionRows(families, new Set(["child"])).map((row) => row.session.id), ["root"]);
  const rows = listVisibleSessionRows(families, new Set(["root"]));
  assert.deepEqual(rows.map((row) => [row.session.id, row.depth, row.collapsed]), [["root", 0, false], ["child", 1, true]]);
});

test("retains expansion across refreshed families and temporarily filtered roots", () => {
  const root = session("root", "2026-01-01T00:00:00.000Z");
  const child = session("child", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "root", profile: "a", description: "A", status: "completed",
  });
  const expanded = new Set(["root"]);
  const refreshed = session("child", "2026-01-06T00:00:00.000Z", child.relation);
  assert.deepEqual(listVisibleSessionRows(listSessionFamilies([root, child]), expanded).map((row) => row.session.id), ["root", "child"]);
  assert.deepEqual(listVisibleSessionRows(listSessionFamilies([]), expanded), []);
  assert.deepEqual(listVisibleSessionRows(listSessionFamilies([refreshed, root]), expanded).map((row) => row.session.id), ["root", "child"]);
});

test("folded intermediate rows inherit selection and running activity from their descendants", () => {
  const root = session("root", "2026-01-01T00:00:00.000Z");
  const child = session("child", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "root", profile: "a", description: "A", status: "completed",
  });
  const grandchild = session("grandchild", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "child", profile: "b", description: "B", status: "running",
  });
  const sessions = [root, child, grandchild];
  const rows = listVisibleSessionRows(listSessionFamilies(sessions), new Set(["root"]));
  assert.deepEqual(rows.map((row) => row.session.id), ["root", "child"]);
  const selected = includeSubagentAncestors(sessions, new Set(["grandchild"]));
  const running = includeSubagentAncestors(sessions, new Set(["grandchild"]));
  assert.ok(rows[1].collapsed && selected.has(rows[1].session.id));
  assert.ok(running.has(rows[1].session.id));
  assert.ok(running.has(rows[0].session.id));
  assert.ok(!includeSubagentAncestors(sessions, new Set(["missing"])).has("root"));
});

test("flattens deep subagent chains without recursion", () => {
  const sessions = [session("root", "2026-01-01T00:00:00.000Z")];
  const expanded = new Set(["root"]);
  for (let i = 1; i <= 11000; i++) {
    const parentSessionId = i === 1 ? "root" : `child-${i - 1}`;
    sessions.push(session(`child-${i}`, "2026-01-02T00:00:00.000Z", {
      kind: "subagent", parentSessionId, profile: "a", description: "A", status: "completed",
    }));
    expanded.add(`child-${i}`);
  }
  const rows = listVisibleSessionRows(listSessionFamilies(sessions), expanded);
  assert.equal(rows.length, sessions.length);
  assert.equal(rows.at(-1).depth, 11000);
});

test("does not promote orphaned or cyclic subagent metadata into the main session list", () => {
  const orphan = session("orphan", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "missing", profile: "explore", description: "Explore", status: "interrupted",
  });
  const a = session("a", "2026-01-01T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "b", profile: "a", description: "A", status: "interrupted",
  });
  const b = session("b", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "a", profile: "b", description: "B", status: "interrupted",
  });

  assert.deepEqual(listSessionFamilies([orphan, a, b]), []);
  assert.equal(getSessionFamily([orphan, a, b], "orphan"), null);
});
