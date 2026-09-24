# Pi Desktop

Windows 桌面版的 pi coding agent。界面沿用现有的 pi-web（React 组件原样搬过来），
但**桌面内部通信不监听本地端口**：窗口和后台之间走 Electron 的进程间通信，
后台进程里跑的是 pi-web 原来的服务端代码。

本轮修复、验收证据与暂缓项见 [REVIEW-FIXES.md](REVIEW-FIXES.md)。
下面标为“早期记录”的数字不代表最终交付包。

```
┌────────────────────────────────────────────────────────┐
│ 窗口（渲染进程）                                          │
│   pi-web 的 React 界面，未经修改                          │
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
│ 后台进程：端口化了 pi-web 的全部服务端路由                   │
│   会话 / Agent / 终端 / 文件 / Git / 模型 / 技能 / 插件      │
│        ↓ HTTPS（唯一的外网出口）                           │
│ 模型服务                                                 │
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
- **不手抄界面**。`lib/`、`components/`、`hooks/`、`app/api/` 与上游 pi-web 逐字节一致（搬迁阶段的要求，`diff -r` 为空）；
  搬迁已经完成，此后这几个目录允许直接改（现有改动见「上游同步」）。

## 垫片做了什么

渲染进程只替换了四个浏览器 API，业务代码零改动：

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
  原名会让以后改这份源码时被它自己的守卫挡住。其余文件与来源一致。
- **只有一份生效**：磁盘上已装的那份（`~/.pi/agent/extensions/pi-automode`）会被丢掉，
  免得同时出现两个分类器和两套工具。插件管理器里仍会列出它，因为它还在磁盘上。
- 设置入口在设置对话框顶部的「自动模式」页；保存后要重新加载会话才生效。
- 页面只列可改的项，不再铺开版本、插件路径、会话计数和生效值表（这些属于排查信息，不属于设置）。
  适用范围是一行下拉框：所有项目 / 当前项目。
- 页面只展示可编辑设置；适用范围使用「所有项目 / 当前项目」下拉框。
  不再铺开版本、插件路径、会话计数和生效值表。配置读取异常仍会提示。
  自动模式页铺满设置面板，左右内边距相同，滚动条位于面板右侧。
- 配置文件与命令行版共用，装没装插件都是这两个：
  - 全局：`~/.pi/agent/extensions/pi-automode/config.json`
  - 本项目：`<项目>/.pi/automode.local.json`（项目未受信任时会被忽略，设置页会标出来）
- 页面上保存时只写你动过的项，没动过的键不进文件，继续用下层的值。

## 命令

```bash
npm install --include=dev        # 这台机器上 NODE_ENV=production，必须显式带上 dev
npm run build                    # 编译主进程 / preload / 后台 + 构建界面
npm start                        # 直接运行（开发态）
npm run typecheck                # 类型检查

npm test                         # 后台路由端到端（走真实 IPC）
npm run test:models-config       # 模型设置保存后同步 enabledModels（用临时 agent 目录，不碰真实配置）
npm run test:prompt              # 再加一次真实模型对话
npm run test:desktop             # 桌面桥接、取消、重连、导航和npm复制的定向回归
npm run test:gate                # 测试统计门槛的反例检查
npm run test:web                 # 选取的上游测试，不代表整个上游套件
npm run test:window              # 窗口检查 + 运行时端口采样 + 采样进程退出检查
npm run test:window:packaged     # 同一套检查，对安装包产物跑（见下）
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
  原生对话框已在 preload 里备好（`pickDirectory`）。上游在 `SessionSidebar.tsx` 里声明了
  `window.piDesktop.selectDirectory` 但从未调用，接上它要改那个文件——
  这会破坏“与上游逐字节一致”，所以留着没动。

## 出网与代理

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
| `lib/directory-browser` / `lib/subagent-input` 的符号链接用例 | 本机没有符号链接权限（Windows 需开发者模式或管理员），`EPERM: symlink` |
| `lib/project-command-env` 的 PATH 用例 | 测试自己用宿主的 `path.delimiter` 却模拟 linux，只在 POSIX 主机上成立 |
| `lib/terminal-manager` 的 pid 用例 | node-pty 1.2.0-beta.15 在 Windows 上 `spawn()` 返回 `pid: 0`（ConPTY 后端如此），直接调用同样如此 |
| `lib/terminal-manager` 的租约过期用例 | 测试用 mock 定时器，但 jiti 转译后模块里拿到的是真实 `setTimeout`，mock 不生效 |
| `components/ChatInput` 的图片告警用例 | 被搬过来的源码与上游逐字节一致，且该测试不加载桌面端任何代码 |

## 上游同步

`lib/`、`components/`、`hooks/`、`app/api/`、`app/*.css`、`public/` 都是从 pi-web 直接复制的。
搬迁阶段要求它们与上游逐字节一致；**搬迁完成后这条要求就放开了**：现在可以直接改这些文件，
改完跑 `node <维护skill>/scripts/check-upstream-parity.mjs` 看差异清单，确认差异都是有意为之。
本次留下的差异（其余文件仍与上游一致）：

```
lib         i18n/messages/{en,zh-CN,zh-TW}.ts   rpc-manager.ts   settings-navigation.ts   (+ automode-builtin.ts)
components  SettingsPanel.tsx, SessionSidebar.tsx                            (+ automode-draft.ts, AutomodeConfig.tsx)
app/api     (+ automode/route.ts, automode/test/route.ts)
```

同步上游时仍然先备份，再镜像这些目录，包含删除上游已删除的文件；
普通覆盖会留下旧路由，`scripts/gen-routes.mjs` 会继续收集它们。还需协调 `package.json` 与锁文件中的新增依赖，
检查新的 Next API/路由约定，重建并跑回归；不能保证任意上游版本直接覆盖就能用。
两类改动要分开处理：上面那 5 个被改过的文件在镜像时会冲突，需要把本地那段改动重做一遍
（都集中在自动模式相关的位置），新增文件不受影响。
（早期版本改过 `lib/terminal-manager.ts`，后来发现按上游原样即可：终端 shell 就用
系统环境里的 `ComSpec`，正常 Windows 上一定有；现在这个文件与上游逐字节一致。）

桌面端自己新增的东西都在这些目录里，不会被覆盖：

```
desktop/     主进程、preload、后台进程、next/server 垫片、窗口探针
renderer/    Vite 入口、四个浏览器 API 垫片、界面挂载
services/    App Router 路由表 + 路由器
scripts/     构建、打包、测试脚本
shared/      三个进程共用的类型契约
tests/       后台端到端测试
```

`scripts/run-web-tests.mjs --list` 可列出实际收集的149个文件。
`app/api` 的12个测试文件尚未接入此命令；其中7个直接依赖未安装的Next运行环境。
9个排除文件中有混合测试，包含桌面也使用的设置界面检查；
不能把它们全部称为“只测web入口”。源码正则测试也不等于真实界面操作检查。

## 安全边界

- 窗口是标准沙箱：`contextIsolation`、`sandbox`、无 Node 集成，`preload` 只暴露白名单方法。
- 页面带 CSP 且 `connect-src 'self'`：界面本身不联外网，模型流量全部由后台进程发出。
- **没有本地HTTP监听入口**，其他程序不能通过本地端口访问这些 API。
  这不防御拥有本机文件或调试权限的程序。
- 代价是：渲染进程里若有 XSS，就能调本地 API（和网页版同源请求的处境一样）。
  缓解手段是 pi-web 自带的 markdown 清洗 + 上面那条 CSP。
