# Pi Code Mode 与 context-mode：功能是否一致？

**日期：** 2026-10-11（UTC）  
**深度：** exhaustive  
**核心功能比较置信度：** 96%（最终 research_checkpoint：各问题为 100%、95%、95%、95%、95%）  
**证据：** 30 个来源条目，6 轮搜索、16 个搜索问题；包含同一项目的不同文档与源码，**不等于 30 份独立实验**。

---

## Executive Summary｜先说结论

**不一致。它们有明显重合，但不是同一个功能，也不能完整互相替代。** Pi Code Mode 是“让模型写 JavaScript，编排 Pi 工具，在结果进入模型前进行处理”的内置能力；context-mode 是“脚本执行 + 大内容检索库 + 会话事件记录与恢复 + 路由规则”的扩展系统。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[context-mode](https://github.com/mksglu/context-mode)

如果你的目的只是少读大段日志、批量调用工具、只返回需要的结果，Pi Code Mode 已经覆盖很大一部分需求。context-mode 的主要增量是**把大量内容放在模型上下文之外，之后可以搜索，以及自动记录部分会话状态**；Pi Code Mode 的优势则是**直接编排宿主工具和任意已连接的 MCP 工具，并调用 Pi 的分类器、图像模型接口**。[Pi MCP](https://pi.dev/docs/latest/mcp)、[context-mode 工具实现](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/server.ts)

96% 是对这些功能边界判断的置信度，**不是性能收益，也不是两者组合稳定性的保证**。本次没有安装 context-mode、修改配置或进行端到端性能实验；“安装后还能比 Pi Code Mode 多省 98%”没有证据支持。

## Key Findings｜关键发现

1. **核心思路相同，产品范围不同。** 两者都让代码先处理数据，模型只接收选择后的输出；context-mode 另外提供索引、检索、会话事件与恢复。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[context-mode README](https://github.com/mksglu/context-mode)
2. **Pi Code Mode 的工具编排更直接。** `tools.<name>()` 可以调用当前会话可调用的 Pi 工具、扩展工具和 MCP 工具；context-mode 的 `ctx_execute` 是运行子进程脚本，不能把它当成拥有 Pi `tools` 全局对象的另一套 Code Mode。[Pi MCP](https://pi.dev/docs/latest/mcp)、[执行器源码](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/executor.ts)、[Pi 设计解释](https://lucumr.pocoo.org/2026/10/6/codemode/)
3. **两个“搜索”不是一回事。** Pi `searchTools()` 搜工具名称、说明和参数等元信息；context-mode `ctx_search()` 搜已索引的文件、网页、命令输出和会话事件。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[FTS5 源码](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/store.ts)
4. **Pi Code Mode 也有持久状态，不能说它完全没有记忆。** `store/load` 保存小型 JSON，并随当前会话分支恢复；它不是大文档搜索库，也不自动采集所有用户要求。[Pi Codemode](https://pi.dev/docs/latest/codemode)
5. **context-mode 的会话恢复是补充能力，不是无限、无损记忆。** 依赖宿主事件、事件提取、有限快照和按需检索；Pi 本身已有会话保存、压缩和分支摘要，不是安装前完全不能恢复会话。[Pi Compaction](https://pi.dev/docs/latest/compaction)、[context-mode README](https://github.com/mksglu/context-mode)
6. **“sandbox”含义不同。** Pi 的脚本 VM 没有直接文件和网络权限；context-mode 的子进程可以使用本地文件、网络和传递的 CLI 凭据，不能视为同等强度的权限隔离。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[维护者安全说明 #857](https://github.com/mksglu/context-mode/issues/857)
7. **Pi 集成不只是重复，还发现了具体兼容问题。** context-mode 扩展已自带桥；但路由不识别 `parentToolCallId`，会让某些 Code Mode 内嵌 bash 也进入输出阻断逻辑；工具结果捕获又读取旧字段，与本机 Pi 1.1.0 的事件结构不匹配。这些是静态源码证据，尚未动态重现，不是“Pi 完全不可用”的结论。[扩展源码](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/adapters/pi/extension.ts)、[Pi 工具事件实现](research_evidence/code-mode-vs-context-mode/pi-1.1.0/dist/core/agent-session.js)、[桥接修复 #426](https://github.com/mksglu/context-mode/issues/426)
8. **98% 是特定测试的输出字节节省，不是相对 Pi 的优势。** 同一 benchmark 总体约 96%，检索部分约 82%，其中一个小输出场景仅约 13%；测试中的 token 数还是字节数除以 4 的估算。[BENCHMARK](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/BENCHMARK.md)、[测试代码](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/tests/ecosystem-benchmark.ts)
9. **官网的新 Gateway 不是本次比较对象。** `context-mode.com` 现宣传请求代理、共享记忆和保护规则，使用 `@context-mode/cli`、修改模型 API 地址，并把 Pi 标为“soon”。不能把这些能力和收益归到用户指定的 GitHub 本地扩展上。[官网](https://context-mode.com)

## Detailed Analysis｜详细分析

### Q1：具体比较的是谁，版本是否确定？

GitHub repository search 使用 `context-mode in:name`、按 stars 降序；查询时第一名是 **`mksglu/context-mode`，26,327 stars**。这确认了用户指定的比较对象。星数只是当时的快照，不作为性能或安全证明。[GitHub 搜索 API](https://api.github.com/search/repositories?q=context-mode+in%3Aname&sort=stars&order=desc&per_page=6)

Pi 一侧以本机实际安装的 **`@earendil-works/pi-coding-agent 1.1.0`** 为实现锚点，并核对官方最新文档。context-mode 一侧同时核对 **npm latest `1.0.169`，发布于 2026-06-29**，与研究时 GitHub main 快照 **`f33a26e3a40a3dcb3586378879d04cfd2eb808f7`**。main 的 package.json 也写 1.0.169，**但不能据此认为 main 与已发布包的实现完全相同**。下载的 npm tarball 已校验 SHA-1，与 registry 元数据一致；只读取文件，没有执行安装脚本。[Pi 包目录](https://pi.dev/packages/context-mode)、[npm registry](https://registry.npmjs.org/context-mode)、[固定版本声明](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/package.json)、[本地 Pi 证据](research_evidence/code-mode-vs-context-mode/pi-1.1.0/provenance.json)

**连接 Q5：** context-mode 的 Pi 桥接起源于 Pi 尚未原生支持 MCP 的时期，而现在 Pi 已有原生 MCP 与 Code Mode。旧集成建议与新宿主并存，是需要检查兼容性而不是简单叠加的原因。[桥接历史](https://github.com/mksglu/context-mode/issues/426)、[现在的 Pi MCP](https://pi.dev/docs/latest/mcp)

### Q2：代码执行、并行和输出过滤，究竟重合多少？

**重合的是处理模式，不是执行接口。** 两者都可以完成“读取大数据 → 编程筛选/计数/聚合 → 只返回小结果”。例如统计日志里的 ERROR 数量：Pi 可以在 Code Mode 中调用 `tools.read` 或 `tools.bash` 再处理结果；context-mode 可以在 `ctx_execute_file` 中处理 `FILE_CONTENT`。这类需求没有本质上的能力差异，只是接口、运行位置和默认行为不同。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[context-mode server](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/server.ts)

但 Pi Code Mode 运行在**宿主的工具编排层**：JavaScript 调用 Pi 注入的工具，可用循环、分支、`Promise.all`、`Promise.allSettled` 串接多个服务器。MCP 的完整 `CallToolResult`、`structuredContent`、`isError` 可以留在脚本里处理，最后只返回选择的字段。它还能通过 `models` 调用分类器和图像模型；不能用该接口调用聊天模型。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[Pi MCP](https://pi.dev/docs/latest/mcp)、[设计解释](https://lucumr.pocoo.org/2026/10/6/codemode/)

context-mode 执行器则启动真实语言运行时，包括 JavaScript、TypeScript、Python、Shell 等 12 种语言；有条件使用本地库、文件、CLI 和网络。`ctx_batch_execute` 可批量执行 shell 命令，默认顺序执行，可选择 1–8 的并发；它不是“把所有外部 MCP 工具都变成子进程内的函数”。没有为它额外提供 MCP 客户端或 CLI 包装时，不能假设脚本能调用任意 Pi 原生工具或第三方 MCP 方法。[context-mode README](https://github.com/mksglu/context-mode)、[执行器](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/executor.ts)、[早期边界讨论](https://news.ycombinator.com/item?id=47193064)

**连接 Q3、Q4：** Pi 的强项是“少让中间结果经过模型”；context-mode 还把部分结果放入可查询的外部索引。这解释了为什么它们可以覆盖同一统计任务，却不能互换整个存储系统，也不能把两种 sandbox 的权限混为一谈。

### Q3：搜索、持久化和会话恢复，是否一致？

**不一致，尤其容易被 BM25 这个共同名词误导。** Pi `searchTools()` 是工具发现：索引工具名、工具说明、schema 参数名及说明、namespace 信息。它告诉模型“用哪个工具”，不负责回答“之前那份日志的错误在哪里”。context-mode `ctx_search()` 是内容检索：SQLite FTS5 保存内容块，BM25 排序，当前 main 还组合 Porter 与 trigram 的排名融合、相近词修正和匹配窗口提取。它不是向量语义检索；关键词选错，仍可能漏掉关键内容。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[Pi 工具发现本地源码](research_evidence/code-mode-vs-context-mode/pi-1.1.0/dist/extensions/tool-search/tool.js)、[内容检索源码](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/store.ts)

Pi `store/load` 的确能跨 Code Mode 调用保存 JSON：成功脚本的写入记录为会话的 custom entry，恢复时按当前分支路径重建。单个值最多 262,144 个 JSON 字符，所有值总量最多约 1,048,576 字符；本地实现总量还计入 key 长度。它适合 ID、游标、小结果或摘要，而不是大资料库。**不调用 `store`，不会自动得到那些资料的搜索和恢复能力。** 保存数据也不等于把完整数据重新发送给主模型。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[Pi 执行实现](research_evidence/code-mode-vs-context-mode/pi-1.1.0/dist/extensions/codemode/execute.js)

context-mode 的 `ctx_index`、`ctx_fetch_and_index` 和执行输出自动索引，提供的是另一种状态：原内容在 SQLite 中，模型用来源标签和查询按需读取。当前 main 在指定 intent 且输出大于约 5,000 字节时索引并返回匹配预览；未指定 intent 时，普通大输出超过 102,400 字节可返回索引指针。**只输出一个数字的小脚本，不会因此自动把没打印的整份原文件永久保存为可搜索内容。** “所有数据都无损存下来”是过度理解。[server.ts 的实际分支](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/server.ts)、[BENCHMARK 的工具选择](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/BENCHMARK.md)

会话方面还必须区分三个层次：**Pi 会话保存**保留历史；**Pi compaction**用 LLM 摘要让后续请求变短；**context-mode 事件库**提取文件、任务、错误等工作状态并提供恢复/检索。Pi 默认摘要已有 Goal、Constraints、Progress、Key Decisions、Next Steps，并累计跟踪文件。context-mode 是补充，不是给原本完全没记忆的 Pi 装上第一份记忆。它的恢复范围取决于实际注册的事件、提取规则、快照预算、保留策略及平台适配，不能等同“全部对话原文永远不丢”。[Pi Compaction](https://pi.dev/docs/latest/compaction)、[context-mode 会话说明](https://github.com/mksglu/context-mode)

**Pi 扩展的具体恢复路径：** 当前 main 与 npm 发布版均在 `before_agent_start` 从 prompt 提取用户事件，构建最多约 500 tokens 的活跃记忆，并读取未消费快照；之后用 `context` hook 追加消息。`session_before_compact` 建快照，`session_compact` 本身只累计压缩次数，下一次启动代理运行时才走上述注入路径。因此不能因为 README 表格没有独立 UserPromptSubmit/Stop 行就断言它完全不记录用户输入或回合信息；也不能把分类提取视为逐字保存。`turn_end` 主要记录 usage/cost，不保存完整回答。[main extension.ts：607–751、809–856](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/adapters/pi/extension.ts)、[已发布 extension.js](research_evidence/code-mode-vs-context-mode/context-mode-npm/build/adapters/pi/extension.js)

**连接 Q5：** Pi `store/load` 明确按会话树分支恢复；context-mode 适配的 session ID 来自会话文件路径哈希，没有对应 branch/tree 识别。同文件中的分支事件可能混用，新文件也没有与 Pi store 相同的继承恢复逻辑。这是源码层面的语义差异，不是本次完成了全套分支测试。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[extension.ts：219–240](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/adapters/pi/extension.ts)

### Q4：运行环境、权限、限制和失败行为有什么不同？

Pi Code Mode 的 QuickJS/WASM VM 没有 Node API、直接文件系统、直接网络或定时器；VM 内存上限 256 MiB。它要访问外界，必须通过注入的工具或 `models`。**这不意味着所有被调用工具也自动拥有操作系统隔离**：`tools.bash`、远程 MCP 等是否受限，仍取决于对应工具和执行环境。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[设计解释](https://lucumr.pocoo.org/2026/10/6/codemode/)

context-mode 的“隔离”主要是子进程与输出边界。执行器使用真实运行时，传递筛选后的环境与部分 CLI 认证信息；脚本能接触其进程拥有的文件和网络能力。维护者明确说明 `ctx_execute/ctx_batch_execute` 的任意代码执行并不是完整 OS sandbox。项目边界检查曾修复 `ctx_execute_file` 的越界读文件入口，但不能据此推导任意代码内部访问也被完全隔离。[执行器源码](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/executor.ts)、[安全跟踪 #857](https://github.com/mksglu/context-mode/issues/857)、[v1.0.164 发布说明](https://github.com/mksglu/context-mode/releases)

Pi 里由 Code Mode 发起的工具调用仍经过 `tool_call/tool_result` 和权限扩展，并携带 `parentToolCallId`。本地实现验证了这条路径，不能说“写进脚本就不会被检查”。但 `models.classify/generateImages` 是另一套模型调用接口，不应因为 UI 把它显示成内嵌调用就认定它也触发相同工具 hook。context-mode 的附加权限匹配在项目文档中主要使用 `.claude/settings.json` 的格式，不应误以为它天然等同用户的 Pi 权限规则。[Pi MCP 权限](https://pi.dev/docs/latest/mcp)、[Pi 本地执行代码](research_evidence/code-mode-vs-context-mode/pi-1.1.0/dist/extensions/codemode/execute.js)、[context-mode 安全实现](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/security.ts)

失败也不是事务回滚。Pi 脚本失败时保留部分输出、不提交本次 store 写入；未完成调用会收到取消信号，但此前已经发生的文件/网络副作用不会撤销。默认输出预算为 10,000 个估算 tokens，超限保留头尾并提供全文临时文件；bash 中间返回最多约 1 MiB，更多内容需从完整输出文件获取。context-mode 的子进程同样不能撤销已发生的副作用，且有 timeout、background 与 batch 不同执行路径；不要把“少返回文字”理解为“少执行操作”。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[context-mode server](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/server.ts)

**连接 Q2、Q5：** 两者权限路径不同，叠加时既可能额外检查，也可能发生路由摩擦；因此功能重合不代表安全行为一致。

### Q5：能否互相替代？在 Pi 中一起使用是否重复？

**对简单输出处理，可以替代一部分；对完整系统，不能。** 大日志计数、JSON 挑字段、批量工作流，通常不需要为了这一个目标再装 context-mode。反过来，只保留 context-mode 也会失去 Pi Code Mode 原生的宿主工具编排、工具发现、小型分支状态及模型接口。若需要长期查阅大量网页、规格和日志内容，context-mode 的搜索库是真实增量，而不是 Code Mode 已经同名实现的功能。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[context-mode README](https://github.com/mksglu/context-mode)、[BENCHMARK 工具矩阵](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/BENCHMARK.md)

在 Pi 集成上，context-mode package 声明 Pi extension；扩展通过自己的 MCP bridge 注册 `ctx_*` 工具。#426 的修复与用户确认说明这一桥接已让 Pi 无需再装一个外部 MCP 适配扩展。现在 Pi 自己又支持原生 MCP：如果额外连接同一服务，有**两套入口、工具描述、子进程或状态归属**的风险。它不必然造成同名冲突，因为原生 MCP 工具名有服务器前缀；但也不应假设宿主会自动去重扩展的裸名工具与原生 MCP 工具。[package 声明](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/package.json)、[MCP bridge](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/adapters/pi/mcp-bridge.ts)、[桥接修复 #426](https://github.com/mksglu/context-mode/issues/426)、[Pi MCP 命名](https://pi.dev/docs/latest/mcp)

叠加还会出现两个层次的代码：外层 Code Mode 调用 `ctx_execute`，内层再运行字符串里的脚本。这样可以工作，但增加嵌套转义、输出解析和模型选工具的复杂度；不是自动变成两倍节省。Pi 设计文章也专门指出“Code Mode 里面再套 Code Mode”的组合问题。context-mode 在 Pi 1.1.0 上的具体路由行为，本次只进行静态核对，不宣称已动态验证。[Pi 设计解释](https://lucumr.pocoo.org/2026/10/6/codemode/)、[Pi 扩展实现](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/adapters/pi/extension.ts)

**本次确认的具体兼容差异：**

- **已有 Code Mode 过滤，仍可能被输出路由拦截。** main `extension.ts:483–526` 与 npm `extension.js:425–467` 只检查工具名 bash 和命令，没有检查父调用。Pi 1.1.0 的 `agent-session.js:327–362、388–416` 明确让内嵌调用经过这些 hooks，并携带 `parentToolCallId`。所以，内层普通 `curl -s URL` 即使准备由外层脚本筛选结果，仍符合扩展的阻断条件。这里阻止的是输出路线，不是自动重写为 `ctx_execute`；也不代表所有 bash 或所有 Code Mode 调用被阻断。[context-mode 路由](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/adapters/pi/extension.ts)、[Pi 本地管线](research_evidence/code-mode-vs-context-mode/pi-1.1.0/dist/core/agent-session.js)、[Pi 官方 nested MCP 权限说明](https://pi.dev/docs/latest/mcp)
- **工具结果正文捕获使用旧字段。** main `extension.ts:547` 与 npm `extension.js:481` 取 `event.result ?? event.output`；Pi 1.1.0 实际发送 `content/details/structuredContent`，另有 `input/isError/usage`。参数与失败标记仍可记录，但这条捕获路径拿不到结果正文，依赖正文的事件提取可能缺失。不能把 README 的“每个错误与修复都记下”当成本机版本上的完整保证。[context-mode 结果捕获](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/adapters/pi/extension.ts)、[npm 发布版](research_evidence/code-mode-vs-context-mode/context-mode-npm/build/adapters/pi/extension.js)、[Pi 实际字段](research_evidence/code-mode-vs-context-mode/pi-1.1.0/dist/core/agent-session.js)
- **快照消费早于成功注入。** 扩展先标记快照已消费，再由后续 context hook 注入；如后续注入失败，恢复可能缺失。它是可靠性风险，不是本次实测出现的数据丢失。[extension.ts：711–751](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/adapters/pi/extension.ts)

这些关键 Pi 路径在本次核查的 main 与 npm 发布版中行为一致，**不是 main 新加但 npm 没有的支持**。没有证据将全部主分支文件与发布包视为相同。

外部反馈也需分别解读：#1168 报告 doctor 使用旧路径，但明确说当时 hooks 功能仍正常；#880 的 2026-09-28 评论报告 npm 1.0.169 在多 Pi 会话下仍有共享内容库被清理、长期 disk I/O error 的问题。前者是诊断不准确，后者是用户报告的稳定性问题，**不能合并成“Pi 完全不支持”**，也不能忽略它们直接推荐无条件叠加。[#1168](https://github.com/mksglu/context-mode/issues/1168)、[#880](https://github.com/mksglu/context-mode/issues/880)

## Comparison｜功能对照

下表“没有内置”不等于“程序员不能另写实现”；比较的是当前产品自带能力，不把可以自行调用 Python/数据库/外部 API 算作两者已经等价。

| 比较项 | Pi Code Mode | context-mode GitHub 项目 | 依据 |
|---|---|---|---|
| 写代码先处理数据，只返回结果 | 支持 | 支持 | S2、S5 |
| 一次编排多项工作 | 支持循环、分支与 Promise | 支持脚本与 batch | S5、S10 |
| 直接调用 Pi 原生/扩展工具 | `tools.<name>()` | 执行脚本没有同样的宿主工具对象 | S5、S12 |
| 直接编排任意已连接 MCP 工具 | 支持，受工具可调用范围限制 | 没有对应通用宿主桥；需额外客户端/CLI | S6、S12 |
| 语言 | 编排脚本是 JavaScript | 12 种语言，需安装对应运行时 | S2、S5 |
| 文件、网络直接访问 | VM 不提供；通过工具取得能力 | 子进程可以访问，受进程与外部限制约束 | S5、S12、S20 |
| 分类器、图像模型 | Pi 原生 `models` 接口 | 没有同等 Pi 模型目录接口 | S5 |
| 图片进入模型协议 | `image()` | 不等同于 Pi 的图片注入机制 | S5、S10 |
| 工具定义按需发现 | `searchTools/describeTool` 与 exposure | 不提供 Pi 全部工具的同等发现层 | S5、S6 |
| 文件/网页/输出的全文检索库 | 没有内置；工具搜索不是内容搜索 | SQLite FTS5，关键词检索与匹配片段 | S10、S11 |
| 大输出自动转搜索指针 | 默认是输出限制 + 完整文件，不自动建内容索引 | 有条件自动索引、返回指针/预览 | S5、S10 |
| 指定 intent 筛选输出 | 可在脚本自行过滤 | 内置 intent + 输出索引路径 | S5、S10 |
| 网页抓取、索引、TTL 缓存一体工具 | 需调用已有工具并自行组织 | `ctx_fetch_and_index` | S10 |
| 跨调用保存小状态 | `store/load`，成功提交、分支路径恢复 | 项目数据库；执行子进程本身不共享内存 | S5、S12 |
| 自动会话事件采集 | Code Mode 本身不做；Pi 另有会话系统 | Pi 扩展采集部分事件，受适配范围限制 | S7、S14 |
| 压缩后恢复 | Pi 自带 compaction；store 仍在会话树中 | 额外事件/快照恢复，不等于完整无损记忆 | S7、S14 |
| 强制工具路由 | `on/only` 控制暴露；不等同输出用途规则 | 扩展规则可能拦截/引导某些调用 | S5、S14 |
| 节省统计与诊断 | 非 Code Mode 的完整专项功能 | `ctx_stats/ctx_doctor` 等 | S2、S19 |
| 失败时撤销工具副作用 | 不撤销 | 不撤销 | S5、S10 |
| 额外依赖与维护 | Pi 内置，已有运行时 | 扩展、数据库、执行运行时与进程生命周期 | S3、S15、S23 |

**表格分析：** 最上面的几项，解释了为什么用户会觉得它们像：都把模型从“读全部数据的人”变成“写处理程序的人”。但“有代码执行”并不规定代码能调用谁，也不规定数据之后保存在哪里。[Pi 设计解释](https://lucumr.pocoo.org/2026/10/6/codemode/)、[执行器](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/executor.ts)

中间的索引、TTL、会话事件几项，是 context-mode 的主要附加价值。Pi Code Mode 有小状态，却没有相同的内容库。反过来，Pi Code Mode 在工具编排和图像/分类器接口上更接近宿主，context-mode 并不是它的上位替代品。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[context-mode server](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/server.ts)

因此应按问题选择：**“少读这一次的输出”优先看 Code Mode；“以后还能查这些资料与历史事件”才是 context-mode 更独特的用途。** 两者都不保证模型筛选正确；保留可回查的原内容、检查实际输入输出，比只看节省百分比重要。[BENCHMARK](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/BENCHMARK.md)、[独立社区讨论](https://news.ycombinator.com/item?id=47193064)

## Contradictions & Debates｜容易误读的说法

### 1. “98% 节省”与“总体 96%、检索 82%”矛盾吗？

不是同一统计范围。BENCHMARK 的结构化处理子集约 315 KB → 5.5 KB，约 98%；加入需要返回真实内容片段的检索后，整体约 376 KB → 16.5 KB，约 96%；检索部分约 82%。小网络输出场景只有约 13%。**合理解读是输出规模与任务不同，收益不同**，不能把子集数字当成整个会话、账单或相对 Pi 的收益。[BENCHMARK](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/BENCHMARK.md)

测试源码计算 `contextBytes` 的对象是 executor 返回的 stdout，tokens 使用 `Math.ceil(bytes / 4)`。这没有完整计算模型编写脚本、工具说明、路由提示、重试和后续检索的成本，也没有测 Pi Code Mode 同任务。项目自己的 stats 公式又经历过调整。独立讨论提出准确率、遗漏信息与冗余路由等疑虑，维护者在该早期讨论中承认当时还没有正式答案质量 benchmark。[测试源码](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/tests/ecosystem-benchmark.ts)、[统计口径 ADR](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/docs/adr/0004-stats-strict-compression-formula.md)、[HN 讨论](https://news.ycombinator.com/item?id=47193064)

### 2. “沙箱执行”是否代表完全保留宿主的权限隔离？

不能。维护者 #857 与 v1.0.164 发布说明明确区分文件工具的路径限制与任意代码执行的 OS 级隔离。issue 关闭也不等于这种更广泛的权限问题已由完整 OS sandbox 解决；当前 README 仍提醒审批执行工具要按任意代码执行看待。这里应优先相信实现与明确安全说明，而不是仅凭 sandbox 标签推断。[#857](https://github.com/mksglu/context-mode/issues/857)、[发布说明](https://github.com/mksglu/context-mode/releases)、[README](https://github.com/mksglu/context-mode)

### 3. README 要求另配 MCP，但 Pi 扩展已经能提供工具？

是文档与集成演进的差异。#426 修复后的评论确认不再需要额外 MCP 扩展，源码保留内建桥。Pi 新版原生 MCP 又带来另一种入口。**本报告只指出重复入口风险，不声称安装文档每一步都会失败，也不擅自改用户配置。** [#426](https://github.com/mksglu/context-mode/issues/426)、[bridge 源码](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/adapters/pi/mcp-bridge.ts)、[Pi 原生 MCP](https://pi.dev/docs/latest/mcp)

### 4. “所有事件都恢复”是否等于永不遗忘？

README 的整体叙述比各平台支持表更宽泛；Pi 扩展源码确实包含用户 prompt 提取与压缩恢复，因此也不能只按表格否定支持。不过，本次核查发现工具结果正文的字段兼容差异、有限的活跃记忆预算及与 Pi 分支不同的 session 绑定。实现证据比泛化的“全部记住”口号更具体。[Pi 扩展](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/adapters/pi/extension.ts)、[Pi 工具事件](research_evidence/code-mode-vs-context-mode/pi-1.1.0/dist/core/agent-session.js)

Pi 本身的压缩并不是删除全部记录，而是改变下一次发送给模型的投影。应区分“磁盘上还有数据”“模型这轮看到数据”“检索能找到正确数据”，这三者不是同一件事。[context-mode README](https://github.com/mksglu/context-mode)、[Pi Compaction](https://pi.dev/docs/latest/compaction)

### 5. 官网现在有 Gateway A/B 数据，能用来证明这次比较吗？

不能直接使用。官网产品走远程请求代理，使用另一个 CLI 包，广告中的配对任务以 Claude Code 为主，Pi 仍标“soon”。那是不同的部署和干预层。本报告不把其账单数据当作 GitHub 本地 context-mode 相对 Pi Code Mode 的测试结果。[官网](https://context-mode.com)

## Uncertainties & Gaps｜证据边界

- **没有 Pi 1.1.0 上两者同任务的可靠端到端 A/B。** 无法回答“额外省多少 token、多少钱、快多少、准确率是否改变”。已发现的官网 Gateway 数据不属于这组对照。
- **只做静态审查，没有动态验证组合。** 已确认 nested hook 的阻断条件及工具结果字段不匹配；实际受影响的任务比例、取消、会话恢复与数据库并发的表现仍需在独立测试会话中验证。
- **main 与 npm 的实现可能不同，虽然版本号相同。** 以固定 commit 描述源码，以已下载的 npm JS 描述发布包；不将尚未发布的改动当作 npm 功能保证。
- **大多数功能事实来自两个项目自身。** 官方源码适合证明“接口是否存在”，不适合单独证明“总体效果更好”。HN 与 issues 提供反例，但不是可泛化的受控实验。
- **历史讨论不能直接代表今天。** HN、#155 的早期路由与 MCP 边界需结合当前源码解释；#880 的最近评论明确涉及 npm 1.0.169，但仍是用户报告，不是本次重现。
- **会话与分支兼容没有全面验证。** 不将项目级数据库恢复等同于 Pi 原生分支路径状态；也不宣称所有中文提示、用户纠正和取消事件都准确捕获。
- **许可证不是功能等价依据。** context-mode 当前为 Elastic-2.0，属于 source-available，不能只因为能看源码就默认具有 MIT 相同的托管服务再分发权。[LICENSE](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/LICENSE)

## Recommendations｜建议

### 首选

**如果你主要在 Pi 中写代码，目标是减少大输出与批量调用成本，先用 Pi 自带 Code Mode。** 它已经解决核心的“先编程处理、再让模型读结果”问题，而且原生接入已有工具与权限 hook，不需要仅因为 context-mode 宣传 98% 就加一套执行系统。[Pi Codemode](https://pi.dev/docs/latest/codemode)、[Pi MCP](https://pi.dev/docs/latest/mcp)

### 替代/补充方案

如果你的痛点是“资料很多，今天索引后，后面还要反复查；压缩后想查具体错误、任务和决策”，context-mode 值得作为补充评估。优先关注它的**内容索引、检索和事件库**，而不是再重复建立一套脚本过滤路线。评估时应检查当前发布包、工具入口数量、Pi 事件适配、数据库稳定性及实际检索质量；先在独立会话验证，不直接归因到 98%。[工具矩阵](https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/BENCHMARK.md)、[Pi 集成问题](https://github.com/mksglu/context-mode/issues/426)、[数据库问题](https://github.com/mksglu/context-mode/issues/880)

### 不建议

- 不建议把它们当成同一功能的两个名字，或认为任何一个能无条件完全替代另一个。
- 不建议为了“再省 98%”无条件同时开启全部路由与重复 MCP 入口。
- 不建议把 context-mode 执行工具当成能自动继承全部 Pi 权限的强隔离沙箱。
- 不建议将压缩过的摘要当作原始证据；应保留可回查的资料，并在答案需要细节时检索原文。

以上是根据接口、实现与问题记录作出的评估建议，不是已验证的性能排序；本次没有实施安装或配置变更。

## Methodology｜研究方法

- **深度：** exhaustive；6 轮搜索，16 个 query，按“对象 → 机制 → 实现 → 风险 → 反证”递进。
- **最终置信度：** checkpoint 96%；对象识别 100%，其余四个功能问题各 95%。收益和组合稳定性不纳入该确定性承诺。
- **子问题：** 5 个，全部回答；将无法由公开文档证明的实测收益明确保留为不确定性。
- **多跳核查：** GitHub 搜索 → README → package/发布记录 → 固定 commit 源码 → npm 实际 tarball → Pi 最新文档与本机 1.1.0 → 用户 issues 与社区反例。
- **只读代理：** 分别检查 Pi 的工具管线、搜索和存储实现，以及 context-mode 的 Pi 扩展、桥接和安全边界；主研究核验关键源码片段。
- **验证方式：** 只读取文档、下载源码快照与 npm 包用于比对。没有 npm install、运行项目脚本、调用模型 API、修改 Pi 设置或进行沙箱逃逸测试。
- **关键难点：** GitHub API 在完成星标查询后触发限流；commit 用 `git ls-remote` 固定，源码由 codeload 下载。官网与 GitHub 项目名称相近但部署不同，单独排除。
- **本地证据目录：** `research_evidence/code-mode-vs-context-mode/`。`snapshot.json` 记录仓库快照；`npm-metadata.json` 记录发布包；`pi-1.1.0/provenance.json` 记录本机来源路径与 SHA-256。

## Sources｜来源

源码日期标为“2026-10-11 快照”，表示访问/冻结日期，不冒充提交日期。Tier 1 指该接口或实现的一手来源；官方性能数字仍是作者自测，不自动变成独立实验。

| ID | 来源 | URL / 本地证据 | 日期 | 可信度 |
|---|---|---|---|---|
| S1 | GitHub 按名称/星标搜索 API | https://api.github.com/search/repositories?q=context-mode+in%3Aname&sort=stars&order=desc&per_page=6 | 2026-10-11 查询 | Tier 1 |
| S2 | context-mode README | https://github.com/mksglu/context-mode | 2026-10-11 访问；源码已固定 commit | Tier 1 |
| S3 | context-mode package.json | https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/package.json | 2026-10-11 快照 | Tier 1 |
| S4 | npm registry / latest 元数据 | https://registry.npmjs.org/context-mode | 1.0.169：2026-06-29；2026-10-11 查询 | Tier 1 |
| S5 | Pi Codemode 官方文档 | https://pi.dev/docs/latest/codemode | 2026-10-11 访问 | Tier 1 |
| S6 | Pi MCP 官方文档 | https://pi.dev/docs/latest/mcp | 2026-10-11 访问 | Tier 1 |
| S7 | Pi Compaction 官方参考 | https://pi.dev/docs/latest/compaction | 2026-10-11 访问 | Tier 1 |
| S8 | 本机 Pi 工具发现源码 | [dist/extensions/tool-search/tool.js](research_evidence/code-mode-vs-context-mode/pi-1.1.0/dist/extensions/tool-search/tool.js) | Pi 1.1.0；2026-10-11 归档 | Tier 1 |
| S9 | Armin Ronacher：What is Codemode | https://lucumr.pocoo.org/2026/10/6/codemode/ | 2026-10-06 | Tier 1（Pi 设计者解释） |
| S10 | context-mode server.ts | https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/server.ts | 2026-10-11 快照 | Tier 1 |
| S11 | context-mode store.ts | https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/store.ts | 2026-10-11 快照 | Tier 1 |
| S12 | context-mode executor.ts | https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/executor.ts | 2026-10-11 快照 | Tier 1 |
| S13 | context-mode security.ts | https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/security.ts | 2026-10-11 快照 | Tier 1 |
| S14 | context-mode Pi extension.ts | https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/adapters/pi/extension.ts | 2026-10-11 快照 | Tier 1 |
| S15 | context-mode Pi MCP bridge | https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/src/adapters/pi/mcp-bridge.ts | 2026-10-11 快照 | Tier 1 |
| S16 | npm 1.0.169 实际发布包及 Pi JS | https://registry.npmjs.org/context-mode/-/context-mode-1.0.169.tgz；[已提取 extension.js](research_evidence/code-mode-vs-context-mode/context-mode-npm/build/adapters/pi/extension.js) | 2026-06-29 发布；2026-10-11 下载 | Tier 1 |
| S17 | BENCHMARK.md | https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/BENCHMARK.md | 2026-10-11 快照，测试日期未注明 | Tier 1（作者自测） |
| S18 | ecosystem-benchmark.ts | https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/tests/ecosystem-benchmark.ts | 2026-10-11 快照 | Tier 1 |
| S19 | ADR：统计压缩比例口径 | https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/docs/adr/0004-stats-strict-compression-formula.md | 2026-05-24 | Tier 1 |
| S20 | #857：任意代码/OS 级隔离边界 | https://github.com/mksglu/context-mode/issues/857 | 2026-06-22 起；2026-10-11 访问 | Tier 1（维护者说明） |
| S21 | #426：Pi 注册工具与桥接修复 | https://github.com/mksglu/context-mode/issues/426 | 2026-05-05 起；5月发布修复 | Tier 1/3（修复说明/用户确认） |
| S22 | #1168：Pi doctor 旧路径 | https://github.com/mksglu/context-mode/issues/1168 | 2026-09-16 | Tier 3（有具体证据的用户报告） |
| S23 | #880：Pi 多进程内容库错误 | https://github.com/mksglu/context-mode/issues/880 | 2026-06-26 起；2026-09-28 最新相关反馈 | Tier 3（用户重现/源码分析） |
| S24 | Hacker News：功能边界与质量讨论 | https://news.ycombinator.com/item?id=47193064 | 页面显示约7个月前；2026-10-11 访问 | Tier 3；作者回复按一手自述看待 |
| S25 | #155：路由开销与 subagent | https://github.com/mksglu/context-mode/issues/155 | 2026-03-20，历史版本1.0.33 | Tier 3；维护者回应为 Tier 1 |
| S26 | Pi 包目录中的 context-mode | https://pi.dev/packages/context-mode | 1.0.169 发布2026-06-29；2026-10-11 访问 | Tier 1（包元数据；README是转载） |
| S27 | context-mode Releases | https://github.com/mksglu/context-mode/releases | 最新列出1.0.169，2026-06-29 | Tier 1 |
| S28 | context-mode.com 当前 Gateway 产品 | https://context-mode.com | 2026-10-11 访问 | Tier 1（不同产品的厂商说明） |
| S29 | context-mode LICENSE | https://github.com/mksglu/context-mode/blob/f33a26e3a40a3dcb3586378879d04cfd2eb808f7/LICENSE | 2026-10-11 快照 | Tier 1 |
| S30 | Pi 1.1.0 本地文档与关键实现证据集 | [provenance.json](research_evidence/code-mode-vs-context-mode/pi-1.1.0/provenance.json)；[execute.js](research_evidence/code-mode-vs-context-mode/pi-1.1.0/dist/extensions/codemode/execute.js)；[agent-session.js](research_evidence/code-mode-vs-context-mode/pi-1.1.0/dist/core/agent-session.js) | 2026-10-11 读取并计算 SHA-256 | Tier 1 |

**一句话总结：Pi Code Mode 像“先算好再给模型看”，context-mode 还加了“放进资料柜，以后再查”。重合，但不等价。**
