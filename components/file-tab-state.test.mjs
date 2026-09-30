import assert from "node:assert/strict";
import test from "node:test";

import { openFileTab, saveFileViewerState } from "./file-tab-state.ts";

const tabA = {
  id: "file:/repo/a.ts",
  label: "a.ts",
  filePath: "/repo/a.ts",
  viewerRevision: 0,
  viewerState: {
    displayMode: "source",
    wrapLines: true,
    scrollTop: 240,
    scrollLeft: 16,
  },
};

const tabB = {
  id: "file:/repo/b.ts",
  label: "b.ts",
  filePath: "/repo/b.ts",
  viewerRevision: 0,
};

const openA = {
  fileName: "a.ts",
  filePath: "/repo/a.ts",
  tabId: "file:/repo/a.ts",
};

test("saving viewer state updates only the matching revision", () => {
  const tabs = [tabA, tabB];
  const nextState = { ...tabA.viewerState, scrollTop: 480 };
  const saved = saveFileViewerState(tabs, tabA.id, 0, nextState);

  assert.notStrictEqual(saved, tabs);
  assert.deepEqual(saved[0].viewerState, nextState);
  assert.strictEqual(saved[1], tabB);

  const stale = saveFileViewerState(saved, tabA.id, 9, tabA.viewerState);
  assert.strictEqual(stale, saved);
});

test("opening an existing tab normally preserves its state and revision", () => {
  const tabs = [tabA, tabB];
  assert.strictEqual(openFileTab(tabs, openA), tabs);
});

test("changing the source session remounts the viewer without losing its state", () => {
  const [next] = openFileTab([tabA], { ...openA, sourceSessionId: "session-2" });
  assert.equal(next.sourceSessionId, "session-2");
  assert.equal(next.viewerRevision, 1);
  assert.strictEqual(next.viewerState, tabA.viewerState);
});

test("opening from the same source session preserves the viewer revision", () => {
  const tab = { ...tabA, sourceSessionId: "session-1" };
  const tabs = [tab];
  assert.strictEqual(
    openFileTab(tabs, { ...openA, sourceSessionId: "session-1" }),
    tabs,
  );
});

test("changing source while forcing diff increments the revision once", () => {
  const [next] = openFileTab([tabA], {
    ...openA,
    sourceSessionId: "session-2",
    modeHint: "diff",
  });
  assert.equal(next.sourceSessionId, "session-2");
  assert.equal(next.viewerRevision, 1);
  assert.equal(next.viewerState.displayMode, "diff");
});

test("every explicit diff activation resets the mode and increments the revision", () => {
  const first = openFileTab([tabA, tabB], { ...openA, modeHint: "diff" });
  assert.equal(first[0].viewerRevision, 1);
  assert.deepEqual(first[0].viewerState, {
    displayMode: "diff",
    wrapLines: true,
    scrollTop: 0,
    scrollLeft: 0,
  });

  const returnedToSource = saveFileViewerState(first, tabA.id, 1, tabA.viewerState);
  const second = openFileTab(returnedToSource, { ...openA, modeHint: "diff" });
  assert.equal(second[0].viewerRevision, 2);
  assert.equal(second[0].viewerState.displayMode, "diff");
});

test("a remounted viewer ignores the previous revision's late cleanup", () => {
  const reopened = openFileTab([tabA], { ...openA, modeHint: "diff" });
  const stale = saveFileViewerState(reopened, tabA.id, 0, tabA.viewerState);
  assert.strictEqual(stale, reopened);
  assert.equal(stale[0].viewerState.displayMode, "diff");
});

test("location preview and content preview stay isolated for the same file", () => {
  const explorerInput = { ...openA, tabId: "explorer:/repo/a.ts", previewKind: "explorer", sourceSessionId: "session-1" };
  const tabs = openFileTab([tabA], explorerInput);
  assert.equal(tabs.length, 2);
  assert.strictEqual(tabs[0], tabA);
  assert.equal(tabs[1].previewKind, "explorer");
  assert.equal(tabs[1].sourceSessionId, "session-1");
  assert.equal(tabs[1].viewerState, undefined);

  const reopened = openFileTab(tabs, { ...explorerInput, sourceSessionId: "session-2" });
  assert.strictEqual(reopened[0], tabA);
  assert.equal(reopened[1].sourceSessionId, "session-2");
  assert.equal(reopened[1].previewKind, "explorer");
  assert.equal(reopened[1].viewerRevision, 1);
  assert.strictEqual(openFileTab(reopened, { ...openA }), reopened);
  assert.equal(reopened[0].previewKind, undefined);
  assert.strictEqual(reopened[0].viewerState, tabA.viewerState);
});

test("reopening a location without a source keeps its prior authorization", () => {
  const input = { ...openA, tabId: "explorer:/repo/a.ts", previewKind: "explorer", sourceSessionId: "session-1" };
  const tabs = openFileTab([], input);
  assert.strictEqual(openFileTab(tabs, { ...input, sourceSessionId: null }), tabs);
  assert.equal(tabs[0].sourceSessionId, "session-1");
});
