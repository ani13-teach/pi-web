# 子代理两阶段实现：回归与对抗审查记录

## 范围与结论

完成第一阶段（任务登记、依赖门禁、一次性采用、通知降噪）和第二阶段（结构化摘要／证据／全文交付）。两轮独立审查及一次重载补丁窄复审发现的阻断问题已修复，现有验收范围内无未解决的测试失败。

这不是已安装应用或在线模型效果认证。没有修改 SDK 源码、用户配置或权限，没有修改外部 pi-subagents 源目录；工作区已有及并行修改保留。

## 审查中实际发现并修复的问题

| 问题 | 修复及防回归覆盖 |
|---|---|
| queued resume 遗留已解决 startGate，造成微任务自旋 | 重置旧 promise，启动后清除 gate；并发上限 1、事件循环检查、任务身份／运行版本断言 |
| 独立批次提前 final 绕过必需 join | 提交合法隐藏 custom-message draft，SDK 继续进入门禁；验证实际后续 provider 请求采用结果 |
| 未结算旧运行 resume 后迟到写污染新运行 | manager 与工具入口均拒绝未结算 resume；Stopped 立即报告与实际结算区分 |
| input 被其他扩展 handled，旧依赖仍提前失效 | 仅 SDK 确认 queued 后撤销；prompt／steer／followUp handled 均保留依赖 |
| 结构报告前台 resume 返回 No output | 使用完整报告渲染，保留 tool-only 输出 |
| resume 静默忽略输出格式 | 继承原契约，双向显式格式切换拒绝 |
| verbose 截断工具参数或长尾内容 | 全部会话消息 JSON 无损序列化，格式化成功后再消费 |
| 第三方 wrapper 保留旧 gate，同会话 reload 被旧 AbortSignal 阻断 | released 后旧 wrapper 透明转发；已等待请求仍中止。真实 SDK 空闲／等待中 reload，保留四个外层 wrapper 并验证重新汇合 |
| 验收可能允许 legacy fallback 或模拟安全成功而假通过 | Unicode 强制 Schema 合格；真实自动模式 handler、本地分类器成功／无效响应拒绝；检查实际工具声明和成功 StructuredOutput 结果 |

另修正了原有 `tests/npx-lifecycle.test.mjs` 的 Windows 测试夹具：npm exec 内部 shell 拆分 `Program Files` 路径，不是 `lib/npx.ts` 的 execFile 回归。夹具使用 `--call`、本沙箱 PATH 和相同运行时文件名；仍真实运行离线 npx 与三代子进程，不减断言，不改生产启动代码。

## 自动化验证

各组有重叠，数量不可相加为独立用例总数。

| 验证 | 结果 |
|---|---|
| 四个新增套件：task-coordination、result-protocol、coordination、display | 63 通过，0 失败／跳过／取消 |
| `npm run test:web -- --serial` | 1360 通过，0 失败，2 跳过 |
| `npm run test:desktop` | 123 通过，0 失败／跳过／取消 |
| `scripts/build-subagent-factory.test.mjs` | 16 通过，0 失败／跳过／取消 |
| scoped TypeScript 检查 | 通过；仅额外排除工作区第三方 `research_evidence/`，正式 tsconfig 未修改 |
| 来源 manifest | 校验 65 个 Desktop 文件通过，外部源只读 |
| `npm run build` | 通过；有既有 INEFFECTIVE_DYNAMIC_IMPORT 提示，无构建错误 |
| `git diff --check` | 通过 |

Web 使用项目原有 runner：排除 9 个文件，过滤 5 个当前宿主不支持的用例，不收集需要额外 Next 适配器的 app/api 测试；报告中的 2 个 skip 为 Windows 项目目录符号链接用例。本次没有修改这些过滤或跳过规则。

可复跑：

```bash
node --test lib/subagent-task-coordination.test.mjs lib/subagent-result-protocol.test.mjs lib/subagent-coordination.test.mjs lib/subagent-display.test.mjs
npm run test:web -- --serial
npm run test:desktop
node --test scripts/build-subagent-factory.test.mjs
node builtin/pi-subagents/scripts/source-manifest.mjs
npm run build
```

本地日志：`.tmp-coordination-new-regression.log`、`.tmp-coordination-web-regression.log`、`.tmp-coordination-desktop-regression.log`、`.tmp-coordination-factory-regression.log`、`.tmp-coordination-typecheck.log`、`.tmp-coordination-build.log`。

## 验证边界与后续建议

- 集成测试使用真实 SDK／本地 provider／实际 Agent 工具／受控屏障，不请求在线模型。固定 mock usage 不能证明真实 token 或耗时收益。
- `rpc-manager.ts` 的生产注册／绑定顺序经源码复审，RPC 回归也通过；还未新增从完整生产 `startRpcSession` 到实际模型请求的端到端验收。现有 SDK 集成使用测试 getter，不能冒称覆盖了该完整启动链。
- 窄复审另建议补充跨 reload 延迟返回 queued／preflight 回调、worktree 清理屏障中的 resume，以及 verbose 序列化异常等更细的组合用例。这些建议不是本轮发现的未修复阻断，不将其宣称为已执行。
- scope／independent_work 是归属声明，不是自动语义去重；同批已发出的工具不能追溯撤销。无通用 DAG、文件锁或资源租约。
- Schema 合格仅证明格式，不证明事实；摘要限长，full／verbose 保留全文。
- 构建输出不会替换用户正在运行的安装应用；打包／安装需另行执行。
