# 本地维护：每个 Agent 独立备用模型

来源：本机 npm 安装的 `@tintinweb/pi-subagents@0.19.0`。原 npm 包保留不动，当前扩展入口仍为 `src/index.ts`。

## 配置

在各 Agent 的 Markdown frontmatter 中添加 `fallback_model`。已有配置位置：

- 全局：`C:/Users/jch/.pi/agent/agents/<agent>.md`
- 项目：`<project>/.pi/agents/<agent>.md`（优先于同名全局 Agent）

例如（仅示例，请填入自己已配置、可用的模型）：

```yaml
---
name: reviewer
model: provider-a/main-model
fallback_model: provider-b/backup-model
thinking: high
---
```

每个 Agent 可以填写不同的 `fallback_model`；不填写则不自动切换。支持现有模型名称解析，但明确填写的 provider 不会被静默替换为其他 provider。未替用户指定任何备用模型。此版本通过 Markdown 配置，没有新增桌面设置表单控件。

## 行为

- 等待 Pi 内核的原模型重试结束后，针对 provider、网络或认证失败最多切换一次。
- 使用同一子会话与已完成的工具历史，发送续跑提示，不从头重新执行原任务。若认证预检失败且原请求尚未入历史，只向备用模型提交原提示一次。
- 取消、达到回合上限、输出 token 上限、结构化输出校验失败、未知本地异常不触发切换。
- 备用不可用、已是当前模型或切换失败，保留原失败；备用也失败时停止，不循环换回主模型。
- 结构化输出补问共享本次切换预算；显式恢复会话是新的调用，最多再切一次。成功切换后该子会话继续使用备用模型，不自动切回。
- 保留现有 Model Scope 策略：用户 frontmatter 配置越界会告警，但允许；不扩大 enabledModels。
- 成功切换有提示，显示原因和实际模型。两边产生的用量仍经过原有累计逻辑。

续跑提示不能强制保证模型绝不重复工具操作；不存在整任务自动重放机制。

## 验证与维护

离线针对性测试（无真实模型请求）：

```bash
node --test test/*.test.ts
```

`node_modules` 是指向现有 `C:/Users/jch/.pi/agent/npm/node_modules` 的本地 junction，复用已安装依赖。不要在此运行全包更新或随意覆盖 `src/`。原 npm 包和本地源差异即本地补丁。

全局 `settings.json` 的 `packages` 改为 `local\\pi-subagents` 后，新会话或 `/reload` 加载本地版。重新加载前先结束正在运行的子代理。回滚只需把该项改回 `npm:@tintinweb/pi-subagents`；Agent frontmatter 的新字段会被原版忽略。
