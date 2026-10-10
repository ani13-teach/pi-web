# 资源优化实施与验收计划

## 目标与范围

1. `pi-usage-monitor` 只有输入 `/usage` 才扫描历史。启动、消息结束、模型切换、压缩、面板刷新等均不扫描。先按文件最近修改时间筛选最近 30 天可能有活动的会话，再按消息时间统计；老会话最近新增消息不能漏计。
2. 桌面浏览历史不启动完整 AgentSession。明确继续任务时激活，事件流就绪后再发送，保留运行中的任务重连。子代理代码通过稳定入口加载，完整模块图的可变状态放在可回收实例中，避免随机 ESM URL 永久累积。

不删除聊天、不修改当前安全配置、不重启正在使用的程序，不进行真实模型/付费 API 调用。

## Todo 清单

- [x] 确认两个仓库的已有修改，保存差异和状态基线。
- [x] 阅读命令、扫描、事件流、SDK 生命周期与模块隔离代码。
- [x] 建立用量扩展、桌面类型与生命周期测试基线。
- [x] 制定按需激活、观察者不保温、编译实例工厂设计。
- [x] 实现仅 `/usage` 的手动扫描与 single-flight。
- [x] 实现 30 天候选筛选、记录时间过滤与单次 JSONL 解析。
- [x] 验证用量扩展全量回归和边界。
- [x] 实现历史只读、明确激活、SSE dormant 和被动重连。
- [x] 验证实际任务保护、空闲回收和错误清理。
- [x] 实现固定模块入口和独立子代理实例，完善释放。
- [x] 验证多会话隔离、重复激活、关闭竞态和迟到启动。
- [x] 修正预存的全量回归兼容失败；不新增 skip 掩盖问题。
- [x] 独立审查实际差异。
- [x] 运行两个项目完整自动测试、类型检查、构建和隔离 IPC/窗口验证。
- [x] 记录结果、已知排除项和生效方式。

## 边界测试

### 手动统计

- 启动、assistant/toolResult、模型切换、压缩和树切换不会扫描。
- `/usage` 参数错误或不支持的 UI 模式不会扫描。
- 连续命令不会重叠扫描；失败后能重试。
- 扫描期间关闭会话，迟到结果不恢复状态栏。
- `/usage-refresh` 与面板刷新不会隐式扫描。

### 最近 30 天

- 起点包含，终点不包含；无效/未来消息不计。
- 过期文件只检查元数据，不读正文、不解析；边界文件可计入。
- 很早创建但近期有消息的会话保留。
- 未来修改时间不能把未来消息算进统计。
- 缓存命中、过期候选清理、父子汇总及分叉去重保持正确。
- 不把文件名日期或会话创建日期当作最近活动日期。

文件 mtime 是候选筛选依据。异常导入工具若人为保留与实际近期消息不一致的旧 mtime，可能需要修正时间或单独提供完整重建方式；不得宣称完全不访问历史目录。

### 会话与子代理

- 查看历史没有 AgentSession/services 冷启动。
- 首次新建/继续：准备 -> 激活 -> SSE ready -> prompt，无早期事件丢失。
- 创建、可选模型设置、激活与 SSE 共用 60 秒准备期限；超时恢复未发草稿，不依赖可能也挂起的状态查询。
- 取消传播、singleton 身份清理与迟到响应保护，不误写会话 ID、不偷偷续发旧消息。
- 已激活、正在启动、休眠、缺失和已取消请求分别处理。
- 观察者和选中窗口不阻止空闲回收。
- 绑定中、变更命令、bash、压缩、前台和后台任务受保护。
- 宽限结束时后台 provider 活跃，保留观察 SSE 接收状态/控件；不续 lease，结束后的 dormant 关闭连接。
- 排队 -> 启动 -> 完成/取消/失败均释放父 signal 监听；无需等根会话 dispose，启动窗口仍可 Esc。
- dormant 不自动重试；网络错误仍可恢复；窗口可见/online 能被动探测。
- 两个父会话的 host、manager、配置和结果互不影响。
- 关闭 A 不影响 B；重复关闭、初始化失败和晚到子会话都释放引用。
- 固定 ESM 模块复用，不再用随机 URL 创建常驻模块实例。
- 以活动实例、监听器、定时器、注册表以及 heap 稳定性验收，不要求 RSS 立即恢复到完全相同数字。

## 已保存的基线

原始 diff、git status 和命令日志：
`C:/Users/WJZN/AppData/Local/Temp/pi-resource-baseline-GZY3sG/`

- 用量扩展 `npm test`、`npm run check`：通过。
- 桌面 `npm run test:desktop`：通过。
- 桌面类型检查原有 `restore-plan.ts` 不存在变量 `o`；仅改成实际参数 `options` 后通过。备份相关初次 85 项通过。
- 桌面 `npm run test:web` 初次：1244 项，1235 通过、4 失败、5 个既有环境排除。
- 已定位旧失败：locale 测试 data URL 相对导入、ChatWindow 源形断言指向旧组件、备份 discovery 新字段兼容、SDK 1.1 会话列表等时间排序。
- 后续定向兼容验证 21 项：20 通过、1 环境跳过；备份 discovery 失败随其他已有变更更新后不再复现，本次未扩大修改。

## 回归覆盖边界

`test:web` 的现有脚本排除了 9 个仅 web/Next 入口测试文件和 5 个 Windows 环境不适用测试，且不自动收集 `app/api` 测试。这些排除必须在最终结果中明确说明；本次修改的路由需要另外执行适配测试或实际 IPC 验证。

真实模型流式聊天和需要账号/网络的场景不以本次本地回归冒充验证。当前安装版 0.2.5 与源码版 0.2.6 不同，当前安装程序的占用不能直接当作新代码的运行结果。

## 最终结果

### 实际实现

- 用量目录：`C:/Users/WJZN/.pi/agent/local/pi-usage-monitor`。
  - `src/monitor.ts`、`monitor-lifecycle.ts`：只有合法 `/usage` 触发扫描，其他命令/面板只提示；无自动扫描或后台刷新 timer，关闭后不发布迟到 UI。
  - `src/monitor-store.ts`：同一 store single-flight、失败可重试、统计时刻固定。
  - `src/session-history.ts`：先 stat 筛 mtime，单次解析完整候选记录，保持完整候选缓存，归属/父子/分叉去重后按消息 `[since,until)` 过滤。
- 桌面目录：`C:/Users/WJZN/pi-desktop/pi-web`。
  - agent/events/state routes、`hooks/useAgentSession.ts`、event connection/stream、`lib/rpc-manager.ts`：历史休眠访问不初始化，显式准备有总截止；SSE 观察者不保温，实际任务仍受保护。
  - `scripts/build-subagent-factory.mjs`、build-desktop、`lib/subagent-extension.ts`、builtin 子代理 index/manager：稳定 ESM URL，共享代码但完整可变模块图实例隔离，结束后释放注册/监听/timer/子会话；排队 signal 不再累积。
  - 新的 callback/deadline/queue 行为测试与 `tests/resource-lifecycle-ipc.mjs`、`tests/resource-lifecycle-window.mjs` 覆盖故障和实际构建产物。

### 最后一轮验证（所有命令 exit 0）

| 检查 | 结果 |
| --- | --- |
| 用量 `npm test` | 60/60，0 fail/skip |
| 用量 `npm run check` | Biome + TypeScript 通过 |
| 桌面 `npm run typecheck` | 通过 |
| 桌面 `npm run test:web` | 1277 项，1272 pass，0 fail，5 个既有 symlink 环境 skip |
| 桌面 `npm run test:desktop` | 123/123 |
| 桌面 `npm run test:backup` | 88/88 |
| 桌面 `npm run build` | backend、稳定子代理工厂、renderer 全部构建成功 |
| 桌面 `npm run test:resources` | 编译工厂/路由 27/27 + 真实后台 IPC 22/22 |
| 桌面 `npm run test:resources:window` | 实际 Electron 27/27；端口快照无监听；抽样 7 个进程全部退出 |
| 桌面标准 `npm test`（隔离 HOME/agent） | 34/34，不带 `--prompt` |
| 桌面 `npm run test:smoke`（隔离） | PTY/SDK 6/6，不调用模型 |
| 桌面 `npm run test:models-config`（临时 agent） | 14/14，loopback-only 假 provider |
| 审查修复定向测试 | 80/80；包含真实 hook callback、单总 budget、迟到、重试、监听归零 |

测试集合存在交叉，不将上述数字相加冒充唯一测试总数。日志及 `verification-results.json` 在基线目录，最新日志以 `final3-` / `usage-final3-` 开头。

### 资源证据

- 仅检查真实历史元数据：1086 文件、963.90 MB，其中 459 候选、262.21 MB；627 过期文件、701.69 MB 的正文可跳过。本次没有刷新用户真实统计或改写用户缓存。
- 独立 GC 实验（不是整个应用 RAM）：旧随机 URL 导入 1/11/21/31 次的 heap 为 39.79/68.01/96.17/124.34 MB；新工厂最后一轮为 39.65/40.26/40.27/40.27 MB，仅 1 个 ESM URL。
- 12 次完整 activation/shutdown 后，manager records、维护 timer、监听和父 signal 订阅等诊断计数归零；新增排队测试不 dispose 根实例也能归零。
- 真实 IPC 使用合成审计扩展：历史/冷 SSE/只读请求 0 factory；6 并发激活 1 factory + 1 session_start；idle shutdown 一次；重新激活与最终退出各一次，最终无存活实例。

### 审查和基线保护

独立审查发现并修复：排队监听残留、激活挂起、后台 SSE 过早关闭、首次新建绕过截止。全部补了行为测试；最后的首次新建复核确认闭环。窗口最初 26/27 是空临时目录没有模型，补仅临时使用、不联网的假模型后 27/27，已保存可复用启动器。

两个仓库原始修改已保存，未 reset/stash/提交/覆盖用户工作。用量非目标 tracked diff 与基线一致；桌面期间另有备份/UI/启动相关并行变动，保留原样并在当前工作树完成全量回归，不把它们算成本任务改动。

JSON 工作树使用 CRLF，原始 `git diff --check` 会把新增行的 CR 视为行末空白。未改 Git 持久配置或格式化用户 JSON；按 Windows 换行识别运行以下检查，两仓库都 exit 0，真实空格/tab 检查仍启用：

```bash
git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check
```

### 重跑与生效

```bash
# 在桌面源码目录，先构建再运行新资源验收
npm run build
npm run test:resources
npm run test:resources:window
```

窗口测试会临时隔离 HOME、agent 和 Electron userData，使用不可连接到真实 provider 的假模型，不发送 prompt，不修改用户配置。

用量扩展需要下一次重新加载代码才能生效；最稳妥是在任务结束后完整退出再打开。桌面优化已在本次源码/构建中，不会自动替换当前安装版；需要后续使用新构建或打包安装。仅重新打开旧安装版不能获得桌面修复。

### 已知限制

- 5 个 symlink 测试因 Windows 权限跳过；9 个旧 Web/Next 入口测试仍按既有 runner 排除，未新增 skip。本次改过的 agent routes 已有独立适配测试和真实 IPC 验证。
- 没有执行真实 provider 的流式聊天、需要网络/账号的 resilience/prompt 测试、打包安装版验收或长时间真实工作负载。以上本地测试不能冒充这些验证。
- 60 秒截止保证客户端恢复，不等于能强行终止任意第三方扩展的永久挂起。后台正在工作的任务不会为了降内存被强杀。
- mtime 候选有导入工具保留旧时间戳的限制；统计也仍需枚举目录和 stat。未承诺零 IO、零内存增长或修复所有其他扩展。
- 没有重启/替换用户当前程序，没有删除聊天或实际任务，没有修改当前安全配置；安装版旧进程的占用不是新代码效果。

