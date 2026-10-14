# 授权模型管理

在设置 → 模型 → 已登录订阅 / 已配置 API Key 页面，账号与用量下方增加模型管理。

- 目录包含该服务商的全部对话模型，包括尚未进入白名单的模型；不触发在线推理。
- 勾选决定桌面可选列表；搜索只过滤显示，不清除选择。搜索状态的批量操作只影响搜索结果。
- 可逐模型设置正整数上下文长度，留空或“恢复默认”使用目录默认值。
- 切换服务商保留未保存草稿；统一使用底部保存。数字无效时阻止保存；保存失败或部分失败保留草稿。
- 全不选隐藏该账号的所有模型，不注销登录。已有对话不会被强制换模型。

## 持久化与生效

上下文通过 SDK 原生 models.json → providers[id].modelOverrides[modelId].contextWindow 配置。只编辑上下文字段，保留其它模型参数、请求头等字段；删除最后一项时清理空定义，避免无效提供商配置。

显式选择通过 models.json 顶层 desktopModelSelections 保存：缺项沿用原有选择；空数组表示明确隐藏。同步全局 settings.json.enabledModels 时保留其它提供商的原有规则与思考级别，并避免旧的自动同步重新启用已关闭模型。

桌面可选列表与新会话应用显式名单；历史会话不被强制切换。保存后通知已打开的聊天界面刷新列表。上下文设置供新会话、重新加载后的会话使用，不提高服务商真实容量。这里不是账号访问权限隔离；子代理的既有策略不变。

models.json 与 settings.json 不支持跨文件共同提交。若第二个文件保存失败，界面明确提示部分保存并保留草稿，重试可同步；不能显示全部成功。自定义模型需要同步时，desktopModelSyncPending 记录待完成工作，防止相同请求重试漏掉同步；完成后清除。外部程序同时修改设置仍按最后一次保存生效。

同时编辑授权名单和添加自定义模型时，两部分都会同步。已有桌面会话重新选择模型时，先离线刷新目录，让只修改上下文的配置也生效；不强制切换正在使用的模型。

## 验证入口

- 类型检查：npm run typecheck
- 构建：npm run build
- 纯逻辑：components/auth-model-drafts.test.mjs、lib/auth-model-settings.test.mjs
- 原模型页面回归：components/ModelsConfig.test.mjs、lib/enabled-models-sync.test.mjs、lib/model-scope.test.mjs、hooks/model-loading.test.mjs
- 隔离真实后端：node tests/auth-model-settings-ipc.mjs 与 node tests/models-config-sync.mjs
- 隔离真实浏览器：node tests/auth-model-settings-browser.mjs

浏览器使用真实 React 组件与样式，API由测试数据替代；独立临时运行目录，禁止在线认证/模型请求，不读取真实凭据或更改用户配置。截图和每项结果保存在 docs/validation/auth-models/<运行时间>/。外部标签外壳使用设置页相同布局，不验证其它设置标签的功能。
