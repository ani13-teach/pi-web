# 子代理默认后台与静默展示

## 行为

- 顶层 `Agent` 默认后台；本次明确传入的 `run_in_background` 优先于代理文件里的模式，再使用全局默认。显式前台仍有效。嵌套调用保留原有默认前台行为。
- 五个程序自带代理继承调用方默认：顶层后台、嵌套前台，不在预设里硬编码后台。已有个人配置文件不被改写。
- 运行时与配置界面使用同一个代理注册表和合并设置。界面显示实际生效来源与默认模式。
- `disableDefaultAgents` 只关闭工厂预设，用户明确保存的 `desktop-agents/*.md` 仍生效；单项停用与删除标记仍受尊重。停用的高优先级配置不会让低优先级同名配置自动复活。
- 主聊天隐藏内置子代理控制调用和内部完成通知；正常文本、思考、普通工具及主代理报错仍展示。不删除会话记录，不过滤模型上下文。普通 Desktop 协调调用现在使用当前请求内交付而非额外 follow-up；其他原有路径的通知/继续机制保留，详见 [协作调度](subagent-coordination.md)。
- 实时隐藏依赖 SDK 的 `<inline:pi-subagents>` 工具来源，不单凭 `Agent` 等名称。执行开始时将调用 ID 与 assistant entry ID 保存为单独的 `pi-web:subagent-display` 元数据；即使参数校验失败或权限拦截，刷新和翻页后仍能还原 UI 来源，不往 SDK 消息或模型上下文写显示字段。旧历史记录也可以对应工具结果的 `details.kind` 识别；没有来源证据的旧调用不猜测隐藏，避免误伤同名第三方工具。内部通知有持久化来源字段，旧版通知按已知结构识别，不仅凭 customType 隐藏。
- 普通会话列表和普通会话搜索按 `relation.kind === "subagent"` 隐藏子会话；底层完整会话集合不变。复用顶部 `Agents` 查看状态、打开完整子会话、返回主会话；不自动跳转。
- 关系与状态由现有增量 JSONL 扫描提取，不假定子代理标记在第二行，也不受大段任务／提示词超过前缀上限的影响。索引只新增身份与最后有效状态摘要；新增摘要不包含任务、提示词或结果全文，原有首条消息等展示信息保持不变。未变化文件复用摘要。磁盘与内存索引均校验格式版本，旧索引重建但不改会话历史。
- 显式子代理标记的父路径必须与文件头一致，避免普通分支继承标记后被误隐藏；存活运行时的已验证子代理关系与状态优先于同文件的滞后磁盘快照，其他展示字段仍用磁盘数据。
- 子代理失败仍保留原始错误、结果、状态与通知，供主代理汇总并在 `Agents` 查看。

## 边界

后台表示启动工具不等待整个子任务，不表示独立系统进程或应用退出后继续运行。普通 Desktop 协调任务默认在下一次主模型请求前等待必需结果，声明独立工作才授权一批继续；并不保证主代理始终非阻塞。主会话关闭仍按原有规则停止所属子代理。显式等待结果或独立操作依赖子任务结果时出现等待是正常行为。

已有文件配置为前台时，省略参数仍尊重该有效配置；若想默认后台，可在现有代理配置界面切换，或者本次明确传 `run_in_background: true`。没有自动覆盖个人文件或删除配置。

## 验证

- 配置与模式：`lib/subagent-invocation.test.mjs`、`lib/subagents.test.mjs`、`components/AgentsConfig.test.mjs`。
- 真正非阻塞：`lib/subagent-extension.test.mjs` 使用本地模拟模型和受控屏障。必须证明子任务未释放时调用已返回，主代理已完成独立操作；另覆盖两个并行子任务。释放后完整结果及内部通知到达。
- 静默与还原：`components/SubagentSilence.test.mjs`、`components/MessageView.test.mjs`、`lib/message-display.test.mjs`、流式事件/快照/归一化测试。
- 会话可见性与导航：session-family、session-search、SessionSidebar、AgentSessionPanel 测试。
- 类型和打包：`npm run typecheck`、`npm run build`，以及隔离的实际打包窗口 smoke。

## 本次验收记录

- 针对测试：375 项，374 通过、0 失败、1 项因本机符号链接权限而跳过。
- `npm run typecheck`、前后端构建通过，source manifest 校验通过。
- 实际打包程序复制到仓库以外运行，使用临时配置与本地模拟模型条目，不调用真实模型：窗口 **27/27** 检查通过；包含主聊天历史/原生调用与通知隐藏、普通侧栏排除子会话、顶部 Agents 状态和开关、主动打开完整子过程、返回主会话仍静默。
- 退出检查：抽样时无监听端口；抽样到的 7 个程序进程全部退出。此检查是单次抽样，不代表持续监控。
- 打包目录：`release/subagent-silent-0.2.4/win-unpacked/`。这是独立验证包，不是已经替换或安装到当前运行程序。
- 日志：`.tmp-subagent-all-tests.log`、`.tmp-subagent-build.log`、`.tmp-subagent-package.log`、`.tmp-subagent-window.log`。窗口退出时仍有已有的 `This operation was aborted` IPC 收尾日志；验收退出码与所有检查通过。

## 运行中子会话误显示修复

- 根因：旧关系读取仅检查文件前两行；SDK 在标记前写入模型、思考和名称条目，导致运行中子会话被识别为 fork，且磁盘快照覆盖正确的运行时关系。完成后父会话的原生记录才使备用识别生效。
- 经方案审查，改为复用 `session-list-scanner.ts` 的完整增量扫描，缓存精简关系／最后有效状态；索引格式由 2 升为 3，同时处理热更新保留的旧内存索引。`session-reader.ts` 不再追加前缀／尾部补读，避免遗漏、重复与状态顺序问题。
- 回归覆盖真实 SDK 创建顺序下单／双子任务仍被屏障保持运行、父任务独立继续、完成后及关闭运行时仍隐藏、Agents 可达，以及巨型 metadata、普通 fork、无效／半行状态、恢复运行、旧索引升级和投影对象隔离。
- 本轮定向 135 项：133 通过、0 失败、2 项因 Windows 符号链接限制跳过；日志 `.tmp-subagent-list-regression.log`。`npm run build` 通过；日志 `.tmp-subagent-list-build.log`。最终只读 review 通过。
- 原 `npm run typecheck` 会扫描工作区未跟踪的 `research_evidence/` 第三方资料；未为消除这些错误删除资料或修改项目类型配置。其他任务也在并发修改工作区，因此另以 `git archive HEAD` 建立仓库外临时副本，仅覆盖本次 8 个修复／测试文件及 `rpc-manager.ts` 的单行调用改动；依赖使用现有 `node_modules` junction。隔离副本中原始 `npm run typecheck`、`npm run build`、135 项回归均退出 0，133 通过、2 平台跳过。日志 `.tmp-subagent-list-isolated-{typecheck,build,regression}.log`；已先移除 junction 本身再清理副本，不修改共享依赖。此结果不为其他任务的并发改动背书。
- 独立开发版窗口检查 27/27，后置检查 3/3，退出 0；日志 `.tmp-subagent-list-window-retest.log`。覆盖完成态夹具的普通侧栏隐藏、Agents 打开／返回以及主聊天静默；运行中识别由上述真实 SDK 屏障回归验证。首轮空白临时环境因零可用模型导致自动模式表单断言失败（26/27），补入临时占位模型后原断言全部通过，未调用真实模型、未弱化检查。临时 cwd／agentDir／userData 已清理；端口及 7 个进程退出仅为一次采样。
- 此修复不改变个人代理配置，不安装、不替换正在运行的程序，不生成新安装包。

## 回退

优先回退此功能对应的源码修改并重新构建。工作区含其他功能改动，不可使用全仓 `git reset --hard` 或覆盖整个个人配置目录。

没有迁移或改写个人代理文件，因而无需恢复个人配置。若用户自行改过前后台开关，可在代理界面逐项恢复。不要为回退执行删除会话历史或子会话关系的操作。
