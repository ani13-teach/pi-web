# 本轮审阅修复与验收

本轮按「优先修日常会遇到的问题」执行。桌面内部仍用 Electron IPC，不加本地 HTTP 服务。
`lib/`、`components/`、`hooks/`、`app/api/`、`public/` 和两份上游 CSS 在当时保持逐字节一致
（后来的自动模式一轮改动了其中 5 个文件，见本文最后一段）。

## 0.2.1 安装包交付

- 按本次重新打包要求及每次仅 patch 加 1 的约定，将版本 `0.2.0` → `0.2.1`，同步 package.json 和锁文件两处项目版本；保留之前未提交工作、旧安装包，不创建 Git 提交或标签。
- `HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm run package` 退出 0，包含完整构建、随包 npm 校验及 Windows x64 NSIS 打包；日志 `.tmp-agents-ui-package-0.2.1.log`。
- 安装包 `release/Pi Desktop Setup 0.2.1.exe`，141488350 字节，修改时间 `2026-10-07T16:03:15.477Z`（UTC）；SHA-256 `086976ef607fcfd67802bc4a841f1d1a93c7182521ee3501587f932373fcab51`。`release/win-unpacked` 修改时间 `2026-10-07T16:02:12.368Z`。asar 元数据 `0.2.1`、渲染版本 `0.2.1-desktop`、原生 bundle 五套预设和独立内置目录、latest.yml 的版本/大小/SHA-512 均核对通过，结果 `.tmp-agents-ui-artifact-0.2.1.json`。首次只读核对脚本因 Bash 传递反斜线产生语法错误，改用不含反斜线的路径匹配后退出 0；未修改产物。
- 打包版仓库外隔离副本 `%TEMP%/pi-desktop-check-AvE9xe/app`，独立用户数据与测试 cwd，窗口 22/22、后置 3/3，退出 0。日志 `.tmp-agents-ui-pkg-window-0.2.1.log` 含 `isolated copy:`；实际点击五套预设检查 ID 草稿编辑、删除按钮及新建默认内置与三个保存范围，不保存真实 Agent 配置。采样时无监听端口，采样的 7 个进程全部退出；自身 fixture、副本和外层临时目录已清理。
- 先前源码类型检查、120/120 定向回归和开发版窗口证据沿用，不为版本号变化重跑全面验收。未运行打包版真实模型聊天/崩溃测试，未自动安装、关闭用户实例、发布或推送。

## 子代理设置：内置优先、五套预设与可编辑 ID

- 内置分组置顶，同名实际生效顺序改为内置 → 项目 → 工作区 → 全局。选中内置只编辑自身，不再自动跳到同名用户配置；原有全局/项目文件保留。
- 默认只保留 `plan`、`review`、`work`、`scout`、`test`，沿用原五套提示词及运行设置。内置编辑、新建独立保存到 `desktop-agents/*.md`；新建默认内置，可选全局/项目。预设可删除，通过 `.deleted/` 持久标记防止重启复活；删除后低层同名用户配置仍可生效。
- 内置/全局/项目 ID 可编辑，PUT 传递 `originalName`，保留未知元数据并删除旧源；拒绝覆盖同范围 ID 或占用的目标文件。创建传 `createOnly`，DELETE 传精确源路径。开关不提交草稿 ID。默认回退仅使用已启用的 `work`，不隐式恢复隐藏通用 Agent。
- 只读审查发现 Windows 仅大小写改名会把旧 ID 的 deletion marker 当作新 ID 标记删除，已改用精确 ID 的 UTF-8 hex 文件名，并加 `work → Work → WORK` 回归，确认旧预设不复活、低层配置保留。
- `npm run typecheck`、`npm run build` 退出 0；源码清单刷新并验证 63 个 Desktop 文件。定向命令 `node --test components/AgentsConfig.test.mjs lib/subagents.test.mjs app/api/subagents/profiles/route.test.mjs lib/subagent-extension.test.mjs lib/subagent-settings.test.mjs lib/rpc-manager.test.mjs`：120/120，退出 0；包含真实 SDK＋本地模拟 provider 运行五套新类型，不调用真实模型。构建前原生集成曾 7/8，因 dist 仍为旧类型；重新构建后 8/8。
- 开发版真实窗口使用独立临时 cwd/用户数据，退出 0：22/22、后置 3/3。专项实际点击五套预设，验证 ID 草稿编辑、删除按钮、新建默认内置及三范围路径，不保存真实代理配置；日志 `.tmp-agents-ui-window.log`。采样时无监听端口，采样的 7 个进程全部退出；自己的 fixture 与临时数据清理完成。
- 涉及文件差异检查与探针语法检查通过。全仓库 diff 检查仍报已有 package.json/package-lock.json 的 CRLF 差异，本轮未改它们。保留所有已有未提交工作；仅更新源码与 `dist/`，未打包、安装、提交、发布或改用户真实 Agent 配置。

## 五套用户配置加入内置预设

- 读取现有 `~/.pi/agent/agents/{planner,reviewer,scout,tester,worker}.md`，固化为 `builtin/pi-subagents/src/desktop-agent-presets.ts` 的原生配置；逐项与原生 parser 读出的配置比较通过，提示词、工具、模型/备用模型、思考级别、轮次、资源和运行选项完全保留，只将来源改成内置。未写入或删除原文件，不复制凭据。
- `DEFAULT_AGENTS`、默认类型名单和原生菜单说明同步扩充为八套；UI 列表和运行时直接使用同一注册表，不另加展示专用名单。现有同名全局/工作区/项目文件仍覆盖默认值，原生关闭默认代理的设置覆盖全部八套，用户配置不受该设置影响。
- 定向配置/UI/API 检查：59/59，退出 0；覆盖八套默认的双范围 CRUD 和启用保值、五套预设提示词 SHA-256、字段复刻、同名覆盖/禁用/删除恢复。首次同作用域冲突测试因 reviewer 新增内置源而统计 3 而非 2，补充断言内置＋两个项目源并保留原来的冲突和后文件胜出断言，复测通过。日志 `.tmp-five-presets-unit.log`。
- 类型检查退出 0（`.tmp-five-presets-typecheck.log`）；来源清单刷新后验证 62 个 Desktop 文件通过。预设来源及原文件摘要记在 `builtin/pi-subagents/DESKTOP-PATCHES.md`，README 同步。
- `npm run build`、`node --test lib/subagent-extension.test.mjs` 退出 0，原生集成 8/8；新增集成使用真实 SDK＋本地模拟 provider 实际运行全部五套内置类型，个人目录不含这五个文件，验证工具描述注册、模型/提示词和工具/资源快照；不调用真实模型。日志 `.tmp-five-presets-build.log`、`.tmp-five-presets-native.log`。
- 独立临时 cwd/用户数据的开发版窗口退出 0：22/22、后置 3/3；专项点击全部八套内置项检查可编辑字段、类型名、双保存范围和保存按钮，不写真实配置。采样时无监听端口，采样的 7 个进程均退出；自己的夹具和临时目录已清理。日志 `.tmp-five-presets-dev-window.log`。本次涉及文件差异检查、探针语法检查、62 个 Desktop 文件及原始来源清单验证均通过。
- 用户追加授权后已重新打包为 `0.2.0`；交付记录如下，不自动安装。

## 0.2.0 安装包交付

- 新增五套兼容预设功能升为 minor 版本 `0.2.0`，同步 package.json 和锁文件根版本。`HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm run package` 退出 0，日志 `.tmp-five-presets-package-0.2.0.log`；旧版安装包保留，不创建 Git 提交或标签。
- 安装包 `release/Pi Desktop Setup 0.2.0.exe`，141489147 字节，修改时间 `2026-10-07T13:57:36.926Z`（UTC）；SHA-256 `2ba1bd3fab9d01366869b0cb4172a44ee059b9ff8268188b96a2ae57efe381a1`。`release/win-unpacked` 修改时间 `2026-10-07T13:56:21.269Z`。只读核对包元数据 `0.2.0`、渲染版本 `0.2.0-desktop`、latest.yml 版本/大小/SHA-512、原生 bundle 五套预设及后台 profiles API 共用预设均通过，退出 0。
- 首次组合验收命令因显式 `rm -rf "$test_dir"` 命中 permissions.ask 被执行前拒绝，平行的产物核对也未执行；未改变安全设置或换工具执行被拒清理。用户要求继续后确认没有该轮日志/状态文件，重新运行不包含显式清理的验收与只读核对。
- 打包版仓库外隔离副本 `%TEMP%/pi-desktop-check-LPAorV/app`，独立窗口数据；验收退出 0，窗口 22/22、后置 3/3。全部八套内置项可选择、编辑并显示原类型名、双保存范围、保存按钮；未保存真实配置。日志 `.tmp-five-presets-pkg-window-0.2.0.log` 包含 `isolated copy:`。采样时无监听端口，采样的 7 个进程均退出；脚本已清理自身 fixture 和隔离副本。
- 外层测试 cwd/用户数据 `%TEMP%/pi-five-presets-pkg-window-87qu1D` 及定位文件 `.tmp-five-presets-pkg-userdata.txt` 留存，不重试被拒绝的清理动作。自动模式始终开启；未安装、关闭用户实例、调用真实模型、运行打包版聊天/崩溃验收、发布或推送。

## 0.1.1 安装包交付

- 按用户「重新打包」要求，将本轮内置代理配置可编辑的小幅调整升为补丁版本 `0.1.1`，同步 package.json 和锁文件的两处根版本；保留之前未提交源码与旧版安装包，不创建提交或标签。
- `HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm run package` 退出 0，完整构建、随包 npm 校验、Windows x64 NSIS 打包通过；日志 `.tmp-builtin-agents-package-0.1.1.log`。
- 安装包：`release/Pi Desktop Setup 0.1.1.exe`，141480874 字节，修改时间 `2026-10-07T12:57:25.626Z`（UTC）；SHA-256 `ebff2c2d99c6cb2594ef427113bd204ce82b5692d85b565e6bf328ed089d20e1`。`release/win-unpacked` 修改时间 `2026-10-07T12:56:19.107Z`。latest.yml 的版本、大小及 SHA-512 与安装包一致；按 electron-builder 的 URL 规则用连字符替换文件名空格。
- asar 包版本 `0.1.1`、渲染包显示版本 `0.1.1-desktop`、内置可编辑设置文案和解包的原生 pi-subagents bundle 均核对通过；核对结果 `.tmp-builtin-agents-artifact-0.1.1.json`。最初两次临时核对脚本分别因 Bash 传递反斜线导致正则语法错误、把 latest.yml 的 URL 当原文件名而失败；改用无反斜线匹配和实际 URL 规则后退出 0，没有修改打包产物。
- 仓库外隔离窗口检查退出 0：窗口 22/22、后置 3/3；副本 `%TEMP%/pi-desktop-check-b3cbVx/app`，日志 `.tmp-builtin-agents-pkg-window-0.1.1.log` 有 `isolated copy:`。包含实际点击全部三个内置项、可编辑字段、双保存范围及保存按钮的专项检查，不写真实代理配置；采样时无监听端口，采样的 7 个进程均退出。自己的 fixture 会话、隔离副本、临时 cwd 和用户数据目录均已清理。
- 未自动安装、关闭用户实例、运行真实模型聊天/崩溃检查或推送。此前源码测试证据沿用，不因版本号变化重新做全面验收。

## 内置代理与扩展共用配置链路

- 内置 `Agent`、`Explore`、`Plan` 不再只读。沿用原生 `/agents` 的同名导出/编辑方式，直接编辑后通过既有 `/api/subagents/profiles` 的 GET/PUT/PATCH/DELETE 和同一 writer/loader，保存到全局 `agents/<name>.md` 或项目 `.pi/agents/<name>.md`；不另建内置专用存储或接口，不生成 `-copy`，不修改内置源码默认值。
- 选中内置项时优先载入已有同名可写配置，按原生优先级和精确名称查找，保留已声明名称对应的源文件。切换保存范围只调整目标路径，不跨范围携带 `filePath`。内置启用开关仅保存现有源配置的 enabled，保留未提交草稿；保存/切换/删除都提示重载会话。
- PATCH 开关改为复用完整源配置，保留备用模型、扩展工具、提示词模式、颜色、隔离和会话持久化等设置，仍保留不归页面管理的 frontmatter。三语说明、README 和真实窗口只读点击探针同步。
- 定向检查 `node --test components/AgentsConfig.test.mjs lib/subagents.test.mjs app/api/subagents/profiles/route.test.mjs`：57/57，退出 0；涵盖全部三个内置项的双范围保存、原生加载、开关保值、删除恢复，以及已有配置选择与路径切换接线。日志 `.tmp-builtin-agents-unit.log`。
- `npm run typecheck`、`npm run build` 退出 0；日志 `.tmp-builtin-agents-typecheck.log`、`.tmp-builtin-agents-build.log`。本次涉及文件的 `git diff --check` 通过；全仓库检查另报已有 package.json/package-lock.json 的 CRLF 差异，本轮未改它们。
- 开发版窗口 `node scripts/smoke-window.mjs --project C:/Users/jch/pi-desktop` 使用独立临时 cwd 和用户数据目录，退出 0：窗口 22/22，后置 3/3。新增专项检查实际点击三个内置项，确认提示词、工具、资源及运行字段可编辑、原生类型名不变、两种保存范围和保存按钮可用；切换范围显示项目目标，未点保存或启用开关。日志 `.tmp-builtin-agents-window.log`。采样时无监听端口，采样到的 7 个进程均已退出；自己的 fixture 会话和临时数据目录已清理。
- 只更新开发源码及 `dist/`；未打包、安装、调用真实模型、修改用户真实代理配置或提交，保留原有未提交工作。

## 0.1.0 安装包交付

- 根据本轮新增原生子代理实现及备用模型 UI，将项目版本从 `0.0.6` 自动升级为 `0.1.0`，同步 `package.json`、锁文件及锁文件根包版本，没有创建 Git 提交或标签。`HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm run package` 退出 0，包含完整构建、随包 npm 校验及 NSIS Windows x64 打包。
- 安装包：`release/Pi Desktop Setup 0.1.0.exe`；141479760 字节；生成时间 `2026-10-07T11:13:51.546Z`（UTC）；SHA-256 `f19d39c207d81ff2a0fc55a0e6e0b0fbbd4c7bad1fdd55a342316744f730d8f5`。`release/latest.yml` 的版本与大小一致。
- 已检查打包后的 asar 包元数据版本 `0.1.0`、前端显示版本 `0.1.0-desktop` 和备用模型选择器，以及解包的原生 `pi-subagents.mjs` 位于 backend 旁边。首次读取 asar 前端文件因 Windows 路径分隔符写成 `/` 导致检查脚本失败，改用 `path.join` 后通过；没有更改打包产物。
- 仓库外窗口首测日志 `.tmp-acceptance/pkg-window-445a751f-3cd9-4ea1-a358-8efd394d0074.log`：退出 1、窗口 18/21、后置 2/3；三个失败均为请求窗口尺寸与实际视口不一致，实际视口始终为 1226x635，启动/IPC/终端/npx 等检查通过。按照维护文档对这一已知偶发 resize 症状重试一次，没有修改源码、断言或重新打包。
- 复查：`npm run test:window:packaged`，隔离副本 `%TEMP%/pw-recheck-d825or/pi-desktop-check-bEInh4/app`；窗口 21/21、后置 3/3，测试真实退出 0。日志 `.tmp-acceptance/pkg-window-recheck-c14db630-730a-4cea-985e-d147962b62d3.log` 包含 `isolated copy:`、有效统计及退出码。采样时无监听端口、采样的 7 个进程均退出；仅代表这一采样快照。
- 两次均使用独立窗口数据目录；自己的测试副本、数据与 fixture 会话均清理。复查包装器最初将进程查询自身误计为残留并退出 1，已排除查询 PID 后确认自己的进程残留为 0、清理完成；窗口测试命令自身退出码为 0，不能混淆二者。
- 本次未调用真实模型、运行打包版聊天/崩溃测试、安装到用户目录、关闭用户实例或推送。先前源码定向测试证据继续保留，不为仅改版本号重复全面验收。

## 重新打包时自动升级版本号的项目约定

- 按用户要求在 `README.md` 新增版本号与重新打包约定：源码更新后生成新安装包必须升级版本号，按 patch/minor/major 的改动性质自然递增；用户默认授权，无需逐次请示。
- 打包前同步项目版本与锁文件，确保显示版本、文件名和元数据一致；同一源码的失败重试不重复升号。版本授权不扩大为自动打包、安装、发布、推送或创建提交/标签。
- 本次只更新项目说明，未修改当前版本号或生成安装包；检查文档差异，不执行构建或模型测试。

## 子代理备用模型设置 UI

- `components/AgentsConfig.tsx` 在指定模型右侧新增备用模型的 `ModelSelector`，桌面双列、移动端单列；思考深度与最大轮次放到下一行。复用现有模型列表、搜索、收藏、渠道标签，沿用 readonly/加载中禁用规则，不可用的已选模型保留并标注。
- 与原生单个 `fallback_model` 完整接线：列表读取、草稿、复制及开关保存均保留设置；明确清空后保存会删除 frontmatter 键。旧 API 调用省略字段时保留文件原值；拒绝非字符串设置且不覆盖原文件。没有修改原生切换规则或新增多备用模型执行功能。三个语言标签已补齐。
- 定向检查 `node --test components/AgentsConfig.test.mjs lib/subagents.test.mjs app/api/subagents/profiles/route.test.mjs`：54/54，退出 0，覆盖双作用域与原生读取的保存/修改/清空、旧调用保值、无效值防覆盖、API 往返、编辑器序列化和 UI 接线。首次直接跑路由测试因没有 `next/server` 失败；测试现显式使用 Desktop 构建同一垫片，不安装 Next，不删除断言。
- `npm run typecheck`、`npm run build` 退出 0；`npm run test:desktop` 76/76、`npm test` IPC 33/33，均退出 0。
- 本轮新构建使用独立用户数据目录运行 `npm run test:window` 一次，退出 0：窗口 21/21，后置采样/退出检查 3/3；测试进程、数据目录和自己的 smoke 夹具已清理。窗口 smoke 证明开发版窗口/IPC 链路，不是备用模型选择、清空的专项点击测试；这些由定向配置/接口测试覆盖。下节保留上一轮窗口超时的当时记录，本轮该阻塞已解除。
- 只更新开发源码及 `dist/`；未调用真实模型、打包、安装或提交。保留上一轮未提交修改。

## 内置子代理替换为本地 pi-subagents 0.19.0

- 完整搬入 `C:/Users/jch/.pi/agent/local/pi-subagents` 的 `src/`，保留 MIT 许可、本地备用模型修改及来源说明；来源核验共 60 个原始源码/说明文件，Desktop 库存 61 个文件（含新增 host 接口），SHA-256 核验退出 0。没有修改来源目录。
- 删除旧 `subagent-runtime`、`subagent-queue`、`subagent-prompt`、`subagent-input` 执行实现及仅针对它们的测试，以原生 SDK 集成回归替代。工具、workflow、scheduler、nested agents、worktree、fallback 等源逻辑由搬入的实现提供；不再提供旧 `input_files` 参数。
- 通过单文件 ESM bundle + 每个根会话的唯一 URL 隔离原生模块状态。启动前解析扩展路径，阻止重复 pi-subagents factory 和未受信任项目的显式扩展路径。子会话由 Desktop wrapper 唯一绑定、管理 IPC、停止与转向，保留宿主自动模式保护及资源快照。
- 审查修复：创建中关闭根会话时关闭待绑定 child；提前记录停止终态；结果去重同时比较结果与错误，避免 worktree 收尾补充结果丢失；关闭后延迟 provider 结果不再调用失效的父 API；没有 worktree 的根会话不在退出时启动无关 git 进程。
- 配置页复用原生单文件解析与默认代理提示词，保留未知 frontmatter 和原有设置存储。内置默认启用，已有显式关闭状态不变。标准工具结果同时识别新原生链接与旧历史链接。构建复制来源与许可证，原生 bundle 与 backend 一起配置 asarUnpack，未打包验收。
- 定向回归：`node --test lib/subagent-extension.test.mjs lib/rpc-manager.test.mjs lib/subagents.test.mjs lib/subagent-settings.test.mjs components/AgentsConfig.test.mjs components/MessageView.test.mjs`，96/96，退出 0。原生集成用真实 SDK 和本地模拟 provider 验证双根会话隔离、运行与控制、信任过滤、待绑定 child 关闭和终态；不调用真实模型。
- UI/家族关系：`node --test components/MessageView.test.mjs components/AgentSessionPanel.test.mjs lib/native-subagent-relation.test.mjs lib/session-family.test.mjs`，27/27，退出 0。`npm run test:desktop` 76/76、`npm test` 后台 IPC 33/33，均退出 0；`npm run typecheck`、`npm run build` 退出 0。差异检查按原有 CRLF 文件行尾规则通过。
- **开发版窗口验收未完成**：`npm run test:window` 使用独立 `pi-subagents-window-WFdFOx` 数据目录，180 秒工具超时；启动日志出现 `UnknownVizError`，没有有效窗口检查统计，不能算通过，也不能得出端口/进程采样结论。已核对并终止本次隔离测试自己的进程树，删除自己的数据目录与 `--desktop-smoke-d787cc9c-13b4-4bf0-befd-b02f7af7554c--` 夹具。未重试、未修改图形/权限配置或用户已安装版本。
- 未运行真实模型子代理、完整 workflow/调度/worktree 场景；未生成新安装包、安装或提交。

## 模型名称统一展示渠道

- 新增 `components/ModelLabel.tsx`、`lib/model-label.ts`，统一展示「模型名 (渠道名)」，提供灰色渠道与完整悬停文字。普通行和收藏行均带渠道；收起按钮同样展示，保持收藏交互和 provider/modelId 身份不变。
- 覆盖回复标签、模型管理列表、子代理/自动模式模型提示、图片能力提示、MiniMax 模型用量和内置 Agent 工具说明。历史回复取消息自身的渠道；名称查不到时回退 ID，不重复拼渠道。`ChatInput` 兼容模型映射的 `provider:id` 键，不再把其他渠道误认成当前渠道。
- 未知渠道、默认/继承和未命名新模型不硬补渠道。配置输入值、模型请求、注册的 Agent 描述、聊天正文和外部扩展自由文字保持原样。模型不可用提示只格式化显示；MiniMax 旧缓存兼容仅针对模型分组，不给其他配额组加渠道。
- 代码审查发现工具说明中的长标签可能横向溢出，已改为允许换行，并增加窄容器 Chromium 检查。
- 图片能力提示回归使用组件实际共享的 draft store，避免 Node 24 的 native ESM 与 jiti require 产生两个独立存储实例；保留图片渲染及警告断言。
- 定向检查：`node --experimental-strip-types --test components/ModelLabel.test.mjs components/MessageView.test.mjs components/ChatInput.test.mjs components/ToolDefinitionsPanel.test.mjs tests/model-config-labels.test.mjs components/ModelsConfig.test.mjs components/AgentsConfig.test.mjs lib/provider-usage.test.mjs tests/automode-panel.test.mjs tests/automode-model-options.test.mjs lib/model-favorites.test.mjs`，127/127，退出 0；日志 `.tmp-model-channel-unit.log`。
- 隔离 Chromium 交互：`node tests/model-selector-favorites.mjs`，33/33，退出 0；覆盖普通行/收藏行/收起按钮的渠道、长工具标签换行及既有收藏交互，无模型请求；日志 `.tmp-model-channel-browser.log`。
- `npm run typecheck`、`npm run build` 退出 0。开发版窗口首轮 20/21：自动模式探针仍匹配旧的纯模型名；更新 `desktop/smoke-probe.js` 为同时核对完整标题及可见渠道，没有删除检查。探针定向回归 `node --test tests/smoke-model-labels.test.mjs`，4/4，退出 0；再次 `npm run build:desktop` 退出 0。
- 开发版 `dist/` 的 `scripts/smoke-window.mjs --project C:/Users/jch/pi-desktop`（等同 `npm run test:window` 的检查入口）使用临时独立用户数据目录和工作目录，最终 21/21，后置 3/3，退出 0；日志 `.tmp-model-channel-window.log`。夹具与临时目录已清理。未做真实模型聊天测试；源码修改阶段未打包、安装、提交，也未修改已安装版本。

### 模型渠道展示安装包

- 用户随后授权打包。`npm run package` 退出 0；日志 `.tmp-package-model-channels.log`。安装包 `release/Pi Desktop Setup 0.0.6.exe`，140876853 字节，修改时间 `2026-10-01T06:37:23.561Z`；SHA-256 `1768e65cd5fd597d721211ae3d029e83b5bdbd0bf6f56990a8cae82d53482ad7`。包含当前源码中的模型渠道展示与收藏功能。
- `release/win-unpacked` 修改时间 `2026-10-01T06:36:22.763Z`；`resources/app.asar` 修改时间 `2026-10-01T06:36:21.865Z`，8017151 字节。
- 打包版窗口检查：`scripts/smoke-window.mjs --binary <release/win-unpacked/Pi Desktop.exe> --isolate --project C:/Users/jch/pi-desktop`（`test:window:packaged` 的相同入口），仓库外隔离副本 21/21、后置 3/3，退出 0；日志 `.tmp-window-model-channels-packaged.log` 包含 `isolated copy:`。检查使用独立临时用户数据与工作目录，夹具和临时目录已清理。
- 未做打包版真实模型聊天测试，未安装或提交，不修改用户当前已安装版本。

## 模型收藏置顶

- `components/ModelSelector.tsx` 每个模型增加独立星标按钮，收藏后只在顶部「★ 收藏」展示一次，附渠道名；取消回原分组。搜索先筛选再分组，无收藏或无匹配收藏时隐藏收藏区。
- `lib/model-favorites.ts` 用 provider/modelId 二元身份区分模型，安全读取、去重与写入本机 `pi-model-favorites`；坏数据或存储不可用不阻断选模型，暂不可选的收藏保留记录。
- `hooks/useModelFavorites.ts` 同步当前窗口各选择器及其他同源窗口的存储变化，不修改模型配置或会话。中英、简繁文案均已补充。
- 星标与模型名称是两个相邻按钮，点星标不触发模型选择，也不关闭列表。跨分组移动后恢复到同一模型星标的焦点，键盘 Enter/Space 和 Escape 可连续使用。
- 存储及共享选择器兼容回归：`node --experimental-strip-types --test lib/model-favorites.test.mjs components/AgentsConfig.test.mjs`，29/29，退出 0（存储 11 项、AgentsConfig 18 项）。
- 实际浏览器交互：`node tests/model-selector-favorites.mjs`，29/29，退出 0；使用实际 React 组件、临时模型与独立 Electron 数据目录，覆盖收藏/取消、去重、渠道独立、同窗口同步、搜索、全收藏、名字选择、默认值、禁用、reload 持久化、键盘焦点及 Escape，无模型请求或监听端口。
- `components/ChatInput.test.mjs` 中选择器显示、切换中锁定、筛选和禁用 field 的 4 项定向回归通过，退出 0。
- `npm run typecheck`、`npm run build`：退出 0。开发版 `dist/` 的 `npm run test:window`（临时独立用户数据目录）：21/21，后置 3/3，退出 0；测试夹具与临时目录已清理。
- 按用户要求生成安装包，不代为安装：`npm run package` 退出 0，日志 `.tmp-package-model-favorites.log`。产物 `release/Pi Desktop Setup 0.0.6.exe`，140876389 字节，修改时间 `2026-10-01T04:59:24.980Z`；SHA-256 `0f4d71a53304be64ec102b0a8040c2d86b80ebfde968531463c2d970bce6ad14`。`release/win-unpacked/resources/app.asar` 修改时间 `2026-10-01T04:58:31.540Z`。
- `npm run test:window:packaged` 对仓库外隔离副本检查：21/21，后置 3/3，退出 0；日志 `.tmp-window-model-favorites-packaged.log` 含 `isolated copy:`，测试夹具与临时数据目录已清理。本轮未进行打包版真实模型聊天检查，未安装或修改已安装版本。

## 会话列表刷新按钮

- 在「新建」左侧增加刷新图标按钮，点击调用 `window.location.reload()`。
- 沿用已有翻译和工具栏样式，提供悬停提示与无障碍名称。
- `SessionSidebar.tsx` 是新增的有意本地差异。没有新增状态、辅助函数或配置。
- 开发版检查：`npm run typecheck`、`npm run build`、`npm run test:window` 均退出 0；窗口 20/20，附加检查 3/3。没有单独实测点击刷新，也未更新已安装版本。

## 已修

| 问题 | 改动 | 证据 |
|---|---|---|
| 关闭文件预览没释放监听 | 同时中止请求、取消源 reader；读失败和页面销毁也清理 | 用上游真实 watch 分支贯穿 renderer/router/backend，创建1个 watcher、关闭1个 |
| 取消请求必须等响应 | 请求开始前登记；前端等待和响应体都支持取消 | pending headers、pending read、headers后取消三类检查 |
| 事件流断线不重连 | EOF/传输失败/5xx重连，保留事件ID与服务端retry；close停止 | EventSource 9项回归 |
| 网页授权静默等待会超时 | 空闲pull每25秒返回SSE注释，不伪造业务事件 | 假时钟覆盖150秒等待，随后事件仍到达；取消后计时器清空 |
| 退出没等待扩展收尾 | 等待已有会话shutdown，关闭终端，总时限兜底 | 延迟扩展清理未完成时shutdown不返回；重复shutdown只执行一次 |
| 关闭主窗口但历史窗还在 | 主窗口关闭触发应用退出；退出前销毁窗口停止轮询 | 源码复核；窗口退出及进程快照检查 |
| 完整历史打不开 | 独立协议、存储分区和预览窗口，无preload或应用bridge | 实窗看到正式会话助手答案；Node和bridge均不存在 |
| 外部协议任意交系统 | 仅HTTP/HTTPS外链；导出路径及GET参数白名单 | 导航10项回归 |
| 上传进度属性回调无效 | 属性和事件监听都收到开始/成功完成，使用请求正文字节数 | 属性与事件监听结果一致，不再拿响应大小当上传大小 |
| 超限上传先占满内存 | 读Blob前检查单文件25MiB、含表单信息总量100MiB | 虚拟超大File被413拒绝，arrayBuffer和IPC调用均为0 |
| npm残缺缓存被跳过 | 比较整个目录内容摘要，暂存复制后验证再替换 | 同版本缺文件、内容改变、缓存命中、复制失败等5项检查 |
| 版本号写死、vendor忽略失效 | 版本从实际包读取；ignore注释独立成行 | 类型检查、构建及文件复核 |

## 验收口径已纠正

- 窗口检查必须非零且全数通过，失败退出码会保留。
- 聊天检查通过真实输入框发送、在运行中点击停止、继续发送并读取助手正文。
- 首次发送可能更换会话ID，测试跟随实际选中的会话，不盯着先前的空会话。
- 窗口基础检查使用自己创建的固定会话，不再依赖用户历史中是否有助手文本。
- 终端命令的输出标记不出现在输入中，防止仅靠命令回显通过。
- 窗口退出前保留测试终端，退出后核对采样进程PID和创建时间。
- 端口结论只针对采样时刻，进程退出结论只覆盖采样到的进程；查询失败不能算零。
- 崩溃场景使用真正的子进程exit通知。接口404、错误响应与有效上下文分开处理。
- 六秒内上下文不变，不再称为“证明模型和工具没有重跑”。

## 本轮源码验收

| 命令/检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test:desktop` | 36/36 |
| `npm test` | 23/23 |
| `npm run test:smoke` | 6/6 |
| `npm run test:gate` | 4个输入的判断均符合预期 |
| `npm run test:chat` | 10/10，包含完整历史正文与隔离检查 |
| `npm run test:window` | 19/19，含3种视口布局；后置检查3/3 |

## 追加一轮（做维护 Skill 时发现的，都是开发脚本层）

接手维护时用新建的验收脚本跑了一遍，撞出三个真问题。产品界面行为没变，但都会让“测试说谎”或让测试跑不起来：

| 问题 | 现象 | 改动 |
|---|---|---|
| 检查脚本继承了 `ELECTRON_RUN_AS_NODE=1` | Pi Desktop 会给子进程设这个变量，在它的会话里跑检查时 Electron 退化成普通 Node，启动即崩在 `registerSchemesAsPrivileged`，还被误报成“单实例锁” | `scripts/smoke-window.mjs`、`scripts/smoke-resilience.mjs` 和 skill 的 `acceptance.mjs` 启动界面前都会删掉它；锁的提示现在只在“静默且退出码 0”时给出 |
| 打包版从没被真实场景覆盖 | `test:chat` / `test:resilience` 写死跑仓库里的开发版（`dist/`），所以“打包版聊天没问题”这类结论当时只验证了开发版 | 新增 `--binary` / `--isolate` 与 `test:chat:packaged`、`test:resilience:packaged`；暂存逻辑提到 `scripts/stage-app.mjs`，两个脚本共用同一道“不能在仓库内测包”的守卫 |
| 布局检查偶发误报 | 三个视口偶尔全挂：`requested 1080x600, actual viewport 1226x635`（窗口刚显示时一次 `setContentSize` 被窗口管理器丢掉） | `desktop/main.ts` 新增 `resizeContent()`：重试并等渲染进程确认，真放不下才判失败 |

追加验收（都在上述环境里、且用户实例保持运行）：

| 命令/检查 | 结果 |
|---|---|
| `acceptance.mjs --fast`（含自带隔离目录） | 7/7 步，退出码 0 |
| `npm run test:window` | 19/19 + 后置检查通过 |
| `npm run test:chat:packaged` | 10/10，输出含 `isolated copy:` |
| `npm run test:resilience:packaged` | 4/4 reload + 11/11 crash，输出含 `isolated copy:` |
| `npm run test:window:packaged` | 19/19 + 后置检查通过 |
| 仓库内直接测包 | 按预期被拒（提示加 `--isolate`） |

安装包已在修复后重建：`release/Pi Desktop Setup 0.0.1.exe`，140,693,367 字节，
SHA-256 `cad36d4d895ca7377ad7f5ad8e09a6a1b7cf1a1ffcfa34b01035fe213f54e66f`（07:36 生成，晚于 `desktop/main.ts` 的最后修改 07:33）。
之后只改了开发脚本与 `package.json` 里的测试命令，产品代码未再变动。

| `npm run test:resilience` | 刷新4/4，崩溃11/11 |
| 上游目录内容核对 | 指定目录及CSS均一致 |

日志在项目根目录 `.tmp-chat-final.log`、`.tmp-window-final.log`、`.tmp-resilience-review.log`。
它们记录不同阶段的验收；最终交付包以仓库外检查记录为准。

## 明确暂缓

- 完整的大文件上传/下载分块；当前下载和Range响应仍整包缓冲，上传只先加限制。
- 没有系统Node/npm的电脑上完整的技能/插件安装链路。
- 删除非Windows二进制以缩包、尾斜杠路由规范化、完整IPC参数校验。
- 恢复重载时的未发送草稿保护；现有自动恢复继续保留。
- 全部上游测试适配。本轮重跑当前149文件集合：920通过、6失败、5跳过，总计931，退出码1。
  两个符号链接权限用例、PATH平台用例、PTY PID和定时器用例、图片告警源码断言仍失败。
  没有把这些算成通过，也没有改上游文件来迎合测试。
  此命令还排除9个含web入口的文件（部分混有桌面检查），未收集app/api的12个文件。
  试收集这些API测试时，7个因直接依赖缺失的Next运行环境而失败，因此没有伪称全套覆盖。

## 最终交付包（已被下文替代）

> 这里的 140,693,367 字节、`cad36d4d…` 是上一轮那个包。最新包见文末「追加一轮：内置自动模式与设置页」里的交付包一节。
- 安装包：`release/Pi Desktop Setup 0.0.1.exe`
- 大小：140693367 bytes
- SHA-256：`cad36d4d895ca7377ad7f5ad8e09a6a1b7cf1a1ffcfa34b01035fe213f54e66f`
- 完整打包真实退出码0；日志 `.tmp-package-final.log`（旧包）；修复后重建那次见「追加一轮」。
- 将包复制到TEMP，核对祖先目录没有node_modules，再运行以下检查。

| 仓库外打包版检查 | 结果 | 日志 |
|---|---|---|
| 窗口、三种视口布局 | 19/19，退出码0 | `.tmp-packaged-final.log` |
| 真实发送、停止、继续及完整历史 | 10/10，退出码0 | `.tmp-packaged-chat.log` |
| 崩溃自动恢复、提示条与手动恢复 | 11/11，退出码0 | `.tmp-packaged-crash.log` |
| 端口与进程快照 | 采样无监听，采样的7个进程退出后均消失 | `.tmp-packaged-final.log` |

上面三个场景日志里都记有 `exe=…\Temp\pi-desktop-scenarios-…\app\Pi Desktop.exe`，也就是当时确实跑的是仓库外的打包副本。
不过当时靠手工复制，脚本自己不支持那个用法（`test:chat` / `test:resilience` 默认只能跑开发版）——现已补上 `:packaged` 那组命令，见「追加一轮」。

主代理已核对日志中的runner退出码、最终安装包哈希和上游目录一致性。
本轮未运行安装程序，仓库外打包版的结果不冒充“新版本安装后实测”。
当前运行的已安装应用没有被强关或覆盖。关闭旧实例后可运行上面的新安装包。

## 追加一轮：内置自动模式与设置页

自动模式（`@czottmann/pi-automode`）原先只以全局插件的形式装着，新电脑上要自己装一遍。
这一轮把它搬进仓库随应用编译，并加了一个设置页。产品行为：新装的电脑开箱就有自动模式，
要改参数不必去改 JSON。

| 改动 | 内容 |
|---|---|
| 内置插件源码 | `builtin/automode/`，来自本机那份插件的工作区（基线提交 `011bd1f`，本地未提交改动也一并搬入），入口由 `extensions/auto-mode.ts` 改名 `extensions/index.ts`；来源与重搬步骤写在 `builtin/automode/VENDOR.md` |
| 只留一份生效 | `lib/automode-builtin.ts`：会话装配时丢弃路径里带 `pi-automode` 段的那份扩展，避免两个判定模型、两套工具和两条 `/automode` 命令。普通会话、子代理会话（`loadExtensions` 为真时；用户的代理预设都是关扩展开的）都注入内置那份 |
| 新增依赖 | `unbash@4.0.10`（插件唯一的运行时依赖，随 esbuild 打进去）；`tsconfig.json` 加 `allowImportingTsExtensions`，因为搬来的源码用 `./x.ts` 显式后缀导入 |
| 设置接口 | `app/api/automode/route.ts`（GET 返回两个文件的原始内容、生效值、每个值来自哪一层、诊断、内置版本；PUT 只接受白名单字段，写入前先过插件自己的校验，坏 JSON 拒绝覆盖，项目未受信任时拒绝写项目文件）、`app/api/automode/test/route.ts`（拿选中的模型试一次判定） |
| 设置页 | `components/AutomodeConfig.tsx` + `components/automode-draft.ts`（纯逻辑：只改动的字段才写、留空=删键、数字校验、读会话状态行），设置对话框顶栏新增「自动模式」页 |
| 标签 | `lib/settings-navigation.ts` 与 `components/SettingsPanel.tsx` 加入 `automode`；三种语言各加约 80 条 |

### 追加验收

| 命令/检查 | 结果 |
|---|---|
| `acceptance.mjs --fast`（含自带隔离目录） | 7/7 步，退出码 0 |
| `npm run test:desktop` | 62/62（新增内置插件去重 5 项、草稿规则 16 项、设置页接线与三语文案 5 项） |
| `npm test` | 33/33（新增：写入落在项目文件、只写改动的字段、不碰文件里其他内容、存完读回来自本项目层、清空后回落到下一层、拒绝未知字段与未知键） |
| `npm run test:window` | 20/20 + 后置检查通过（新增一项真实窗口检查：打开设置对话框 → 点「自动模式」页 → 页面显示接口报出的超时值与内置版本，随后关掉对话框以免影响后面的布局检查） |
| `npm run test:web` | 931 项中 920 通过、6 失败（与本轮无关的已知环境失败）、退出码 1 |
| `npm run test:prompt` | 35/36：唯一失败的一项是本机 Codex 线路当前连不上（`provider_transport_failure`→`fetch failed`）。同一条提示词用 `pi` CLI 在仓库外单独跑也失败，换 `DeepSeek/deepseek-flash` 就正常，因此与本轮改动无关 |
| `npm run package` | 退出码 0（日志 `.tmp-package-automode.log`） |
| `npm run test:window:packaged`（仓外副本） | 20/20 + 后置检查通过，退出码 0，日志有 `isolated copy:`（`.tmp-packaged-automode.log`） |
| `node <skill>/scripts/check-upstream-parity.mjs` | 3 个镜像目录有差异，差异清单都在本轮（见 README「上游同步」），其余目录及两份 CSS 仍一致 |

### 交付包

`release/Pi Desktop Setup 0.0.1.exe`，140,827,384 字节，SHA-256
`626fef70606fc5b87032979bbc4eb10cd9bef7af34d746509f80210ba9ba41a7`（12:38 生成，晚于最后一批源码改动）。
它替换了上文「最终交付包」那一节里的旧包（140,693,367 字节）。
安装前要先关掉正在跑的窗口，否则单实例锁会让新装的版本起不来。

打包时踩到一个坑：直接用默认的网络去下 electron 和 winCodeSign 会卡到 600 秒超时然后失败，
得把代理环境变量带上（`HTTP_PROXY`/`HTTPS_PROXY=http://127.0.0.1:7890`）才下得动。

### 没覆盖到的

- 保存往返的实测是在临时项目目录里做的，**没有写过真实的全局配置文件**（两个文件走的是同一段写入代码，但只有项目文件被实测过）。
- 真实模型那一档没跑完：`test:prompt` 跑了 36 项里的 35 项，默认模型（Codex）当前在本机连不上，
  只验到“提示词能被接受且事件流能跑完”；`test:chat` / `test:resilience`（含打包版那两个）没跑，原因相同。
- 页面上「本会话」那行依赖插件输出的状态行格式（`AM● a:3 d:0`）；格式变了会显示“还没读到”，不会显示错的值。
- 没有在新电脑上装过这个包：打包版的检查是对着仓库外的副本跑的，没有真正执行安装程序。

---

## 追加一轮：跟随系统代理（GPT 连不上）

**问题**：桌面版连不上 GPT，直连 `api.openai.com` 十秒超时。默认模型是 DeepSeek，
直连本来就能通，所以这个毛病一直被盖着。

**根因**：后台的出网分发器用的是 undici 的 `EnvHttpProxyAgent`，它**只读环境变量**，
不读 Windows 的系统代理设置。网页版没事，是因为它的启动器 `pi-web.vbs` 会去读注册表、
把代理写进环境变量再启动；桌面版的快捷方式是直接拉起 exe，没有这一层。

实测：系统代理开着（FlClash，`127.0.0.1:7890`）。无代理时 `api.openai.com` 报
`UND_ERR_CONNECT_TIMEOUT`（约 10.6 秒），加上代理同样的请求 0.63 秒拿到 401。

### 改了什么

| 问题 | 改动 | 证据 |
|---|---|---|
| 后台不认系统代理 | 新增 `desktop/system-proxy.ts`：环境变量优先，否则按目标地址查系统代理 | 真实 App 跑聊天时抓到 `dispatch api.deepseek.com` → `main ask => PROXY 127.0.0.1:7890` → `decision => PROXY 127.0.0.1:7890` |
| 后台拿不到 Chromium 的代理判定 | 新增后台→主进程的反向 IPC（`proxy.query` / `proxy.result`），主进程用 `session.resolveProxy(url)` | 同上；另用 Electron 44 实测返回值：`DIRECT` / `PROXY host:port` / `SOCKS5 host:port` |
| 万一绕过去直连 | `DIRECT` 直连；`PROXY`/`HTTPS` 走代理；`SOCKS5`、读不懂的写法、查询超时/失败都**明确报错** | 定向测试：不支持的代理类型与失败的查询都不会碰到代理，也不会退回直连 |
| 一条答案套所有网址 | 每条请求单独查，绕过规则按目标生效 | `127.0.0.1:30141` 与 `*zhihu.com` 实测返回 `DIRECT`，OpenAI/ChatGPT 返回 `PROXY` |
| 长连接漏掉 | 握手也是走同一条 dispatch，全局 fetch 与 WebSocket 一起被替换 | 定向测试里真实 WebSocket 握手打到代理（记录到 `codex.invalid:443` 隧道） |
| 加载顺序把改动架空 | `desktop/backend.ts` 先配网络、路由改成动态加载 | 构建产物里确认 `configureOutboundNetworking()` 在 `init_http_router()` 之前 |
| 畸形的代理地址会让请求永久挂着 | 复核时发现：连接对象构造是同步抛错的，旧写法把错误吞了、`dispatch` 却已经返回 true，于是既不报错也不返回。改成只在一处上报 | 查表返回 `PROXY 127.0.0.1:not-a-port` 时，实测拿到 `TypeError: Invalid URL` 而不是超时 |

### 本轮验收

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run build` | 通过；产物内确认加载顺序 |
| `npm run test:desktop` | 66/66（原 62，加上 system-proxy 的 4 项） |
| `npm test` | 33/33 |
| `npm run test:window`（独立用户数据目录） | 20/20，后置 3 项通过，**没有任何监听端口** |
| `npm run test:chat`（隔离） | 10/10，真实模型回答经代理完成（含流式） |

### 没覆盖到的

- **真实 GPT 账号没验**。验到的是：链路打通、系统代理判定正确、OpenAI/ChatGPT 域名会拿到 `PROXY`，
  以及真实模型对话能经代理跑完。用 Codex/ChatGPT 账号实际提问、OAuth 刷新没跑过——
  换模型要动 `~/.pi/agent`，那不在本轮授权范围内。
- **代理开关/换地址的动态跟随没做实测**（需要改系统代理设置或重启 FlClash）。
  当前行为是：每条新请求重新查；已有池按地址复用；在途回答跑完；已连上的 WebSocket 等它自然断开。
  Chromium 何时把新配置传播出来也没测。
- **SOCKS5 是明确报错，不是支持**。undici 的 `ProxyAgent` 本身认 `socks5:`，真要支持只需改一行，
  但没有 SOCKS 服务器可以实测，所以先不接。
- 企业代理需要认证的情况没考虑：Electron 的登录态不会自动传给后台的代理连接。
- 打包版（`:packaged`）没重打，本轮结论只覆盖 `dist/` 开发版。

### 过程记录

中途为了看清握手，往**构建产物**（`dist/main/*`，已被 gitignore）里插过调试语句，
有一次手写转义写坏，导致测试实例启动即崩（不影响源码，重建即恢复）。
后来改成用脚本插桩 + 先 `node --check` 再跑，拿到证据后已重建还原，
产物内已确认无残留。

### 交付包（本轮）

`release/Pi Desktop Setup 0.0.1.exe`，140,843,463 字节，SHA-256
`e12d1e79fb26052096db1509b8c8aaf0c2c813d8cdd9ed1f3fa27304eadd6206`（17:56 生成，
晚于最后一批源码改动；上一版是 140,827,384 字节）。

打包同样必须带上代理环境变量（`HTTP_PROXY`/`HTTPS_PROXY=http://127.0.0.1:7890`），
否则下载 electron / winCodeSign 会卡到超时。

打包版验收（都在仓库外跑的副本上，输出里有 `isolated copy:` 那一行）：

| 命令 | 结果 |
|---|---|
| `test:window:packaged` | 20/20 + 后置 3 项通过，无监听端口 |
| `test:chat:packaged` | 10/10，真实模型回答在打包版里完成 |

**没有安装到 `%LOCALAPPDATA%`**：用户没要求，而且他正开着旧版窗口。

---

## 追加一轮：自动模式设置页精简

用户反馈：左右留白失衡，运行信息、保存位置和生效值表占据了大量空间。

- `components/AutomodeConfig.tsx` 删除版本、插件路径、会话计数和生效值表；适用范围缩成一行下拉框。
- `renderer/desktop.css` 让自动模式页占满面板、左右内边距相等，滚动条贴到面板右侧；开关与表单右侧对齐。
- 三种语言同步精简说明，保存反馈不再显示文件路径。配置读取异常和未信任项目提示保留。
- 删掉不再需要的会话状态请求、刷新计数和 `applyState` 转发函数；保存成功只记录布尔值。
- 配置文件、判定规则及保存字段逻辑未改。测试只读取现有配置，没有通过设置页保存真实配置。

检查对象为 `dist/` 开发版：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 退出码 0 |
| `npm run build` | 退出码 0，日志 `.tmp-automode-ui-build.log` |
| `node --experimental-strip-types --test tests/automode-draft.test.mjs tests/automode-panel.test.mjs` | 21/21，退出码 0 |
| `npm run test:desktop` | 66/66，退出码 0 |
| `npm run test:window`（独立用户数据目录，跑 5 次） | 4 次 20/20 + 后置 3 项全过、退出码 0；1 次 17/20（见下）；日志 `.tmp-automode-ui-window*.log` |

真实窗口里量的东西：设置面板 1079 像素宽时表单填满滚动区、左右内边距相等、
开关行尾到内容区右边（不再停在 420 像素），把面板压到 480 像素后重测同样成立。

### 这条检查本身做了反向验证

把旧的 `max-width: 680px` 加回去重建，这条检查确实失败：
`the scroll area does not fill the pane: 680/1079 px`，退出码 1（日志 `.tmp-falsify-window.log`），
改回来才恢复。不是一条永远绿的断言。

审查时发现我第一版断言有两个真毛病，已改：

1. 配置里没写 `classifierTimeoutMs` 时，输入框会填生效值而不是空，原断言会误判失败；
   另外取配置没带项目路径。现在改成：四个数字字段必须都是正整数，
   并且全局文件确实写了这一项时，输入框必须等于它。
2. 布局检查只缩小了容器、没验证缩小真的生效，也测不出“开关行右侧又空一片”。
   现在会断言两次量出的宽度确实不同，并逐个要求开关行宽度等于内容区宽度。

### 顺手修了一个会让端口结论假失败的缺陷

跑检查时出现一次 `FAIL  nothing was listening — listening: 127.0.0.1:30141`。
查下去发现那不是应用起的进程：是用户自己那份 pi-web 服务
（`next start -p 30141`，启动于 18:10:42，早于那次检查 35 分钟），
它的父 PID 已经不在了，而那个 PID 被本次启动的进程复用，
于是 Windows 保留的旧父子关系让整棵外来进程树被算成了应用的子进程。

`scripts/smoke-window.mjs` 的进程树遍历现在只跟随**创建时间不早于根**的子进程：
进程不可能由比自己晚启动的东西创建。用一对真实存在的“父比子晚启动”的进程验证过：
旧走法拿到 5 个（含 4 个外来的），新走法只剩根本身。
真泄漏仍然看得见（子进程都是应用启动之后才创建的）。

### 一次偶发失败（与本次改动无关）

5 次里有一次掉在侧栏会话列表上：
`the sidebar lists sessions that exist on disk — none of the 194 sessions on disk is listed`，
连带“点开会话”和“正文渲染”各失败一条。这三条按顺序在本轮改动的那条**之前**跑，
我的改动碰不到它们；本机会话库有 194 个，探针自己的夹具会话等不到出现在侧栏就会这样。
另有 4 次全过，故按偶发处理，没改。（改的是测试等多久，属于另一个题目。）

本轮没有重新打包，也没有替换用户已安装的那份。

## 运行中的子代理过程默认折叠

主会话此前跳过运行中轮次的「过程详情」分组，因此 Agent 工具调用虽自身折叠，整个过程仍逐条展开；只有父代理完成后才收起。现在含 Agent 调用的运行中轮次也使用同一个过程分组，默认折叠，允许手动展开；流式生成的新工具调用也放进组内。未使用子代理的运行中轮次保持原来的展示方式。

## HTTP 空闲超时调整为 30 分钟

- 默认响应头等待及响应体空闲超时由 `600_000` 改为 `1_800_000` 毫秒；环境变量代理、系统代理和直连沿用同一默认值。响应体仍按连续无数据时间计时，不限制回复总时长。
- 同步默认值回归断言与 README。历史 10 分钟调整记录保留如下；本轮不修改 IPC 租约、中转站配置或已安装版本。
- `node --experimental-strip-types --test lib/http-dispatcher.test.mjs tests/system-proxy.test.mjs`：6/6，退出码 0；`npm run typecheck`、`npm run build`：退出码 0。开发版后台产物确认默认值为 `18e5`。
- 开发版窗口检查首轮使用空的临时 agent 配置，因无模型选择器为 20/21，退出码 1；改为仅隔离 Electron 用户数据目录后重跑 `node scripts/smoke-window.mjs --project C:/Users/jch/pi-desktop`：21/21，后置 3/3，退出码 0。夹具会话与本轮临时目录已清理；未运行真实模型长回复测试，未打包、安装、提交或推送。

### 30 分钟超时安装包

- 用户授权更新安装包。`npm run package` 退出码 0，日志 `.tmp-package-http-30m.log`。产物 `release/Pi Desktop Setup 0.0.6.exe`，140877057 字节，修改时间 `2026-10-03T10:24:20.684Z`；SHA-256 `f2873e7cad8c324c2c936cbbf81eba68f925e9999003df37134124274e32889f`。
- `release/win-unpacked` 修改时间 `2026-10-03T10:23:07.765Z`；包内 `resources/app.asar` 修改时间 `2026-10-03T10:23:06.816Z`。包内后台确认默认超时为 `18e5`（1800000 毫秒），后台 SHA-256 `352c935315ea9cba421061e475a3fe1f086247ebb691facf00bad0feaaba14f5`。
- `npm run test:window:packaged` 使用独立临时用户数据目录、仓库外隔离副本：窗口 21/21、后置 3/3，真实退出码 0；日志 `.tmp-window-http-30m-packaged.log` 包含 `isolated copy:`。退出阶段出现一条 `Only the main app window can use the backend bridge` 日志，验收未失败；本轮不扩展排查。测试夹具、隔离副本和临时用户数据已清理。
- 未做打包版真实模型长回复测试，未自动安装或关闭当前应用，未提交或推送源码。

## HTTP 空闲超时调整为 10 分钟

- `lib/http-dispatcher.ts` 的默认值由 `300_000` 改为 `600_000`；环境变量代理、系统代理和直连的响应头等待及响应体空闲超时均沿用此值。未改 IPC 租约或中转站配置。
- `lib/http-dispatcher.test.mjs` 增加默认值回归断言，README 同步说明。构建产物 `dist/main/backend.mjs` 已核对为 `6e5`。
- `node --experimental-strip-types --test lib/http-dispatcher.test.mjs tests/system-proxy.test.mjs`：6/6，退出码 0；`npm run typecheck`、`npm run build`：退出码 0。
- 开发版 `npm run test:window`（独立用户数据目录）：21/21，后置 3 项通过，退出码 0。
- 用独立临时 agent 配置、新构建后台及系统代理判定，对 `澄枢云/gpt-6.1-sol`（high）做一次无工具长文本复测：274574 毫秒，900 行逐条校验正确，31416 字符，9057 输出 token，最终标记及正常结束事件均收到，无 `terminated`。这次不足 5 分钟，不能证明原来的断流问题已解决。
- 复测脚本在模型完成后删除正在使用的 Electron 用户数据目录时报 EPERM，未正常退出，外层命令超时；随后按 PID、可执行路径及测试脚本名确认并只停止本次测试进程，清理本次临时目录和脚本，清理命令退出码 0。模型完成结果与脚本退出状态分开记录。
- 此次源码复测时未重新打包、安装或重启用户实例；安装版更新见下节。

### 用户要求更新安装版

- `npm run package` 退出码 0。安装包：`release/Pi Desktop Setup 0.0.6.exe`，140875008 字节，SHA-256 `294211e30360c900afc146847d7aa4eb6a3ed51a92c9762bd5845c14266a3130`。
- 包内后台确认默认超时为 `6e5`，后台 SHA-256 `db84d686ce0285b48bf4cea8f9a1fa7c763dd04ab6c091581530c454e84f95f6`。
- `npm run test:window:packaged`：仓库外副本 21/21，后置 3 项通过，退出码 0。此次未重新做模型长回复复测。
- 用户明确授权安装；当前实例仍在使用，因此安排一次性等待安装，最多等待 30 分钟。用户从托盘「完全退出」且安装路径下没有剩余应用进程后才执行 `/S` 安装；不强关用户实例，不修改会话、密钥或自动更新配置。
- 安装前校验安装包哈希，安装后检查退出码、已安装后台哈希与 600000 毫秒设置，随后重新打开应用。此处记录的是安排，不是已安装成功。
- 状态凭据：`C:/Users/jch/AppData/Local/Temp/pi-timeout-install-294211e3.json`；安装等待脚本及日志位于同目录同名前缀。Windows 原生启动方式已确认等待进程 PID 12004 正在运行，状态为 `waiting_for_exit`；首次 Node detached 启动未持续运行，未执行安装。
