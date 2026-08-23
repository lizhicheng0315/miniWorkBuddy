# 🧭 WorkBuddy 本地智能助手

仿照 WorkBuddy 思路的个人本地助手，覆盖三件事：

- **待办（Todos）**：增删改查、优先级左色条、相对截止时间、快速添加条
- **日程（Schedule）**：具体时间点事件，提前 N 分钟弹 Windows 通知
- **每日定时提醒（Reminders）**：用 cron 表达式配置任意重复节奏
- **智能能力**：通过 OpenAI 兼容 LLM（DeepSeek / 通义千问 / Moonshot / 自部署均可）生成今日摘要、任务建议、**任务拆解**、今日日报、**本周周报**、**月度复盘**

数据保存在本地 **SQLite** 文件（`./data/workbuddy.db`，通过 sql.js 纯 WASM 引擎），支持完整**备份 / 导入**。

## ✨ 核心特性

### 🤖 Agent 式对话（核心界面）
- **自然语言管理一切**：「明天下午3点开周会」「提醒我买牛奶」「每天9点写日报」「把买牛奶标记完成」
- **Plan-then-Execute Agent 循环**：复合任务一句话完成——「创建待办'写周报'并每天9点提醒我」自动拆成两步工具调用
- **可插拔工具注册表**：20+ 内置工具（待办/日程/提醒/日报/PPT/搜索），新增能力只需在 `TOOLS` 注册表加一项
- **真流式输出**：LLM token 级 SSE 增量 + 打字机光标 + 节流渲染（长回复不卡顿）
- **可见工具转录**：助手每执行一步操作，聊天里实时显示 🔧 步骤条（MiniCode transcript 风格）

### 🌐 联网搜索
- 对话里说「查一下XX」「XX是什么」自动触发
- 多引擎降级链：Bing API（可选 key）→ **Bing HTML**（cn.bing.com 国内免key直连）→ DuckDuckGo
- 搜索结果由 LLM 汇总成带来源链接的回答
- 对话右上角「联网」开关随时启停

### 📊 PPT 助理（ppt-master 方法论）
```
你: 帮我做一份"Q3工作汇报"的PPT
🤖 ⛔ 生成大纲等你确认 → ✏️ 「第2页改成…」「加一页讲XX」（LLM现场改写）
你: 确认
🤖 🎨 选主题：商务蓝/极简白/科技黑/活力橙
你: 商务蓝
🤖 🎉 原生 .pptx 导出 → 聊天内点击下载卡片获取文件
```
- 右侧 **16:9 实时预览面板**：主题色实时渲染、缩略图翻页
- 中文数字页码识别：「第四页改为…」✅
- 下载用 10 分钟一次性签名票据，无需暴露登录态

### 🗣️ 语音模式
- 🔊 语音播报：AI 回复自动 TTS 朗读（中文）
- 🎤 语音输入：Web Speech API 听写，说完再点一次即发送

### 💬 会话历史
- 左栏会话列表：SQLite 持久化、首条消息自动命名、点击回放完整记录
- 新建 / 删除 / 当前高亮，刷新页面恢复上次会话

### 🔗 团队 IM 对接
飞书 / 企业微信 / 钉钉 自定义机器人 webhook 推送（支持飞书/钉钉加签），配置页一键测试。

### 📈 Token 用量统计
按天/模型统计，指标卡 + SVG 平滑曲线图，数据落库可回溯。

## 🛠️ 技术栈

- Node.js 18+（已在 v24.9.0 测试）
- Express 4
- node-cron（定时调度）
- node-notifier（Windows 系统通知 + 提示音）
- openai（OpenAI 兼容 LLM 客户端，自带指数退避重试 + 超时）
- **sql.js**（SQLite WASM 引擎，零原生编译）
- **pptxgenjs**（原生 .pptx 生成，纯 JS）
- 原生 HTML/CSS/JS（无前端构建步骤）

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 准备环境变量
copy .env.example .env
# 编辑 .env，把 LLM_API_KEY 改成你真实的 key

# 3. 启动
npm start

# 4. 浏览器打开
# http://localhost:3000
```

启动后日志会显示：

```
[INFO] SQLite created in memory (will persist on first write)
[INFO] scheduler loaded 0 reminder(s)
[INFO] WorkBuddy 助手已启动 → http://localhost:3000
[INFO] LLM 状态: 已启用 (deepseek-chat)
[INFO] 数据目录: E:\project\dsh\data
```

## ⚙️ 配置项（`.env`）

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | Web 服务端口 | `3000` |
| `DATA_DIR` | 数据目录（SQLite 文件 + 备份） | `./data` |
| `TZ` | 时区 | `Asia/Shanghai` |
| `LLM_BASE_URL` | OpenAI 兼容 baseURL | `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | **必填** LLM 密钥 | — |
| `LLM_MODEL` | 模型名 | `deepseek-chat` |
| `NOTIFY_SOUND` | 是否播放系统提示音 | `true` |
| `BING_SEARCH_KEY` | 可选：Bing Web Search API key（不配则用 Bing HTML/DuckDuckGo） | — |

### 接入其他 LLM

把 `LLM_BASE_URL` 改成对应服务的根地址即可，常见选项：

- **DeepSeek**：`https://api.deepseek.com/v1`，模型 `deepseek-chat`
- **Moonshot (Kimi)**：`https://api.moonshot.cn/v1`，模型 `moonshot-v1-8k`
- **OpenAI**：`https://api.openai.com/v1`，模型 `gpt-4o-mini`
- **自部署 vLLM / Ollama**：`http://localhost:11434/v1`

## 📡 REST API

### 基础

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查（含 DB 类型） |
| `GET / POST / PATCH / DELETE` | `/api/todos[/:id]` | 待办 CRUD |
| `GET / POST / PATCH / DELETE` | `/api/schedule[/:id]` | 日程 CRUD |
| `GET / POST / PATCH / DELETE` | `/api/reminders[/:id]` | 提醒 CRUD |
| `POST` | `/api/reminders/:id/toggle` | 启用/停用提醒 |
| `GET` | `/api/reminders/cron-validate?expr=...` | 校验 cron 表达式 |

### AI

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/ai/status` | LLM 是否配置 |
| `POST` | `/api/ai/summarize` | 今日摘要 |
| `POST` | `/api/ai/advise`  body: `{task}` | 任务建议 |
| `POST` | `/api/ai/breakdown`  body: `{task}` | 任务拆解（返回 JSON 步骤） |
| `POST` | `/api/ai/daily-report` | 今日日报 |
| `POST` | `/api/ai/weekly-report` | 本周周报 |
| `POST` | `/api/ai/monthly-review` | 月度复盘 |
| `GET` | `/api/ai/usage?days=7` | Token 用量统计（admin） |
| `POST` | `/api/ai/search`  body: `{query}` | 联网搜索 |
| `POST` | `/api/ai/chat/stream` | SSE 流式对话（真 token 级增量） |

### PPT 助理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/ppt/draft` | 当前用户 PPT 草稿 |
| `GET` | `/api/ppt/download/t/:ticket` | 票据下载 .pptx（10 分钟有效） |

### 会话历史

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET / POST` | `/api/chathistory/sessions` | 会话列表 / 新建 |
| `GET / POST` | `/api/chathistory/sessions/:id/messages` | 回放消息 / 追加消息 |
| `PATCH / DELETE` | `/api/chathistory/sessions/:id` | 重命名 / 删除会话 |

### 对接配置

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET / POST` | `/api/integrations` | 渠道列表（webhook 脱敏）/ 创建更新 |
| `PATCH` | `/api/integrations/:id/enabled` | 启用/停用 |
| `POST` | `/api/integrations/:id/test` | 测试推送 |
| `DELETE` | `/api/integrations/:id` | 删除渠道 |

### 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/auth/login`  body: `{username, password}` | 登录拿 token |
| `POST` | `/api/auth/logout` | 登出（销毁 session） |
| `GET` | `/api/auth/me` | 当前用户信息（需 token） |
| `POST` | `/api/auth/change-password`  body: `{old_password?, new_password}` | 改密码 |
| `POST` | `/api/auth/register` | **admin only** 创建新用户 |
| `GET` | `/api/auth/users` | **admin only** 列出用户 |

### 备份

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/backup/export` | 导出当前用户数据为 JSON（自动下载） |
| `GET` | `/api/backup/stats` | 当前用户数据统计 |
| `POST` | `/api/backup/import`  body: `snapshot + {mode}` | 导入备份，`mode: replace` 覆盖 / `merge` 合并 |

### 可观测性

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 简单存活检查（公开） |
| `GET` | `/api/stats` | 丰富运行时状态（DB 大小 / 用户数 / 提醒数 / session / LLM / TLS） |
| `GET` | `/api/stats/metrics` | Prometheus 风格指标（**admin only**） |

## ⏰ cron 表达式速查

5 段：`分 时 日 月 周`

| 表达式 | 含义 |
|---|---|
| `0 9 * * *` | 每天 9:00 |
| `0 9 * * 1-5` | 每个工作日 9:00 |
| `*/30 9-18 * * *` | 9-18 点每 30 分钟 |
| `0 9 * * 1` | 每周一 9:00 |
| `0 0 1 * *` | 每月 1 号 0:00 |

## 🔔 提醒触发方式

- **Windows 系统通知**：通过 `node-notifier` 调用 Windows Toast
- **提示音**：用 PowerShell 调 `System.Media.SystemSounds.Exclamation` 播放
- **控制台回显**：服务日志会同时打印，便于排查
- **日程提前提醒**：服务每分钟扫描一次"未来 24 小时内未触发的日程"，按 `remind_before_min` 提前弹窗

## 🔁 LLM 重试 / 超时机制

- **超时**：单次请求 30 秒（AbortController）
- **重试**：最多 3 次，指数退避（500ms / 1000ms / 2000ms）
- **重试条件**：5xx / 408 / 429 / 网络错误；4xx 业务错误不重试，立即返回
- **响应字段**：成功时 `attempts: N` 表示总共尝试次数

## 🗄 数据存储

- 单文件 SQLite：`./data/workbuddy.db`（首次写入自动持久化）
- WASM 文件：`./data/sql-wasm.wasm`（首次启动自动从 `node_modules` 复制）
- 4 张表：`todos` / `schedule_events` / `reminders` / `settings`
- 备份导出格式：包含 `version / exported_at / tables.*` 的 JSON 快照

## 📂 项目结构

```
dsh/
├── server.js                # 入口（async main 启动）
├── package.json
├── .env.example
├── public/                  # 前端静态文件（无构建）
│   ├── index.html
│   ├── app.js               # 对话/待办/PPT预览/历史栏 全部交互
│   ├── styles.css           # 蓝白主题
│   └── sw.js                # PWA Service Worker
├── src/
│   ├── config.js
│   ├── db.js                # sql.js 数据层 + 备份快照 + 迁移
│   ├── logger.js
│   ├── routes/
│   │   ├── todos.js / schedule.js / reminders.js / backup.js
│   │   ├── ai.js            # SSE 流式对话 + 用量统计
│   │   ├── integrations.js  # 飞书/企微/钉钉对接配置
│   │   ├── ppt.js           # 草稿查询 + 票据下载
│   │   └── chathistory.js   # 会话历史 CRUD
│   └── services/
│       ├── notifier.js / scheduler.js / backup.js
│       ├── llm.js           # 带重试+超时的 LLM 客户端（chat/chatStream/getClient）
│       ├── ai.js            # LLM 业务逻辑（日报/周报/拆解…）
│       ├── nlp.js           # TOOLS 工具注册表 + Agent Plan-then-Execute 循环
│       ├── websearch.js     # Bing HTML → DuckDuckGo 多引擎降级搜索
│       ├── ppt.js           # PPT 草稿状态机 + pptxgenjs 导出
│       ├── integration.js   # IM webhook 推送（加签支持）
│       └── chatstore.js     # 会话历史持久化
├── scripts/
│   ├── smoke.js             # 端到端 API 测试（12 场景）
│   ├── test-agent.js        # Agent 工具循环 mock 测试
│   ├── test-markdown.js     # Markdown 渲染 + XSS 防护测试（11 例）
│   ├── test-ppt.js          # PPT 导出真实文件测试
│   └── test-pageno.js       # 中文数字页码测试
└── data/                    # 运行后自动创建
    ├── workbuddy.db
    └── ppt/                 # 生成的 PPTX 文件
```

## 🧪 测试

```bash
# 端到端（12 个场景）：多用户隔离 / 限流 / 指标 / SSE / 登录失败计数 / 备份
node scripts/smoke.js

# LLM 重试逻辑单测（isRetryable + 集成重试链路）
node scripts/test-retry.js

# NLP 对话单测
node scripts/test-nlp.js

# Agent 工具循环（mock LLM 决策，验证多步工具调用）
node scripts/test-agent.js

# Markdown 渲染 + XSS 防护（11 例）
node scripts/test-markdown.js

# 中文数字页码识别（第三页→3）
node scripts/test-pageno.js

# PPT 真实导出（生成合法 .pptx 并校验 ZIP 头）
node scripts/test-ppt.js
```

## 🤖 LLM Key 怎么获取

WorkBuddy 用的是 **OpenAI 兼容协议**（不是非要 OpenAI 官方），推荐 3 个国内可用 + 1 个国外：

| 服务 | 申请地址 | 模型示例 | 说明 |
|---|---|---|---|
| **DeepSeek** | <https://platform.deepseek.com> | `deepseek-chat` | 推荐，1 元起充、速度快、中文好 |
| **Moonshot (Kimi)** | <https://platform.moonshot.cn> | `moonshot-v1-8k` | 长上下文 |
| **通义千问 DashScope** | <https://dashscope.aliyun.com> | `qwen-turbo` | 阿里云 |
| OpenAI | <https://platform.openai.com> | `gpt-4o-mini` | 国外信用卡 |

**自部署（Ollama / vLLM / LM Studio）**：
```ini
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=anything
LLM_MODEL=qwen2.5:7b
```

### 三种配置方式（按推荐度）

**1. 启动前**：编辑 `.env`
```ini
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-你的真实key
LLM_MODEL=deepseek-chat
```

**2. 启动后**：在浏览器 "智能助手" Tab 底部 "⚙️ LLM 配置" 直接填 → 保存 → 点 "测试连接"

**3. 不配置 LLM**：脱机降级模式自动启用（关键词匹配）

### 🧠 意图识别架构（默认 LLM 优先）

- **LLM 已配置**：所有消息先走 LLM 分类/Agent 规划；本地正则规则仅在 LLM 调用失败时兜底
- **LLM 未配置**：自动降级为本地关键词规则（增删改查待办/日程/提醒均可，无需任何 key）
- Agent 判定 unknown → 直接由 LLM 闲聊兜底，不会生硬回复"没听懂"

### 🌐 联网搜索

对话里直接说「查一下XX」「搜索XX」「XX是什么」即可触发联网搜索：

- 引擎降级链：**Bing API**（配 `BING_SEARCH_KEY` 时优先）→ **Bing HTML**（cn.bing.com，国内免 key 直连，默认主力）→ DuckDuckGo
- 有 LLM key 时：搜索 → LLM 汇总成一段可读回答 + 来源链接
- 无 LLM key 时：直接列出搜索结果标题/摘要/链接
- 对话右上角「联网」开关随时启停

## 🔐 多用户 & 安全

- 启动时若没有任何用户，自动 `bootstrap` 一个 admin（用户名/密码从 `.env` 读）
- 密码用 Node 内置 `crypto.scrypt` 哈希（PBKDF2/scrypt 比 bcrypt 简单且无 native 依赖）
- Token = 32 字节随机 hex，存 `sessions` 表，默认 7 天有效；剩余 < 1 天时自动续期
- 登录失败 5 次/15 分钟会被锁定（同一用户名）
- API 限流：默认 300 次/分钟/IP；登录端点单独限流 20 次/15 分钟
- 所有 API 默认要求 Bearer token（除 `/api/health`、`/api/stats`、`/api/auth/login`）

### 注册新用户

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"alice123"}'
```

## 🔒 HTTPS（自签证书 / 本地用）

```bash
# Windows
scripts\gen-cert.bat

# macOS / Linux
./scripts/gen-cert.sh
```

然后在 `.env` 设置 `TLS_ENABLED=true`，重启服务即可走 `https://localhost:3000`。

## 🛡 生产部署

### Windows 服务（用 NSSM）

```powershell
# 1. 下载 NSSM: https://nssm.cc/download
# 2. 在管理员 PowerShell 中：
nssm install WorkBuddy "C:\Program Files\nodejs\node.exe" "E:\project\dsh\server.js"
nssm set WorkBuddy AppDirectory "E:\project\dsh"
nssm set WorkBuddy AppEnvironmentExtra "BOOTSTRAP_PASSWORD=你的密码" "LLM_API_KEY=sk-xxx"
nssm set WorkBuddy AppStdout "E:\project\dsh\data\logs\service.out.log"
nssm set WorkBuddy AppStderr "E:\project\dsh\data\logs\service.err.log"
nssm set WorkBuddy Start SERVICE_AUTO_START
nssm start WorkBuddy
```

### 监控

```bash
# 健康 + 运行时状态
curl http://localhost:3000/api/stats

# Prometheus 抓取（admin token）
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/stats/metrics
```

返回示例：
```
workbuddy_uptime_seconds 1234
workbuddy_users_total 3
workbuddy_todos_open 7
workbuddy_sessions_active 2
workbuddy_reminders_enabled 4
```

### 请求日志

默认写入 `data/logs/access-YYYY-MM-DD.log`（JSON Lines），每天一个文件。控制台同步彩色输出。可通过 `LOG_TO_FILE=false` 关闭。

## 📦 打包成单文件 .exe

用 [@yao-pkg/pkg](https://github.com/yao-pkg/pkg) 把整个项目打成单文件可执行（**不依赖 Node 环境**，双击即用）。

### 一次打包

```bash
# 1. 安装 pkg 工具（首次）
npm install --save-dev @yao-pkg/pkg

# 2. 打包当前平台
npm run build

# 输出：dist/workbuddy-win-x64.exe（约 70MB）
```

### 跨平台打包（在某平台打某平台）

```bash
# 在 macOS 上打 Windows
npm run build -- --target win-x64
# 在 Windows 上打 macOS
npm run build -- --target macos-arm64
```

> ⚠️ pkg 默认产物体积约 60-90MB（内嵌 Node 18 运行时 + sql.js WASM + 全部依赖）

### 用户分发包

最终给用户一个目录即可：

```
WorkBuddy/
├── workbuddy.exe          # 主程序
├── start.bat              # 一键启动（可选）
├── data/                  # 首次启动自动创建
└── README.txt
```

**用户使用方式**：

1. 双击 `workbuddy.exe`（或 `start.bat`）
2. 弹出 Windows Toast 通知「服务已启动」
3. 自动打开浏览器到 `http://localhost:3000`
4. 第一次使用：`admin` / 首次启动会**打印随机密码到控制台窗口**，登录后立即改密码
5. 系统托盘图标右键菜单：打开主页 / 打开数据目录 / 退出

### CLI 参数

```bash
# 自定义数据目录
workbuddy.exe --userdata D:\WorkBuddyData

# 不自动打开浏览器
workbuddy.exe  # （设置环境变量 WORKBUDDY_NO_BROWSER=1）

# 不启动托盘
workbuddy.exe  # （设置环境变量 WORKBUDDY_NO_TRAY=1）
```

### 内嵌 .env

打包后无法编辑 `.env`？两种方案：

**A. 环境变量**（推荐）：在系统环境变量里设 `LLM_API_KEY=sk-xxx`、`BOOTSTRAP_PASSWORD=yourpass`

**B. 旁挂 .env**：把 `.env` 放到 `workbuddy.exe` 同目录，`dotenv` 会自动加载

### 升级用户数据

新版本发布后，用户只需：
1. 备份 `data/` 目录
2. 用新 .exe 覆盖旧的
3. 启动 → 自动加载旧 SQLite 数据

数据库结构变更时，迁移在 `migrate()` 函数里**幂等执行**（`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` try/catch），无需手动脚本。

## 🆚 一些设计选择

- **为什么用 `sql.js` 而不是 `better-sqlite3`？** 部分环境（受限沙箱 / 容器 / 无 MSVC）下 `better-sqlite3` 无法原生编译；`sql.js` 是 SQLite 官方维护的 WASM 版，零编译，SQL 语法 100% 兼容，序列化到本地 `.db` 文件保持兼容性。需要换回原生版时只需改 `src/db.js` 一个文件。
- **为什么用 `OpenAI` 官方 SDK？** 它走 OpenAI 兼容协议，覆盖 90% 的国产 LLM 服务；切换服务商只改 baseURL。
- **为什么把重试做在客户端而不是 SDK 默认？** OpenAI SDK v4 内置 maxRetries 不能区分 4xx/5xx；我们做更精确的指数退避。
- **为什么不用前端构建？** 个人助手场景，越简单越可靠，复制粘贴即用。

## 🐛 常见问题

- **首次启动没看到 Windows 通知？** 第一次 `node-notifier` 需要向系统注册 AppUserModelID，触发一次后会一直有效。
- **LLM 调用返回 401？** 检查 `.env` 里的 `LLM_API_KEY` 是否正确；`/api/ai/status` 会显示是否已配置。
- **LLM 调用很慢 / 卡住？** 30 秒后会自动超时，并按 500/1000/2000ms 退避重试 3 次，看日志定位。
- **日程没弹窗？** 服务每分钟轮询一次，最坏延迟 60 秒；检查进程是否在跑。
- **想清空所有数据？** 删掉 `data/workbuddy.db` 重启即可。

## 📜 License

MIT
