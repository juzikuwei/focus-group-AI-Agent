# Focus Lab - 虚拟焦点小组深度访谈系统

Focus Lab 是一个基于大模型的虚拟焦点小组访谈工具。用户输入产品概念、核心卖点、目标人群和访谈议题后，系统会自动生成受访者画像、主持人提纲、多轮访谈对话和结构化洞察报告。

当前版本已经移除登录、注册和数据库依赖，打开后即可使用。项目数据保存在浏览器本地 `localStorage` 中，不需要 MySQL、账号系统或后端数据库。

## 主要功能

- 快速生成项目：用一句话描述产品想法，自动补全产品概念、卖点、目标受众和访谈问题。
- 受访者生成：根据研究目标生成多个差异化虚拟受访者画像。
- 主持人提纲：自动生成访谈主持流程和追问方向。
- 多轮焦点小组访谈：支持一次性运行完整访谈，也支持逐轮推进。
- 联网资料增强：可选 Tavily 搜索，在访谈前补充外部资料。
- 洞察报告生成：基于访谈记录输出结构化 Markdown 报告。
- 项目历史：项目草稿和已完成报告保存在浏览器本地，可恢复、查看、重跑或编辑。
- 多模型支持：支持 OpenAI 兼容接口、Anthropic Claude、Google Gemini 等模型格式。

## 技术栈

- 前端：原生 HTML / CSS / JavaScript ES Modules
- 后端：FastAPI / Uvicorn
- LLM 编排：LangChain
- 存储：浏览器 `localStorage`
- 模型接口：
  - OpenAI-compatible Chat Completions
  - Anthropic Messages API
  - Google Gemini Generate Content API
- 可选搜索：Tavily Search API

## 快速启动

### Windows 双击启动

在项目根目录直接双击：

```text
双击启动.bat
```

它只负责启动本地服务端口，并自动打开浏览器访问 `http://127.0.0.1:5173`。使用期间保持弹出的命令行窗口打开即可，关闭窗口或按 `Ctrl+C` 会停止服务。

如果是第一次运行项目，请先安装依赖：

```bash
pip install -r requirements.txt
```

### 1. 环境要求

需要 Python 3.10 或更高版本。

```bash
python --version
```

### 2. 克隆项目

```bash
git clone https://github.com/juzikuwei/focus-group-AI-Agent.git
cd focus-group-AI-Agent
```

### 3. 安装 Python 依赖

建议先创建虚拟环境：

```bash
python -m venv .venv
```

Windows PowerShell：

```powershell
.\.venv\Scripts\Activate.ps1
```

macOS / Linux：

```bash
source .venv/bin/activate
```

安装后端依赖：

```bash
pip install -r requirements.txt
```

### 4. 配置模型 API Key

推荐创建本地配置文件：

```bash
cp config/api.config.json config/api.config.local.json
```

然后编辑 `config/api.config.local.json`，把 `active` 改成要使用的供应商，并填写对应 provider 的 `apiKey`。

示例：

```json
{
  "active": "deepseek",
  "providers": {
    "deepseek": {
      "format": "openai",
      "endpoint": "https://api.deepseek.com/v1/chat/completions",
      "model": "deepseek-chat",
      "apiKey": "你的 API Key"
    }
  }
}
```

`config/*.local.json` 已加入 `.gitignore`，不会被提交到 GitHub。

### 5. 启动服务

```bash
python run_backend.py
```

默认访问：

```text
http://localhost:5173
```

如果 5173 端口被占用，可以指定端口：

```bash
PORT=5174 python run_backend.py
```

Windows PowerShell：

```powershell
$env:PORT=5174; python run_backend.py
```

如果你习惯使用 npm，也可以执行：

```bash
npm start
```

这个命令内部同样启动 FastAPI 后端。

## 模型配置说明

全局模型配置位于：

```text
config/api.config.json
```

本地私有配置建议放在：

```text
config/api.config.local.json
```

支持的 provider 包括：

- `openai`
- `deepseek`
- `moonshot`
- `groq`
- `zhipu`
- `qwen`
- `openrouter`
- `mimo`
- `anthropic`
- `gemini`

每个 provider 的核心字段：

```json
{
  "format": "openai",
  "endpoint": "https://api.example.com/v1/chat/completions",
  "model": "model-name",
  "apiKey": "your-key"
}
```

字段含义：

- `format`：接口格式，可选 `openai`、`anthropic`、`gemini`。
- `endpoint`：模型接口地址。
- `model`：模型名称。
- `apiKey`：模型 API Key，建议只写在 `.local.json` 文件里。

也可以在应用里的“个人中心”填写 API 配置。该配置只保存在当前浏览器本地，会通过请求头临时传给后端，不写入数据库。

## 联网搜索配置

联网搜索配置位于：

```text
config/search.config.json
```

如需启用 Tavily，建议创建：

```text
config/search.config.local.json
```

示例：

```json
{
  "enabled": true,
  "active": "tavily",
  "providers": {
    "tavily": {
      "apiKey": "你的 Tavily API Key"
    }
  }
}
```

如果不配置搜索，核心访谈和报告功能仍然可以使用。

## 数据保存方式

当前版本不使用数据库。

项目数据保存在浏览器本地：

```text
localStorage
```

这意味着：

- 刷新页面不会丢失当前浏览器里的项目。
- 换浏览器或换电脑不会自动同步项目。
- 清理浏览器缓存或站点数据可能会删除项目历史。
- 不需要登录，也没有用户隔离。

相关本地存储 key：

- `focus-group-mvp:config`：当前表单草稿。
- `focus-group-mvp:projects`：项目历史记录。
- `focus-group-local-settings`：浏览器本地 API 配置。

## 项目结构

```text
.
├── index.html                 # 前端页面
├── styles.css                 # 页面样式
├── app.js                     # 前端主入口
├── app-api.js                 # API 请求和本地设置请求头
├── app-state.js               # 前端状态和表单配置
├── app-storage.js             # localStorage 项目保存
├── app-render.js              # 页面渲染
├── app-markdown.js            # Markdown 渲染辅助
├── app-export.js              # 报告复制和下载
├── run_backend.py             # FastAPI 启动入口
├── backend/
│   ├── __init__.py
│   └── main.py                # FastAPI 路由、LangChain 模型调用和静态文件服务
├── config/
│   ├── api.config.json        # 模型供应商配置模板
│   └── search.config.json     # 搜索供应商配置模板
├── prompts/                   # 大模型提示词模板
├── requirements.txt           # Python 后端依赖
└── package.json               # npm start 兼容入口
```

## 常用命令

启动：

```bash
python run_backend.py
```

检查后端语法：

```bash
python -m py_compile backend/main.py run_backend.py
```

检查主要前端模块语法：

```bash
node --check app.js
node --check app-api.js
node --check app-storage.js
```

查看 Git 状态：

```bash
git status
```

## 常见问题

### 1. 页面能打开，但生成时报 API Key 缺失

检查 `config/api.config.local.json` 是否存在，或者在页面“个人中心”里填写 API Key。

如果使用配置文件，改完后需要重启服务：

```bash
python run_backend.py
```

### 2. 端口 5173 被占用

换一个端口启动：

```powershell
$env:PORT=5174; python run_backend.py
```

然后访问：

```text
http://localhost:5174
```

### 3. 历史项目不见了

项目历史保存在浏览器本地。如果更换浏览器、清理站点数据或使用无痕模式，历史项目不会保留。

### 4. 不想使用联网搜索

不用配置 `search.config.local.json` 即可。页面里的搜索增强不可用时，系统仍然可以正常生成受访者、访谈和报告。

### 5. 可以部署到服务器吗

可以，但当前版本没有登录和数据库，所有项目历史仍保存在访问者自己的浏览器里。如果需要多人协作、云端保存或账号隔离，需要重新接入数据库和认证系统。

## 安全说明

- 不要把真实 API Key 写入 `config/api.config.json` 后提交。
- 推荐把真实密钥写入 `config/api.config.local.json`，该文件已被 `.gitignore` 排除。
- 页面“个人中心”保存的 API Key 位于当前浏览器本地，不会写入服务端数据库。
- 当前版本没有账号权限控制，不适合作为多用户生产系统直接开放。

## 版本说明

当前上传版本：

- 移除了登录和注册功能。
- 移除了 MySQL、JWT、bcrypt 等数据库和认证依赖。
- 后端迁移为 FastAPI。
- 模型调用迁移为 LangChain。
- 项目数据改为浏览器本地保存。
- 保留模型配置、访谈生成、报告生成和可选搜索增强。
