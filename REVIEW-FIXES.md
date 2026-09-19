# 本轮审阅修复与验收

本轮按「优先修日常会遇到的问题」执行。桌面内部仍用 Electron IPC，不加本地 HTTP 服务。
`lib/`、`components/`、`hooks/`、`app/api/`、`public/` 和两份上游 CSS 在当时保持逐字节一致
（后来的自动模式一轮改动了其中 5 个文件，见本文最后一段）。

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
