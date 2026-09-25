# 🧭 WorkBuddy 本地智能助手

仿照 WorkBuddy 思路的个人本地助手，覆盖三件事：

- **待办（Todos）**：增删改查、优先级左色条、相对截止时间、快速添加条
- **日程（Schedule）**：具体时间点事件，提前 N 分钟弹 Windows 通知
- **每日定时提醒（Reminders）**：用 cron 表达式配置任意重复节奏
- **智能能力**：通过 OpenAI 兼容 LLM（DeepSeek / 通义千问 / Moonshot / 自部署均可）生成今日摘要、任务建议、**任务拆解**、今日日报、**本周周报**、**月度复盘**

数据保存在本地 **SQLite** 文件（`./data/workbuddy.db`，通过 sql.js 纯 WASM 引擎），支持完整**备份 / 导入**。

## 🆕 近期更新（2026-09）

### 🧹 前端模块精简审计（2026-09-25）

- **样式表合并去重**：`public/styles.css` 原本是「v1 基础样式 + WorkBuddy Theme v3」两套设计的叠加，现合并为单一来源并逐属性去重：
  **114,684 B → 89,517 B（−21.9%）**，最终 **868 条规则 / 3,259 条声明 / 13 个 `@media`**。
- **等价性可验证（非目测）**：按 `(media, selector)` 逐条比对合并前后的**有效属性映射**，差异 **0 / 917** 组；
  产物顺序按每个选择器的**最后出现位置**排序，层叠顺序违规 **0**；产物重新解析后选择器与属性集合零差异（往返自校验），合并幂等。
- **删除 49 条不可达规则**：29 个类名在 `app.js` / `index.html` / `sw.js` 中完全不出现，含这些类的选择器永远无法匹配。
  判定时对 `:not()` / `:is()` / `:where()` / `:has()` 参数做保守处理，并额外检查**字符串拼接生成的类名**——
  `todo-compact` / `todo-loose` 由列表密度下拉框 `'list todo-' + value` 动态生成，已保留。
- **清理前端死代码**：`app.js` 移除无引用函数 `newsSourceName`；`index.html` 移除 3 个无引用的包裹 `id`
  （`chatHint` / `llmConfigCard` / `integrationForm`，其内部控件 id 保留）；静态资源版本号更新为 `styles.css?v=71` / `app.js?v=105`。
- **验收**：`/`、`/index.html`、`/styles.css`、`/app.js`、`/sw.js`、`/manifest.webmanifest`、`/icon.svg`、`/api/health` 全部返回 200，
  且 HTTP 返回的 `styles.css` 与磁盘内容逐字符一致。

> **已知问题（本次审计发现，未改动代码）**：`app.js` 会向 `#compStatus` 写入 Computer Use 状态（沙箱 / 系统信息），
> 但 `public/` 中不存在该 `id`，写入静默失效，因此该状态行始终不显示。

### 其他近期更新

- **对话内 COT 链路**：Think、工具调用、批准与结果直接附着到对应回复，轨迹随消息持久化，历史会话可继续展开。
- **MarkItDown 文档上下文**：对话输入区支持直接上传 PDF、Word、PPT、Excel、EPUB、HTML 和常见代码文本，服务端转换为 Markdown 后注入当前对话。
- **Codex 式核心模块融合**：补齐 Computer Use、Browser Use、长期 Memory、Skills、Review、Worktree、MCP、后台任务和远程 handoff，并统一接入 Agent 工具循环。
- **新闻模块**：固定 RSS/Atom 源注册表、可定制板块、关键词过滤、六个新闻模板、对话内检索与定时系统通知推送。
- **计划工作台**：月目标 → 周任务 → 每日待办三层结构、完成率仪表盘、逾期自动顺延，并支持对话内直接拆解目标。
- **三栏常驻工作台**：左侧功能导航、中间详情页、右侧常驻 AI 助理；切换模块时对话上下文不丢失。
- **三档权限模式**：对话区弹层切换「请求批准 / 帮我批准 / 完全访问」，敏感操作可在消息内批准或拒绝。
- **更紧凑的 Composer**：文件/文件夹/图片、目标和计划改为输入区状态与上拉面板；目标与计划都可独立持久开关，目标内容关闭后保留但不注入对话。
- **界面重构**：采用 porcelain / ink / jade / amber 的安静编辑式视觉，工具台按「思路 / 设备 / 记忆 / 工作台 / 技能」分组，统一浅色与深色主题、原生控件和 PWA 主题色。
- **移动端优化**：会话历史改为抽屉，工具台在桌面端停靠并为内容让位，`390×844` 视口无横向溢出。
- **Playwright 验收链路**：项目本地安装并使用 `playwright-cli`，覆盖桌面端、移动端、上传和关键交互截图检查。

## ✨ 核心特性

### 🤖 Agent 式对话（核心界面）
- **常驻右侧助理**：宽屏下对话框固定在右侧，切换首页、计划、新闻等详情页时仍然保留，底部输入框随时可用
- **自然语言管理一切**：「明天下午3点开周会」「提醒我买牛奶」「每天9点写日报」「把买牛奶标记完成」
- **Plan-then-Execute Agent 循环**：复合任务一句话完成——「创建待办'写周报'并每天9点提醒我」自动拆成两步工具调用
- **Codex 式迭代工具循环**：模型逐步调用工具/技能 → 观察工具结果 → 继续决策，直到输出 final；比一次性计划更能自动应对截图、页面快照、沙箱命令等需要看结果再行动的场景
- **沙箱执行策略**：`sandbox_read_file` / `sandbox_write_file` / `sandbox_list_dir` / `sandbox_git_status` / `sandbox_run` 默认只允许工作区读写，危险命令直接拒绝，所有操作写入 `data/logs/sandbox-*.jsonl` 审计
- **三档权限模式**（对话输入框上方切换）：
  - **请求批准**：敏感工具执行前 SSE 推送批准卡片，后端阻塞等待你点“批准/拒绝”
  - **帮我批准**：沙箱内文件读写/查看自动放行，命令与 GUI 控制仍先询问
  - **完全访问**：不再请求批准，沙箱限制放开为 `danger-full-access`，所有操作仍写审计日志
- **代码审阅（仿 `/review`）**：Composer 的“代码审阅”动作会读取 git status + diff，由 LLM 按 P0/P1/P2 输出 findings，不修改工作区
- **子代理（subagents）**：支持把独立调查/分析任务委派给只读子代理，子代理结果汇总回主对话
- **Git worktrees**：`sandbox_git_worktree_list` / `sandbox_git_worktree_add` 支持查看和创建 worktree（创建需要允许命令或完全访问）
- **MCP**：支持 stdio / streamable HTTP MCP servers，配置后 Agent 可通过 `mcp_list_tools` / `mcp_call` 使用外部工具
- **Scheduled tasks（automations）**：cron + prompt 定时让 Agent 后台执行任务；支持启停、立即运行、运行历史
- **可插拔工具注册表**：20+ 内置工具（待办/日程/提醒/日报/PPT/搜索），新增能力只需在 `TOOLS` 注册表加一项
- **真流式输出**：LLM token 级 SSE 增量 + 打字机光标 + 节流渲染（长回复不卡顿）
- **消息内 COT 链路**：Think、工具决策、批准与执行结果直接附着在回复中，历史会话可继续展开查看
- **文档上下文**：支持 PDF / Word / PPT / Excel / EPUB / HTML / 代码等文件，服务端用 Microsoft MarkItDown 转成 Markdown 后注入对话

### 🌐 联网搜索
- 对话里说「查一下XX」「XX是什么」自动触发
- 多引擎降级链：Bing API（可选 key）→ **Bing HTML**（cn.bing.com 国内免key直连）→ DuckDuckGo
- 搜索结果由 LLM 汇总成带来源链接的回答
- 对话右上角「联网」开关随时启停

### 📰 新闻聚合与定时推送
- **固定高质量源注册表**：人民网、新华网、新浪、少数派、雷锋网、钛媒体、极客公园、IT之家、The Verge、Ars Technica、GitHub Blog、OpenAI News、arXiv、Nature、ScienceDaily 等
- **六个默认模板**：今日要闻、中文科技、AI 与开发、财经观察、科学前沿、文化生活
- **可定制板块**：自由组合信息源、包含/排除关键词、条数和排序方式
- **对话联动**：可说「看看今天的科技新闻」「搜索芯片新闻」「每天 8 点推送科技新闻」
- **定时推送**：新闻板块直接生成专用 automation，后台抓取后通过 WorkBuddy 系统通知推送
- **只允许注册表中的源**：用户不能传入任意 URL，避免 SSRF；单个源失败不影响其他来源

### 🧭 计划工作台
- **三层计划**：月目标、周任务、每日待办完整串联，关联关系直接落 SQLite
- **单入口融合**：顶部导航只保留「计划」，在其中切换「计划看板 / 全部待办」，避免计划与待办重复
- **完成率仪表盘**：月目标权重进度、周任务完成率、今日完成率、逾期与顺延统计
- **周视图看板**：按月自动生成周列，任务进度由关联每日待办实时计算
- **逾期自动顺延**：服务启动和每天 0 点自动检查；每日待办顺延到今天、周任务顺延到当前周、月目标顺延到当前月
- **对话联动**：「把本月目标拆成周任务和每日待办」「查看本月完成率」直接写入或读取工作台
- **备份覆盖**：月目标与周任务随 WorkBuddy 数据备份一起导出和恢复

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

### 📄 MarkItDown 文档上传
- 在对话输入区点击「添加 → 选择文件」，可上传 PDF、Word、PowerPoint、Excel、EPUB、HTML 和常见文本/代码文件
- 文档由微软 [MarkItDown](https://github.com/microsoft/markitdown) 转为 Markdown，转换结果作为当前对话上下文
- 本地安装依赖：`npm run install:markitdown`
- 默认单文件上限 25 MB，可通过 `MARKITDOWN_MAX_MB` 调整

### 💬 会话历史
- 左栏会话列表：SQLite 持久化、首条消息自动命名、点击回放完整记录
- 新建 / 删除 / 当前高亮，刷新页面恢复上次会话

### 🔗 团队 IM 对接
飞书 / 企业微信 / 钉钉 自定义机器人 webhook 推送（支持飞书/钉钉加签），配置页一键测试。

### 📈 Token 用量统计
按天/模型统计，指标卡 + SVG 平滑曲线图，数据落库可回溯。

### 🖥️ Computer Use（电脑操作）
- 窗口枚举、全屏/窗口截图、鼠标移动/单击/双击/右键、键盘输入（支持中文）、滚轮、激活窗口
- 在对话右侧「工具台 → 电脑」里截图后可直接在图上点选坐标，或对自然语言说要助手"截屏 / 点哪里 / 输入什么"
- 默认不开放任意命令；在工具台打开"允许命令"开关后才可以执行 PowerShell / 启动程序

### 🌐 Browser Use（浏览器控制）
- 用系统 **Edge / Chrome / Chromium** 的 CDP 协议驱动真实浏览器（零额外依赖，无需安装 Playwright）
- 打开/导航网页、读取页面快照（链接/按钮/正文）、点击元素、输入中文、按键、滚动、截图
- 对话里说"打开百度 / 在网页上找到 XXX / 点某个按钮"即可自动调度

### 🧠 长期记忆
- 结构化记忆：事实 / 偏好 / 习惯 / 事件 / 上下文，支持标签、重要度、置顶、过期
- 每次对话自动召回相关记忆注入 Agent 上下文，跨会话记住你的偏好
- 可在对话右侧「工具台 → 记忆」管理，或说"记住我每天 9 点开始工作" / "我有什么记得的"
- 支持一键从最近对话中让 LLM 提炼值得长期保存的事实

### ⚡ 技能区（仿 Codex skills）
- 内置模板在项目根目录 `skills/<技能名>/SKILL.md`，首次启动自动复制到 `data/skills/`（pkg 单文件打包后也能编辑）
- `data/skills/<技能名>/SKILL.md` 即一个正式技能，frontmatter 描述用途/适用场景
- Agent 会在需要时自动选 `use_skill`；也可以在对话右侧「工具台 → 技能」编辑、新建、删除、发送到对话
- 内置 `computer-use` / `browser-use` / `memory-manager` 三个示例技能

## 🧩 作为 Codex 插件

本项目同时是一个可被 Codex 加载的插件源码：

- `.codex-plugin/plugin.json`：插件 manifest（名称 `workbuddy`、技能目录 `./skills/`、MCP 配置 `./.mcp.json`）
- `.mcp.json`：把 WorkBuddy 暴露为 MCP stdio server，Codex 可调用它的 agent、会话、记忆、review、sandbox 工具
- `npm run mcp-server`：启动 WorkBuddy MCP server

校验插件 manifest：

```bash
python "$CODEX_HOME/skills/.system/plugin-creator/scripts/validate_plugin.py" .
```

## 🛠️ 技术栈

- Node.js 18+（已在 v24.9.0 测试）
- Express 4
- node-cron（定时调度）
- node-notifier（Windows 系统通知 + 提示音）
- openai（OpenAI 兼容 LLM 客户端，自带指数退避重试 + 超时）
- **sql.js**（SQLite WASM 引擎，零原生编译）
- **pptxgenjs**（原生 .pptx 生成，纯 JS）
- Node 内置 WebSocket + CDP（Browser Use，Node >= 22；其余模块 Node 18+ 可用）
- 原生 HTML/CSS/JS（无前端构建步骤）

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 可选：安装本地 MarkItDown 文档解析依赖
npm run install:markitdown

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
| `COMPUTER_ALLOW_SHELL` | 是否允许执行 PowerShell 命令 / 启动程序（危险能力） | `false` |
| `BROWSER_HEADLESS` | Browser Use 是否无头运行（不弹窗口） | `false` |
| `BROWSER_EXECUTABLE` | 指定浏览器可执行文件路径（留空自动找 Edge/Chrome） | — |
| `MARKITDOWN_PYTHON` | MarkItDown 使用的 Python 命令 | `python` |
| `MARKITDOWN_HOME` | MarkItDown 本地安装目录 | `./.tools/markitdown` |
| `MARKITDOWN_MAX_MB` | 单文件上传上限 | `25` |
| `MARKITDOWN_TIMEOUT_MS` | 单文件转换超时 | `90000` |

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
| `GET` | `/api/ai/approval/pending` | 当前会话待批准操作 |
| `POST` | `/api/ai/approval/:id`  body: `{approved}` | 批准/拒绝工具执行 |
| `GET` | `/api/ai/documents/status` | MarkItDown 安装状态与支持格式 |
| `POST` | `/api/ai/documents/convert?name=...` | 上传原始文件并转换为 Markdown |

### PPT 助理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/ppt/draft` | 当前用户 PPT 草稿 |
| `GET` | `/api/ppt/download/t/:ticket` | 票据下载 .pptx（10 分钟有效） |

### 新闻

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/news/catalog` | 信息源、模板与分类目录 |
| `GET / POST` | `/api/news/boards` | 新闻板块列表 / 新建 |
| `PATCH / DELETE` | `/api/news/boards/:id` | 更新或删除自定义板块 |
| `POST` | `/api/news/boards/:id/run` | 抓取当前板块并生成 Markdown 简报 |
| `POST` | `/api/news/boards/:id/schedule` | 设置或取消定时新闻推送 |
| `GET` | `/api/news/items` | 按板块、关键词、时间与来源查询条目 |
| `POST` | `/api/news/search` | 跨已配置信息源搜索关键词 |

### 计划工作台

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/plan/dashboard?month=YYYY-MM` | 月目标、周任务、每日待办与完成率 |
| `GET / POST` | `/api/plan/goals` | 月目标列表 / 新建 |
| `PATCH / DELETE` | `/api/plan/goals/:id` | 更新或删除月目标 |
| `GET / POST` | `/api/plan/tasks` | 周任务列表 / 新建 |
| `PATCH / DELETE` | `/api/plan/tasks/:id` | 更新或删除周任务 |
| `POST` | `/api/plan/todos` | 创建计划内每日待办 |
| `POST` | `/api/plan/rollover` | 立即执行逾期顺延 |

### 会话历史

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET / POST` | `/api/chathistory/sessions` | 会话列表 / 新建 |
| `GET / POST` | `/api/chathistory/sessions/:id/messages` | 回放消息 / 追加消息 |
| `PATCH / DELETE` | `/api/chathistory/sessions/:id` | 重命名 / 删除会话 |

### 长期记忆

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET / POST` | `/api/memory` | 记忆列表（q/kind/pinned 过滤）/ 新建 |
| `GET` | `/api/memory/stats` | 统计与最近事件 |
| `GET` | `/api/memory/events` | 记住/回忆/提取操作流水 |
| `POST` | `/api/memory/recall` | 关键词召回记忆（更新访问时间） |
| `POST` | `/api/memory/extract`  body: `{messages}` | LLM 从对话提炼长期记忆 |
| `GET / PATCH / DELETE` | `/api/memory/:id` | 单条记忆读/改/删 |
| `POST` | `/api/memory/:id/pin` | 置顶/取消置顶 |

### 技能区

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET / POST` | `/api/skills` | 技能列表 / 新建或更新 |
| `GET / PATCH / DELETE` | `/api/skills/:name` | 读 / 改 / 删技能 |
| `POST` | `/api/skills/:name/run`  body: `{task}` | 用 LLM 执行技能 |

### Computer Use

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/computer/status` | 平台与"允许命令"状态 |
| `GET` | `/api/computer/windows` | 可见窗口列表 |
| `POST` | `/api/computer/screenshot` | 全屏或指定窗口截图 |
| `POST` | `/api/computer/mouse` | 移动/单击/双击/右键（x,y,action） |
| `POST` | `/api/computer/type` | 向当前焦点输入文本 |
| `POST` | `/api/computer/key` | 发送按键（含 modifiers） |
| `POST` | `/api/computer/scroll` | 滚轮滚动 |
| `POST` | `/api/computer/activate` | 激活窗口 |
| `POST` | `/api/computer/launch` / `run` | 启动程序 / PowerShell（**admin + 开关**） |
| `PATCH` | `/api/computer/allow-shell` | 切换允许命令开关（admin） |

### Browser Use

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/browser/status` | 运行状态 / 标签 / 可执行文件 |
| `POST` | `/api/browser/start` | 启动受控浏览器（可带 url） |
| `GET` | `/api/browser/tabs` | 标签页列表 |
| `POST` | `/api/browser/open` / `navigate` | 新标签打开 / 当前标签导航 |
| `POST` | `/api/browser/snapshot` | 页面快照（按钮/链接/正文） |
| `POST` | `/api/browser/screenshot` | 标签页截图 |
| `POST` | `/api/browser/click` / `type` / `key` / `scroll` | 点击 / 输入 / 按键 / 滚动 |
| `POST` | `/api/browser/close` / `stop` | 关闭标签 / 停止浏览器 |

截图文件统一走 `GET /api/media/screenshot?name=...&token=...`（仅登录用户可读）。

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
- WASM 文件：`./data/sql-wasm.wasm`（开发模式从 `node_modules` 复制，便携版从 exe 同目录复制）
- 核心表：`todos` / `plan_goals` / `plan_tasks` / `schedule_events` / `reminders` / `automations` / `news_boards` / `settings` / `users` / `chat_sessions` / `chat_messages` / `memory_items` / `memory_events`
- 备份导出格式：包含 `version / exported_at / tables.*` 的 JSON 快照

## 📂 项目结构

```
dsh/
├── .codex-plugin/plugin.json # Codex 插件 manifest
├── .mcp.json                 # WorkBuddy MCP server 配置
├── server.js                # 入口（async main 启动）
├── package.json
├── .env.example
├── public/                  # 前端静态文件（无构建）
│   ├── index.html
│   ├── app.js               # 对话/计划/待办/新闻/PPT预览/历史栏 全部交互
│   ├── styles.css           # 单一主题入口（v1 布局 + Theme v3 已合并去重）
│   └── sw.js                # PWA Service Worker
├── src/
│   ├── config.js
│   ├── db.js                # sql.js 数据层 + 备份快照 + 迁移
│   ├── logger.js
│   ├── routes/
│   │   ├── todos.js / schedule.js / reminders.js / backup.js
│   │   ├── ai.js            # SSE 流式对话 + 用量统计
│   │   ├── plan.js          # 月目标、周任务、每日待办与顺延
│   │   ├── news.js          # 新闻目录、板块、搜索与推送
│   │   ├── integrations.js  # 飞书/企微/钉钉对接配置
│   │   ├── ppt.js           # 草稿查询 + 票据下载
│   │   ├── chathistory.js   # 会话历史 CRUD
│   │   ├── memory.js        # 长期记忆 API
│   │   ├── skills.js        # 技能区 API
│   │   ├── computer.js      # Computer Use API
│   │   ├── browser.js       # Browser Use API
│   │   └── media.js         # 截图鉴权下载
│   └── services/
│       ├── notifier.js / scheduler.js / backup.js
│       ├── news.js          # RSS/Atom 抓取、过滤、模板与简报
│       ├── plan.js          # 三层计划、完成率与逾期顺延
│       ├── llm.js           # 带重试+超时的 LLM 客户端（chat/chatStream/getClient）
│       ├── ai.js            # LLM 业务逻辑（日报/周报/拆解…）
│       ├── nlp.js           # TOOLS 工具注册表 + Agent Plan-then-Execute 循环
│       ├── websearch.js     # Bing HTML → DuckDuckGo 多引擎降级搜索
│       ├── ppt.js           # PPT 草稿状态机 + pptxgenjs 导出
│       ├── integration.js   # IM webhook 推送（加签支持）
│       ├── chatstore.js     # 会话历史持久化
│       ├── memory.js        # 长期记忆（召回/提取/事件流水）
│       ├── skills.js        # SKILL.md 扫描/编辑/执行
│       ├── computer.js      # PowerShell + user32 电脑控制
│       ├── browser.js       # CDP 浏览器客户端
│       └── media.js         # 截图文件管理
├── src/data/news-sources.json # 固定新闻源与默认模板注册表
├── skills/
│   ├── computer-use/SKILL.md
│   ├── browser-use/SKILL.md
│   └── memory-manager/SKILL.md
├── scripts/
│   ├── smoke.js             # 端到端 API 测试（12 场景）
│   ├── test-codex-modules.js # memory/skills/computer/browser 冒烟
│   ├── test-agent.js        # Agent 工具循环 mock 测试
│   ├── test-news.js         # 新闻解析、板块 CRUD 与定时注册测试
│   ├── test-news-live.js    # 真实 RSS 与定时推送验收
│   ├── test-plan.js         # 计划层级、完成率与对话拆解测试
│   ├── test-markdown.js     # Markdown 渲染 + XSS 防护测试（11 例）
│   ├── test-ppt.js          # PPT 导出真实文件测试
│   └── test-pageno.js       # 中文数字页码测试
└── data/                    # 运行后自动创建
    ├── workbuddy.db
    ├── ppt/                 # 生成的 PPTX 文件
    ├── screenshots/         # Computer/Browser 截图
    ├── skills/              # 运行期技能（首次启动从 skills/ 复制）
    └── browser-profile/     # 受控浏览器用户数据
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

# 新闻解析、板块 CRUD、模板与定时任务注册
npm run test:news

# 计划层级、完成率、逾期顺延与对话拆解
npm run test:plan

# 真实 RSS 抓取、对话工具与定时推送链路（需要联网）
node scripts/test-news-live.js

# Markdown 渲染 + XSS 防护（11 例）
node scripts/test-markdown.js

# 中文数字页码识别（第三页→3）
node scripts/test-pageno.js

# 新增 Codex 式模块（记忆/技能/电脑/浏览器）冒烟
node scripts/test-codex-modules.js

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

## 📦 打包成便携版 .exe

用 [@yao-pkg/pkg](https://github.com/yao-pkg/pkg) 把整个项目打成便携可执行包（**不依赖 Node 环境**，双击即用）。SQLite 的 `sql-wasm.wasm` 需要与 exe 放在同一目录。

### 一次打包

```bash
# 1. 安装 pkg 工具（首次）
npm install --save-dev @yao-pkg/pkg

# 2. 打包当前平台
npm run build

# 输出：dist/workbuddy-win-x64.exe + dist/sql-wasm.wasm
```

### 跨平台打包（在某平台打某平台）

```bash
# 在 macOS 上打 Windows
npm run build -- --target win-x64
# 在 Windows 上打 macOS
npm run build -- --target macos-arm64
```

> ⚠️ 当前 Windows 便携包约 48MB（内嵌 Node 18 运行时 + 全部依赖），另有约 0.6MB 的 `sql-wasm.wasm`

### 用户分发包

最终给用户一个目录即可：

```
WorkBuddy/
├── workbuddy.exe          # 主程序
├── sql-wasm.wasm          # SQLite WASM 运行文件
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
