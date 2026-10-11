# 主子代理共同能力与显式设置

主会话、新建子代理和恢复子会话共用 `lib/desktop-session-extensions.ts` 中的普通工具提供者和去重规则。codemode 仍由全局/项目 `defaultTools` 选择是否启用；只注册不自动开启。所有新建和恢复会话保留同样的 automode 安全处理器。扩展中间调用（包括 codemode 与工作流 gate）仍通过真实工具检查。

## 默认与差异设置

- 新的五种内置预设默认发现扩展与技能。`work` 使用全部平台基础工具，其他角色保留明确列出的工具选择。
- 已保存的 `desktop-agents/*.md`、项目和全局代理文件不自动迁移或覆盖。文件明确设置的 false、工具清单、选择器和禁止项继续有效。
- `extensions: false`/`isolated: true` 关闭普通扩展能力；安全处理器不随之关闭。`isolation: off/worktree` 只控制工作目录隔离。
- `tools` 中的 `ext:<扩展>/<工具>` 选择器限制扩展工具，不负责加载扩展。`exclude_extensions` 和 `disallowed_tools` 优先。`builtin:codemode` 与命名 inline 扩展有规范名称供选择器使用。
- `allowed_subagents` 未设置时，在正常扩展会话中默认允许全部已启用角色；false、none 或空值明确关闭，列表限制角色。关闭扩展会话保留显式启用嵌套的兼容设置。
- 子代理拥有 Agent、结果获取、引导、任务协调和启用的工作流能力，但任务记录按 owner 隔离。它们共享所属分支的管理器，不获取其他 owner 的历史任务。嵌套深度和并发设置继续约束资源消耗。

## 恢复与重载

版本2资源快照记录完整的显式策略（扩展/技能列表、工具选择和禁止项、配置目录、允许角色和历史深度），不把某一回合的工具清单冻结为永久能力上限。工具文件操作绑定真实 cwd，配置和信任判断绑定保存的 configCwd。恢复后的独立 owner 不重新连接已经结束的父管理器。版本1快照保守保持原清单，不自动扩权。损坏的版本2快照按无工具恢复。

主、子会话都使用可重新发现资源的过滤加载器。每个模型请求前再次收窄执行工具和真实工具声明，包括 before_agent_start 临时注册和扩展命令重载。间接调用也受 tool_call 范围检查，不能借 codemode 使用未选中的 deferred 工具。

## 验证入口

`lib/subagent-capabilities.test.mjs` 使用真实 SDK/RPC、临时资源目录及本地模拟模型，覆盖 codemode 实际返回42、开关/排除/禁止项、直接与间接调用、扩展动态注册、重载、不同配置/工作目录、恢复后的实际嵌套创建与清理。`builtin/pi-subagents/nested-tools.test.mjs` 和 `restored-tools.test.mjs` 覆盖协调、工作流安全 gate、启动失败不会无限等待、深度/owner范围和管理器维护。

修改源码并构建不会自动替换已安装的 Pi Desktop；安装版需要重新打包安装或从源码启动后才能使用新机制。
