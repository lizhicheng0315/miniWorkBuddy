'use strict';

/**
 * NLP 助手核心：意图分类 + 实体抽取 + 时间解析 + 分发
 *
 * 设计目标：
 *   - 用户说自然语言，助手判断意图（create_todo / query_todo / chat / ...）
 *   - 抽出时间、标题、优先级等实体
 *   - 必要时执行 DB 写操作
 *   - 调用 LLM 把结果改写为自然语言回复
 */

const chrono = require('chrono-node');
const db = require('../db');
const llm = require('./llm');
const scheduler = require('./scheduler');
const ai = require('./ai');
const logger = require('../logger');

// ===== 时间解析 =====
function parseTime(text, refDate = new Date()) {
  // 优先中文
  const results = chrono.zh.hans.parse(text, refDate, { forwardDate: true });
  if (results && results.length) {
    const best = results[0];
    return {
      time: best.start.date(),
      text: best.text,
      index: best.index,
    };
  }
  return null;
}

// ===== 关键词意图匹配（脱机降级模式，不依赖 LLM） =====
/**
 * 当 LLM 未配置或调用失败时使用。覆盖最常见 80% 用例。
 * 匹配规则按顺序返回第一个命中。
 */
function offlineClassify(message) {
  const text = String(message).trim();
  if (!text) return null;

  const lower = text.toLowerCase();

  // ===== 闲聊 =====
  if (/^(你好|hi|hello|hey|嗨|嗨嗨|早上好|下午好|晚上好|谢谢|thank|ok|好的|收到)/i.test(text)) {
    return { intent: 'chat', confidence: 0.9, reply: '你好！我是 WorkBuddy 助手。我能帮你管理待办、日程、提醒，或者聊聊天。' };
  }
  if (/(你能做什么|你能干什么|你会什么|怎么用|help|help me)/i.test(text)) {
    return {
      intent: 'chat', confidence: 0.95,
      reply: '我能做：\n1. 添加/查询/完成/删除待办\n2. 创建/查询日程（"明天下午3点开会"）\n3. 创建定时提醒（"每天9点提醒我写日报"）\n4. 任务拆解、今日摘要、日报、周报、月度复盘\n\n试试："明天下午3点开会" 或 "提醒我买牛奶"',
    };
  }

  // ===== 删除 =====
  let m;
  if ((m = text.match(/(?:删除|删掉|移除|取消|丢掉)\s*[「"']?(.+?)[」"']?(?:吧|啊|呀)?$/))) {
    return { intent: 'delete_todo', confidence: 0.85, title: m[1].trim() };
  }

  // ===== 完成（含"标记完成"等变体） =====
  // "把 X 标记完成" / "X 做完了" / "完成 X"
  if ((m = text.match(/(?:把|将)\s*(.+?)\s*(?:标记完成|标记为完成|标记已?完成|标记为已?完成)\s*$/))) {
    return { intent: 'complete_todo', confidence: 0.9, title: m[1].trim() };
  }
  if ((m = text.match(/(?:标记完成|标记为完成|标记已?完成|完成一下|做完了|搞定|done)\s*[「"']?(.+?)[」"']?$/))) {
    return { intent: 'complete_todo', confidence: 0.85, title: m[1].trim() };
  }
  if ((m = text.match(/(?:完成|做完了|搞定)\s*[「"']?(.+?)[」"']?$/))) {
    return { intent: 'complete_todo', confidence: 0.85, title: m[1].trim() };
  }

  // ===== 删除 =====
  let m2;

  // ===== 修改（新增：把 X 改成 Y / 推迟到 Y / 改时间为 Y）=====
  if ((m = text.match(/(?:把|将)\s*(.+?)\s*(?:改成|改为|修改为|换成|改为|改成|推迟到|改到|挪到|移到)\s*(.+?)(?:吧|啊|呀)?$/))) {
    return {
      intent: 'update_todo',
      confidence: 0.85,
      target: m[1].trim(),
      new_value: m[2].trim(),
    };
  }
  if ((m = text.match(/(.+?)\s*(?:推迟到|改到|挪到|移到)\s*(.+?)(?:吧|啊|呀)?$/))) {
    return {
      intent: 'update_todo',
      confidence: 0.8,
      target: m[1].trim(),
      new_value: m[2].trim(),
    };
  }

  // ===== 重复提醒 =====
  // "每天/工作日/每周X HH:MM 提醒我 X"
  if ((m = text.match(/(?:每天|每日)\s*(\d{1,2})(?::(\d{1,2}))?\s*(?:分)?\s*(?:提醒我|提醒|叫我)?\s*(.*)/))) {
    return {
      intent: 'create_reminder',
      confidence: 0.92,
      cron: `${m[2] || 0} ${m[1]} * * *`,
      title: (m[3] || '每日提醒').replace(/^[：:，,。 ]+/, '').replace(/^点\s*/, '') || '每日提醒',
    };
  }  if ((m = text.match(/(?:每个)?工作日\s*(\d{1,2})(?::(\d{1,2}))?\s*(?:分)?\s*(?:提醒我|提醒|叫我)?\s*(.*)/))) {
    return {
      intent: 'create_reminder',
      confidence: 0.92,
      cron: `${m[2] || 0} ${m[1]} * * 1-5`,
      title: (m[3] || '工作日提醒').replace(/^[：:，,。 ]+/, '').replace(/^点\s*/, '') || '工作日提醒',
    };
  }
  const weekdays = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  if ((m = text.match(/每周\s*([一二三四五六日天])\s*(\d{1,2})(?::(\d{1,2}))?\s*(?:分)?\s*(?:提醒我|提醒|叫我)?\s*(.*)/))) {
    return {
      intent: 'create_reminder',
      confidence: 0.9,
      cron: `${m[3] || 0} ${m[2]} * * ${weekdays[m[1]]}`,
      title: (m[4] || `周${m[1]}提醒`).replace(/^[：:，,。 ]+/, '').replace(/^点\s*/, '') || `周${m[1]}提醒`,
    };
  }
  if ((m = text.match(/(\d{1,2}):(\d{2})\s*(?:提醒我|提醒|叫我)\s*(.+)/))) {
    return {
      intent: 'create_reminder',
      confidence: 0.9,
      cron: `${m[2]} ${m[1]} * * *`,
      title: m[3].trim(),
    };
  }
  if (/(?:提醒我|记得提醒我|别忘[了]?)\s*(.+)/.test(text)) {
    m = text.match(/(?:提醒我|记得提醒我|别忘[了]?)\s*(.+)/);
    const body = m[1].trim();
    // 兜底分支只在有具体时间时才升级为 reminder
    const t = parseTime(body);
    if (t) {
      return {
        intent: 'create_reminder',
        confidence: 0.8,
        cron: '0 9 * * *',
        title: body,
      };
    }
    // 无时间 → 普通待办
    return { intent: 'create_todo', confidence: 0.85, title: body };
  }

  // ===== 日程（含具体时间）=====
  // 先看有没有时间点
  const timeMatch = parseTime(text);
  if (timeMatch && /(开会|约|见|活动|会议|面试|约会|聚餐|训练|课|看|玩)/.test(text)) {
    // 从时间后面 / 前面抠出标题
    const title = text
      .replace(timeMatch.text, '')
      .replace(/^[我要要去准备安排约]/, '')
      .replace(/[的]?$/, '')
      .trim() || '日程';
    return { intent: 'create_schedule', confidence: 0.88, title };
  }
  // "X点Y" + 事件关键词
  if ((m = text.match(/(?:今天|明天|后天|下周[一二三四五六日天]?)?\s*(?:上午|下午|早上|晚上|夜里)?\s*(\d{1,2})\s*(?:点|:)\s*(\d{1,2})?\s*(.+)/))) {
    if (m[3] && m[3].length > 1) {
      return { intent: 'create_schedule', confidence: 0.85, title: m[3].trim() };
    }
  }
  // "X点" 单独出现 + 事件词
  if ((m = text.match(/(?:今天|明天|后天|下周[一二三四五六日天]?)?\s*(?:上午|下午|早上|晚上|夜里)?\s*(\d{1,2})\s*点(?:[半整]?)\s*(.+)/))) {
    if (m[2] && m[2].length > 1) {
      return { intent: 'create_schedule', confidence: 0.8, title: m[2].trim() };
    }
  }

  // ===== 查询 =====
  if (/(?:我|还)?(?:今天|现在)?(?:有)?什么(?:待办|没做|没完成|todo|todo)/.test(text)) {
    return { intent: 'query_todo', confidence: 0.92 };
  }
  if (/(?:我的)?(?:今天|明天|这周|本周|未来).*(?:日程|安排|计划|有什么)/.test(text)) {
    return { intent: 'query_schedule', confidence: 0.9 };
  }
  if (/(?:我的)?提醒/.test(text) && /(?:有|是|列|什么|看)/.test(text)) {
    return { intent: 'query_reminder', confidence: 0.85 };
  }

  // ===== AI 能力 =====
  if (/(?:拆解|拆分|分解|规划|step\s*by\s*step|怎么开始|怎么完成|步骤)\s*[「"']?(.+?)[」"']?$/.test(text)) {
    m = text.match(/(?:拆解|拆分|分解|规划|step\s*by\s*step|怎么开始|怎么完成|步骤)\s*[「"']?(.+?)[」"']?$/);
    return { intent: 'breakdown', confidence: 0.92, title: m[1].trim() };
  }
  if (/(?:今日|今天).*(?:摘要|要点|总结)/.test(text) || /总结一下/.test(text)) {
    return { intent: 'summarize', confidence: 0.9 };
  }
  if (/(?:今日|今天).*(?:日报|报告)/.test(text) || /今天.{0,5}报告/.test(text)) {
    return { intent: 'daily_report', confidence: 0.92 };
  }
  if (/(?:本周|这周|周).*报/.test(text)) {
    return { intent: 'weekly_report', confidence: 0.92 };
  }
  if (/(?:本月|这个月|月度|月份).*(?:复盘|总结|报告)/.test(text)) {
    return { intent: 'monthly_review', confidence: 0.9 };
  }
  if (/(?:帮我)?(?:拆解|拆分|分解|规划|step).*(?:任务|一下|怎么做)/.test(text)) {
    const t = text.replace(/(?:帮我)?(?:拆解|拆分|分解|规划|step).*?(?:任务|一下|怎么做|：|:)?\s*/, '').trim();
    return { intent: 'breakdown', confidence: 0.88, title: t || text };
  }

  // ===== 联网搜索 =====
  // "查一下XX" / "搜索XX" / "XX是什么"（常识/新闻/信息类）/ "XX的天气" / "XX新闻"
  if ((m = text.match(/(?:查|搜|查一查|查一下|搜一搜|搜一下|帮我查|帮我搜|百度|谷歌|google|bing|搜索)\s*[:：]?\s*(.+)/))) {
    return { intent: 'web_search', confidence: 0.95, query: m[1].trim() };
  }
  if ((m = text.match(/(.+?)\s*(?:是什么|是啥|怎么回事|什么情况|为什么|原因|新闻|天气|怎么样|多少钱|在哪|哪里)/))) {
    const q = m[1].trim();
    if (q && q.length >= 2 && !/^(你|我|他|她|它|这|那|今天|明天|昨天)/.test(q)) {
      return { intent: 'web_search', confidence: 0.9, query: text.trim() };
    }
  }

  // ===== 默认 =====
  return { intent: 'create_todo', confidence: 0.5, title: text };
}
const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: [
        'create_todo', 'query_todo', 'complete_todo', 'delete_todo', 'update_todo',
        'create_schedule', 'query_schedule', 'update_schedule',
        'create_reminder', 'query_reminder', 'delete_reminder', 'update_reminder',
        'breakdown', 'daily_report', 'weekly_report', 'monthly_review', 'summarize',
        'web_search',
        'chat', 'config', 'unknown',
      ],
    },
    confidence: { type: 'number' },
    title: { type: 'string' },
    new_value: { type: 'string' },
    target: { type: 'string' },
    query: { type: 'string' },
    priority: { type: 'string', enum: ['high', 'medium', 'low'] },
    time_text: { type: 'string' },
    cron: { type: 'string' },
    reply: { type: 'string' },
  },
  required: ['intent', 'confidence'],
};

const INTENT_SYSTEM = `你是一个意图分类器。分析用户输入并返回 JSON（不要 Markdown 包裹）。

可用意图：
- create_todo: 添加待办。"提醒我X"/"记一下X"/"加个todo: X"
- query_todo: 查待办。"我今天有什么"/"待办列表"
- complete_todo: 标记完成。"X做完了"/"完成X"
- delete_todo: 删除。"删掉X"/"取消X"
- update_todo: 修改。"把X改成Y"/"X推迟到Y"/"把X时间改成Y"
- create_schedule: 日程。"明天下午3点开会"/"X日X点X"
- query_schedule: 查日程。"明天有什么安排"
- update_schedule: 修改日程
- create_reminder: 重复提醒。"每天9点提醒我X"- query_reminder: 查提醒
- delete_reminder / update_reminder
- breakdown: 拆解任务。"帮我拆解X"
- daily_report / weekly_report / monthly_review / summarize
- web_search: 用户想查实时/外部信息。"查一下X"/"搜索X"/"X是什么"/"X新闻"/"X天气"/"X怎么样"。query 字段填要搜索的内容
- chat: 闲聊或问答。"你好"/"你能做什么"

规则：
1. "每天/每周/工作日 + 时间 + 提醒我" → create_reminder
2. 具体时间点 + 事件 → create_schedule
3. "把/将 X 改成/推迟到 Y" → update_todo，target=X, new_value=Y
4. 抽取 title（去掉时间词和"提醒我"等前缀）
5. confidence 0-1
6. 涉及实时信息/知识查询（新闻、天气、股价、定义、事实、人物、事件）→ web_search，query=完整搜索词
7. 只有管理本地待办/日程/提醒才是 create_*/query_*；其他知识类一律 web_search 或 chat

只返回 JSON。`;

/**
 * 让 LLM 分类用户意图
 */
const KNOWN_INTENTS = new Set([
  'create_todo', 'query_todo', 'complete_todo', 'delete_todo', 'update_todo',
  'create_schedule', 'query_schedule', 'update_schedule',
  'create_reminder', 'query_reminder', 'delete_reminder', 'update_reminder',
  'breakdown', 'daily_report', 'weekly_report', 'monthly_review', 'summarize',
  'web_search', 'chat', 'config', 'unknown',
]);

/**
 * 容错解析 LLM 返回的 JSON：
 * - 剥离 ```json ... ``` markdown 代码块
 * - 剥离前后多余文本（找到第一个 { 到最后一个 }）
 * - 失败返回 null
 */
function safeParseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // 去 markdown 代码块
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // 截取 JSON 对象区间
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

async function classifyIntent(message, userId) {
  const cfg = llm.resolveConfig();

  if (!cfg.apiKey) {
    // LLM 未配置：直接走脱机匹配
    return offlineClassify(message) || { intent: 'unknown', confidence: 0, error: '未匹配到任何意图' };
  }

  // 默认优先走 LLM 意图分类（本地规则仅在 LLM 不可用时兜底）
  try {
    const c = llm.getClient();
    if (!c) return offlineClassify(message) || { intent: 'unknown', confidence: 0, error: 'LLM 客户端不可用' };
    const resp = await c.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: 'system', content: INTENT_SYSTEM },
        { role: 'user', content: message },
      ],
      temperature: 0.1,
      max_tokens: 300,
    });
    // 记录意图分类的 token 用量
    if (resp.usage && resp.usage.total_tokens) {
      llm.recordUsage({
        model: cfg.model,
        prompt_tokens: resp.usage.prompt_tokens,
        completion_tokens: resp.usage.completion_tokens,
        total_tokens: resp.usage.total_tokens,
        userId,
        intent: 'intent_classify',
      });
    }
    const text = resp.choices?.[0]?.message?.content || '{}';
    const parsed = safeParseJson(text);

    // 校验 LLM 输出：intent 必须合法
    const intentOk = parsed && KNOWN_INTENTS.has(parsed.intent);
    if (intentOk && parsed.intent !== 'unknown') {
      // confidence 缺失时补默认 0.8（很多兼容接口不返回 confidence）
      if (typeof parsed.confidence !== 'number') parsed.confidence = 0.8;
      parsed.source = 'llm';
      return parsed;
    }

    // LLM 返回合法但为 unknown（或格式轻微无效）→ 默认由 LLM 直接兜底闲聊，
    // 不再猜测成 create_todo（用户已选择"默认走 LLM"）
    if (intentOk && parsed.intent === 'unknown') {
      return parsed;
    }
    // 格式严重无效 → 让 LLM 兜底闲聊（chat），不报错
    return { intent: 'unknown', confidence: 0, source: 'llm-unknown' };
  } catch (e) {
    // LLM 调用失败（网络/API 错误）：降级到本地规则兜底
    logger.warn(`classifyIntent failed (${e.message}), falling back to offline classifier`);
    const offline = offlineClassify(message);
    if (offline) {
      offline.fallback = 'offline';
      return offline;
    }
    return { intent: 'unknown', confidence: 0, error: e.message };
  }
}

// ===== 实体精化（结合 chrono + LLM 抽取的 title）=====
function refineTime(parsed, intent) {
  if (!parsed) return null;
  return parsed.time.toISOString();
}

// ===== 分发执行 =====

/**
 * 工具注册表（nanobot 灵魂：极简可扩展内核）
 * 每个工具 = { description, handler(ctx) -> { summary, data, steps } }
 *   ctx = { intent, userId, message }
 *   steps = [{ icon, text }] 操作转录（MiniCode transcript 灵魂）
 * 新增能力只需在这里加一项，无需改动分发逻辑。
 */

/**
 * 从文本提取"第X页"的页码：支持阿拉伯数字与中文数字
 *   第3页 / 第三页 / 第十二页 / 第 12 页 / 第123页
 * @returns {number} 页码，未识别返回 0
 */
function extractPageNo(text) {
  const s = String(text || '');
  // 阿拉伯数字
  const arabic = s.match(/第\s*(\d{1,3})\s*页/);
  if (arabic) return parseInt(arabic[1], 10);
  // 中文数字
  const cn = s.match(/第\s*([零一二两三四五六七八九十百]+)\s*页/);
  if (!cn) return 0;
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const c = cn[1];
  if (c === '十') return 10;
  if (c === '百') return 100;
  const tenIdx = c.indexOf('十');
  const hundredIdx = c.indexOf('百');
  if (hundredIdx >= 0) {
    // 百位：X百[零Y / YZ]
    let v = (digits[c[hundredIdx - 1]] || 1) * 100;
    const rest = c.slice(hundredIdx + 1).replace(/^零/, ''); // 一百"零"一 → 去零后按个位读
    if (rest) {
      const t2 = rest.indexOf('十');
      if (t2 >= 0) {
        v += ((digits[rest[t2 - 1]] || 1) * 10) + (digits[rest[t2 + 1]] || 0);
      } else {
        v += digits[rest] || 0;
      }
    }
    return v;
  }
  if (tenIdx >= 0) {
    // 十位：X十[Y] 或 十Y
    return (tenIdx > 0 ? (digits[c[tenIdx - 1]] || 1) * 10 : 10) + (digits[c[tenIdx + 1]] || 0);
  }
  return digits[c] != null ? digits[c] : 0;
}

const TOOLS = {
  create_todo: {
    description: '添加待办',
    async handler({ intent, userId, message }) {
      const title = (intent.title || message).slice(0, 200);
      const row = db.insert('todos', {
        user_id: userId,
        title,
        priority: intent.priority === 'high' ? 1 : intent.priority === 'low' ? 3 : 2,
        status: 'open',
        due_at: refineTime(parseTime(message)),
      });
      return { data: row, summary: `✅ 已添加待办：${title}`, steps: [{ icon: '✅', text: `已添加待办：${title}` }] };
    },
  },
  create_schedule: {
    description: '创建日程',
    async handler({ intent, userId, message }) {
      const title = (intent.title || message).slice(0, 200);
      const parsed = parseTime(message);
      if (!parsed) return { summary: '⚠️ 没听出具体时间，请告诉我什么时候（例：明天下午3点）' };
      const remindBeforeMin = 15;
      const row = db.insert('schedule_events', {
        user_id: userId, title, start_at: parsed.time.toISOString(), remind_before_min: remindBeforeMin, fired: 0,
      });
      return { data: row, summary: `📅 已创建日程：${title}（${parsed.time.toLocaleString()}，提前 ${remindBeforeMin} 分钟提醒）`, steps: [{ icon: '📅', text: `已创建日程：${title}` }] };
    },
  },
  create_reminder: {
    description: '创建重复提醒',
    async handler({ intent, userId, message }) {
      const title = (intent.title || message).slice(0, 200);
      let cron = intent.cron;
      if (!cron) cron = inferCronFromMessage(message);
      if (!cron || !scheduler.isValidCron(cron)) return { summary: '⚠️ 没听出重复规则，试试：每天 9:00 / 工作日 8:30 / 每周一 10:00' };
      const row = db.insert('reminders', {
        user_id: userId,
        title: title.replace(/^提醒我/, '').replace(/^每天.*提醒我/, '').trim() || '提醒',
        cron, message: title, enabled: 1,
      });
      scheduler.register(row);
      return { data: row, summary: `⏰ 已创建提醒：${row.title}（cron: ${cron}）`, steps: [{ icon: '⏰', text: `已创建提醒：${row.title}` }] };
    },
  },
  query_todo: {
    description: '查询待办',
    async handler({ userId }) {
      const open = db.list('todos', (t) => t.status === 'open', userId);
      const summary = open.length
        ? `你有 ${open.length} 个未完成待办：\n` + open.slice(0, 10).map((t, i) => `${i + 1}. ${t.title}${t.due_at ? `（截止 ${new Date(t.due_at).toLocaleDateString()}）` : ''}`).join('\n')
        : '🎉 当前没有未完成待办';
      return { data: open, summary, steps: open.length ? [{ icon: '📋', text: `查询到 ${open.length} 个未完成待办` }] : [] };
    },
  },
  query_schedule: {
    description: '查询日程',
    async handler({ userId }) {
      const now = new Date();
      const week = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      const events = db.list('schedule_events', (ev) => new Date(ev.start_at) >= now && new Date(ev.start_at) <= week, userId);
      const summary = events.length
        ? `未来 7 天有 ${events.length} 个日程：\n` + events.slice(0, 10).map((e) => `• ${e.title} @ ${new Date(e.start_at).toLocaleString()}`).join('\n')
        : '未来 7 天没有日程';
      return { data: events, summary, steps: events.length ? [{ icon: '📆', text: `查询到 ${events.length} 个未来日程` }] : [] };
    },
  },
  query_reminder: {
    description: '查询提醒',
    async handler({ userId }) {
      const list = db.list('reminders', null, userId);
      const summary = list.length
        ? `你有 ${list.length} 个提醒：\n` + list.map((r) => `• ${r.title} (${r.cron}) ${r.enabled ? '✅' : '⏸'}`).join('\n')
        : '还没有设置提醒';
      return { data: list, summary, steps: list.length ? [{ icon: '⏰', text: `查询到 ${list.length} 个提醒` }] : [] };
    },
  },
  complete_todo: {
    description: '完成待办',
    async handler({ intent, userId, message }) {
      const target = intent.title || message.replace(/(完成|做完了|done)/g, '').trim();
      const todos = db.list('todos', (t) => t.status === 'open', userId);
      const hit = findByTitle(todos, target);
      if (!hit) return { summary: `找不到"${target}"` };
      db.update('todos', hit.id, { status: 'done', completed_at: db.nowIso() }, userId);
      return { summary: `✅ 已完成：${hit.title}`, steps: [{ icon: '✅', text: `已完成待办：${hit.title}` }] };
    },
  },
  delete_todo: {
    description: '删除待办',
    async handler({ intent, userId, message }) {
      const target = intent.title || intent.target || message.replace(/(删除|删掉|取消)/g, '').trim();
      const todos = db.list('todos', null, userId);
      // 危险操作：严格匹配，绝不模糊兜底误删
      const hit = findByTitle(todos, target, true);
      if (!hit) return { summary: `找不到名为「${target}」的待办，未删除。可先说"查一下待办"确认名称`, steps: [] };
      db.remove('todos', hit.id, userId);
      return { summary: `🗑 已删除：${hit.title}`, steps: [{ icon: '🗑', text: `已删除待办：${hit.title}` }] };
    },
  },
  update_todo: {
    description: '修改待办',
    async handler({ intent, userId, message }) {
      const target = intent.target || intent.title || message;
      const newVal = intent.new_value || '';
      const todos = db.list('todos', null, userId);
      const hit = findByTitle(todos, target);
      if (!hit) return { summary: `找不到"${target}"` };
      const timeParsed = parseTime(newVal);
      const update = {};
      let stepText = '';
      if (timeParsed) { update.due_at = timeParsed.time.toISOString(); stepText = `截止时间改为 ${timeParsed.time.toLocaleString()}`; }
      else if (/(高|重要|紧急|high)/i.test(newVal)) { update.priority = 1; stepText = '优先级设为高'; }
      else if (/(中|medium)/i.test(newVal)) { update.priority = 2; stepText = '优先级设为中'; }
      else if (/(低|不急|low)/i.test(newVal)) { update.priority = 3; stepText = '优先级设为低'; }
      else if (newVal) { update.title = newVal; stepText = `标题改为「${newVal}」`; }
      else return { summary: '⚠️ 没听出要改成什么' };
      db.update('todos', hit.id, update, userId);
      return { summary: `📝 已将「${hit.title}」${stepText}`, steps: [{ icon: '📝', text: `已修改待办：${hit.title} → ${stepText}` }] };
    },
  },
  update_schedule: {
    description: '修改日程',
    async handler({ intent, userId, message }) {
      const target = intent.target || intent.title || message;
      const newVal = intent.new_value || '';
      const events = db.list('schedule_events', null, userId);
      const hit = findByTitle(events, target);
      if (!hit) return { summary: `找不到日程"${target}"` };
      const timeParsed = parseTime(newVal);
      if (timeParsed) {
        db.update('schedule_events', hit.id, { start_at: timeParsed.time.toISOString(), fired: 0 }, userId);
        return { summary: `📅 已将「${hit.title}」改到 ${timeParsed.time.toLocaleString()}`, steps: [{ icon: '📅', text: `已修改日程时间：${hit.title}` }] };
      } else if (newVal) {
        db.update('schedule_events', hit.id, { title: newVal }, userId);
        return { summary: `📅 已将日程名改为「${newVal}」`, steps: [{ icon: '📅', text: `已修改日程名：${hit.title}` }] };
      }
      return { summary: '⚠️ 没听出要改成什么' };
    },
  },
  update_reminder: {
    description: '修改提醒',
    async handler({ intent, userId, message }) {
      const target = intent.target || intent.title || message;
      const newVal = intent.new_value || '';
      const reminders = db.list('reminders', null, userId);
      const hit = findByTitle(reminders, target);
      if (!hit) return { summary: `找不到提醒"${target}"` };
      const newCron = inferCronFromMessage(newVal) || (newVal && scheduler.isValidCron(newVal) ? newVal : null);
      if (newCron) {
        scheduler.unregister(hit.id);
        db.update('reminders', hit.id, { cron: newCron, enabled: 1 }, userId);
        const r2 = db.find('reminders', hit.id, userId);
        scheduler.register(r2);
        return { summary: `⏰ 已将「${hit.title}」cron 改为 ${newCron}`, steps: [{ icon: '⏰', text: `已修改提醒：${hit.title}` }] };
      }
      return { summary: '⚠️ 没听出新的 cron' };
    },
  },
  breakdown: {
    description: '任务拆解',
    async handler({ intent, userId, message }) {
      const r = await ai.breakdown(intent.title || message);
      if (r.ok) {
        try {
          const obj = JSON.parse(r.text);
          const summary = `🧩 **${obj.summary || '任务拆解'}**\n\n` + (obj.steps || []).map((s, i) => `${i + 1}. ${s.step}（约 ${s.estimate_min} 分钟）`).join('\n');
          return { data: obj, summary, steps: [{ icon: '🧩', text: '已生成任务拆解' }] };
        } catch { return { summary: r.text }; }
      }
      return { summary: '⚠️ ' + r.error };
    },
  },
  daily_report: {
    description: '今日日报',
    async handler({ userId }) { const r = await ai.dailyReport(userId); return { summary: r.ok ? r.text : '⚠️ ' + r.error, steps: r.ok ? [{ icon: '📊', text: '已生成今日日报' }] : [] }; },
  },
  weekly_report: {
    description: '本周周报',
    async handler({ userId }) { const r = await ai.weeklyReport(userId); return { summary: r.ok ? r.text : '⚠️ ' + r.error, steps: r.ok ? [{ icon: '📊', text: '已生成本周周报' }] : [] }; },
  },
  monthly_review: {
    description: '月度复盘',
    async handler({ userId }) { const r = await ai.monthlyReview(userId); return { summary: r.ok ? r.text : '⚠️ ' + r.error, steps: r.ok ? [{ icon: '📊', text: '已生成月度复盘' }] : [] }; },
  },
  summarize: {
    description: '内容摘要',
    async handler({ userId }) { const r = await ai.summarize(userId); return { summary: r.ok ? r.text : '⚠️ ' + r.error }; },
  },
  web_search: {
    description: '联网搜索',
    async handler({ intent, userId, message, onDelta }) {
      const query = intent.query || intent.title || message.replace(/^(查|搜|查一查|查一下|搜一搜|搜一下|帮我查|帮我搜|搜索)\s*[:：]?\s*/, '').trim();
      const summary = await handleWebSearch(query, userId, onDelta);
      return { summary, steps: [{ icon: '🔍', text: `已联网搜索：${query}` }] };
    },
  },

  // ===== PPT 助理（ppt-master 方法论：大纲⛔ → 设计⛔ → 生成）=====
  ask_clarification: {
    description: '向用户追问澄清（当需求有歧义、缺关键参数、多种理解都可能时使用）',
    async handler({ intent, message }) {
      const question = intent.question
        || intent.clarification
        || (() => {
          const q = String(message || '').trim();
          return q ? '关于「' + q.slice(0, 40) + '」：能补充一下具体要求吗？（例如范围、时间、格式）' : '';
        })();
      if (!question) question = '能补充一下具体要求吗？';
      return {
        summary: '❓ ' + question,
        steps: [{ icon: '❓', text: '需要向你确认一些信息' }],
        data: { clarification: true },
      };
    },
  },

  ppt_outline: {
    description: '生成PPT大纲（等待用户确认）',
    async handler({ intent, userId }) {
      const ppt = require('./ppt');
      const topic = intent.topic || intent.title || '';
      if (!topic) return { summary: '⚠️ 请告诉我要做什么主题的PPT' };
      // LLM 结构化输出大纲
      const prompt = `你是PPT策划师。为主题「${topic}」设计一份演示文稿大纲。
只返回 JSON：{"title":"主标题","subtitle":"副标题","pages":[{"title":"页标题","bullets":["要点1","要点2","要点3"],"note":"演讲提示"}]}
要求：8-10页；结构含背景/现状/分析/方案/计划/总结；每页3-4条精炼要点。`;
      const r = await llm.chat(
        [{ role: 'system', content: '你是专业的PPT策划师，只输出 JSON，不要任何解释和 Markdown 包裹。' }, { role: 'user', content: prompt }],
        { temperature: 0.5, max_tokens: 3000, userId, intent: 'ppt_outline' }
      );
      if (!r.ok) return { summary: '⚠️ 大纲生成失败：' + r.error };
      // 截断检测：finish_reason=length 说明 JSON 被腰斩
      if (r.finish_reason === 'length') {
        return { summary: '⚠️ 大纲太长被截断了，请重试一次；若反复出现请减少要求的页数' };
      }
      const parsed = safeParseJson(r.text);
      if (!parsed || !Array.isArray(parsed.pages) || !parsed.pages.length) {
        return { summary: '⚠️ 大纲格式异常，请重试' };
      }
      const draft = ppt.createOutline(userId, topic, parsed);
      return {
        summary: ppt.outlineToText(draft) +
          '\n\n⛔ 请确认这份大纲：\n• 回复「确认」进入下一步\n• 或说「第X页改成…」「删掉第X页」「加一页讲XX」来调整',
        data: draft,
        steps: [{ icon: '📑', text: `已生成《${draft.title}》大纲（${draft.pages.length} 页）` }],
      };
    },
  },
  ppt_add_page: {
    description: '往PPT草稿追加一页（"加一页讲XX"）',
    async handler({ intent, userId, message }) {
      const ppt = require('./ppt');
      const d = ppt.getDraft(userId);
      if (!d) return { summary: '⚠️ 当前没有PPT草稿' };
      const topic = intent.topic || intent.title || message.replace(/^.*?(?:加一页|添加一页|新增一页)\s*(?:讲|关于)?\s*/, '').replace(/[。！？]$/, '').trim();
      if (!topic) return { summary: '⚠️ 请说明新页面讲什么，例如"加一页讲风险预案"' };
      // LLM 生成该页内容
      const r = await llm.chat(
        [
          { role: 'system', content: '你是PPT策划师。为新页面生成内容。只返回 JSON：{"title":"页标题","bullets":["要点1","要点2","要点3"]}' },
          { role: 'user', content: `整份PPT主题：《${d.title}》。已有页面：${d.pages.map((p) => p.title).join('、')}。\n请为「${topic}」设计一页（3-4条要点，不与已有页重复）。` },
        ],
        { temperature: 0.5, max_tokens: 400, userId, intent: 'ppt_add_page' }
      );
      if (!r.ok) return { summary: '⚠️ 生成失败：' + r.error };
      const parsed = safeParseJson(r.text);
      if (!parsed || !parsed.title) return { summary: '⚠️ 格式异常，请重试' };
      const lastNo = d.pages.length;
      const np = ppt.addPage(userId, lastNo, { title: parsed.title, bullets: parsed.bullets || [] });
      return {
        summary: `➕ 已在第 ${np.no} 页位置新增：「${np.title}」（现共 ${d.pages.length} 页）\n${np.bullets.map((b) => '   • ' + b).join('\n')}\n\n回复「确认」继续，或继续调整`,
        steps: [{ icon: '➕', text: `已新增第 ${np.no} 页` }],
      };
    },
  },
  ppt_edit_page: {
    description: '修改PPT草稿的某一页（支持"第X页改成…"/"展开讲讲"）',
    async handler({ intent, userId, message }) {
      const ppt = require('./ppt');
      const d = ppt.getDraft(userId);
      if (!d) return { summary: '⚠️ 当前没有PPT草稿，先说"帮我做一份XX的PPT"' };
      const no = extractPageNo(message) || (intent.page_no | 0);
      if (!no) return { summary: '⚠️ 请说明要改第几页，例如"第2页改成…"或"第二页…"' };
      const page = d.pages.find((p) => p.no === no);
      if (!page) return { summary: `⚠️ 没找到第${no}页（当前共 ${d.pages.length} 页）` };

      // Agent args 带了明确新内容 → 直接替换；否则让 LLM 按用户要求改写本页
      if (intent.new_title || intent.bullets) {
        const updated = ppt.editPage(userId, no, { title: intent.new_title, bullets: intent.bullets });
        return {
          summary: `✏️ 已更新第 ${updated.no} 页：${updated.title}\n${updated.bullets.map((b) => '   • ' + b).join('\n')}\n\n回复「确认」继续，或继续调整其他页`,
          steps: [{ icon: '✏️', text: `已修改第 ${updated.no} 页` }],
        };
      }

      // LLM 改写：把用户原话 + 当前页内容交给 LLM 重写
      const r = await llm.chat(
        [
          { role: 'system', content: '你是PPT内容编辑。根据用户的修改要求重写指定页。只返回 JSON：{"title":"新标题","bullets":["要点1","要点2",...]}。保持其他页无关。' },
          { role: 'user', content: `页面当前内容：\n标题：${page.title}\n要点：${JSON.stringify(page.bullets)}\n\n用户要求：${message}\n\n请输出修改后的这一页。` },
        ],
        { temperature: 0.5, max_tokens: 600, userId, intent: 'ppt_edit_page' }
      );
      if (!r.ok) return { summary: '⚠️ 改写失败：' + r.error };
      const parsed = safeParseJson(r.text);
      if (!parsed || (!parsed.title && !Array.isArray(parsed.bullets))) {
        return { summary: '⚠️ 改写格式异常，请换个说法重试' };
      }
      const updated = ppt.editPage(userId, no, { title: parsed.title, bullets: parsed.bullets });
      return {
        summary: `✏️ 已按你的要求更新第 ${no} 页：\n\n${updated.title}\n${updated.bullets.map((b) => '   • ' + b).join('\n')}\n\n回复「确认」继续生成，或继续调整`,
        steps: [{ icon: '✏️', text: `已修改第 ${no} 页` }],
      };
    },
  },
  ppt_confirm: {
    description: '确认当前阶段（大纲/设计）并推进',
    async handler({ userId }) {
      const ppt = require('./ppt');
      const d = ppt.getDraft(userId);
      if (!d) return { summary: '⚠️ 当前没有PPT草稿' };
      if (d.stage === 'outline_pending') {
        ppt.confirmOutline(userId);
        return {
          summary: '✅ 大纲已锁定！\n\n🎨 接下来选择主题风格（回复编号或名称）：\n1. 商务蓝（默认）\n2. 极简白\n3. 科技黑\n4. 活力橙\n\n或直接回复「确认」使用商务蓝',
          steps: [{ icon: '✅', text: '大纲已确认，进入设计阶段' }],
        };
      }
      if (d.stage === 'design_pending') {
        // 设计阶段收到的"确认"= 用当前主题生成
        return await TOOLS.ppt_generate.handler({ userId });
      }
      if (d.stage === 'done') return { summary: '🎉 PPT已生成过。要改的话请重新发起，例如"帮我做一份XX的PPT"' };
      return { summary: `当前阶段：${d.stage}，请按提示操作` };
    },
  },
  ppt_theme: {
    description: '设置PPT主题风格',
    async handler({ intent, userId, message }) {
      const ppt = require('./ppt');
      const d = ppt.getDraft(userId);
      if (!d || d.stage !== 'design_pending') return { summary: '⚠️ 请先完成大纲确认再选主题' };
      const map = { '1': 'business_blue', 商务蓝: 'business_blue', '2': 'minimal_white', 极简白: 'minimal_white', '3': 'tech_dark', 科技黑: 'tech_dark', '4': 'warm_orange', 活力橙: 'warm_orange' };
      let key = null;
      for (const k of Object.keys(map)) { if (String(message).includes(k)) { key = map[k]; break; } }
      key = key || intent.theme_key;
      const theme = key && ppt.setTheme(userId, key);
      if (!theme) return { summary: '⚠️ 未识别的主题，可选：商务蓝 / 极简白 / 科技黑 / 活力橙' };
      d.stage = 'design_confirmed';
      // 选完主题直接生成
      const gen = await TOOLS.ppt_generate.handler({ userId });
      return gen;
    },
  },
  ppt_generate: {
    description: '生成PPTX文件',
    async handler({ userId }) {
      const ppt = require('./ppt');
      const d = ppt.getDraft(userId);
      if (!d) return { summary: '⚠️ 当前没有PPT草稿' };
      if (d.stage === 'outline_pending') return { summary: '⛔ 大纲还没确认。先回复「确认」' };
      const r = await ppt.generatePptx(userId);
      if (!r.ok) return { summary: '⚠️ 导出失败：' + r.error };
      return {
        summary: `🎉 PPT 已生成！\n\n📄 文件：${r.fileName}\n📊 共 ${r.pageCount} 页 · 主题：${(require('./ppt').THEMES[d.theme] || {}).label || d.theme}\n\n⬇️ 点击下载：/api/ppt/download/t/${r.downloadTicket}\n（原生 .pptx，可用 Office/WPS 二次编辑 · 链接 10 分钟内有效）`,
        data: { exportId: r.exportId, fileName: r.fileName, downloadUrl: `/api/ppt/download/t/${r.downloadTicket}` },
        steps: [{ icon: '📊', text: `已生成 ${r.pageCount} 页 PPT` }],
      };
    },
  },

  // ===== PRD 智能需求分析（CodeBuddy 需求分析能力借鉴）=====
  prd_generate: {
    description: '生成结构化产品需求文档PRD（等待用户确认后再导出）',
    async handler({ intent, userId, message }) {
      const prd = require('./prd');
      const topic = intent.topic || intent.title || message.replace(/^(帮我|请|生成|写)(?:做|写)?一份?(?:关于|关于|描述)?/i, '').trim();
      if (!topic) return { summary: '⚠️ 请描述你要分析的需求主题，例如"做一个社区团购小程序的需求文档"' };
      const prompt = `你是资深产品经理。根据用户需求「${topic}」，生成一份结构化的产品需求文档(PRD)。
只返回 JSON：{
  "title":"产品名称",
  "version":"v1.0",
  "overview":"项目背景与目标概述",
  "targetUsers":"目标用户画像",
  "goals":["目标1","目标2"],
  "userStories":["用户故事1","用户故事2"],
  "features":[
    {"name":"功能名","priority":"高/中/低","description":"详细描述","acceptance":["验收标准1","验收标准2"]}
  ],
  "constraints":["约束条件"],
  "timeline":"时间规划",
  "metrics":["成功指标1","成功指标2"]
}
要求：3-5个功能模块，每个功能至少2条验收标准，目标和指标要量化。`;
      const r = await llm.chat(
        [{ role: 'system', content: '你是一位资深产品经理，擅长编写结构化需求文档。只输出 JSON，不要任何解释或 Markdown 包裹。' }, { role: 'user', content: prompt }],
        { temperature: 0.5, max_tokens: 2000, userId, intent: 'prd_generate' }
      );
      if (!r.ok) return { summary: '⚠️ PRD 生成失败：' + r.error };
      if (r.finish_reason === 'length') return { summary: '⚠️ PRD 太长被截断，请减少需求范围后重试' };
      const parsed = safeParseJson(r.text);
      if (!parsed || !parsed.features || !parsed.features.length) {
        return { summary: '⚠️ PRD 格式异常，请重试' };
      }
      const draft = prd.createDraft(userId, topic, parsed);
      return {
        summary: prd.previewText(draft) + '\n\n⛔ 请确认：\n• 回复「确认」导出为 Markdown\n• 说「功能X展开描述」「加一条约束」来修改',
        data: { features: draft.features.length, topic: draft.title },
        steps: [{ icon: '📋', text: `已生成《${draft.title}》PRD（${draft.features.length} 个功能模块）` }],
      };
    },
  },
  prd_review: {
    description: '审查当前PRD草稿，输出优化建议',
    async handler({ userId }) {
      const prd = require('./prd');
      const d = prd.getDraft(userId);
      if (!d) return { summary: '⚠️ 没有进行中的 PRD，先说"帮我写一份XX的需求文档"' };
      const r = await llm.chat(
        [
          { role: 'system', content: '你是产品评审专家。审查这份 PRD，给出 3-5 条具体可操作的优化建议（缺什么、哪里模糊、功能优先级合理性等）。' },
          { role: 'user', content: prd.reviewPreviewText(d) },
        ],
        { temperature: 0.4, max_tokens: 600, userId, intent: 'prd_review' }
      );
      if (!r.ok) return { summary: '⚠️ 审查失败：' + r.error };
      prd.updateDraft(userId, { reviewNotes: r.text.trim() });
      return {
        summary: '🔍 PRD 审查意见：\n\n' + r.text.trim() + '\n\n回复「确认」导出 Markdown，或根据建议修改',
        steps: [{ icon: '🔍', text: 'PRD 审查完成' }],
      };
    },
  },
  prd_export: {
    description: '导出PRD为Markdown文件',
    async handler({ userId }) {
      const prd = require('./prd');
      const d = prd.getDraft(userId);
      if (!d) return { summary: '⚠️ 没有 PRD 草稿' };
      const r = prd.exportMd(userId);
      if (!r.ok) return { summary: '⚠️ 导出失败：' + r.error };
      return {
        summary: `📄 PRD 已导出为 Markdown\n\n📝 文件：${r.fileName}\n📊 ${d.features.length} 个功能模块 · ${d.goals.length} 个目标\n\n⬇️ 点击下载：/api/prd/download/t/${r.ticket}`,
        data: { ticket: r.ticket, fileName: r.fileName },
        steps: [{ icon: '📄', text: '已导出 PRD Markdown' }],
      };
    },
  },
  prd_confirm: {
    description: '确认PRD并导出Markdown',
    async handler({ userId }) {
      return await TOOLS.prd_export.handler({ userId });
    },
  },
};

/**
 * 工具分发器：根据 intent 找到工具并执行（找不到则兜底）
 */
async function executeIntent(intent, userId, originalMessage, opts = {}) {
  const tool = TOOLS[intent.intent];
  if (!tool) {
    return {
      data: null,
      summary: intent.reply || '我能帮你管理待办、日程、提醒，或者聊聊天。试试：明天下午3点开会 / 提醒我买牛奶 / 今日日报',
      steps: [],
    };
  }
  try {
    const r = await tool.handler({ intent, userId, message: originalMessage, onDelta: opts.onDelta });
    // 实时推送操作转录（MiniCode transcript 灵魂）
    if (opts.onStep && r.steps && r.steps.length) {
      for (const s of r.steps) { try { opts.onStep(s); } catch (_) {} }
    }
    return r;
  } catch (e) {
    logger.error('tool failed:', intent.intent, e.message);
    return { data: null, summary: '⚠️ 执行出错：' + e.message, steps: [] };
  }
}

/**
 * 联网搜索：搜索 → 有 LLM key 时 LLM 汇总；无 key 时直接列结果
 */
async function handleWebSearch(query, userId, onDelta) {
  if (!query) return '⚠️ 没听出要搜索什么';
  try {
    const websearch = require('./websearch');
    const r = await websearch.search(query, { count: 6 });
    if (!r.ok) return '⚠️ 搜索失败：' + r.error;
    if (!r.results.length) return `🔍 没搜到「${query}」的相关结果`;

    // 构造结果文本
    const itemsText = r.results.map((it, i) => `${i + 1}. ${it.title}\n   ${it.snippet || ''}\n   ${it.url}`).join('\n');

    // 有 LLM key → 让 LLM 汇总成可读回答（流式）
    const cfg = llm.resolveConfig();
    if (cfg.apiKey) {
      const prefix = `🔍 已联网查询「${query}」\n\n`;
      if (onDelta) onDelta(prefix);
      const resp = await llm.chatStream(
        [
          {
            role: 'system',
            content:
              '你是联网搜索助理。根据给定的搜索结果，用简洁的中文回答用户问题。' +
              '先给直接答案（100 字内），再列 2-3 条关键来源（带链接）。' +
              '如果搜索结果不足以回答，如实说明。不要编造。',
          },
          { role: 'user', content: `问题：${query}\n\n搜索结果：\n${itemsText}` },
        ],
        { temperature: 0.3, max_tokens: 600, userId, intent: 'web_search' },
        onDelta
      );
      if (resp.ok) return prefix + resp.text;
    }

    // 无 LLM：直接列结果
    const plain = `🔍 搜索「${query}」的结果（${r.results.length} 条）：\n\n${itemsText}`;
    if (onDelta) onDelta(plain);
    return plain;
  } catch (e) {
    logger.warn('handleWebSearch failed:', e.message);
    return '⚠️ 联网搜索出错：' + e.message;
  }
}

// 模糊匹配 todo 标题
function findByTitle(rows, target, strict = false) {
  if (!target || !rows.length) return null;
  const t = target.toLowerCase();
  let best = null, bestScore = 0;
  for (const r of rows) {
    const title = (r.title || '').toLowerCase();
    if (title === t) return r;
    if (title.includes(t) || t.includes(title)) {
      const score = Math.min(title.length, t.length) / Math.max(title.length, t.length);
      if (score > bestScore) { best = r; bestScore = score; }
    }
  }
  // strict 模式：删除等危险操作不兜底，匹配不到就返回 null
  if (strict) return best;
  return best || rows[0]; // 非严格兜底：第一个
}

// 简单 cron 推断
function inferCronFromMessage(msg) {
  const m = msg;
  // "每天 HH:MM" 或 "每天 H 点"
  let r = m.match(/每天\s*(\d{1,2})(?::(\d{2}))?\s*点?/);
  if (r) return `${r[2] || 0} ${r[1]} * * *`;
  // "每个工作日 HH:MM"
  r = m.match(/(?:每个)?工作日\s*(\d{1,2})(?::(\d{2}))?\s*点?/);
  if (r) return `${r[2] || 0} ${r[1]} * * 1-5`;
  // "每周X HH:MM"
  const weekdays = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  r = m.match(/每周([一二三四五六日天])\s*(\d{1,2})(?::(\d{2}))?\s*点?/);
  if (r) return `${r[3] || 0} ${r[2]} * * ${weekdays[r[1]]}`;
  // "HH:MM 提醒我"（每天）
  r = m.match(/(\d{1,2}):(\d{2})\s*提醒/);
  if (r) return `${r[2]} ${r[1]} * * *`;
  return null;
}

// ===== Agentic 工具循环（MiniCode 灵魂：tool loop）=====
const AGENT_MAX_ROUNDS = 4;

/** 生成给 LLM 的工具清单描述 */
function toolCatalogFor(enableSearch) {
  return Object.entries(TOOLS)
    .filter(([name]) => name !== 'web_search' || enableSearch) // 搜索关闭时不暴露该工具
    .map(([name, t]) => `- ${name}: ${t.description}`)
    .join('\n');
}

/**
 * Agent 决策 prompt：LLM 一次性输出完整计划（plan-then-execute，对弱模型更稳）
 *   {"action":"final","reply":"..."}   ← 无需工具（问答/闲聊）
 *   {"action":"plan","steps":[
 *      {"tool":"create_todo","args":{"title":"写论文","priority":"high"}},
 *      {"tool":"create_reminder","args":{"title":"每天提醒写论文","cron":"0 9 * * *"}}
 *   ]}
 */
const AGENT_SYSTEM = `你是 WorkBuddy 本地智能助手的规划器。分析用户消息，只输出一个 JSON 对象（不要 Markdown 包裹、不要解释）。

可用工具：
{TOOLS}

两种输出格式：

A. 问答/闲聊/建议，不需要工具操作数据：
{"action":"final","reply":"用一句话说明回答方向（如：介绍上海的城市概况）"}
注意：reply 只是方向提示，系统会据此生成完整流式回答；写简短即可

B. 用户要执行操作（可多个）：
{"action":"plan","steps":[
  {"tool":"工具名","args":{"参数":"值"}},
  {"tool":"工具名","args":{"参数":"值"}}
]}

规则：
1. steps 按用户提到的操作顺序排列；同一动作只出现一次
2. args 从用户原话精确提取：title 取引号内或动词后的核心名词原文，禁止发明、禁止用代词（如"它"）
3. 涉及实时信息/外部知识用 web_search，query=完整搜索词
4. 纯知识问答/闲聊/建议用格式 A 直接回答，不要强行调用工具
5. PPT 类请求（做/生成/修改PPT、确认大纲）：
   - 新主题 → 只调用 ppt_outline，args: {"topic":"主题"}。绝不连续调用多个 ppt 工具——PPT 是分阶段流程，每步要等用户确认
   - 用户说"确认/可以/没问题"且存在进行中的草稿 → 调用 ppt_confirm
   - 用户选主题风格（商务蓝/极简白/科技黑/活力橙）→ ppt_theme
   - "第X页改成…/第X页展开讲讲" → ppt_edit_page
   - "加一页讲XX/新增一页XX" → ppt_add_page，args: {"topic":"XX"}
   - "删掉第X页" → ppt_edit_page（用户意图删除时在 message 里说明即可）
   - "导出/下载 PPT" → ppt_generate
6. 需求有歧义/缺关键参数/多种理解都可能时 → 调用 ask_clarification，args: {"question":"你的追问"}，一次只问一个最关键的问题。宁可问清楚也不要猜错后执行危险操作（如删除、生成大文件）
7. PRD 类请求（需求文档/需求分析/PRD）：
   - 新需求 → 只调用 prd_generate，args: {"topic":"需求主题"}
   - "确认/导出" → prd_confirm
   - "审查/优化建议" → prd_review
8. 只输出 JSON`;

/**
 * 解析 LLM 的 agent 计划 JSON
 */
function parseAgentDecision(text) {
  const j = safeParseJson(text);
  if (!j) return null;
  if (j.action === 'final') return { action: 'final', reply: String(j.reply || '') };
  if (j.action === 'plan' && Array.isArray(j.steps)) {
    const steps = j.steps
      .filter((s) => s && TOOLS[s.tool])
      .slice(0, AGENT_MAX_ROUNDS)
      .map((s) => ({ tool: s.tool, args: s.args || {} }));
    if (steps.length) return { action: 'plan', steps };
  }
  return null;
}

/**
 * Plan-then-Execute：
 * LLM 一次输出完整计划 → 逐步执行每个工具 → 汇总结果
 */
async function runAgentLoop(userId, message, opts = {}) {
  const enableSearch = !!opts.enableSearch;
  const onDelta = (opts && typeof opts.onDelta === 'function') ? opts.onDelta : null;
  const onStep = (opts && typeof opts.onStep === 'function') ? opts.onStep : null;

  // 注入 PPT + PRD 草稿状态（规划器需要知道"是否存在进行中的草稿"才能正确路由）
  let draftContext = '';
  try {
    const d = require('./ppt').getDraft(userId);
    if (d) draftContext += `\n[当前状态] 用户有一个进行中的PPT草稿：《${d.title}》（${d.pages.length} 页，阶段：${d.stage}）。用户此时说"确认/可以/好的"就是在推进这个流程。`;
    const pd = require('./prd').getDraft(userId);
    if (pd) draftContext += `\n[当前状态] 用户有一个进行中的PRD草稿：《${pd.title}》（${pd.features.length}个功能模块）。用户此时说"确认"就是在导出。`;
  } catch (_) {}

  // 确定性指令快通道
  const trimmed = message.trim();
  // PPT 确认
  if (draftContext.includes('PPT草稿') && /^(确认|确定|可以|好的?|ok|yes|继续)[。！!。\s]*$/i.test(trimmed)) {
    logger.info('agent: fast-path ppt-confirm');
    const r = await executeToolSafe('ppt_confirm', { intent: 'ppt_confirm' }, userId, message, { onDelta, onStep });
    if (onDelta && r.summary) onDelta(r.summary);
    return { intent: 'ppt_confirm', confidence: 1, reply: r.summary || '✅ 已确认', data: null, steps: r.steps || [] };
  }
  // PRD 确认（导出 Markdown）
  if (draftContext.includes('PRD草稿') && /^(确认|确定|可以|导出|好的?|ok|yes|继续)[。！!。\s]*$/i.test(trimmed)) {
    logger.info('agent: fast-path prd-confirm');
    const r = await executeToolSafe('prd_confirm', { intent: 'prd_confirm' }, userId, message, { onDelta, onStep });
    if (onDelta && r.summary) onDelta(r.summary);
    return { intent: 'prd_confirm', confidence: 1, reply: r.summary || '📄 已导出', data: null, steps: r.steps || [] };
  }
  // 设计阶段选主题快通道：纯主题词直接走 ppt_theme
  if (/^(商务蓝|极简白|科技黑|活力橙|[1-4])[。！!。\s]*$/.test(trimmed)) {
    try {
      const pd = require('./ppt').getDraft(userId);
      if (pd && pd.stage === 'design_pending') {
        logger.info('agent: fast-path theme');
        const r = await executeToolSafe('ppt_theme', { intent: 'ppt_theme' }, userId, message, { onDelta, onStep });
        if (onDelta && r.summary) onDelta(r.summary);
        return { intent: 'ppt_theme', confidence: 1, reply: r.summary || '🎨 已应用主题', data: null, steps: r.steps || [] };
      }
    } catch (_) {}
  }

  // 1. 让 LLM 出计划（非流式）
  let raw;
  try {
    const c = llm.getClient();
    if (!c) return null; // LLM 不可用 → 走旧路径
    const resp = await c.chat.completions.create({
      model: llm.resolveConfig().model,
      messages: [
        { role: 'system', content: AGENT_SYSTEM.replace('{TOOLS}', toolCatalogFor(enableSearch)) + draftContext },
        { role: 'user', content: message },
      ],
      temperature: 0.2,
      max_tokens: 500,
    });
    raw = resp.choices?.[0]?.message?.content || '';
    if (resp.usage && resp.usage.total_tokens) {
      llm.recordUsage({
        model: llm.resolveConfig().model,
        prompt_tokens: resp.usage.prompt_tokens,
        completion_tokens: resp.usage.completion_tokens,
        total_tokens: resp.usage.total_tokens,
        userId, intent: 'agent_plan',
      });
    }
  } catch (e) {
    logger.warn('agent plan failed:', e.message);
    return null; // LLM 失败 → 走旧路径兜底
  }

  // 2. 解析计划
  const decision = parseAgentDecision(raw);
  if (!decision) {
    // JSON 无效但 LLM 输出了文字 → 当 final 回复
    if (raw && raw.trim().length > 2 && !raw.trim().startsWith('{')) {
      const text = raw.trim();
      if (onDelta) onDelta(text);
      return { intent: 'agent', confidence: 1, reply: text, data: null, steps: [] };
    }
    return null; // 无法理解 → 走旧路径
  }

  // 3a. final：需要 LLM 回答的问答/闲聊 → 用 chatStream 真流式生成完整回答
  //     （规划器的 reply 只是方向提示；把提示并入 user 消息让二段模型展开）
  if (decision.action === 'final') {
    const planned = decision.reply || '';
    try {
      const r = await llm.chatStream(
        [
          { role: 'system', content: '你是 WorkBuddy 本地智能助手。中文、简洁友好、自然回答。' },
          { role: 'user', content: planned && planned !== message ? `${message}\n\n（回答方向：${planned}）` : message },
        ],
        { temperature: 0.7, max_tokens: 400, userId, intent: 'chat' },
        onDelta
      );
      const text = r.ok ? r.text : (planned || '⚠️ ' + r.error);
      if (!r.ok && onDelta && text) onDelta(text);
      return { intent: 'chat', confidence: 1, reply: text, data: null, steps: [] };
    } catch (_) {
      if (onDelta && planned) onDelta(planned);
      return { intent: 'chat', confidence: 1, reply: planned, data: null, steps: [] };
    }
  }

  // 3b. plan：顺序执行每个步骤
  const allSteps = [];
  const results = [];
  let lastIntent = 'agent';
  for (const step of decision.steps) {
    const fakeIntent = { intent: step.tool, ...step.args };
    const exec = await executeToolSafe(step.tool, fakeIntent, userId, message, { onDelta, onStep });
    allSteps.push(...(exec.steps || []));
    lastIntent = step.tool;
    // PPT/PRD 类工具的 summary 是给用户看的主要内容（大纲/PRD预览），不截断
    // 其他工具防超长兜底 600；工具名前缀在下面剥离，这里只存 summary
    const isLongForm = step.tool.startsWith('ppt_') || step.tool.startsWith('prd_');
    results.push({ tool: step.tool, summary: exec.summary || 'done', longForm: isLongForm });
  }

  // 4. 汇总最终回复（多步时用分隔线，单步直接展示内容避免"已完成1个操作"噪音）
  let reply;
  if (results.length === 1) {
    reply = results[0].summary;
  } else {
    reply = results.map((r) => `• ${r.tool}: ${r.summary.slice(0, 300)}`).join('\n');
  }
  if (onDelta) onDelta(reply);
  return { intent: lastIntent, confidence: 1, reply, data: null, steps: allSteps };
}

/** 安全执行单个工具（复用 TOOLS 注册表） */
async function executeToolSafe(name, intent, userId, message, opts = {}) {
  const tool = TOOLS[name];
  if (!tool) return { summary: `未知工具 ${name}`, steps: [] };
  try {
    const r = await tool.handler({ intent, userId, message, onDelta: opts.onDelta });
    if (opts.onStep && r.steps && r.steps.length) {
      for (const s of r.steps) { try { opts.onStep(s); } catch (_) {} }
    }
    return r;
  } catch (e) {
    logger.error('agent tool failed:', name, e.message);
    return { summary: `⚠️ ${name} 执行出错：${e.message}`, steps: [] };
  }
}

// ===== 主入口 =====
async function chat(userId, message, opts = {}) {
  const enableSearch = !!(opts && opts.enableSearch);
  const onDelta = (opts && typeof opts.onDelta === 'function') ? opts.onDelta : null;

  // ===== Agentic 路径（默认）：LLM 可用时走工具循环 =====
  const cfg = llm.resolveConfig();
  if (cfg.apiKey) {
    const agentResult = await runAgentLoop(userId, message, { enableSearch, onDelta, onStep: opts.onStep });
    if (agentResult) {
      logger.info(`agent: "${message}" → ${agentResult.intent} (${(agentResult.steps || []).length} steps)`);
      remember(userId, message, { intent: agentResult.intent });
      return agentResult;
    }
    // agentResult === null → LLM 失败，降级到旧路径
    logger.warn('agent loop unavailable, falling back to classify path');
  }

  // ===== 旧路径（降级保底）：分类 → 单工具执行 =====
  const intent = await classifyIntent(message, userId);
  logger.info(`nlp: "${message}" → ${intent.intent} (${intent.confidence}) search=${enableSearch}`);

  // 写记忆（包括失败的情况也记，方便后续分析）
  remember(userId, message, intent);

  // classify 失败（LLM 错误）→ 友好提示
  if (intent.error) {
    if (onDelta) onDelta('⚠️ 助手暂时连不上：' + intent.error);
    return {
      intent: 'error',
      confidence: 0,
      reply: '⚠️ 助手暂时连不上：' + intent.error + '\n\n试试：明天下午3点开会 / 提醒我买牛奶 / 今日日报',
      data: null,
    };
  }

  // LLM 判 unknown 或低置信度 → 交给 LLM 兜底闲聊（默认走 LLM 模式）
  if (intent.intent === 'unknown') {
    if (intent.error) {
      // 本地兜底也无结果：仍然 LLM 闲聊兜底，但提示可操作命令
      const reply = '⚠️ 本地规则未识别，但我会尽力回答。如果你要管理待办，可以说："明天下午3点开会"、"提醒我买牛奶"、"今日日报"。';
      if (onDelta) onDelta(reply);
      return { intent: 'unknown', confidence: intent.confidence || 0, reply, data: null };
    }
    // 正常 LLM unknown → 走 chat 兜底
    intent.intent = 'chat';
  }

  // 联网搜索开关关闭时：web_search 意图降级为提示（直接返回，不重新生成）
  if (intent.intent === 'web_search' && !enableSearch) {
    const reply = '🔌 联网搜索已关闭。点击对话右上角的「联网」开关，我就能帮你查实时信息了。\n\n（或者直接告诉我你想了解什么，我可以先聊聊）';
    if (onDelta) onDelta(reply);
    return {
      intent: 'web_search_off',
      confidence: intent.confidence,
      reply,
      data: null,
    };
  }

  if (intent.intent === 'web_search') {
    const reply = await handleWebSearch(intent.query || intent.title || message, userId, onDelta);
    return { intent: 'web_search', confidence: intent.confidence, reply, data: null };
  }

  if (intent.intent === 'chat') {
    // 直接 LLM 闲聊（流式）
    const sys = '你是 WorkBuddy 本地智能助手。如果用户是在管理待办/日程/提醒，请用对应能力完成；如果是普通问题（知识/闲聊/建议），直接自然回答，不要生硬推送功能。中文、简洁友好。';
    if (onDelta) {
      const r = await llm.chatStream(
        [
          { role: 'system', content: sys },
          { role: 'user', content: message },
        ],
        { temperature: 0.7, max_tokens: 400, userId, intent: 'chat' },
        onDelta
      );
      return { intent: 'chat', confidence: 1, reply: r.ok ? r.text : '⚠️ ' + r.error, data: null };
    }
    // 无流式回调：走普通 chat
    const r = await llm.chat(
      [
        { role: 'system', content: sys },
        { role: 'user', content: message },
      ],
      { temperature: 0.7, max_tokens: 400, userId, intent: 'chat' }
    );
    return { intent: 'chat', confidence: 1, reply: r.ok ? r.text : '⚠️ ' + r.error, data: null };
  }

  const exec = await executeIntent(intent, userId, message, {
    onDelta,
    onStep: (opts && typeof opts.onStep === 'function') ? opts.onStep : null,
  });
  // 工具类操作没有流式 LLM 输出 → 把 summary 作为一次性 delta 发出，保证前端能渲染
  if (onDelta && exec.summary && !exec._deltaSent) onDelta(exec.summary);
  return {
    intent: intent.intent,
    confidence: intent.confidence,
    reply: exec.summary,
    data: exec.data,
    steps: exec.steps || [],
  };
}

// ===== 长期记忆 =====
function ensureMemoryTable() {
  db.rawDb().run(`
    CREATE TABLE IF NOT EXISTS ai_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function remember(userId, message, intent) {
  try {
    ensureMemoryTable();
    const now = db.nowIso();
    // 简单策略：每次对话记一条 KV（key=last_intent, value=intent名+时间）
    db.rawDb().run(
      'INSERT INTO ai_memory (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
      [userId, `last_intent_${Date.now()}`, `${intent.intent}: ${message.slice(0, 100)}`, now]
    );
    // 保留每个用户最近 50 条记忆
    db.rawDb().run(
      `DELETE FROM ai_memory WHERE user_id = ? AND key NOT IN (
        SELECT key FROM ai_memory WHERE user_id = ? ORDER BY id DESC LIMIT 50
      )`,
      [userId, userId]
    );
  } catch (e) {
    logger.warn('remember failed:', e.message);
  }
}

function getMemories(userId, limit = 10) {
  try {
    const r = db.rawDb().exec(
      'SELECT key, value, updated_at FROM ai_memory WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [userId, limit]
    );
    if (!r.length) return [];
    return r[0].values.map((row) => ({ key: row[0], value: row[1], updated_at: row[2] }));
  } catch (_) { return []; }
}

module.exports = {
  parseTime,
  classifyIntent,
  offlineClassify,
  safeParseJson,
  extractPageNo,
  chat,
  getMemories,
  inferCronFromMessage,
  executeIntent,
};
