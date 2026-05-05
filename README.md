# 虚拟焦点小组深度访谈系统 MVP

实验手册第一题的实现。让 AI 扮演不同人设的虚拟受访者，围绕产品概念展开多轮焦点小组讨论，自动生成访谈实录与洞察报告。

## 运行

```bash
cd focus-group-mvp
npm start
```

浏览器打开 [http://localhost:5173](http://localhost:5173)。

默认使用 `mino` 这个 OpenAI 兼容 provider。首次运行前请在 `config/api.config.local.json` 里填写自己的 API Key。
服务默认只监听本机 `localhost`；如需局域网访问，macOS/Linux 可用 `HOST=0.0.0.0 npm start`，PowerShell 可用 `$env:HOST='0.0.0.0'; npm start` 显式开启。

## 配置 API 与切换模型

配置分成两个文件：

- `config/api.config.json`：公开配置，保存 provider、endpoint、model，不放真实 Key。
- `config/api.config.local.json`：本机私有配置，只保存真实 API Key，已加入 `.gitignore`。

切换 provider 或模型时，修改 `config/api.config.json` 的 `active` / `endpoint` / `model`：

```json
{
  "active": "mino",
  "providers": {
    "mino": { "format": "openai", "endpoint": "...", "model": "mimo-v2.5-pro", "apiKey": "" }
  }
}
```

填写或更换 API Key 时，修改 `config/api.config.local.json`：

```json
{
  "providers": {
    "mino": {
      "apiKey": "sk-你的新Key"
    }
  }
}
```

支持 3 种 API 标准（`format` 字段）：

| format | 兼容厂商 |
|---|---|
| `openai` | OpenAI、DeepSeek、Kimi、Groq、智谱、通义、Mistral、OpenRouter 等 |
| `anthropic` | Anthropic Claude 原生 `/v1/messages` 接口 |
| `gemini` | Google Gemini 原生 `:generateContent` 接口 |

要接其他 OpenAI 兼容厂商，复制 `openai` 那条改 `endpoint` 和 `model` 即可。`config/api.config.json` 内 `_examples` 字段列了 6 家常用 OpenAI 兼容服务的完整 endpoint 可直接抄。

**改完一定要重启 server**（Ctrl+C → `npm start`）。启动横幅会显示当前 provider、model 和 key 是否加载成功。

## 文件结构

```text
focus-group-mvp/
├─ index.html               主页面（SPA：home / running）
├─ styles.css               界面样式（含 @media print 打印样式）
├─ app.js                   前端入口：流程编排 + 事件绑定
├─ app-state.js             state + 表单工具 + $ DOM 助手
├─ app-storage.js           localStorage 草稿与项目持久化
├─ app-api.js               postJson + showToast
├─ app-markdown.js          轻量 Markdown → HTML + escape
├─ app-render.js            persona / chat / evidence / report 渲染
├─ app-export.js            复制 Markdown + 导出 PDF（window.print）
├─ server.js                Node 后端入口（路由、初始化、静态服务）
├─ package.json
├─ README.md
├─ PROJECT_STRUCTURE.md     项目结构说明
├─ .gitignore
├─ config/
│  ├─ api.config.json                       公开 API 配置
│  ├─ api.config.local.json                 本机私有 API Key（gitignored）
│  ├─ search.config.json                    搜索工具公开配置
│  ├─ search.config.local.example.json      搜索 Key 模板
│  └─ search.config.local.json              本机搜索 Key（gitignored）
├─ lib/
│  ├─ config.js                  API / 搜索配置加载与合并
│  ├─ llm.js                     LLM 调用、JSON 修复、429 重试
│  ├─ search.js                  Tavily 搜索 client
│  ├─ context-engine.js          结构化上下文（contextState）
│  ├─ prompts.js                 Prompt 读取与模板渲染
│  ├─ http.js                    JSON 请求/响应（body 上限 8MB）
│  ├─ static.js                  静态文件服务 + 敏感路径屏蔽
│  ├─ validators.js              请求参数校验
│  ├─ focus-group-service.js     路由 handler + 主流程编排
│  ├─ text-utils.js              字符串清洗 + 并发工具
│  ├─ interview-profiles.js      主持风格 / 输出深度 profile
│  ├─ token-estimator.js         各阶段 token 上限估算
│  ├─ normalizers.js             受访者 / 主持指南 / 消息规范化
│  ├─ anonymizer.js              报告匿名化（R1/R2/…）
│  ├─ evidence-pack.js           evidencePack 规范化与注入
│  ├─ quick-fill.js              一句话项目扩写规范化
│  └─ report-builder.js          报告生成 + 截断续写
└─ prompts/
   ├─ persona-generator.md
   ├─ moderator-guide.md
   ├─ search-plan.md
   ├─ evidence-pack.md
   ├─ focus-group-session.md
   ├─ session-round.md
   ├─ moderator-turn.md
   ├─ participant-turn.md
   ├─ participant-state-updater.md
   ├─ report-analyst.md
   ├─ quick-fill.md
   ├─ quick-fill-search-plan.md
   ├─ moderator.md
   └─ participant.md
```

## 已实现功能

- 主界面 hero + 快捷输入（一句话生成项目，可叠加搜索增强）+ 详情表单 + 最近项目（localStorage）
- 运行视图：3 阶段进度条 + 受访者预览 + 主持指南 + 受访者立场记忆 + 真实耗时提示 + 失败重试
- 手动流程控制：受访者生成后暂停 → 选择「一步一轮」或「直接到位」→ 生成报告
- 直接到位模式可选搜索增强：先生成 evidencePack，再一次性跑完整场访谈
- 结果视图：受访者卡片 / 访谈实录 / Markdown 报告（可复制 / 导出 PDF）
- PDF 导出走浏览器原生 `window.print()`：文本可选可搜，跨平台中文一致
- 访谈生成采用 JSON 消息契约，避免依赖”姓名：发言”的脆弱文本解析
- 9 个 HTTP 端点（7 POST + 2 GET，见下方 API 端点）外加静态资源服务

## API 端点

- `POST /api/personas` 生成虚拟受访者
- `POST /api/moderator-guide` 生成主持指南与初始受访者立场记忆
- `POST /api/session` 一次性生成多轮访谈（直接到位模式）
- `POST /api/session/round` 生成单轮访谈（一步一轮模式）
- `POST /api/report` 生成 Markdown 洞察报告（一次性返回）
- `POST /api/report/stream` 流式生成洞察报告（NDJSON 事件，前端默认走这个）
- `POST /api/quick-fill` 一句话扩成完整项目配置
- `GET /api/health` 健康检查（含当前 provider / 搜索状态）
- `GET /api/config` 列出所有 provider 与 prompt 文件

## Prompt 模板

调整角色风格、报告结构或访谈节奏直接改 `prompts/` 下的 Markdown，无需改 `server.js`。
