// The right-hand list is a directory of questions: one row per user message,
// sourced from the branch rather than from whatever the chat has loaded. These
// tests cover the two rules that decide what the rail and the panel do, plus the
// shape that keeps assistant content out of the list again.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => String(key) });",
    };
  },
});

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { layoutNodes, nearestQuestionIndex, pointerRatioOf } = await jiti.import("./ChatMinimap.tsx");

const nodesOf = (count) => Array.from({ length: count }, (_, index) => ({
  index,
  entryId: `q${index}`,
  preview: `question ${index}`,
  scrollTop: null,
}));

test("nodes are spread down the rail and stay inside its padding", () => {
  const { nodes, gap } = layoutNodes(nodesOf(5), 500);

  assert.equal(nodes.length, 5);
  assert.equal(nodes[0].topRatio * 500, 12);
  assert.equal(nodes[4].topRatio * 500, 12 + 4 * gap);
  assert.ok(12 + 4 * gap <= 500 - 12 + 0.001, "the last node stays above the bottom padding");
  assert.ok(gap > 0);
});

test("one node sits at the top of the rail and an empty directory has no nodes", () => {
  assert.equal(layoutNodes(nodesOf(1), 500).nodes[0].topRatio * 500, 12);
  assert.deepEqual(layoutNodes([], 500).nodes, []);
  assert.equal(nearestQuestionIndex([], 50, 500, 0.5), null);
});

test("the pointer always resolves to the nearest question, even below a short list", () => {
  // Two questions: both nodes sit near the top, and the pointer is at the bottom.
  // Before, everything outside the nodes' own neighbourhood was dead space.
  const short = layoutNodes(nodesOf(2), 500);
  assert.equal(nearestQuestionIndex(short.nodes, short.gap, 500, 0.95), 1);
  assert.equal(nearestQuestionIndex(short.nodes, short.gap, 500, 0.5), 1);
  assert.equal(nearestQuestionIndex(short.nodes, short.gap, 500, 0), 0);

  // A single question is reachable from anywhere on the rail.
  const single = layoutNodes(nodesOf(1), 500);
  assert.equal(nearestQuestionIndex(single.nodes, single.gap, 500, 0.9), 0);

  // Many questions: the pointer maps to the node it is next to, and clamps at both ends.
  const many = layoutNodes(nodesOf(30), 500);
  assert.equal(nearestQuestionIndex(many.nodes, many.gap, 500, 0), 0);
  assert.equal(nearestQuestionIndex(many.nodes, many.gap, 500, 1), 29);
  assert.equal(nearestQuestionIndex(many.nodes, many.gap, 500, 0.5), nearestQuestionIndex(many.nodes, many.gap, 500, 0.5));

  const middle = nearestQuestionIndex(many.nodes, many.gap, 500, 0.5);
  assert.ok(middle > 10 && middle < 20, `expected a middle node, got ${middle}`);
});

test("the pointer above or below the rail still lands on an end question", () => {
  const element = { getBoundingClientRect: () => ({ top: 100, height: 500 }) };

  assert.equal(pointerRatioOf(100, element), 0);
  assert.equal(pointerRatioOf(350, element), 0.5);
  assert.equal(pointerRatioOf(600, element), 1);
  assert.equal(pointerRatioOf(40, element), 0, "above the rail clamps to the top");
  assert.equal(pointerRatioOf(900, element), 1, "below the rail clamps to the bottom");
  assert.equal(pointerRatioOf(300, { getBoundingClientRect: () => ({ top: 0, height: 0 }) }), 0);
});
