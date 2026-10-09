# Pi Desktop 项目入门与维护指南

本指南描述当前仓库的实际实现，不把规划当成功能，也不把历史测试当成本次通过。
功能细节见 [README](../README.md)，历次证据见 [REVIEW-FIXES](../REVIEW-FIXES.md)，备份规划见 [备份文档](backup-plan.md)。

## 项目是什么

Pi Desktop 把 pi coding agent 和 pi-web 界面装进 Windows 桌面应用，可以聊天、管理模型与会话、运行 Agent、操作项目文件、Git 和终端。
它不是一个另外启动的网页服务器：界面通过 Electron IPC 与后台通信，资源通过 `pi-app://app/` 加载，**内部不监听 HTTP/WebSocket 端口**。
代码里的 `http://127.0.0.1:30141` 是兼容路由校验用的虚拟来源，不代表真的启动了30141端口。

- 当前构建和交付目标：Windows x64；不承诺 Linux/macOS 安装包。
- 不做自动更新；源码、开发产物、安装包、已安装应用是不同副本。
- 模型调用需要可用渠道、凭据和网络，可能产生费用；无凭据不等于应用不能启动。
- 插件、OAuth 或 Agent 自己启动的服务器可能监听端口，不属于内部通信。

## 开发环境与首次启动

### 准备

| 工具 | 要求与用途 |
|---|---|
| Windows | 当前支持/验收的平台为 x64 Windows；其他平台未交付验证 |
| Node.js | 采用 Node 24；后台构建目标为 `node24`，本次文档核查环境为24.16.0 |
| npm | 采用 npm 11；本次环境为11.13.0，随包 npm 由构建机复制而来 |
| Git | 源码管理和应用 Git 功能；worktree 子代理也依赖 Git |
| Git Bash / PowerShell | 执行开发命令；本文的环境变量示例使用 Git Bash |
| Electron | 由项目开发依赖提供，当前锁定44.4.2，不需要另装全局 Electron |
| 模型配置 | 窗口部分检查及真实模型测试需要可用模型；不要把个人 key 放进仓库 |

依赖版本以 `package.json` / `package-lock.json` 为准，不要因本指南中的核查版本自行升级依赖。
`node-pty` 是原生依赖；打包配置为 `npmRebuild: false`，不会自动为它重编译。
若缺预构建二进制，可能需要额外原生编译工具；应先检查具体报错，不承诺一条安装命令适用于所有机器。

### 安装和启动

在仓库根目录执行：

```bash
node --version
npm --version
npm ci --include=dev       # 新克隆、锁文件与 package.json 一致时的安装方式
npm run typecheck
npm start                 # 构建 + 复制随包 npm + 启动开发版
```

已有工作区要调整依赖时使用 `npm install --include=dev`，先保留未提交改动；`npm ci` 会重建 `node_modules`，不适合拿来随意修复一个正在使用的工作区。
即使环境中设置了 `NODE_ENV=production`，开发和打包也需要显式安装 devDependencies（Electron、Vite、TypeScript 等）。

`npm start` **不是热更新开发服务器**。修改源码后需要重新构建和启动新实例。
如果从 Desktop 的终端/Agent 启动 GUI，继承的 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 变成普通 Node。Git Bash 可用：

```bash
env -u ELECTRON_RUN_AS_NODE npm start
```

窗口测试脚本会主动去掉此变量，但直接 `npm start` 不会。不要修改后台自身依赖的 `ELECTRON_RUN_AS_NODE` 设置。

### 首次使用

1. 选择工作区/项目目录。
2. 在「设置 → 模型」配置渠道和模型，或使用现有 pi 共享配置；不要把密钥写进聊天或提交到 Git。
3. 必要时完成登录，再选择模型、新建会话。
4. 对项目扩展/技能的信任提示先审阅代码，再确认。配置保存后若提示重载，重载或新建会话。
5. 关闭窗口会隐藏到托盘；要彻底退出，在托盘选择「完全退出」。

目前不能保证没有系统 Node/npm 的干净电脑能完成技能/插件安装；随包 npm 可运行不等于整条安装链路已验证。

## 源码地图与改动落点

| 路径 | 作用 |
|---|---|
| `desktop/main.ts` | 主进程：窗口/托盘、协议、后台生命周期、原生对话框、备份 IPC |
| `desktop/preload.ts`、`shared/contract.ts` | 窗口可调用的白名单桥及三层通信契约 |
| `desktop/backend.ts` | 独立后台：请求登记、取消、流式拉取、会话/终端收尾 |
| `desktop/system-proxy.ts`、`lib/http-dispatcher.ts` | 出网代理与默认超时 |
| `renderer/` | React 挂载、恢复条、桌面 CSS 和浏览器 API 垫片 |
| `components/`、`hooks/`、`lib/` | 界面、状态和业务逻辑；允许按本地需求修改 |
| `app/api/` | 来自 pi-web 的服务路由及本地新增路由 |
| `services/http-router.ts` | 把 HTTP 形状请求分配到路由，不创建 HTTP 服务器 |
| `services/routes.gen.ts` | 自动生成的路由表，不手工编辑 |
| `desktop/shims/` | `next/server` 等服务端兼容实现 |
| `builtin/` | 随应用打包的自动模式、子代理等源码和来源/许可证说明 |
| `lib/backup/`、`components/BackupSettings.tsx` | 加密备份逻辑及界面 |
| `scripts/`、`tests/` | 构建、打包、测试入口；业务目录中也有 `.test.mjs` |
| `public/`、`build/` | 静态资源及打包图标 |
| `dist/main/`、`dist/renderer/` | 编译输出；不要当成源码维护 |
| `vendor/npm-bundle/` | 构建机 npm 的复制产物，不提交 |
| `release/` | 打包输出，包含 NSIS 安装程序和 `win-unpacked/`，默认只读 |

构建链：`build:desktop` 先生成路由表，esbuild 编译主进程/preload（CJS）、后台与子代理（ESM）；`build:ui` 用 Vite 构建静态界面并复制资源。
SDK 与 `node-pty` 等运行依赖保持外部加载；打包时 `node_modules`、后台入口、子代理 bundle 解包到真实目录。
没有运行 Next 开发服务器，不要为了修一个导入错误就加本地端口或安装整套 Next 运行环境。

## 配置和数据在哪里

下表用 `A` 表示运行时 `getAgentDir()`，默认是当前用户 `~/.pi/agent`；可由 `PI_CODING_AGENT_DIR` 改写。测试时尽量使用绝对路径。
`P` 表示项目目录。**应用安装目录不是会话和密钥存储目录。**

| 数据 | 路径/位置 | 注意事项 |
|---|---|---|
| 原始会话 | `A/sessions/**/*.jsonl` | 与 pi CLI/pi-web 共享；不要多客户端同时编辑同一会话 |
| 全局设置/模型 | `A/settings.json`、`A/models.json` | 模型配置也可能包含 key、请求头或命令型值 |
| 登录/API 凭据 | `A/auth.json` | 敏感；不能上传或放进调试报告 |
| 项目信任 | SDK 在 `A` 下的信任存储（`trust.json`） | CLI 与 Desktop 共享；备份不继承此信任 |
| 项目设置 | `P/.pi/settings.json` 等 | 部分项目值会覆盖全局值，如 `enabledModels` |
| 用户 Agent | `A/agents/`、`P/.pi/agents/` | 扩展开关在 `A/agents/settings.json`；运行设置在 `A/subagents.json` 与 `P/.pi/subagents.json`，项目覆盖全局；旧显式并发仅兼容回退 |
| 内置 Agent 的用户修改 | `A/desktop-agents/` | 删除记录在 `.deleted/`；不是修改安装包 |
| Agent 记忆 | `A/agent-memory/`、`P/.pi/agent-memory/`、`P/.pi/agent-memory-local/` | 原生子代理按作用域使用；还兼容旧用户记忆目录 |
| 自动模式 | `A/extensions/pi-automode/config.json`、`P/.pi/automode.local.json` | 共用 CLI 配置；项目配置需满足信任规则 |
| 会话列表索引 | `A/pi-web-session-index.json` | 派生缓存，不代替原始会话 |
| 界面偏好/模型收藏 | Electron profile 中 `pi-app://app` 的 localStorage | 不是 `A/settings.json`，也不跨电脑自动同步 |
| 恢复隔离区 | `A/backup-imports/<批次>/` | 解密后的配置/凭据仍敏感，人工审阅后迁移 |

Electron profile 按运行时 `app.getPath("userData")` 及 `--user-data-dir` 决定；不要猜安装版的具体目录，也不要随意删除整个 profile。
单实例锁绑定窗口 profile。隔离窗口 profile **不会**隔离 `A`、项目文件或模型费用。
当前桌面会话列表扫描 `A/sessions`，不能直接把 CLI 的自定义 session-dir 选项当成 Desktop 已支持。

### 常用环境变量

| 名称 | 用途 |
|---|---|
| `PI_CODING_AGENT_DIR` | 更换 agent 数据根，用于独立配置/测试；不会自动提供模型凭据 |
| `PI_DESKTOP_SMOKE_USERDATA` | 由窗口/场景测试脚本转换成 `--user-data-dir`，仅隔离窗口 profile；不是普通应用直接读取的设置 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 后台出网代理，大小写形式也识别；无显式代理时查询系统代理 |
| `PI_WEB_SKIP_VERSION_CHECK` | 主进程给后台设置为1，关闭网页版更新提示，不是自动更新机制 |
| `PI_DESKTOP_SMOKE`、`PI_DESKTOP_SCENARIO` | 自动化测试入口；正常使用不要设置 |
| `PI_DESKTOP_SMOKE_DROP_TERMINAL` | 设为1会提前关闭测试终端，结果不作为“退出时清理打开终端”的证据 |
| `PI_DESKTOP_SMOKE_HOLD_MS` | 窗口检查等待采样时间；正常使用无需设置 |
| `PI_DESKTOP_SKILL` | 技能场景额外执行真实安装；会下载/执行外部代码，不属于普通窗口检查 |

系统代理只采用第一项；不支持的 SOCKS5、解析失败或查询超时会报错，不偷偷直连。
默认响应头等待和响应体连续无数据超时均为30分钟；这不会改变中转站自己的超时。

## 修改和测试流程

先 `git status --short` 看清已有工作，再选正确源码落点，保留所有与本任务无关的修改。

1. 改源码并同步 README 行为说明；新增/删除路由由构建生成路由表。
2. `npm run typecheck`。
3. `npm run build`。多数运行测试使用 `dist/`，不会自动重建；漏掉此步就是测试旧代码。
4. 跑定向测试及窗口检查；记录退出码、对象和未覆盖场景。
5. 需要交付时另外打包并测试打包版；不替用户安装、发布或推送。

纯文档修改只需核对命令、链接、源码和文档差异，不必构建或调用模型，也不因修改文档立即升版本打包。

| 命令 | 主要覆盖 | 真实模型/隔离边界 |
|---|---|---|
| `npm run test:desktop` | 桥、取消、SSE 重连、导航、代理、npm、自动模式等定向回归 | 不要求真实模型；不是完整功能套件 |
| `npm test` | 真实后台 IPC 和路由 | 默认使用当前 `A`，创建/清理自身夹具；不作全目录隔离 |
| `npm run test:smoke` | Node/原生依赖基础检查 | 不是 Electron 窗口验收 |
| `npm run test:models-config` | 模型保存与 enabledModels 同步 | 自动使用临时 agent 配置，不写个人配置 |
| `npm run test:gate` | 测试统计门槛的反例检查 | 不证明应用全部功能正常 |
| `npm run test:web` | 选取的业务/界面测试 | 不收集 `app/api`、`tests`；排除9文件、过滤5用例，名单见脚本 |
| `npm run test:window` | 开发版窗口、IPC、布局及端口/退出采样 | 不发送真实聊天，但部分检查依赖可用模型列表；只清理自身夹具 |
| `npm run test:prompt` | 后台真实模型提交 | 要凭据、网络，可能收费；测试 host 默认代理回答为 DIRECT，必要时显式提供代理变量 |
| `npm run test:chat` | 输入、停止、继续及助手回复 | 真实模型；默认开发版 |
| `npm run test:resilience` | 刷新、后台崩溃与恢复 | 真实模型；默认开发版 |
| `npm run test:*:packaged` | 上述 window/chat/resilience 的打包版入口 | 自带 `--isolate`，把包复制到仓库外再测，不自动打包 |

`test:*:packaged` 表示三个实际命令：`test:window:packaged`、`test:chat:packaged`、`test:resilience:packaged`，不是可以直接执行的通配命令。
测试数量会变化，用 `node scripts/run-web-tests.mjs --list` 核对当前收集范围。
备份定向回归入口为 `node --test lib/backup/index.test.mjs components/BackupSettings.test.mjs`，其合成目录/配置不是个人备份操作。

用户应用开着时，Git Bash 可以独立窗口 profile 运行检查：

```bash
PI_DESKTOP_SMOKE_USERDATA="$TEMP/pi-desktop-window-check" npm run test:window
```

使用自己的未占用测试路径；不要强关用户应用。若还要隔离 agent 数据，额外设置指向准备好的临时目录的 `PI_CODING_AGENT_DIR`；空配置可能让依赖模型列表的检查失败，不能为过测试关闭这些断言，也不能无授权复制个人凭据。

**验收只认真实退出码和有效统计。** 端口结论仅代表采样时刻，退出结论仅覆盖采样进程；查询失败不能算“零”。输出有 passed、用户提示词含答案、终端命令回显标记都不能独立证明成功。测试失败与没运行要分别报告。

## 备份与恢复的实际范围

入口：「设置 → 备份与恢复」。这是用户数据备份，不代替项目 Git 备份。

### 使用步骤

1. 停止活动会话，关闭终端及可能同时写相同数据的外部 CLI。
2. 选择是否包含隐私；如选“是”，再选择会话、自定义资源、项目资源。项目由系统目录对话框选择，不包含整个项目源码。
3. 先扫描并查看数量、大小、分类、遗漏警告，再输入并确认本次密码。
4. 保存为新的 `.pibak` 文件，放在 agent 和所选项目目录之外；已有档案不覆盖。密码为8—1024字符，丢失无法恢复。
5. 恢复时输入密码、选择档案、查看预览后确认；默认且目前只能跳过已存在目标，不支持覆盖或自动合并。
6. 审阅 `A/backup-imports/<批次>/` 中隔离的配置/资源，再按需人工迁移，必要时重新登录、重载会话。

扫描、导出和恢复期间后台暂时停止，完成后重启。扫描/导入预览令牌10分钟过期，过期重新扫描或选文件。

### 当前包含与遗漏

- **隐私“否”**：仅 `settings.json` 的 `defaultThinkingLevel`、`theme`、`enabledModelsSync` 固定取值白名单；不含聊天、模型/凭据、路径或自由文本。没有符合字段时可能得到无用户数据的档案。
- **隐私“是”**：全局设置、`models.json` 和**全部已有 `auth.json` 凭据**，不是按供应商勾选；会话、自定义资源、项目资源另行选择。
- 自定义资源仅按实现的文件/目录白名单收集，不跟随符号链接，也不会打包整个 `A`。
- **不包含**：内置 Agent 用户编辑/删除记录（`desktop-agents`）、Agent 记忆、项目 `automode.local.json`、浏览器偏好/收藏、推送凭据、技能锁文件、自定义会话根自动发现、外部符号链接目标、祖先指令、项目根 `CLAUDE.md`、trust、依赖缓存、未落盘消息/草稿和正在运行的任务。
- 会话可恢复到空闲目标；含隐私的设置、模型、凭据及自定义/项目资源隔离到 `backup-imports`，不会自动激活扩展。非隐私设置也只在目标文件未占用时恢复，不合并字段。
- 不自动重写会话中的原项目路径，不保证迁移后外部文件引用有效。

档案为版本1的 `PIDESK01` 加密容器，scrypt + AES-256-GCM，不是明文 ZIP。
实现上限：单文件8 GiB、总载荷16 GiB、10000条目；不是所有极限大小都已实测的保证。
导出盘不支持硬链接时有独占复制回退，异常掉电仍可能留下无效半成品；恢复目标目前仍需硬链接支持。
恢复过程有解密暂存文件，Windows 下继承 agent 目录 ACL；并非已经验证所有账户间权限隔离。不要公开备份密码、解密隔离区或暂存数据。
详细后续目标见 [备份文档](backup-plan.md)，不能用其中的规划表声称遗漏项已覆盖。

## 打包、交付与版本管理

```bash
npm run package                  # 构建、复制 npm、生成 Windows x64 NSIS 安装包
npm run test:window:packaged      # 必跑：仓库外隔离副本
npm run test:chat:packaged        # 有模型时补真实聊天
npm run test:resilience:packaged  # 有模型时补刷新/崩溃恢复
```

- 输出：`release/Pi Desktop Setup <版本>.exe` 与 `release/win-unpacked/`；`package:dir` 仅生成免安装目录。
- 不要在仓库内直接测打包目录，否则缺失依赖可能被仓库的 `node_modules` 补齐而假通过；隔离测试日志需有 `isolated copy:`。
- 核对包版本、生成时间、大小及 SHA-256；记录测试真实退出码。`latest.yml`、blockmap 不代表已接自动更新。
- 新源码需要重新出包时按项目约定只将 patch 加1，同步 package.json 和锁文件，重试同一源码不再升号；授权不扩大为提交/标签/安装/发布/推送。
- 安装前从托盘完全退出旧版；只隐藏窗口不够。不在用户使用时覆盖 `%LOCALAPPDATA%/Programs/Pi Desktop`。
- 访问 GitHub 需使用本机配置的代理；本维护环境是 `http://127.0.0.1:7890`，不是所有电脑都应使用的固定地址。
- `upgrade:pi` 会联网更新四个内核包和锁文件并构建，不是普通启动步骤。同步上游遵循 README 的合并流程，保留本地功能。

## 常见问题

| 现象 | 先检查什么 |
|---|---|
| 改了源码但界面没变 | 是否构建；运行的是 `dist/`、打包副本还是已安装旧版 |
| 启动静默退出且退出码0 | 同 profile 的应用是否已在运行；测试用独立 user-data-dir |
| Electron 协议 API 未定义/启动即崩 | GUI 是否继承 `ELECTRON_RUN_AS_NODE=1` |
| `ERR_MODULE_NOT_FOUND`、界面面板全报错 | 顶层四个 Pi 包、运行依赖及 asar 解包路径；不能靠仓库内测包证明修复 |
| 新模型保存后看不到 | 凭据是否有效、全局 enabledModels 同步结果、项目白名单覆盖；重载会话 |
| GPT/渠道连不上 | 环境变量代理优先级、系统代理、渠道可达性；SOCKS5 当前不支持 |
| 技能搜索可用但安装失败 | 系统 Node/npm 是否可用、外部网络、权限和60秒安装路由超时 |
| 备份提示失败/不可用 | 活动会话或终端是否关闭、令牌过期、源变化、密码/文件名/大小/文件系统限制 |
| 恢复成功但模型/插件没生效 | 是否在隔离目录等待人工审阅，而不是写入活动配置 |
| 崩溃恢复后草稿消失 | 自动重启成功会重载页面；未发送草稿保护暂缓，不是备份能恢复的内容 |

问题报告写清应用版本、运行副本、步骤、错误和命令退出码；不要贴 API key、OAuth token 或完整私人会话。

## 安全与维护边界

- 窗口有 contextIsolation/sandbox、无 Node 集成，preload 白名单和 CSP；这不是对所有本机行为的沙箱。
- 后台与扩展有文件/终端能力；项目信任和自动模式降低误操作风险，不保证恶意代码绝对无法影响机器。
- 不加本地 HTTP/WebSocket 服务、不做自动更新，不为测试绿灯删断言或擅改权限设置。
- 本维护工作区可写源码为 `C:/Users/jch/pi-desktop`；`C:/Users/jch/pi-web-main` 是只读上游参照，已安装目录和旧交付包默认只读。其他机器使用其实际工作区路径。
- 保留已有未提交工作，不提交 release、dist、node_modules、vendor 和临时日志；它们已被 `.gitignore` 排除。行尾遵循 `.gitattributes` 的 LF 约定。
- 内置组件的许可证/来源在 `builtin/` 内各自记录。当前根目录没有统一 LICENSE，不能推断整仓采用某一开源许可；对外再分发前需另外确认授权和依赖许可。
- 大文件完整分块、无系统 Node 的完整安装、缩包、全面 IPC 参数校验、自动恢复草稿保护等仍是暂缓项；详见 README/REVIEW-FIXES，不在普通维护中顺手实施。
