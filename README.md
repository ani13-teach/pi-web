# Pi Desktop

Windows 桌面版的 pi coding agent。界面和服务端基于 pi-web 移植，并有本地功能修改。
**桌面内部通信不监听本地端口**：窗口和后台之间走 Electron 的进程间通信（IPC），
后台进程承载会话、模型、文件、终端等服务。

## 文档导航

- **首次使用或接手开发**：[项目入门与维护指南](docs/project-guide.md)（环境、启动、目录、数据、测试、排错和交付）。
- **功能与实现概览**：本 README；命令从下文「命令」开始。
- **备份现状与后续目标**：[备份与恢复](docs/backup-plan.md)，注意首版不等于完整恢复所有用户数据。
- **历次改动和验证证据**：[REVIEW-FIXES.md](REVIEW-FIXES.md)。其中旧测试数量与旧交付包仅是历史记录，不代表当前验收。

本文的维护基线为源码 `0.2.4` / Pi 内核 `1.1.0`；实际版本以 `package.json` 和锁文件为准。

```
┌────────────────────────────────────────────────────────┐
│ 窗口（渲染进程）                                          │
│   基于 pi-web 的 React 界面，含本地修改                   │
│   fetch / EventSource / XMLHttpRequest / next-navigation │
│        ↓ 垫片：把 /api/… 转成 IPC                         │
│  preload（白名单桥）                                      │
└────────────────────────────────────────────────────────┘
        ↓ Electron IPC（不是 HTTP，没有端口）
┌────────────────────────────────────────────────────────┐
│ 主进程：窗口、pi-app:// 协议、看护后台、原生对话框           │
└────────────────────────────────────────────────────────┘
        ↓ 子进程通道（请求/响应 + 流式分块拉取）
┌────────────────────────────────────────────────────────┐
│ 后台进程：移植 pi-web 服务端路由                          │
│   会话 / Agent / 终端 / 文件 / Git / 模型 / 技能 / 插件      │
│        ↓ 出网请求（模型、技能和插件等）                    │
│ 外部服务                                                 │
└────────────────────────────────────────────────────────┘
```

## 托盘与退出

Windows 下点击主窗口的关闭按钮会将窗口隐藏到系统托盘，应用与当前会话仍在运行。
点击任务栏通知区域的 Pi Desktop 图标（也可能在「显示隐藏的图标」中），会弹出小窗口：
「打开主窗口」恢复界面，「完全退出」才会关闭窗口并执行后台清理。
再次启动 Pi Desktop 也会唤起已有主窗口。自动化窗口检查模式仍按原方式直接退出。
托盘入口只解决窗口隐藏和退出操作的区分；如需排查退出后的其他子进程残留，仍须单独复现并检查进程树。

## 为什么是这种结构

- **不要本地端口**。端口会带来一连串麻烦：换端口导致 `localStorage` 按来源隔离、偏好读不回来；
  防火墙和代理软件盯着监听端口；睡眠唤醒、网络抖动时本地连接反而最先出问题。
- **不重写 agent**。pi 的核心是 Node 库，任何非 Node 外壳（C#/Rust/Python）都得再带一个 Node 进程。
  所以外壳也是 TypeScript，用 Electron 自带的 Node 跑后台（`ELECTRON_RUN_AS_NODE=1`），不需要额外打包运行时。
- **以本地实现为准**。`lib/`、`components/`、`hooks/`、`app/api/` 来自上游 pi-web，但搬迁阶段的逐字节一致要求已经结束；
  本地功能需要时可直接修改，不必为上游差异暂停或反复提示。同步上游时再核对并保留本地改动（见「上游同步」）。

## 垫片做了什么

桌面传输主要由下面四类 API 垫片接管；这不意味着业务代码未修改。
构建还为 `next/image`、`next/font/google` 提供兼容别名（见 `vite.config.ts`）。

| 浏览器 API | 桌面端实现 |
|---|---|
| `fetch("/api/...")` | `renderer/shims/desktop-fetch.ts` → IPC → 后台跑原路由 |
| `EventSource(...)` | `renderer/shims/desktop-eventsource.ts` → 基于流式 fetch 的 SSE 客户端 |
| `XMLHttpRequest` | `renderer/shims/desktop-xhr.ts`（只为文件上传的进度回调） |
| `next/navigation` | `renderer/shims/next-navigation.ts`（URL 参数状态 + 订阅重渲染） |

后台把 pi-web 的 App Router 路由当成普通模块调用：`services/http-router.ts` 自己做路径匹配
（支持 `[id]`、`[...path]`），`app/api/*/route.ts` 里的 `NextResponse` 由
`desktop/shims/next-server.ts` 顶上，路由表由 `scripts/gen-routes.mjs` 扫描生成。

请求必须带一个**环回地址的来源**（`http://127.0.0.1:30141`），因为 pi-web 自带的
host/origin 校验只接受环回或显式配置的主机名。浏览器自己加的 `origin`、`sec-fetch-*`
等头部会被剥掉——它们描述的是一个这里并不存在的网络跳转。

流式响应（`text/event-stream`）采用**拉取**模式：窗口要一块，后台才读一块。
传输层每次只拉一块；上游事件生产者仍可能自行排队，不能据此保证内存始终有界。
浏览器自己发起的资源加载（图片、音视频、下载、`<img src="/api/files/...">`）
走 `pi-app://` 协议，同样回到同一个路由器。

## 内置自动模式

`builtin/automode/` 是 `@czottmann/pi-automode` 1.14.0 的本地副本，跟着应用一起编译，
新装的电脑不用再单独装这个插件。来源提交、本地改动和重新搬运的步骤都写在 `builtin/automode/VENDOR.md`。

- 入口文件名由 `extensions/auto-mode.ts` 改成 `extensions/index.ts`。这个插件会拦掉对
  “文件名里带 auto-mode”的文件的写入（它把这类文件当成自己的安全配置），
  原名会让以后改这份源码时被它自己的守卫挡住。这份副本还包含来源工作区的本地修改及 Desktop Pi 1.1 适配，不保证其余文件与上游逐字节一致。
- **只有一份生效**：磁盘上已装的那份（`~/.pi/agent/extensions/pi-automode`）从会话加载清单中排除，
  免得同时出现两个分类器和两套工具；不会删除磁盘插件，插件管理器里仍会列出它。
- 设置入口在设置对话框顶部的「自动模式」页；保存后要重新加载会话才生效。
- 页面只展示可编辑设置；适用范围使用「所有项目 / 当前项目」下拉框。
  不再铺开版本、插件路径、会话计数和生效值表。配置读取异常仍会提示。
  自动模式页铺满设置面板，左右内边距相同，滚动条位于面板右侧。
- 配置文件与命令行版共用，装没装插件都是这两个：
  - 全局：`~/.pi/agent/extensions/pi-automode/config.json`
  - 本项目：`<项目>/.pi/automode.local.json`（项目未受信任时会被忽略，设置页会标出来）
- 页面上保存时只写你动过的项，没动过的键不进文件，继续用下层的值。

## Code Mode

桌面版通过 SDK 显式加载 Pi 1.1.0 的官方 `createCodemodeExtension()`，不自行实现脚本沙箱。
入口：**设置 → 常规 → Code Mode → 启用 Code Mode**。默认关闭；切换后自动重载当前会话，
其他已打开会话需自行重载，新会话读取最新配置。纯聊天模式保持无工具；只读模式的脚本不能调用
`bash`、`edit`、`write`。顶部「工具」面板可查看已启用的 `codemode`。

- 开关只更新 `~/.pi/agent/settings.json` 的 `defaultTools`，保留其他配置、工具白名单及 `+name/-name` 语义；命令行版可共用该配置。项目 `defaultTools` 仍可覆盖全局选择。
- Desktop 固定使用官方 `on` 模式：保留原有工具声明，模型可选择直接调用或通过脚本调用，不提供 `only` 模式开关。`tool_search` 不是必需条件，本轮未接入。
- 遵守内核 `extensions: ["-builtin:codemode"]` / 禁用扩展设置。仅根会话增加内置工厂；不扩大子代理保存的工具和扩展范围。
- 外层脚本及内层工具调用仍经过原有自动模式安全检查，不增加放行规则。脚本内修改和命令执行都是真实操作，失败不自动撤销已经完成的操作。
- 可直接提问：`使用 codemode，并行读取 README.md 和 package.json，只返回 README 的一级标题及项目名称、版本，不要输出全文或修改文件。` 不需要输入 `/codemode` 或自己编写 JavaScript。

定向检查：`node --test lib/codemode-settings.test.mjs lib/codemode-sdk.test.mjs app/api/tools/codemode/route.test.mjs lib/powershell-settings.test.mjs`。
使用真实 SDK、官方 QuickJS 沙箱与本地模拟 provider，不请求真实模型，不修改用户凭据或配置；
覆盖开关往返/重载、只读/纯聊天、并行读取只返回筛选结果及嵌套调用的安全拒绝。
窗口检查另验证常规页开关通过 IPC 读到全局值，不保存用户设置。
修改源码、构建 `dist/` 不会更新已安装版，需要重新打包并安装才会出现在当前安装的应用中。

## 内置子代理

内置实现现为本地 `C:/Users/jch/.pi/agent/local/pi-subagents` 的完整 `0.19.0` 源码，
位于 `builtin/pi-subagents/`，包含原有备用模型修改。旧的 Desktop 自研运行时、队列、提示词与输入文件实现已移除。
`Agent`、`get_subagent_result`、`steer_subagent`、`SubagentWorkflow` 及调度、嵌套、记忆、worktree 等执行逻辑由这份源码提供。
旧 `input_files` 参数不再提供；需要文件上下文时在任务中给出路径，让原生代理读取。

- 每个根会话加载独立的单文件 bundle，配置与任务不会串到其他会话；子会话仍可在 Desktop 中查看、转向和停止。
- 启动前排除磁盘上重复安装的 `pi-subagents`，不修改它们或用户的全局插件设置。未受信任项目的扩展不会加载。
- 子会话通过原有 IPC 接入，扩展只绑定一次；保留 Desktop 自动模式保护、历史关系与工具范围快照。
- 配置页使用原生代理解析与默认值；新配置默认启用内置实现，已有显式关闭状态仍保留。扩展开关继续存于 `agents/settings.json`；运行设置统一读取全局 `subagents.json` 与项目 `.pi/subagents.json`，保存后重载会话应用。
- 内置预设仅五套：`plan`、`review`、`work`、`scout`、`test`，分别沿用原 `planner`、`reviewer`、`worker`、`scout`、`tester` 的完整提示词、工具、指定/备用模型、思考级别和轮次限制；不再内置 `Agent/general-purpose`、`Explore`、`Plan` 或长名称的重复预设。技能、扩展、继承上下文和后台默认均关闭。原全局 `.md` 文件保留为用户配置，不删除不改写；模型渠道和凭据不随预设复制，指定模型不可用时可在设置页更换。
- 列表内置分组置顶；同名生效优先级为 **内置 → 项目 → 工作区 → 全局**。选中内置项只编辑它自身，不自动转向同名全局/项目文件。内置编辑和新建使用同一 `/api/subagents/profiles` 接口，独立保存到 `~/.pi/agent/desktop-agents/<id>.md`，不修改程序包。新建默认选择内置，也可选择全局 `agents/<id>.md` 或项目 `.pi/agents/<id>.md`。
- 预设和新建内置 Agent 均可删除；内置删除记录保存在 `desktop-agents/.deleted/`，重启后不会恢复预设。删除内置后若存在低层同名用户配置，则该用户配置重新生效；其他范围的文件不受影响。内置/全局/项目 ID 都可编辑，保存时保留原配置和未知 frontmatter、移除旧源，并拒绝覆盖同范围已有 ID 或目标文件；预设改名不会复活旧 ID。工作区来源仍只读。
- 启用/停用也通过相同接口保存；切换只改已保存配置的启用状态，不提交未保存的 ID 等草稿。保存、切换或删除后提供会话重载提示。默认调用回退到已启用的 `work`；它已删除或停用时明确拒绝，不偷偷使用隐藏的通用预设。
- “指定模型”旁提供单个“备用模型”的下拉模型列表，复用模型搜索/收藏与渠道显示；可选择、清空并保存到对应内置、全局或项目 Agent Markdown 的 `fallback_model`，已有文件设置会回显。模型不可用时保留其值并标注；清空后保存才关闭备用模型。保持原有认证/服务错误切换规则，不增加多模型顺序重试。
- CLI 的键盘 FleetView/自动补全属于终端功能；Desktop 仍使用自己的会话界面，不伪装成 TUI。源码包含完整功能不等于已逐项实测所有模型、工作流和调度场景。
- 构建复制许可证与来源清单；`node builtin/pi-subagents/scripts/source-manifest.mjs` 检查源码文件库存及 SHA-256。

定向检查：`node --test lib/subagent-extension.test.mjs lib/rpc-manager.test.mjs lib/subagents.test.mjs lib/subagent-settings.test.mjs components/AgentsConfig.test.mjs`。

子代理顶层调用默认后台，显式前后台参数优先于代理配置；关闭自带预设不再忽略已保存的桌面代理文件。主聊天和普通会话列表默认静默，复用顶部 `Agents` 查看完整过程、状态并返回主会话。配置界面显示实际生效来源和默认模式。此功能不删除历史、不改个人配置、不阻断结果和错误回传；后台不代表应用退出后仍运行。详细规则、测试和回退范围见 [`docs/subagent-background-silence.md`](docs/subagent-background-silence.md)。
备用模型界面/保存检查：`node --test components/AgentsConfig.test.mjs lib/subagents.test.mjs app/api/subagents/profiles/route.test.mjs`（路由测试使用与 Desktop 构建相同的 `next/server` 垫片）。
其中子代理测试使用真实 SDK 会话和本地模拟 provider，不调用真实模型或修改用户会话。

### 子代理协作调度与结果协议

Desktop 普通顶层后台 Agent 现在登记任务归属，默认在下一次主模型请求前等待必需结果；明确声明 `independent_work` 才授权一批独立工作，之后重新汇合。协调结果直接进入当前请求，不无条件追加完成 follow-up；旧任务与结束后普通顾问结果保持静默。新增 `subagent_tasks` 控制等待/独立批次/明确收尾，结果默认摘要，可用 `get_subagent_result view:"evidence"` 定点核对或 `view:"full"` 获取原文。前台、嵌套、workflow 和旧宿主保持兼容路径，权限检查不变。行为、限制、取消语义及离线验收见 [子代理协作调度](docs/subagent-coordination.md)。

### 子代理运行设置与高级选项

入口：**设置 → 子代理 → 左侧「运行设置」**，可选「所有项目」或「当前项目」。
提供 18 个桌面运行字段：后台／前台并发、默认轮数、收尾宽限轮数、结果汇合模式、默认后台运行、
定时调度、模型范围限制、严格解析、自带预设、工具描述模式、保存会话、输出记录、worktree、工作流、
嵌套深度、找不到代理时的回退及用量汇总。终端专用 FleetView、widget 等选项不放进桌面界面。

- 每项显示本层设置／继承来源，当前项目覆盖全局时另行提示；布尔选项支持继承、启用、关闭。
- 保存只写修改过的键，恢复继承只删除本层键；保留未知 JSON 字段，不将默认值整份写回。
  坏 JSON／非法字段会报错，不静默覆盖。定时任务开关只开放能力，不创建任何定时任务。
- 后台并发读取优先级：**项目 native → 全局 native → 旧 `agents/settings.json` 的显式并发 → 默认 10**。
  原来桌面默认 10 覆盖原生文件 4 的问题已修正；旧文件不迁移、不重写。旧 settings API 的并发字段
  仅为兼容入口，不再用于新 UI；native 已有显式值时不会被旧值盖过。
- 保存后需新建或重载会话，不承诺运行中任务热更新。默认轮数 0 为不限；单个代理和调用参数仍可覆盖。
  工作流继承为原生自动模式；嵌套深度 0 或 1 都关闭嵌套。严格解析遵循原生现有覆盖范围，
  目前启动严格校验不覆盖 `desktop-agents` 的容错加载。
- 单个代理的「高级设置」增加系统提示词追加／替换、文件隔离、保存会话、扩展工具白名单和颜色。
  worktree 不是安全沙箱，默认不带主目录未提交修改；全局关闭 worktree 时会共享当前目录。
  显式清空扩展工具白名单可以移除已有选择器；老 API 客户端省略字段时保留原值。
- 原生其余 agent frontmatter（如记忆、嵌套类型白名单、资源白名单）仍在文件中维护；界面保存保留这些字段。

检查：`node --test components/AgentsConfig.test.mjs components/SubagentRuntimeSettings.test.mjs lib/subagent-runtime-settings.test.mjs app/api/subagents/runtime-settings/route.test.mjs lib/subagent-extension.test.mjs lib/subagents.test.mjs`。
`node tests/subagent-runtime-ipc.mjs` 验证构建后后台的真实 IPC 路由与临时文件持久化；
`node tests/subagent-settings-browser.mjs` 使用独立 Electron 窗口和内存 API，验证实际编辑、保存、继承和布局；
后者不是完整应用 IPC 或打包版验收。两者都不请求真实模型、不写用户配置。

## 模型名称与渠道

界面中的具体模型统一显示为「模型名 (渠道名)」，例如 `GPT-6.1 Sol (哈尔)`。
模型标签的渠道使用灰色小字；文字提示也带括号渠道。覆盖聊天模型按钮、普通/收藏列表、
回复标签、子代理与自动模式设置、模型管理列表、图片能力提示、MiniMax 模型用量和内置 Agent 工具说明。
旧回答使用该条消息自己的渠道，不跟随当前选择改变。长标签可悬停查看完整文字；工具说明允许换行。
无渠道的旧记录不猜渠道；默认、继承、未命名新模型不加后缀。模型 ID/名称输入框仍保留原值，
不修改配置、接口请求、注册给模型的工具描述，也不替换聊天正文或外部扩展自由文字。

定向检查：`node --experimental-strip-types --test components/ModelLabel.test.mjs tests/model-config-labels.test.mjs`
及下方的模型选择器浏览器检查。

## 自适应思考（Adaptive）

自定义模型使用 `anthropic-messages` 协议时，在「设置 → 模型 → 能力」的「推理 / 思考」旁显示「自适应思考（Adaptive）」。
开启会同时启用推理，并保存模型级 `compat.forceAdaptiveThinking: true`；实际聊天开启思考时，内核发送
`thinking.type: "adaptive"` 与 `output_config.effort`，不使用旧式 `budget_tokens`。
思考强度仍由聊天中的思考等级控制，高级设置的 `thinkingLevelMap` 可自定义对应的 effort。
关闭只将该 compat 写为显式 `false`（覆盖渠道继承值），不关闭普通推理，也不改变其他兼容项；其他协议不显示此选项。
保存后请新建或重载会话，使已有运行时重新读取模型配置。

定向检查：`node --test components/ModelsConfig.test.mjs lib/adaptive-thinking.test.mjs lib/models-config-store.test.mjs lib/thinking-level-map.test.mjs`。
请求测试使用临时配置与 mock fetch，不调用真实模型或读取用户凭据。

## 模型收藏

模型选择列表中，点模型右侧的 ☆ 收藏，点 ★ 取消；点名称才切换模型。
收藏模型集中显示在顶部「★ 收藏」，附带渠道名，原分组不重复展示；搜索同样筛选收藏区。
没有收藏时隐藏该区域。相同模型 ID 在不同渠道可分别收藏。
收藏保存在本机当前应用的浏览器数据里（`pi-model-favorites`），刷新或重启后仍可恢复，
同窗口各模型选择器共用；不修改模型配置或会话，不跨电脑同步。
暂时不在当前可选列表里的收藏不会显示，但记录保留，模型恢复可选后重新出现。
若浏览器存储不可用，当前已挂载选择器仍可收藏，但不能保证重启保留。

定向检查：`node --experimental-strip-types --test lib/model-favorites.test.mjs`（存储）和
`node tests/model-selector-favorites.mjs`（隔离 Chromium fixture 的实际点击、键盘、筛选及 reload）。

## 版本号与重新打包约定

- **源码有更新后，重新生成安装包必须使用新的版本号**，不得沿用旧版本号覆盖之前的安装包。以一次源码更新后的新安装包为单位升级，不为逐个文件修改或同一源码的失败构建重试重复升级。
- **用户已默认授权自动升级版本号，无需每次再次询问或等待授权。每次升级只递增 `0.0.1`，即补丁号（patch）加 1，主版本号（major）和次版本号（minor）保持不变。** 无论是修复、小幅调整、新功能还是不兼容变更，都遵循此规则，不得按改动性质一次性升级 `0.1.0` 或 `1.0.0`；例如 `0.2.0` → `0.2.1`，`0.2.9` → `0.2.10`。
- 打包前同步 `package.json` 与 `package-lock.json` 的项目版本，重新构建，确保应用内显示版本、安装包文件名及打包元数据一致。不自动创建 Git 提交或标签。
- 此约定授权的是常规版本号升级，不表示每次修改文件都要立即打包，也不自动授权安装、发布或推送；这些仍按具体任务范围执行。

## 最新安装包

- 版本：`0.2.6`，四个 Pi 内核包保持 `1.1.0`。包含完整加密备份重构、退出进程清理、历史会话按需激活及子 Agent 资源回收改进。
- 下载：[GitHub Release v0.2.6](https://github.com/ani13-teach/pi-web/releases/tag/v0.2.6)。本地安装包：`release/latest-0.2.6/Pi Desktop Setup 0.2.6.exe`，Windows x64，141302754 字节。
- SHA-256：`f71df1a8fae7bbaf07793da7fdbacd7f7acf964cb5ed53dd673c7d2a83497f97`。
- 发布前类型检查通过；隔离 Web 回归 1272 通过、0 失败、5 跳过（另排除 9 个文件），桌面回归 123/123、备份回归 88/88、子 Agent 工厂及 API 定向回归 27/27，均退出 0。
- 发布前使用仓库外、无真实凭据的离线配置重跑最新打包版窗口验收：27/27，退出 0；端口采样无监听，采样的 7 个进程退出后全部消失。包内版本为 `0.2.6`，192 个打包构建文件与当前 `dist/` 一致。旧窗口记录中自动模式模型选择器失败已在此次隔离配置下通过；未执行真实模型聊天或安装器安装测试，未自动安装。

## 命令

```bash
npm install --include=dev        # 这台机器上 NODE_ENV=production，必须显式带上 dev
npm run build                    # 编译主进程 / preload / 后台 + 构建界面
npm start                        # 先构建、复制随包 npm，再启动开发版；不是热更新
npm run typecheck                # 类型检查

npm test                         # 后台路由端到端（走真实 IPC）
npm run test:models-config       # 模型设置保存后同步 enabledModels（用临时 agent 目录，不碰真实配置）
npm run test:prompt              # 再加一次真实模型对话
npm run test:desktop             # 桌面桥接、取消、重连、导航和npm复制的定向回归
npm run test:gate                # 测试统计门槛的反例检查
npm run test:web                 # 选取的上游测试，不代表整个上游套件
npm run test:window              # 窗口检查 + 运行时端口采样 + 采样进程退出检查
npm run test:window:packaged     # 同一套检查，对安装包产物跑（见下）
node scripts/verify-packaged-codemode.mjs  # 包内 Code Mode 专项；仓库外隔离、本地模拟模型
npm run test:resilience          # 提交后刷新 / 后台崩溃两个场景（需要真实模型）
npm run test:chat                # 真正在输入框发送、停止、继续对话（需要真实模型）

npm run vendor:npm               # 把 npm 复制到打包位置（技能安装要用，见下）
npm run upgrade:pi               # 升级 pi 内核到最新版并重新编译
npm run package                  # 生成 Windows x64 安装包（release/）
npm run package:dir              # 只生成免安装目录（release/win-unpacked）
```

对**打包后**的产物跑同一套检查：

```bash
npm run test:window:packaged
```

它会先把产物复制到临时目录再跑，不会自动重新打包。
开发态检查前也要先 `npm run build`。应用已开着时，可以在 Bash 使用独立窗口配置：

```bash
PI_DESKTOP_SMOKE_USERDATA="$TEMP/pi-desktop-check" npm run test:window
```

这只隔离 Electron 的窗口配置，不隔离 `~/.pi/agent` 会话库。
检查仅创建和删除自己的测试会话，不应同时编辑正在使用的同一个会话。

**不要在仓库里直接测打包产物**：
后台入口被解包到 `app.asar.unpacked/`，模块查找会从那里向上走，
如果上层正好是仓库目录，就会拿仓库的 `node_modules` 把缺失的依赖补上，
测试全绿但安装包其实起不来（这个坑真踩过，见「还没做完的事」）。
`scripts/smoke-window.mjs` 现在会直接报错拦住这种跑法：

```
A packaged build must be checked outside this repository.
These directories above the binary hold node_modules: .
Re-run with --isolate to copy the build somewhere clean first.
```

技能/插件那套（不装东西，只探 npx 和搜索）：

```bash
PI_DESKTOP_SCENARIO=skills "release/win-unpacked/Pi Desktop.exe"
```

## 备份与恢复

设置中的「备份与恢复」已实现首版。导出 `.pibak` 始终要求当次密码并加密；
「不备份隐私信息」只保存三个白名单设置字段，不含聊天或模型配置。
选择备份隐私信息会包含全局模型配置和全部已保存凭据，会话、自定义资源、项目资源另选。

扫描、导出和恢复前要停止活动会话并关闭终端；操作期间后台会暂时停止并重启。
恢复不覆盖已有文件；含隐私的配置、凭据、自定义资源和项目资源先放入
`<agent目录>/backup-imports/<批次>/`，人工审阅后迁移，不会自动启用。
**目前不包含内置 Agent 的编辑/删除记录、Agent 记忆或浏览器偏好，不能当成完整整机迁移。**
使用步骤、大小限制和遗漏项见 [项目指南](docs/project-guide.md#备份与恢复的实际范围)；
已实现与待实现的详细区分见 [备份文档](docs/backup-plan.md)。

## 升级

### 升级 pi 内核

pi 内核就是普通的 npm 包，没有做任何写死：

```bash
npm run upgrade:pi     # 装最新版 pi 内核 + 重新编译
npm run package        # 要更新安装包的话再打包一次
```

三个细节值得记住：

- **为什么要写成一条命令装四个包**：后台把 pi 的包当**外部模块**在运行时加载，
  所以四个包都必须在顶层 `node_modules` 里能被找到。npm 会把传递依赖塞进
  `pi-coding-agent/node_modules/` 里，从后台代码那里解析不到，程序起不来。
  （试过只留一个包，结果就是启动即 `ERR_MODULE_NOT_FOUND`。）
- 安装目录里的内核随应用发布（实际运行文件在 `app.asar.unpacked/node_modules`），
  开发目录升级后，要重新打包、安装才能更新已安装的应用。界面版本从实际安装的包读取。
- 包版本精确固定（`--save-exact`），升级命令会更新依赖和锁文件。
  随包 npm 仍来自构建机；复制时核对全部文件内容，并输出版本和摘要。
  这能发现残缺缓存，但不等于不同构建机必然产出相同 npm。

当前 Desktop 的 Pi 1.1 适配使用 SessionManager 保存子代理克隆历史，按
`started` / `queued` / `handled` 区分提交结果；用户上下文的精确系统提示词在每次请求投影中覆盖，
保留 SDK 的消息变换与当前工具声明，不写入只读 Agent 状态。
内置自动模式经公开 `ModelRegistry.streamSimple()` 归一化上下文；权限规则与配置不变。
Pi 1.1 新增的系统提示词/工具声明消息是上下文记录，不插入聊天消息列表，也不重置流式界面；
因此不会打断本次用户消息的乐观显示与服务端确认，避免一次发送显示两个消息框。
后续相同文字的 steering/follow-up 消息仍正常显示，不按全文全局去重。

消息显示回归：`node --test hooks/useAgentSession.messages.test.mjs hooks/useAgentSession.test.mjs lib/prompt-recovery.test.mjs`。
新增测试执行实际 hook 消息事件分支，包含真实 Pi 内核的 system → user 事件，不调用模型。

升级专项回归：`node --test lib/rpc-manager*.test.mjs lib/mention-clone.test.mjs tests/automode-classifier-sdk.test.mjs`。
这些测试使用本地模拟 provider，不调用真实模型或读取用户凭据。

### 升级 pi-web 界面

按文末「上游同步」镜像指定目录，核对依赖、路由与桌面适配后重建。

### 应用自身不自动更新

自己用，不做自更新。安装数据里带了 blockmap（具备差分更新的条件），但没有接更新源。
pi-web 界面上那个「有新版本」的提示指的是 npm 上的 `@agegr/pi-web` 包，
在这里是误导信息，所以后端启动时用上游自带的开关关掉了它：

```ts
PI_WEB_SKIP_VERSION_CHECK: "1"   // desktop/main.ts，没改任何界面代码
```

实测 `GET /api/app-update` 返回 `{"updateAvailable":false}`，界面不再出现那个提示。

## 本轮修复范围

- 「模型设置」保存后同步 `enabledModels`。这个页面原来只写 `models.json`，
  而 `settings.json` 里的 `enabledModels` 一旦非空就是硬白名单（pi 的 Ctrl+P 和
  本应用的选择器都只看命中项），于是页面上新加的 provider/模型在 pi 里看不到，
  从 `models.json` 删掉的模型又在白名单里留下永远匹配不到的死条目。
  现在保存后对账，范围只限 `models.json` 里声明的 provider：补上没有被任何模式
  覆盖的模型（一律写全限定 `provider/modelId`，避免歧义条目把选择器整个搞挂），
  删掉模型已从 `models.json` 消失的模式；只是暂时不可用（缺凭据）的模型保留条目，
  裸 modelId 和含 `*`/`?` 的 glob 一律不碰（`[0.2]glm-5.3` 这类带方括号的模型名
  算字面 id，不按通配符处理），空数组仍表示不过滤。在页面上删掉或改名一个 provider
  时，运行时已经不认这个 provider，指向它的死条目会跟着清掉；内置 provider（`anthropic`
  等，运行时一直认识）的条目仍完全不动，所以手工维护的内置白名单不会被误删。
  写入复用 `SettingsManager`（单字段 + 文件锁合并，和 pi 命令行并发写不互相覆盖），
  写失败或读不动 `settings.json` 时报 `skipped` 而不是假报成功；响应里附
  `enabledModelsSync` 说明本次做了什么（含 `added`/`removed`）。`settings.json` 里设 `enabledModelsSync: "off"` 可关闭。

- 会话列表顶部「新建」左侧增加刷新按钮，点击重新加载整个界面。
- 主会话调用 Agent 子代理时，运行中的工具与过程消息也默认收进「过程详情」；可手动展开查看，结束后沿用同一折叠状态。其他没有子代理的运行中消息仍按原样展示。
- 工作区切换按钮对其他工作区的活动分开提示：有已完成但未查看的任务时显示实心蓝点；否则有运行中的任务时显示旋转的空心蓝环。两种状态同时存在时优先显示未读蓝点。

- 文件监听关闭同时触发请求中止和源流取消，读取异常也会清理登记与计时器。
- 请求在路由开始前登记，等待响应时就能取消；响应体读取也遵守取消信号。
  窗口导航或退出会清理自己拥有的流。
- EventSource 在断线、正常流结束或服务端暂时错误后重连，携带上次事件ID。
  主动关闭会取消重试；204、4xx和错误内容类型会明确终止。
  静默等待时每25秒发一次注释，避免网页登录等待触发IPC超时。
- 退出时等待现有会话的扩展收尾，并关闭终端。主进程仍保留总时限兜底。
- 「查看完整历史」在独立预览窗口显示。它无preload、无主窗口操作入口，
  使用独立存储和只读导出协议；外部链接仅允许HTTP/HTTPS。
- 上传先检查大小，再读文件。进度回调现在能收到实际正文大小，
  只显示开始和成功完成，不提供虚假的中间进度。
- npm缓存核对整棵目录内容，缺文件或同版本内容不同都会重新复制。
  版本显示来自实际包，vendor排除规则已修正。

没有在这轮扩展为完整的上传/下载分块、无系统Node电脑的安装支持，
也没有为了缩包删除其他平台二进制。这些是明确暂缓项。
自动恢复仍保留，未发送草稿的保护尚未增加。

## 桌面布局修复

Vite 以 `renderer/` 为源码根目录，默认没有收集旁边 `components/` 等目录的
Tailwind 类。生成的 CSS 缺少 `flex-col`、`min-w-0` 等布局规则，导致聊天输入框
挤到右侧、内容超出窗口，搜索按钮样式也不完整。

桌面入口现在通过 `renderer/desktop.css` 导入上游样式，并显式声明源码收集目录。
上游组件和 CSS 保持原样。默认的 Electron 英文菜单栏已移除。

本轮开发态和仓库外打包态各通过 19/19 项窗口检查，其中新增三个实际视口尺寸：
1080×600、900×560、760×500。检查会核对实际尺寸、输入框位于正文下方且没有出界、
正文可独立滚动；截图保存在 `.tmp-shot/ui-1080.png` 等文件。
旧 CSS 下三项布局检查全部失败，补齐样式后全部通过。

本轮 UI 检查使用 `PI_DESKTOP_SMOKE_DROP_TERMINAL=1`，主动关闭测试终端；
这些结果不作为“退出时会清理仍打开的终端”的新证据。

## 早期实测记录（以下不是本轮验收结果）

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 0 错误 |
| 后台路由端到端（走真实 IPC） | 23/23 |
| 加上一次真实模型对话 | 26/26 |
| 选取的上游测试 | 早期记录为920通过/931；有失败，不能视为整套通过 |
| 真实窗口（开发态，含布局检查） | 19/19 |
| 真实窗口（打包后，移出仓库跑，含布局检查） | 19/19 |
| 刷新窗口中途 | 4/4 |
| 后台进程崩溃 + 恢复 | 11/11 |
| 技能安装通道（npx 可达 + 搜索可用） | 2/2（安装本身另说，见下） |

上面「真实窗口」里会话相关的三条，现在不再假定“接口返回的第一个会话就会出现在侧栏”，
而是先看侧栏上确实列出的那一条，再去核对它背后的数据——
不然会话库一大（现在 163 个），断言就会因为“那条恰好没在可见列表里”而假失败。
早期端口和残留检查只做有限采样，且比较全机同名进程数量，不能证明全生命周期无残留。
本轮改为核对本次采样进程的 PID 和创建时间；查询出错会失败。
子进程树的遍历也只跟随创建时间不早于根的进程：Windows 保留的是创建时的父 PID，
PID 被复用后，别人的进程树会被当成我们的（用户自己那份 `next start -p 30141` 的
pi-web 服务就这样被误报成“应用在监听 30141”）。

刷新检查现在只查看助手消息及聊天正文中的助手节点，
不再用含有提示词的整页文本冒充助手回答。
它证明提交后刷新仍能读到答案，不保证刷新恰好发生在生成中途。

崩溃检查区分有效上下文、404未落盘和真正的接口错误。
“六秒内落盘消息没有变化”只是一段时间内的观察，
不能据此证明没有模型请求或工具调用被重新执行。

## 还没做完的事

- **打包后的依赖查找（已修，这个曾经把安装包彻底弄坏）**：后台入口被解包到
  `app.asar.unpacked/`，而 pi 的运行依赖原本在 `app.asar` 里，两者不在同一条查找链上，
  装到别的电脑上后台直接 `ERR_MODULE_NOT_FOUND`，界面能打开但每个面板都报错。
  之前没发现，是因为测试就在仓库目录里跑，模块查找向上撞到了仓库的 `node_modules`，
  把缺失的依赖悄悄补上了。现在 `asarUnpack` 改成 `node_modules/**/*`（整个运行期依赖都在真实目录里），
  并且打包检查必须移出仓库才允许运行。
- **文件预览（已修）**：窗口策略里 `frame-src 'none'` 把预览用的 iframe 全堵了，
  打开 PDF / 文档 / HTML 预览会是空白。改成 `frame-src 'self'`（仍是同源、调用处仍带 sandbox，
  离开本机来源的帧依然被拦）。窗口检查里加了一条真会读帧内容的用例——
  注意“iframe 触发了 load”证明不了任何事：被策略拦下的帧也会触发 load（Chromium 往里面塞错误页）。
- **干净机器上装技能/插件还不能保证**：随包带的 npm 让 `npx‑cli.js` 能跑起来（已实测），
  但 npx 随后要执行 `skills` 这个包自己的命令，生成的 `.cmd` 找不到 node 时会回落到
  PATH 里的 `node`；而插件链路走 pi 内核的 `DefaultPackageManager`，直接调 `npm`。
  所以**这台机器上（装了 Node）能用，没装 Node 的机器上会失败**。
  可行的修法：随包带 `node.cmd` / `npm.cmd` / `npx.cmd` 三个垫片，
  并把它们所在目录加到后台进程的 PATH 前面（只影响这个应用，不改系统）。
- **后台崩了（已修）**：现在窗口顶上会解释发生了什么，并给一个能用的出口。
  行为是这样的：崩溃时渲染进程先**自己悄悄重启一次**（成功就重新加载一次页面，
  因为 EventSource 和那些没返回的请求都已经死了，不重载界面会卡在一半），
  你一般什么都不会看到；5 分钟内再崩就不悄悄试了，直接在窗口顶上出那条
  「后台进程已停止」+ 停止原因，右边「重启后台」按一下就能恢复，
  旁边「复制诊断信息」把原因、应用版本和后台最后 20 行输出放进剪贴板。
  界面**不会变灰**，因为这一条已经说清楚了下边是旧数据。
  这条是桌面层加在 `<AppShell />` 上方的（`renderer/backend-recovery.tsx`），
  不动上游界面文件。外观样稿在 `mockups/backend-recovery.html`，
  真窗口截图由崩溃场景自己产出到 `.tmp-shot/backend-bar.png`。
  代价：悄悄恢复成功时会重载一次页面，正在输入框里没发出去的草稿可能丢。

剩余的已知问题（按会不会真的遇上排）：

| 问题 | 会遇上的条件 | 影响 |
|---|---|---|
| 非 SSE 响应整包转 Base64 过 IPC | 下载大文件、大体积预览 | 内存峰值，极大文件可能把后台搞挂 |
| IPC 参数没有完整运行时校验 | 主页面脚本被控制时 | 主页面仍能调用应用提供的本地能力 |

- **已验证的是随包 npx 能运行、技能搜索能返回结果**，没有跑完一次真实安装。
  原来装不了的原因找到了：安装走 `npx skills add …`，而 `lib/npx.ts` 要在
  `process.execPath` 旁边找 `node_modules/npm/bin/npx-cli.js`——打包后的
  `execPath` 是 `Pi Desktop.exe`，旁边只有 Electron 自带的 Node，没有 npm，
  于是回退去跑系统的 `npx`，在 Windows 上直接 `spawn npx ENOENT`。
  现在随包带了一份 npm（`npm run vendor:npm` 复制到打包根目录，16MB），
  程序二进制加 `ELECTRON_RUN_AS_NODE` 可以启动 npm 入口，
  但下游命令仍可能依赖系统 Node/npm，不能承诺无 Node 的电脑安装成功。
  实测结果：`npm is reachable from the app binary — npx 11.13.0`，搜索也能拿到真实结果；
  接着跑真安装时 `npx skills add github/awesome-copilot@git-commit` 确实起来了、开始 clone 仓库，
  但**被自动模式拦下了**（它会下载并执行外部仓库的代码），所以那一步没跑完。
  `PI_DESKTOP_SCENARIO=skills` 默认只检查版本和搜索。
  真安装必须额外指定 `PI_DESKTOP_SKILL` 和外部准备的 `PI_CODING_AGENT_DIR`；
  脚本不会自动创建隔离的 agent 目录。安装路由有60秒超时，大仓库可能超时。
- **没有自动更新**，这是刻意的（自己用）。安装包里已经带了 blockmap（支持差分更新），
  但没有接更新源；界面上那个误导的「有新版本」提示已经关掉（见「升级」一节）。
- **系统通知**按浏览器 Notification API 走（Electron 窗口里可用），
  但 pi-web 的后台推送（Service Worker + Web Push）在桌面端不适用，需要时改成原生通知。
- **原生目录选择器**没接到界面上：pi-web 用的是自带的网页目录浏览器（能用）；
  原生对话框已在 preload 里备好（`pickDirectory`）。`SessionSidebar.tsx` 中的
  `window.piDesktop.selectDirectory` 未接线；此项暂缓不是因为禁止修改上游来源文件。
  备份选择项目目录已使用原生对话框，不代表工作区选择器也已接通。

## 出网与代理

出网 HTTP 的默认响应头等待和响应体空闲超时均为 30 分钟（`lib/http-dispatcher.ts`）。
响应体空闲超时限制连续没有收到数据的时间，不限制整段回复的总时长；
环境变量代理、系统代理和直连沿用同一个默认值。改动需重新构建并启动新后台，
不会自动改变已运行的后台或已安装版本，也不能延长中转站自身的超时。

模型请求从后台进程发出，走哪条路按这个顺序决定（`desktop/system-proxy.ts`）：

1. **环境变量优先**：`HTTPS_PROXY` / `HTTP_PROXY`（大小写都认）只要有值，就完全按原来的方式走，
   `NO_PROXY` 也照旧由 undici 处理。网页版启动器 `pi-web.vbs` 就是靠这条路工作的，行为没变。
2. **否则跟随系统代理**：每条请求单独问一次主进程「这个网址该走哪个代理」。
   Chromium 手里才有系统设置、绕过清单和 PAC 脚本，Electron 的 `session.resolveProxy(url)` 是唯一的读法。
   所以判定**按目标地址做**：`127.*`、`*zhihu.com` 这类绕过项返回 `DIRECT`，不会为了省事复用一个答案。

读到 `DIRECT` 就直连；`PROXY` / `HTTPS` 走对应代理；**`SOCKS5` 和读不懂的写法会直接报错**，
不会绕过去直连。查不出结果（主进程不回答、超时）同样报错——这条是故意的：
把「不知道」当成「直连」正好会绕过用户刚打开的代理。

几个边界：

- 只使用代理清单里的**第一项**。第二个代理意味着把聊天请求重发到别处，比当场失败更糟。
- 代理池按地址复用（最多 4 个），地址变了后续新请求换新池，**已经在传输的回答会自然跑完**。
- 聊天用的 WebSocket 长连接也走同一套判定（握手本身就是一次请求），
  但**已经连上的那条连接**要等它自己断开才会跟随新地址。
- 代理开关的生效时机依赖 Chromium 何时把新配置传播出来，没有做强制重载，需要实测。

代理解析是在**后台进程**里替换掉进程级 fetch/WebSocket 的分发器实现的，
必须在加载路由之前完成（`desktop/backend.ts` 特意把路由改成动态加载），
否则界面看着正常、请求却悄悄直连。

## 已知限制

- **外网到模型服务的故障不会被这套结构消除**。断网、代理失效时聊天照样失败；
  能保证的是本地功能不受影响（历史、文件、Git、终端都在后台进程里，与模型调用互不牵连）。
- 后台进程被强杀时，**那一轮正在生成的内容**可能还没来得及落盘（pi 在回合结束时才落盘）。
  重启后会话仍在，但可能少一条助手消息，且不会自动重发。
- 第三方插件、OAuth 登录页、以及你自己让 agent 起的开发服务器**都可能自己开端口**。
  这与桌面内部通信无关，属于它们的正常行为。
- 上传在读取 Blob 前检查单文件25MiB和包含表单信息的总量100MiB上限。
  IPC仍一次发送整份正文，进度只报告开始和成功完成，不伪造中间百分比。
  下载与媒体Range响应仍在各自响应体读完后返回，完整分块传输暂缓。
- 桌面端和网页版共用 `~/.pi/agent`。同时写同一个会话会互相踩，别两边同时开着同一个会话。
- 「模型设置」的 `enabledModels` 同步只管全局 `settings.json`，也只认 `models.json`
  里声明的 provider：项目 `.pi/settings.json` 若覆盖了 `enabledModels`，那由项目自己负责；
  provider 还没凭据时它的模型不会被自动加进白名单（有凭据后再保存一次即可）；
  含 `*`/`?` 的 glob 和裸 id 无法归到唯一模型，永不自动删除；
  指向运行时完全不认识的 provider 的死条目会被当成删掉/改名的残留清掉，
  所以给“还没配置的 provider”预先手写的白名单条目留不住（内置 provider 的条目不受影响）。
  这份对账是为了让保存和 `models.json` 保持一致，不代替在 pi 里手动精挑白名单。

### 早期上游测试失败记录（不作为本轮通过项）

| 失败项 | 原因 |
|---|---|
| `lib/directory-browser` 的符号链接用例 | 本机没有符号链接权限（Windows 需开发者模式或管理员），`EPERM: symlink`；旧 `subagent-input` 用例已随执行引擎替换移除 |
| `lib/project-command-env` 的 PATH 用例 | 测试自己用宿主的 `path.delimiter` 却模拟 linux，只在 POSIX 主机上成立 |
| `lib/terminal-manager` 的 pid 用例 | node-pty 1.2.0-beta.15 在 Windows 上 `spawn()` 返回 `pid: 0`（ConPTY 后端如此），直接调用同样如此 |
| `lib/terminal-manager` 的租约过期用例 | 测试用 mock 定时器，但 jiti 转译后模块里拿到的是真实 `setTimeout`，mock 不生效 |
| `components/ChatInput` 的图片告警用例 | 被搬过来的源码与上游逐字节一致，且该测试不加载桌面端任何代码 |

## 上游同步

`lib/`、`components/`、`hooks/`、`app/api/`、`app/*.css`、`public/` 来源于 pi-web，
**搬迁阶段的逐字节一致要求已经结束**。普通本地修改不要求运行来源差异检查。
当前已有自动模式、备份、模型收藏/渠道/Adaptive、子代理、会话和 SDK 适配等本地改动；
不能再按早期“五个修改文件”清单覆盖，也不能认为新增文件在完整镜像时一定会保留。

同步只在专门的任务中进行：

1. 先保存当前源码和未提交改动，并记录待同步的上游版本。上游参照目录只读。
2. 对上述目录逐项生成差异清单，区分有意本地修改、本地新增文件与真正的上游删除。
   如本机配置了维护 Skill，可按需运行其 `scripts/check-upstream-parity.mjs` 辅助比较；这不是仓库自带命令。
3. 合并上游新增/修改/删除，并重新应用本地功能；不要无差别覆盖或删除本地专用实现。
   只覆盖不处理上游删除也不行：旧路由会被 `scripts/gen-routes.mjs` 继续收集。
4. 协调 `package.json` 与锁文件，检查新增 Next API 是否需要垫片；重建并跑定向回归与窗口检查。

不能保证任意上游版本直接覆盖即可使用；历史上保持一致的结论不是当前差异清单。

桌面端自己新增的东西都在这些目录里，不会被覆盖：

```
desktop/     主进程、preload、后台进程、next/server 垫片、窗口探针
renderer/    Vite 入口、四个浏览器 API 垫片、界面挂载
services/    App Router 路由表 + 路由器
scripts/     构建、打包、测试脚本
shared/      三个进程共用的类型契约
tests/       后台端到端测试
```

`node scripts/run-web-tests.mjs --list` 可列出当前实际收集的文件；本次文档核查为155个，数量会随源码改变。
它只收集 `lib/`、`components/`、`hooks/`，不收集 `app/api` 和 `tests/`。
当前排除9个完整文件，并按名称过滤5条环境相关用例，具体名单和理由在该脚本的
`SKIP` / `SKIP_TESTS` 中；即使命令成功，也不能说整个项目测试全过。
排除文件中有混合测试，包含桌面也使用的设置界面检查；不能全部称为“只测web入口”。
上文失败表是历史记录，不等于当前脚本还会运行这些用例。源码正则测试也不等于真实界面操作检查。

## 安全边界

- 窗口是标准沙箱：`contextIsolation`、`sandbox`、无 Node 集成，`preload` 只暴露白名单方法。
- 页面带 CSP 且 `connect-src 'self'`：界面本身不联外网，模型流量全部由后台进程发出。
- **没有本地HTTP监听入口**，其他程序不能通过本地端口访问这些 API。
  这不防御拥有本机文件或调试权限的程序。
- 代价是：渲染进程里若有 XSS，就能调本地 API（和网页版同源请求的处境一样）。
  缓解手段是 pi-web 自带的 markdown 清洗 + 上面那条 CSP。
