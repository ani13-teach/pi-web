/** Bounded, evidence-aware views of a child report. Validation checks shape, not truth. */
import type { AgentRecord } from "./types.js";
import { compileJsonSchema, type CompiledSchema } from "./workflow/json-schema.js";

export const RESULT_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["conclusion", "evidence", "uncertainties", "nextAction"],
  properties: {
    conclusion: { type: "string", maxLength: 1400 },
    evidence: {
      type: "array", maxItems: 8,
      items: {
        type: "object", additionalProperties: false, required: ["file", "note"],
        properties: {
          file: { type: "string", maxLength: 240 },
          line: { type: "integer", minimum: 1 },
          inputVersion: { type: "string", maxLength: 160 },
          note: { type: "string", maxLength: 400 },
        },
      },
    },
    uncertainties: { type: "array", maxItems: 6, items: { type: "string", maxLength: 400 } },
    nextAction: { type: "string", maxLength: 600 },
  },
};

const compilation = compileJsonSchema(RESULT_REPORT_SCHEMA);
if (!compilation.ok) throw new Error(`Cannot compile RESULT_REPORT_SCHEMA: ${compilation.message}`);
export const compiledResultReport: CompiledSchema = compilation.compiled;

export type ResultView = "summary" | "evidence" | "full";
type ResultRecord = Pick<AgentRecord, "result" | "error" | "status" | "structuredJson" | "worktreeResult">;
interface ResultReport {
  conclusion: string;
  evidence: { file: string; line?: number; inputVersion?: string; note: string }[];
  uncertainties: string[];
  nextAction: string;
}

const SUMMARY_LIMIT = 5000;
const EVIDENCE_LIMIT = 10000;
const LEGACY_LIMIT = 1600;
const FULL_HINT = '完整内容：get_subagent_result view="full"。';

/** Limits are UTF-16 lengths, even if the schema validator counts Unicode code points. */
function clip(text: string, limit: number, label: string): string {
  if (text.length <= limit) return text;
  const marker = `…[${label}已截断；${FULL_HINT}]`;
  const end = Math.max(0, limit - marker.length);
  // Avoid splitting a surrogate pair at the cut.
  const boundary = end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end;
  return text.slice(0, boundary) + marker.slice(0, limit);
}

function reportFrom(json: string | undefined): ResultReport | undefined {
  if (json === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    return compiledResultReport.check(value) === true ? value as ResultReport : undefined;
  } catch {
    return undefined;
  }
}

function statusText(record: ResultRecord): string {
  return `status: ${record.status}${record.status === "completed" ? "" : "（未成功完成；以下可能是部分输出）"}`;
}

function worktreeText(record: ResultRecord, full: boolean): string {
  const result = record.worktreeResult;
  if (!result) return "";
  const branch = result.branch === undefined ? "" : `；分支：${full ? result.branch : clip(result.branch, 160, "分支")}`;
  // hasChanges alone cannot prove that best-effort cleanup actually succeeded.
  return `工作树 cleanup 报告：hasChanges=${result.hasChanges}${branch}。清理是否成功需核对。`;
}

function metadata(record: ResultRecord, full: boolean): string[] {
  const blocks = [statusText(record)];
  if (record.error !== undefined) blocks.push(`错误：\n${full ? record.error : clip(record.error, 240, "错误")}`);
  const worktree = worktreeText(record, full);
  if (worktree) blocks.push(worktree);
  return blocks;
}

function summary(record: ResultRecord, report: ResultReport): string {
  const prefix = metadata(record, false);
  prefix.push("子代理报告，需定点核对。结构符合 Schema 不代表事实真实，证据未验证。");
  if (record.status !== "completed" && record.result !== undefined) {
    prefix.push(`部分原始输出：\n${clip(record.result, 240, "部分输出")}`);
  }
  const uncertainties = report.uncertainties.length
    ? report.uncertainties.map((text, i) => `${i + 1}. ${clip(text, 400, `不确定性 ${i + 1}`)}`).join("\n")
    : "子代理未报告不确定性（不代表已经验证）。";
  const tail = [
    `不确定性（${report.uncertainties.length} 项）：\n${uncertainties}`,
    `下一步：\n${clip(report.nextAction, 600, "下一步")}`,
    `子代理报告证据数量：${report.evidence.length}（未验证）。`,
    `证据定位及输入版本：get_subagent_result view="evidence"。${FULL_HINT}`,
  ];
  // Reserve every uncertainty and the next action before spending space on the conclusion.
  const fixed = [...prefix, "结论：\n", ...tail].join("\n\n");
  const budget = Math.min(1400, SUMMARY_LIMIT - fixed.length);
  return [...prefix, `结论：\n${clip(report.conclusion, budget, "结论")}`, ...tail].join("\n\n");
}

function evidenceView(record: ResultRecord, report: ResultReport): string {
  const core = summary(record, report);
  if (!report.evidence.length) return `${core}\n\n证据：子代理未提供证据。`;
  const heading = "\n\n证据（子代理报告，需定点核对）：\n";
  const locators = report.evidence.map((item, i) => {
    const line = item.line === undefined ? "" : `:${item.line}`;
    const version = item.inputVersion === undefined
      ? "未提供（不可推断）" : clip(item.inputVersion, 160, "输入版本");
    return `${i + 1}. ${clip(item.file, 240, "证据文件")}${line}\n输入版本：${version}\n说明：`;
  });
  const fixedLength = core.length + heading.length + locators.join("\n\n").length;
  const noteBudget = Math.min(400, Math.floor((EVIDENCE_LIMIT - fixedLength) / locators.length));
  return core + heading + locators.map((locator, i) =>
    locator + clip(report.evidence[i].note, noteBudget, `证据说明 ${i + 1}`),
  ).join("\n\n");
}

function legacyView(record: ResultRecord): string {
  const blocks = metadata(record, false);
  blocks.push(record.structuredJson === undefined
    ? "未提供结构化结果/证据未验证。"
    : "未提供结构化结果/证据未验证：structuredJson 未通过结果报告 Schema（可能是 malformed JSON 或其他结构）。");
  blocks.push("无法从旧文本推断证据、输入版本或不确定性；以下仅为原始输出节选。", FULL_HINT);
  const fixed = [...blocks, "原始输出：\n"].join("\n\n");
  const text = record.result ?? record.structuredJson ?? "（无输出）";
  return [...blocks, `原始输出：\n${clip(text, LEGACY_LIMIT - fixed.length, "原始输出")}`].join("\n\n");
}

/** Full is intentionally unbounded; compact views never imply validation of the facts. */
export function renderAgentResult(record: ResultRecord, view: ResultView): string {
  const report = reportFrom(record.structuredJson);
  if (view === "full") {
    const blocks = metadata(record, true);
    blocks.push("子代理报告，需定点核对；证据未验证。");
    if (record.result !== undefined) blocks.push(`原始 result：\n${record.result}`);
    if (report) {
      // Rebuild in protocol order rather than retaining the model's JSON whitespace/key order.
      const canonical = {
        conclusion: report.conclusion,
        evidence: report.evidence.map(item => ({
          file: item.file,
          ...(item.line === undefined ? {} : { line: item.line }),
          ...(item.inputVersion === undefined ? {} : { inputVersion: item.inputVersion }),
          note: item.note,
        })),
        uncertainties: report.uncertainties,
        nextAction: report.nextAction,
      };
      blocks.push(`canonical report（结构合格，事实需核对）：\n${JSON.stringify(canonical, null, 2)}`);
    } else {
      blocks.push("未提供结构化结果/证据未验证。");
      if (record.structuredJson !== undefined) blocks.push(`原始 structuredJson（未通过结果报告 Schema）：\n${record.structuredJson}`);
    }
    return blocks.join("\n\n");
  }
  if (!report) return legacyView(record);
  return view === "evidence" ? evidenceView(record, report) : summary(record, report);
}
