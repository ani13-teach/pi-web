# 子代理协作调度与精简结果

本功能是第一阶段（任务登记、依赖等待、通知去重）及第二阶段（结构化交付）的 Desktop 实现。不是自动语义去重、完整 DAG、文件锁或通用工作流引擎。

## 默认行为

Desktop 根会话安装公开 `Agent.prepareRequest` 门禁。普通顶层后台 `Agent` 默认 `required:true`：启动工具立即返回 ID，但下一次主模型请求在必需子任务结束前等待，不轮询模型、不重新进行同一调查。结果在现有请求中持久化并采用，不再发额外 follow-up。

前台调用保留原有同步及全文结果；嵌套子任务、workflow、定时任务和外部 RPC 启动保留其原有所有权/通知路径。没有 Desktop 门禁的宿主保留旧行为。

可选字段：

- `task_key`、`scope`、`deliverable`、`input_version`：任务身份、范围、交付物及调用方输入版本；仅作为任务数据，不是已经验证的证据。
- `independent_work: string[]`：明确不与子任务重复的工作，授权主代理一次模型请求/工具批次，然后重新等待。并行启动多名子代理不会叠加无限额度。
- `required:false`：可选顾问任务。结束后普通结果留在 Agents，不启动额外回复；原始失败状态和生命周期事件仍保留。
- `result_format:"text"`：旧模型兼容。默认协调后台子任务使用 `StructuredOutput` 报告；不提交合格报告会保留失败，不伪造结构化证据。

`subagent_tasks`：`independent` + `work` 再授权一批独立工作；`wait` 撤销额度；`finish` 明确结束当前任务（必需结果尚未采用时拒绝）。声明独立工作仍是模型承诺，不是语义分析器，无法自动判定不同命令是否在做同一调查。同一模型已经发出的工具批次也不能被请求门禁追溯撤销。

## 生命周期与取消

- 真实 `agent_settled` 关闭本次请求，不把普通 `agent_end` 当最终结束。
- 在独立批次后提前产生最终答案时，若还有必需结果，`turn_end` 请求一次继续，下一次请求门禁汇合结果；不能跳过汇合。但模型已经生成的早期文本不会被偷偷删除。
- 主代理 Stop 取消等待，不自动取消后台子任务；关闭会话按原规则停止子任务。
- 等待中的新用户 steer/follow-up 解除旧任务等待并使旧结果失效，不清空 SDK 用户消息队列，不自动采用旧证据。消息仍沿 SDK 原有队列顺序处理。
- 子任务状态先完成但 worktree 清理尚未结束时，不提前采用缺少分支信息的结果；队列中的停止和恢复均可解除等待。stopped 结果可以立即报告，但 provider/清理未真正结算前拒绝再次 resume；可显式 `get_subagent_result wait:true` 等结算。排队 resume 启动后清除已解决的 startGate，避免事件循环自旋。
- 已采用、已显式读取、旧请求或已结束任务的协调结果，不重复发送 follow-up。重新运行同一代理递增 `runVersion`，结构化捕获重新初始化，不复用上一次答案。
- 安全处理不变：新协调工具与 `StructuredOutput` 仍经过 SDK 工具校验及自动模式。没有新增安全白名单或修改用户权限设置。
- 同一会话 reload 时，先中止旧门禁中正在等待的请求，再释放旧协调副作用；第三方扩展若保留了旧方法包装，之后的调用透明转发，不因已中止的旧 activation 阻断新请求。不覆盖第三方的外层钩子。

## 结果协议

报告含 `conclusion`、`evidence`、`uncertainties`、`nextAction`。证据含文件、可选行号及输入版本、说明；未提供的信息不会由主代理代码推断补齐。Schema 验证仅证明格式合格，不证明事实真实。

resume 继承原会话输出格式，显式 structured↔text 切换明确拒绝（需要新建代理），不会静默忽略。本次转前台 resume 也返回 StructuredOutput 中的完整答案，即使最终文本为空。

`get_subagent_result` 默认 `view:"summary"`：结论、全部不确定性、下一步、证据数量。`view:"evidence"` 加上定位，支持定点复核。`view:"full"` 提供原始输出和完整合格报告；`verbose:true` 额外返回原始会话消息的完整 JSON（含工具参数、结果和内容块，不做 200 字符节选）。原始输出可在子会话中查看。摘要最多 5000 UTF-16 字符，证据视图最多 10000；旧文本节选最多 1600，状态/统计/任务包装另计。截断明确标注，不把“未验证”变成“已验证”。

根会话只保存一次摘要交付，不默认把子代理完整工具过程复制到主上下文。当前任务表是有界的请求投影，不逐轮追加到持久历史。

## 验收

完整结果、修复清单及未覆盖边界见 [回归与对抗审查记录](subagent-coordination-verification.md)。

```bash
node --test lib/subagent-task-coordination.test.mjs lib/subagent-result-protocol.test.mjs lib/subagent-coordination.test.mjs lib/subagent-display.test.mjs
```

前两组使用隔离构建；集成组使用真实 SDK、由模拟主模型实际发出 Agent 调用、本地 provider、受控屏障和请求计数。覆盖默认等待、独立批次、并发、队列停止、Stop、新输入、迟到结果、失败、resume、根隔离、别名消费竞态、终局汇合、旧文本、安全失败，以及第三方方法包装保留情况下真实 SDK 的空闲/等待中 reload。保留真实安全处理，只模拟分类器服务；不修改权限配置。

这些测试验证调度与传输，不是在线模型基准。模拟 usage 是固定值，不能用来宣称实际 token/总耗时改善；仍需真实模型任务对照测试才能量化收益。构建源码不会更新当前安装应用，需另行打包并安装。
