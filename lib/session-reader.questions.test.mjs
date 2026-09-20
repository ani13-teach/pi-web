// The question directory feeds the right-hand list. It walks the branch itself
// instead of reading the loaded chat window, so these tests pin the two things
// that made the old list disappear: a long turn with no user message inside the
// window, and images/logs that must not reach the client.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { buildBranchQuestions, previewUserContent } = await jiti.import("@/lib/session-reader");

const user = (id, parentId, content) => ({
  id,
  parentId,
  type: "message",
  timestamp: new Date(1000).toISOString(),
  message: { role: "user", content },
});

const assistant = (id, parentId) => ({
  id,
  parentId,
  type: "message",
  timestamp: new Date(1000).toISOString(),
  message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
});

/** One user message followed by `processCount` assistant entries — the shape of
 *  a long agent turn, which is what overflows the chat window. */
function longTurn(startIndex, processCount, parentId) {
  const entries = [user(`u${startIndex}`, parentId, `第 ${startIndex + 1} 个问题`)];
  let previous = `u${startIndex}`;
  for (let i = 0; i < processCount; i += 1) {
    entries.push(assistant(`a${startIndex}-${i}`, previous));
    previous = `a${startIndex}-${i}`;
  }
  return { entries, leafId: previous };
}

test("the directory lists every question even when the last turn has no user message in the window", () => {
  const first = longTurn(0, 3, null);
  const second = longTurn(1, 60, first.leafId);
  const entries = [...first.entries, ...second.entries];

  // What the chat window would load: the newest 50 entries, all inside turn 2.
  const windowEntries = entries.slice(-50);
  assert.equal(windowEntries.filter((entry) => entry.message.role === "user").length, 0);

  assert.deepEqual(
    buildBranchQuestions(entries, second.leafId).map((question) => question.entryId),
    ["u0", "u1"],
  );
});

test("the directory follows the active branch, not the whole file", () => {
  const entries = [
    user("u0", null, "root question"),
    assistant("a0", "u0"),
    user("u1", "a0", "main branch question"),
    assistant("a1", "u1"),
    user("b1", "a0", "side branch question"),
    assistant("b2", "b1"),
  ];

  assert.deepEqual(
    buildBranchQuestions(entries, "a1").map((question) => question.entryId),
    ["u0", "u1"],
  );
  assert.deepEqual(
    buildBranchQuestions(entries, "b2").map((question) => question.entryId),
    ["u0", "b1"],
  );
});

test("the directory defaults to the last entry when no leaf is given, and is empty without questions", () => {
  const { entries, leafId } = longTurn(0, 2, null);
  assert.deepEqual(buildBranchQuestions(entries).map((q) => q.entryId), buildBranchQuestions(entries, leafId).map((q) => q.entryId));
  assert.deepEqual(buildBranchQuestions([assistant("a0", null)]), []);
});

test("a deep linear branch is walked without overflowing the stack", () => {
  const entries = [];
  let previous = null;
  for (let i = 0; i < 5000; i += 1) {
    entries.push(user(`u${i}`, previous, `question ${i}`));
    previous = `u${i}`;
  }
  const questions = buildBranchQuestions(entries, previous);
  assert.equal(questions.length, 5000);
  assert.equal(questions[0].entryId, "u0");
  assert.equal(questions[4999].entryId, "u4999");
});

test("previews keep text blocks, drop images, collapse to one truncated line", () => {
  assert.equal(previewUserContent("  hello  "), "hello");
  assert.equal(
    previewUserContent([
      { type: "text", text: "看这张图" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(100000) } },
      { type: "text", text: "还有这里" },
    ]),
    "看这张图\n还有这里",
  );

  const long = "字".repeat(500);
  const preview = previewUserContent(long, 8);
  assert.equal(preview, `${"字".repeat(8)}…`);

  const entry = user("u0", null, [{ type: "image", source: { data: "B".repeat(500000) } }]);
  const [question] = buildBranchQuestions([entry], "u0");
  assert.equal(question.preview, "");
  assert.ok(JSON.stringify(question).length < 200, "an image-only message must stay a tiny row");
});
