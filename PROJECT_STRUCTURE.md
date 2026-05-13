# 项目结构说明

本文档说明当前项目中每个主要文件的职责，以及后续扩展功能时应该优先修改的位置。

## 顶层文件

```text
focus-group-mvp/
├─ server.js
├─ index.html
├─ styles.css
├─ app.js                  前端入口（流程编排 + 事件绑定）
├─ app-state.js            state + 表单 + $ 助手
├─ app-storage.js          localStorage 持久化
├─ app-api.js              postJson + showToast
├─ app-markdown.js         Markdown → HTML + escape
├─ app-render.js           persona / chat / evidence / report 渲染
├─ app-export.js           复制 + 导出 PDF（window.print）
├─ package.json
├─ README.md
├─ PROJECT_STRUCTURE.md
├─ .gitignore
├─ config/
├─ lib/
└─ prompts/
```

### `server.js`

Node HTTP 服务入口。

主要职责：

- 读取 API 配置并选择当前 provider。
- 初始化 prompt store、LLM client、焦点小组业务服务。
- 注册后端 API 路由。
- 提供 `/api/health` 和 `/api/config`。
- 提供静态文件服务入口。

原则：`server.js` 只做启动、路由和组装，不放具体业务逻辑。

### `app.js`

前端 SPA 入口（ES module）。

主要职责：

- 顶层流程编排：`startRun` / `runPersonasStage` / `runSessionAllAtOnce` / `runOneRound` / `runReportStage`
- 阶段控制：`setStage` / `setRunStatus` / 计时器 / `stageMeta` 文案
- 草稿恢复：`restoreDraftRunView` / `handleRecentClick`
- 资料包模态框：`openEvidencePackModal` / `closeEvidencePackModal`
- `init()` + DOM 事件绑定

副作用入口；导入下面 6 个模块的能力组合使用。

### `app-state.js`

应用状态与表单工具。

导出：`state`（mutable 单例对象）、`defaultData`、`fields`、`getConfig` / `getRawConfig` / `setConfig`、`clampNumber`、`buildTopics`、`getCompletedRoundCount`、`formatDate`、`$` DOM 助手。

跨模块共享 `state` 与 `$` 都从这里 import。

### `app-storage.js`

localStorage 草稿与项目持久化。

导出：`saveDraft` / `loadDraft`、`loadProjects` / `saveProjects` / `upsertProject` / `deleteProjectById` / `getProjectById` / `newProjectId`、`buildProjectSnapshot` / `persistCurrent` / `loadProjectIntoState`、`PROJECTS_CAP` / `RECENT_DISPLAY` 常量。

未来加 schemaVersion 做兼容迁移时改这里。

### `app-api.js`

`postJson(url, payload, { signal })` 与 `showToast(text)`。

加全局请求拦截、错误重试、loading 计数都改这里。

### `app-markdown.js`

轻量 Markdown → HTML：支持 `# / ## / ### / - / >`，转义所有内容防 XSS。

需要支持 `**bold**` / `*italic*` / 行内代码 / 链接 / 表格时改这里。

### `app-render.js`

纯 DOM 渲染，无副作用流程：

- `renderPersonaGrid` / `renderChatLog` / `renderEvidencePackHtml` / `renderRunReport`
- `updateEvidencePackButton` / `hasUsableEvidencePack` / `scrollChatPreviewToBottom`

依赖 `state`（颜色 index）和 `app-markdown` 的 `markdownToHtml` / `escapeHtml`。

### `app-export.js`

`copyReport`：把 Markdown 写入剪贴板。

`downloadReport`：在 `<body>` 上加 `printing-report` class（触发 `@media print` 隐藏侧栏/按钮、只保留 `#reportContent`），调用 `window.print()`，监听 `afterprint` 清理。打印对话框由浏览器提供，用户选「另存为 PDF」即可。

### `index.html`

单页应用 HTML 结构。

包含：

- 首页表单。
- 运行中视图。
- 受访者 / 实录 / 报告区块。
- 资料包模态框。
- 最近项目区域。

`app.js` 通过 `<script type="module">` 加载。

### `styles.css`

全站样式。

包含：

- 首页表单样式。
- 运行页阶段条、耗时提示、重试控制。
- 受访者卡片。
- 聊天实录。
- 报告页。
- 响应式样式。
- `@media print` 块：导出 PDF 时隐藏侧栏/按钮，只显示 `#reportContent`。

### `package.json`

项目元信息和启动脚本。

当前脚本：

```bash
npm start
```

实际执行：

```bash
node server.js
```

## `config/`

```text
config/
├─ api.config.json
├─ api.config.local.json
├─ search.config.json
├─ search.config.local.example.json
└─ search.config.local.json
```

### `config/api.config.json`

公开 API 配置。

保存：

- 当前 active provider。
- provider 名称。
- API endpoint。
- model。
- provider format。

不应该保存真实 API Key。

### `config/api.config.local.json`

本机私有配置。

保存真实 API Key，例如：

```json
{
  "providers": {
    "mino": {
      "apiKey": "你的真实 Key"
    }
  }
}
```

该文件已加入 `.gitignore`，后端会读取它并覆盖公开配置中的同名 provider 字段。

### `config/search.config.json`

公开搜索工具配置。

保存：

- 搜索工具是否启用。
- 当前 active search provider。
- 搜索 endpoint。
- 搜索深度和每次返回数量。

不应该保存真实搜索 API Key。

### `config/search.config.local.json`

本机私有搜索配置。

保存真实搜索 API Key，例如：

```json
{
  "enabled": true,
  "providers": {
    "tavily": {
      "apiKey": "tvly-YOUR_API_KEY"
    }
  }
}
```

可以参考 `config/search.config.local.example.json` 创建。`search.config.local.json` 已被 `.gitignore` 忽略；example 文件不含真实 Key，可提交到仓库。

## `lib/`

```text
lib/
├─ config.js                  API / 搜索配置加载
├─ llm.js                     LLM provider 调用
├─ search.js                  Tavily 搜索 client
├─ context-engine.js          结构化上下文（contextState）
├─ prompts.js                 Prompt 读取与模板渲染
├─ http.js                    JSON 请求/响应
├─ static.js                  静态文件服务
├─ validators.js              请求参数校验
├─ focus-group-service.js     路由 handler + 主流程编排
├─ text-utils.js              字符串工具 + mapWithConcurrency
├─ interview-profiles.js      默认访谈 / 报告规则 profile
├─ token-estimator.js         各阶段 token 上限估算
├─ normalizers.js             受访者 / 主持指南 / 消息规范化
├─ anonymizer.js              报告匿名化（R1/R2/…）
├─ evidence-pack.js           evidencePack 规范化与注入
├─ quick-fill.js              一句话项目扩写规范化
└─ report-builder.js          报告生成 + 截断续写
```

### `lib/config.js`

API 配置加载模块。

主要职责：

- 读取 `config/api.config.json`。
- 读取并合并 `config/api.config.local.json`。
- 读取并合并搜索工具配置 `config/search.config.json` / `config/search.config.local.json`。
- 构建 provider map。
- 解析当前 active provider。

后续新增 provider 或配置合并规则，优先改这里。

### `lib/llm.js`

LLM Provider 调用模块。

主要职责：

- OpenAI-compatible 调用。
- Anthropic 调用。
- Gemini 调用。
- JSON 模式请求。
- JSON 修复调用。
- SSE fallback 解析。
- 429 重试。
- AI 调用耗时日志。
- API Key / endpoint 就绪检查。

后续要加：

- 请求超时。
- 5xx 自动重试。
- 模型测速。
- provider 特定参数。

优先改这里。

### `lib/context-engine.js`

结构化上下文工程模块。

主要职责：

- 初始化和规范化 `contextState`。
- 维护项目背景、研究目标、核心假设。
- 维护每轮摘要、待追问问题、证据片段。
- 为主持人组装本轮上下文包。
- 为单个受访者组装个人记忆包和相关群体记忆。
- 为报告生成轮次记忆、证据账本和待验证问题。
- 预留 `externalFindings`，后续接搜索 API 或资料卡时使用。

原则：这里管理“模型应该看什么上下文”，不直接调用 LLM，不直接处理 HTTP。

### `lib/search.js`

搜索工具客户端模块。

主要职责：

- 读取搜索 provider 状态。
- 判断搜索工具是否可用。
- 调用 Tavily Search API。
- 控制搜索 query 数量和并发。
- 返回后端可整理成 `evidencePack` 的原始搜索结果。

### `lib/prompts.js`

Prompt 文件读取与模板渲染模块。

主要职责：

- 读取 `prompts/*.md`。
- 替换 `{{placeholder}}`。
- 列出可用 prompt 文件。

后续如果 prompt 需要版本管理或多语言模板，可以从这里扩展。

### `lib/focus-group-service.js`

焦点小组核心业务模块（约 980 行，工厂 + handler 编排）。

主要职责：

- 暴露工厂 `createFocusGroupService({ promptStore, llm, searchClient })`。
- 6 个路由 handler：
  - `POST /api/personas`：生成受访者。
  - `POST /api/moderator-guide`：生成主持指南和初始受访者立场记忆。
  - `POST /api/evidence-pack`：搜索增强开启时生成外部资料包，并注入 `contextState.externalFindings`。
  - `POST /api/session/round/stream`：流式生成单轮访谈，逐轮深访和极速完整访谈共用。
  - `POST /api/report/stream`：流式生成洞察报告，按 NDJSON 事件（`start` / `chunk` / `done` / `error`）推送，前端默认走这个端点。
  - `POST /api/quick-fill`：一句话补全项目配置（含搜索增强）。
- 逐轮深访编排：`generateDeepSessionRound` → 主持人开场 + 全员初始立场 + 受访者自由讨论 + 主持人判断收束 + 主持人小结，并并发更新立场记忆。
- 资料包获取：`buildEvidencePackForSession` / `buildQuickFillResearch`（依赖 `searchClient`）。
- 调用 `context-engine.js` 组装主持人、受访者和报告所需上下文。

不再放：

- 默认访谈 / 报告规则 profile（已搬到 `interview-profiles.js`）。
- 各类 normalize* 与 token 估算（已搬到 `normalizers.js` / `token-estimator.js`）。
- 报告续写（已搬到 `report-builder.js`）。
- evidencePack / quick-fill / 匿名化的纯工具函数（已分别搬到对应文件）。

### `lib/text-utils.js`

通用字符串与并发工具：`cleanGeneratedText`、`compactJson`、`truncateText`、`formatPromptTranscript`、`mapWithConcurrency`。被多个模块共用。

### `lib/interview-profiles.js`

默认访谈 / 报告规则 profile：`getStyleProfile`、`getDepthProfile`、`buildInterviewControls` 拼装到 prompt 模板的字段；不再保留可选风格或深度档位。

调追问规则、证据颗粒度或输出长度的字数区间，改这里。

### `lib/token-estimator.js`

各阶段的 `max_tokens` 估算：personas / moderator turn / participant turn / 报告。也含 `getParticipantParallelLimit`（默认 3，受 `FOCUS_GROUP_PARTICIPANT_PARALLELISM` 环境变量控制）。

模型上下文窗口变化或对长度容忍度变化时改这里。

### `lib/normalizers.js`

LLM 输出规范化：`normalizePersonas` / `normalizeModeratorGuide` / `normalizeParticipantStates` / `normalizeSessionMessages` / `extractMessageArray` / `splitPersonasForRound` 等。

加新字段或调整默认兜底值时改这里。

### `lib/anonymizer.js`

报告匿名化：把受访者真名替换成 `R1` / `R2` / …，递归处理 messages、participantStates、contextState。导出 `buildAnonymizedReportContext`。

### `lib/evidence-pack.js`

`evidencePack` 数据结构规范化、搜索 query / 来源卡片等通用字段清洗，以及把资料包来源摘要注入 `contextState.externalFindings`。

### `lib/quick-fill.js`

`/api/quick-fill` 用到的纯工具：搜索结果整理成 `quickFillResearch`、回退查询 `buildFallbackQuickFillQueries`、最终 `normalizeQuickFill` 输出。

### `lib/report-builder.js`

工厂 `createReportBuilder({ llm })` → 返回 `generateReportMarkdown(prompt, options)`。

内部含：

- `shouldContinueReport`：检测末尾断句 / 缺尾标 / 缺结尾章节。
- `buildReportContinuationPrompt` + `mergeReportContinuation`：自动续写 + 重叠去重。
- 最多续写 2 次。

### `lib/http.js`

HTTP 请求/响应工具。

主要职责：

- 读取 JSON request body（上限 8MB）。
- 返回 JSON response。
- 抛 `HttpError(413)` 当 body 过大。

### `lib/static.js`

静态文件服务模块。

主要职责：

- 返回 `index.html`、`app.js`、`styles.css` 等静态资源。
- 阻止浏览器访问 `config/`。
- 阻止访问隐藏文件和 `.local.json`。

### `lib/validators.js`

请求参数校验模块。

主要职责：

- 定义 `HttpError`。
- 校验项目配置。
- 校验数组、字符串、正整数等基础参数。
- 让错误请求返回 400，而不是进入模型调用。

## `prompts/`

```text
prompts/
├─ persona-generator.md
├─ moderator-guide.md
├─ search-plan.md
├─ evidence-pack.md
├─ moderator-turn.md
├─ participant-turn.md
├─ participant-state-updater.md
├─ report-analyst.md
├─ quick-fill.md
├─ quick-fill-search-plan.md
└─ round-facilitator-decision.md
```

### `persona-generator.md`

生成虚拟受访者。

输出：

- 基础画像。
- 细分类型。
- 一句话背景。
- 当前替代方案。
- 转换触发。
- 价格锚点。
- 证据门槛。
- 讨论角色、顾虑和说话风格。

### `moderator-guide.md`

生成主持指南。

输出：

- 研究目标。
- 核心假设。
- 每轮目标。
- 每轮关键问题。
- 必须追问点。
- 浅回答识别信号。
- 追问策略。

### `search-plan.md`

网络搜索增强使用。根据项目配置和访谈议题生成搜索计划，输出搜索 query、用途和类型。

### `evidence-pack.md`

网络搜索增强使用。把搜索 API 的结果整理成结构化 `evidencePack`，包括来源卡片、可核查事实、用户信号、竞品/替代方案、购买阻力和访谈需验证问题。

### `moderator-turn.md`

逐轮深访中的主持人发言。

用于：

- 开场主问题。
- 本轮小结。

会读取：

- 主持指南。
- 受访者立场记忆。
- 前几轮上下文。
- 本轮当前实录。
- 结构化轮次记忆、未追问问题、证据片段。

### `participant-turn.md`

逐轮深访中的受访者回应和自由讨论。

用于让指定受访者围绕主持人的引导、其他受访者观点或本轮分歧继续讨论。

会强调：

- 直接回答问题。
- 具体场景。
- 替代方案比较。
- 购买/拒绝条件。
- 回应其他受访者观点。
- 当前受访者自己的记忆包和相关群体记忆。

### `participant-state-updater.md`

每轮结束后更新受访者立场记忆。

输出：

- 当前态度。
- 已提过顾虑。
- 购买条件。
- 明确阻力。
- 需要证据。
- 矛盾点。
- 具体例子、替代方案、可引用原话、后续追问问题。
- 本轮观点变化。

### `report-analyst.md`

生成 Markdown 洞察报告。

会读取：

- 项目信息。
- 访谈记录。
- 主持指南。
- 受访者最终立场记忆。
- 结构化上下文：轮次记忆、待验证问题、证据片段。
- 外部资料包：来源卡片、市场信号、购买阻力。

### `quick-fill.md`

把一句产品想法扩写为完整项目配置。如果搜索工具启用，会先经过 `quick-fill-search-plan.md` 生成 1–4 条查询，再把搜索结果作为参考喂给本 prompt。

### `quick-fill-search-plan.md`

为 `/api/quick-fill` 生成搜索查询计划。仅当搜索工具启用时使用；失败会回退到 `buildFallbackQuickFillQueries` 给出的默认查询。

### `round-facilitator-decision.md`

后台主持人判断本轮是否继续自由讨论，输出下一波发言者、讨论焦点或收束信号。

## 当前数据流

### 逐轮深访模式

```text
前端 startRun
  -> /api/personas
  -> /api/moderator-guide
  -> 用户选择逐轮深访
  -> /api/session/round/stream
       -> 主持人开场
       -> 全员初始立场
       -> 受访者自由讨论
       -> 主持人后台判断是否继续
       -> 主持人小结
       -> 更新受访者立场记忆
       -> 更新 contextState
  -> 多轮重复
  -> /api/report/stream（流式逐段返回 Markdown）
```

### 极速完整访谈模式

```text
前端 startRun
  -> /api/personas
  -> /api/moderator-guide
  -> 如果勾选网络搜索增强：/api/evidence-pack
  -> 自动连续调用 /api/session/round/stream
       -> 每轮消息按 NDJSON 事件逐批推送到前端
       -> 每轮更新受访者立场记忆和 contextState
  -> /api/report/stream（流式逐段返回 Markdown）
```

## 后续扩展建议

### 接搜索 API

推荐流程：

```text
搜索 API -> evidencePack -> 主持人读取 evidencePack -> 受访者基于个人经验回应
```

不要让每个受访者随意搜索，否则会变成“专家访谈”，不像消费者焦点小组。
当前搜索有两条用途：`/api/quick-fill` 用于一句话项目扩写；`/api/evidence-pack` 用于极速完整访谈前整理外部资料包，并把来源摘要写入 `contextState.externalFindings`，再由主持人围绕事实卡片引导受访者讨论。

### 前端模块化

已实施。前端从单文件 2100+ 行 `app.js` 拆成 7 个 ES module（`app.js` 入口 + `app-state` / `app-storage` / `app-api` / `app-markdown` / `app-render` / `app-export`），通过 `<script type="module">` 加载，零构建步骤、零外部依赖。

后续如果继续增长（资料卡、引用来源、可视化分析），可以再按职责拆分新模块；不需要再做"单文件拆分"的工作。

### 数据版本

建议后续给保存的项目加：

```js
schemaVersion: 2
```

这样旧草稿恢复时可以做兼容迁移。
