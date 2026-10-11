import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Bundle just the pure protocol and validator: no Desktop host, sessions, models or credentials.
const dir = await mkdtemp(join(tmpdir(), "pi-result-protocol-"));
const file = join(dir, "protocol.mjs");
let protocol;
try {
  await build({
    entryPoints: [fileURLToPath(new URL("../builtin/pi-subagents/src/result-protocol.ts", import.meta.url))],
    outfile: file, bundle: true, platform: "node", format: "esm",
  });
  protocol = await import(pathToFileURL(file).href);
} catch (error) {
  await rm(dir, { recursive: true, force: true });
  throw error;
}
test.after(() => rm(dir, { recursive: true, force: true }));
const { RESULT_REPORT_SCHEMA, compiledResultReport, renderAgentResult } = protocol;

function report(overrides = {}) {
  return {
    conclusion: "发现配置路径不一致。",
    evidence: [{ file: "src/config.ts", line: 17, inputVersion: "sha:before-edit", note: "读取该版本的配置路径。" }],
    uncertainties: ["运行环境未复现。", "修改后的输入尚未检查。"],
    nextAction: "核对当前输入版本后运行相关检查。",
    ...overrides,
  };
}
function record(value = report(), overrides = {}) {
  return { status: "completed", result: "原始详细回答", structuredJson: JSON.stringify(value), ...overrides };
}
function maximumReport(character = "x") {
  const within = length => character.repeat(Math.floor(length / character.length));
  return report({
    conclusion: within(1400),
    evidence: Array.from({ length: 8 }, (_, i) => ({
      file: within(239) + i, line: i + 1,
      inputVersion: within(159) + i, note: within(400),
    })),
    uncertainties: Array.from({ length: 6 }, (_, i) => `${i}:${within(398)}`),
    nextAction: within(600),
  });
}

test("plain JSON schema compiles and requires all four report fields", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(RESULT_REPORT_SCHEMA)), RESULT_REPORT_SCHEMA);
  assert.equal(RESULT_REPORT_SCHEMA.additionalProperties, false);
  assert.equal(compiledResultReport.check(report()), true);
  assert.equal(compiledResultReport.check(maximumReport()), true);
  assert.equal(compiledResultReport.check(report({ evidence: [{ file: "a", note: "b" }] })), true);
  for (const field of ["conclusion", "evidence", "uncertainties", "nextAction"]) {
    const value = report(); delete value[field];
    assert.notEqual(compiledResultReport.check(value), true, field);
  }
});

test("rejects invalid line, extra properties, wrong types, excess items and overlong fields", () => {
  const invalid = [
    report({ extra: "not allowed" }),
    report({ evidence: [{ file: "a", note: "b", extra: "not allowed" }] }),
    ...[0, -1, 1.5, "17", null].map(line => report({ evidence: [{ file: "a", note: "b", line }] })),
    report({ conclusion: "x".repeat(1401) }),
    report({ conclusion: 42 }),
    report({ evidence: Array(9).fill({ file: "a", note: "b" }) }),
    report({ evidence: [{ file: "x".repeat(241), note: "b" }] }),
    report({ evidence: [{ file: "a", note: "x".repeat(401) }] }),
    report({ evidence: [{ file: "a", note: "b", inputVersion: "x".repeat(161) }] }),
    report({ uncertainties: Array(7).fill("unknown") }),
    report({ uncertainties: ["x".repeat(401)] }),
    report({ uncertainties: [true] }),
    report({ nextAction: "x".repeat(601) }),
    { output: "unrelated workflow payload", evidence: [] },
    null, [], "text",
  ];
  for (const value of invalid) {
    assert.notEqual(compiledResultReport.check(value), true);
    const rendered = renderAgentResult(record(value), "summary");
    assert.match(rendered, /未提供结构化结果\/证据未验证/);
    assert.doesNotMatch(rendered, /canonical report|子代理报告证据数量/);
    assert.ok(rendered.length <= 1600);
  }
});

test("summary contains every uncertainty, action and count but excludes the evidence list", () => {
  const value = report({ uncertainties: Array.from({ length: 6 }, (_, i) => `未核对事项-${i}`) });
  const rendered = renderAgentResult(record(value), "summary");
  assert.match(rendered, /结论：[\s\S]*发现配置路径不一致/);
  for (const uncertainty of value.uncertainties) assert.ok(rendered.includes(uncertainty));
  assert.ok(rendered.includes(value.nextAction));
  assert.match(rendered, /证据数量：1/);
  assert.match(rendered, /get_subagent_result view="evidence"/);
  assert.match(rendered, /子代理报告，需定点核对/);
  assert.match(rendered, /不代表事实真实/);
  assert.ok(!rendered.includes(value.evidence[0].file));
  assert.ok(!rendered.includes(value.evidence[0].note));
  assert.ok(rendered.length <= 5000);
});

test("evidence shows source location, note and reported input version without inventing missing values", () => {
  const value = report({ evidence: [
    { file: "src/config.ts", line: 17, inputVersion: "sha:before-edit", note: "旧版本检查记录。" },
    { file: "README.md", note: "没有定位行号。" },
  ] });
  const rendered = renderAgentResult(record(value), "evidence");
  assert.match(rendered, /src\/config\.ts:17/);
  assert.match(rendered, /输入版本：sha:before-edit/);
  assert.match(rendered, /旧版本检查记录/);
  assert.match(rendered, /README\.md\n输入版本：未提供（不可推断）/);
  assert.ok(!rendered.includes("README.md:1"));
  assert.ok(rendered.includes(value.uncertainties[0]));
  assert.ok(rendered.length <= 10000);
});

test("an empty uncertainty/evidence array does not imply certainty or verified evidence", () => {
  const r = record(report({ evidence: [], uncertainties: [] }));
  assert.match(renderAgentResult(r, "summary"), /未报告不确定性（不代表已经验证）/);
  assert.match(renderAgentResult(r, "evidence"), /未提供证据/);
  assert.match(renderAgentResult(r, "summary"), /证据数量：0（未验证）/);
});

test("all compact views have hard limits even with maximal fields, giant errors and branches", () => {
  for (const character of ["x", "😀"]) {
    const value = maximumReport(character);
    assert.equal(compiledResultReport.check(value), true, "Unicode boundary must exercise a valid structured report, never legacy fallback");
    const r = record(value, {
      status: "error", error: "ERROR-".repeat(30000), result: "PARTIAL-".repeat(30000),
      worktreeResult: { hasChanges: true, branch: "branch-".repeat(30000) },
    });
    const summary = renderAgentResult(r, "summary"), evidence = renderAgentResult(r, "evidence");
    assert.ok(summary.length <= 5000, `summary length: ${summary.length}`);
    assert.ok(evidence.length <= 10000, `evidence length: ${evidence.length}`);
    assert.match(summary, /错误：[\s\S]*ERROR-/);
    assert.match(summary, /PARTIAL-/);
    assert.match(summary, /已截断/);
    for (let i = 0; i < 6; i++) assert.ok(summary.includes(`${i + 1}. ${i}:`));
    for (const uncertainty of value.uncertainties) assert.ok(summary.includes(uncertainty), "Every valid uncertainty remains visible");
    assert.match(summary, /不确定性（6 项）/);
    for (let i = 1; i <= 8; i++) assert.ok(evidence.includes(`${i}. `));
    assert.match(evidence, /证据说明 \d已截断/);
    assert.doesNotMatch(summary, /未提供结构化结果/);
    assert.doesNotMatch(summary, /[\uD800-\uDFFF]/u);
    assert.doesNotMatch(evidence, /[\uD800-\uDFFF]/u);
    assert.match(evidence, /get_subagent_result view="full"/);
  }
});

test("missing, malformed and unrelated structured JSON fall back explicitly, without treating prose as evidence", () => {
  for (const structuredJson of [undefined, "{bad JSON", JSON.stringify({ steps: [], status: "ok" }), JSON.stringify({})]) {
    const r = { status: "completed", result: "Legacy report claims VERIFIED ".repeat(10000), structuredJson };
    for (const view of ["summary", "evidence"]) {
      const rendered = renderAgentResult(r, view);
      assert.match(rendered, /未提供结构化结果\/证据未验证/);
      assert.match(rendered, /无法从旧文本推断证据、输入版本或不确定性/);
      assert.match(rendered, /原始输出已截断/);
      assert.match(rendered, /get_subagent_result view="full"/);
      assert.ok(rendered.length <= 1600);
    }
  }
  const jsonOnly = { status: "completed", structuredJson: "{malformed, no prose" };
  assert.ok(renderAgentResult(jsonOnly, "summary").includes(jsonOnly.structuredJson));
});

for (const status of ["error", "aborted", "steered", "stopped", "queued", "running"]) {
  test(`${status} retains status, error and partial output in each view`, () => {
    for (const structured of [true, false]) {
      const r = record(report(), {
        status, error: "provider failed distinctly", result: "partial work distinctly",
        ...(!structured ? { structuredJson: undefined } : {}),
      });
      for (const view of ["summary", "evidence", "full"]) {
        const rendered = renderAgentResult(r, view);
        assert.ok(rendered.includes(`status: ${status}`));
        assert.match(rendered, /未成功完成/);
        assert.ok(rendered.includes(r.error));
        assert.ok(rendered.includes(r.result));
        assert.doesNotMatch(rendered, /status: completed/);
      }
    }
  });
}

test("worktree branches and cleanup reports survive all views without asserting cleanup success", () => {
  for (const structuredJson of [JSON.stringify(report()), undefined]) {
    const r = record(report(), { structuredJson, worktreeResult: { hasChanges: true, branch: "pi-agent-preserved" } });
    for (const view of ["summary", "evidence", "full"]) {
      const rendered = renderAgentResult(r, view);
      assert.match(rendered, /分支：pi-agent-preserved/);
      assert.match(rendered, /cleanup 报告：hasChanges=true/);
      assert.match(rendered, /清理是否成功需核对/);
    }
  }
  const cleaned = record(report(), { worktreeResult: { hasChanges: false } });
  assert.match(renderAgentResult(cleaned, "full"), /hasChanges=false/);
  assert.doesNotMatch(renderAgentResult(cleaned, "full"), /分支：/);
});

test("full preserves original result, errors, branches and canonical report without any length limit", () => {
  const value = maximumReport();
  const r = record(value, {
    result: `RAW-BEGIN\n${"raw result ".repeat(5000)}\nRAW-END`,
    error: `ERROR-BEGIN\n${"error ".repeat(5000)}\nERROR-END`,
    worktreeResult: { hasChanges: true, branch: `BRANCH-BEGIN${"b".repeat(12000)}BRANCH-END` },
  });
  const rendered = renderAgentResult(r, "full");
  assert.ok(rendered.includes(r.result));
  assert.ok(rendered.includes(r.error));
  assert.ok(rendered.includes(r.worktreeResult.branch));
  assert.ok(rendered.length > 10000);
  assert.doesNotMatch(rendered, /已截断/);
  const canonical = rendered.split("canonical report（结构合格，事实需核对）：\n")[1];
  assert.deepEqual(JSON.parse(canonical), value);
});

test("full also preserves invalid JSON and legacy text in their entirety", () => {
  const r = { status: "aborted", result: "legacy ".repeat(10000), structuredJson: "{broken".repeat(10000) };
  const rendered = renderAgentResult(r, "full");
  assert.ok(rendered.includes(r.result));
  assert.ok(rendered.includes(r.structuredJson));
  assert.match(rendered, /未提供结构化结果\/证据未验证/);
  assert.doesNotMatch(rendered, /canonical report/);
});
