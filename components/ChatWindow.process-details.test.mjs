import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("groups live subagent calls without opening their process by default", () => {
  assert.match(source, /const liveSubagentEnd = isLiveTail \? findLiveSubagentProcessEnd\(messages, userIdx, endIdx\) : -1/);
  assert.match(source, /if \(isLiveTail && liveSubagentEnd < 0\)/);
  assert.match(source, /const finalAssistantIdx = liveSubagentEnd >= 0\s*\? liveSubagentEnd/);
  assert.match(source, /<ProcessDetailsGroup[^>]*defaultExpanded=\{!isLiveTail && !finalAnswerMessage\}/);
  assert.match(source, /processViews\.push\(<MessageView key="live-process"/);
  assert.match(source, /splitFinalAssistantBlocks\(streamingMessage, \{ isStreaming: true \}\)/);
  assert.match(source, /streamingProcessAnswer = withAssistantBlocks\(streamingMessage, streamingSplit\.answerBlocks\)/);
  assert.match(source, /\(!streamingInProcess \|\| streamingProcessAnswer\)/);
  assert.match(source, /onClick=\{\(\) => setExpanded\(\(v\) => !v\)\}/);
});

test("expands process details when a completed turn has no final answer", () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(defaultExpanded\)/);
  assert.match(source, /defaultExpanded=\{!isLiveTail && !finalAnswerMessage\}/);
});
