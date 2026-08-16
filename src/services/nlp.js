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
        'chat', 'config', 'unknown',
      ],
    },
    confidence: { type: 'number' },
    title: { type: 'string' },
    new_value: { type: 'string' },
    target: { type: 'string' },
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
- create_reminder: 重复提醒。"每天9点提醒我X"
- query_reminder: 查提醒
- delete_reminder / update_reminder
- breakdown: 拆解任务。"帮我拆解X"
- daily_report / weekly_report / monthly_review / summarize
- chat: 闲聊或问答。"你好"/"你能做什么"

规则：
1. "每天/每周/工作日 + 时间 + 提醒我" → create_reminder
2. 具体时间点 + 事件 → create_schedule
3. "把/将 X 改成/推迟到 Y" → update_todo，target=X, new_value=Y
4. 抽取 title（去掉时间词和"提醒我"等前缀）
5. confidence 0-1

只返回 JSON。`;

/**
 * 让 LLM 分类用户意图
 */
async function classifyIntent(message) {
  const cfg = llm.resolveConfig();
  if (!cfg.apiKey) {
    // LLM 未配置：直接走脱机匹配
    return offlineClassify(message) || { intent: 'unknown', confidence: 0, error: '未匹配到任何意图' };
  }
  try {
    const OpenAI = require('openai');
    const c = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 0 });
    const resp = await c.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: 'system', content: INTENT_SYSTEM },
        { role: 'user', content: message },
      ],
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    });
    const text = resp.choices?.[0]?.message?.content || '{}';
    return JSON.parse(text);
  } catch (e) {
    // LLM 调用失败：降级到关键词匹配
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

async function executeIntent(intent, userId, originalMessage) {
  const result = { data: null, summary: '' };
  const title = (intent.title || originalMessage).slice(0, 200);

  switch (intent.intent) {
    case 'create_todo': {
      const row = db.insert('todos', {
        user_id: userId,
        title,
        priority: intent.priority === 'high' ? 1 : intent.priority === 'low' ? 3 : 2,
        status: 'open',
        due_at: refineTime(parseTime(originalMessage)),
      });
      result.data = row;
      result.summary = `✅ 已添加待办：${title}`;
      break;
    }
    case 'create_schedule': {
      const parsed = parseTime(originalMessage);
      if (!parsed) {
        result.summary = '⚠️ 没听出具体时间，请告诉我什么时候（例：明天下午3点）';
        break;
      }
      const remindBeforeMin = 15;
      const row = db.insert('schedule_events', {
        user_id: userId,
        title,
        start_at: parsed.time.toISOString(),
        remind_before_min: remindBeforeMin,
        fired: 0,
      });
      result.summary = `📅 已创建日程：${title}（${parsed.time.toLocaleString()}，提前 ${remindBeforeMin} 分钟提醒）`;
      break;
    }
    case 'create_reminder': {
      // 先尝试 LLM 给的 cron；再尝试 chrono + cron 推断
      let cron = intent.cron;
      if (!cron) cron = inferCronFromMessage(originalMessage);
      if (!cron || !scheduler.isValidCron(cron)) {
        result.summary = '⚠️ 没听出重复规则，试试：每天 9:00 / 工作日 8:30 / 每周一 10:00';
        break;
      }
      const row = db.insert('reminders', {
        user_id: userId,
        title: title.replace(/^提醒我/, '').replace(/^每天.*提醒我/, '').trim() || '提醒',
        cron,
        message: title,
        enabled: 1,
      });
      scheduler.register(row);
      result.summary = `⏰ 已创建提醒：${row.title}（cron: ${cron}）`;
      break;
    }
    case 'query_todo': {
      const open = db.list('todos', (t) => t.status === 'open', userId);
      result.data = open;
      result.summary = open.length
        ? `你有 ${open.length} 个未完成待办：\n` + open.slice(0, 10).map((t, i) => `${i + 1}. ${t.title}${t.due_at ? `（截止 ${new Date(t.due_at).toLocaleDateString()}）` : ''}`).join('\n')
        : '🎉 当前没有未完成待办';
      break;
    }
    case 'query_schedule': {
      const now = new Date();
      const week = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      const events = db.list('schedule_events', (ev) => new Date(ev.start_at) >= now && new Date(ev.start_at) <= week, userId);
      result.data = events;
      result.summary = events.length
        ? `未来 7 天有 ${events.length} 个日程：\n` + events.slice(0, 10).map((e) => `• ${e.title} @ ${new Date(e.start_at).toLocaleString()}`).join('\n')
        : '未来 7 天没有日程';
      break;
    }
    case 'query_reminder': {
      const list = db.list('reminders', null, userId);
      result.data = list;
      result.summary = list.length
        ? `你有 ${list.length} 个提醒：\n` + list.map((r) => `• ${r.title} (${r.cron}) ${r.enabled ? '✅' : '⏸'}`).join('\n')
        : '还没有设置提醒';
      break;
    }
    case 'complete_todo': {
      const target = intent.title || originalMessage.replace(/(完成|做完了|done)/g, '').trim();
      const todos = db.list('todos', (t) => t.status === 'open', userId);
      const hit = findByTitle(todos, target);
      if (!hit) { result.summary = `找不到"${target}"`; break; }
      db.update('todos', hit.id, { status: 'done', completed_at: db.nowIso() }, userId);
      result.summary = `✅ 已完成：${hit.title}`;
      break;
    }
    case 'delete_todo': {
      const target = intent.title || originalMessage.replace(/(删除|删掉|取消)/g, '').trim();
      const todos = db.list('todos', null, userId);
      const hit = findByTitle(todos, target);
      if (!hit) { result.summary = `找不到"${target}"`; break; }
      db.remove('todos', hit.id, userId);
      result.summary = `🗑 已删除：${hit.title}`;
      break;
    }
    case 'update_todo': {
      const target = intent.target || intent.title || originalMessage;
      const newVal = intent.new_value || '';
      const todos = db.list('todos', null, userId);
      const hit = findByTitle(todos, target);
      if (!hit) { result.summary = `找不到"${target}"`; break; }
      // 智能判断 newVal 是时间、优先级、还是新标题
      const timeParsed = parseTime(newVal);
      const update = {};
      if (timeParsed) {
        update.due_at = timeParsed.time.toISOString();
        result.summary = `📝 已将「${hit.title}」截止时间改为 ${timeParsed.time.toLocaleString()}`;
      } else if (/(高|重要|紧急|high)/i.test(newVal)) {
        update.priority = 1;
        result.summary = `📝 已将「${hit.title}」优先级设为高`;
      } else if (/(中|medium)/i.test(newVal)) {
        update.priority = 2;
        result.summary = `📝 已将「${hit.title}」优先级设为中`;
      } else if (/(低|不急|low)/i.test(newVal)) {
        update.priority = 3;
        result.summary = `📝 已将「${hit.title}」优先级设为低`;
      } else if (newVal) {
        update.title = newVal;
        result.summary = `📝 已将待办改为「${newVal}」`;
      } else {
        result.summary = '⚠️ 没听出要改成什么';
        break;
      }
      db.update('todos', hit.id, update, userId);
      break;
    }
    case 'update_schedule': {
      const target = intent.target || intent.title || originalMessage;
      const newVal = intent.new_value || '';
      const events = db.list('schedule_events', null, userId);
      const hit = findByTitle(events, target);
      if (!hit) { result.summary = `找不到日程"${target}"`; break; }
      const timeParsed = parseTime(newVal);
      if (timeParsed) {
        db.update('schedule_events', hit.id, { start_at: timeParsed.time.toISOString(), fired: 0 }, userId);
        result.summary = `📅 已将「${hit.title}」改到 ${timeParsed.time.toLocaleString()}`;
      } else if (newVal) {
        db.update('schedule_events', hit.id, { title: newVal }, userId);
        result.summary = `📅 已将日程名改为「${newVal}」`;
      } else {
        result.summary = '⚠️ 没听出要改成什么';
      }
      break;
    }
    case 'update_reminder': {
      const target = intent.target || intent.title || originalMessage;
      const newVal = intent.new_value || '';
      const reminders = db.list('reminders', null, userId);
      const hit = findByTitle(reminders, target);
      if (!hit) { result.summary = `找不到提醒"${target}"`; break; }
      const newCron = inferCronFromMessage(newVal) || (newVal && scheduler.isValidCron(newVal) ? newVal : null);
      if (newCron) {
        scheduler.unregister(hit.id);
        db.update('reminders', hit.id, { cron: newCron, enabled: 1 }, userId);
        const r2 = db.find('reminders', hit.id, userId);
        scheduler.register(r2);
        result.summary = `⏰ 已将「${hit.title}」cron 改为 ${newCron}`;
      } else {
        result.summary = '⚠️ 没听出新的 cron';
      }
      break;
    }
    case 'breakdown': {
      const r = await ai.breakdown(intent.title || originalMessage);
      if (r.ok) {
        try {
          const obj = JSON.parse(r.text);
          result.data = obj;
          result.summary = `🧩 **${obj.summary || '任务拆解'}**\n\n` + (obj.steps || []).map((s, i) => `${i + 1}. ${s.step}（约 ${s.estimate_min} 分钟）`).join('\n');
        } catch {
          result.summary = r.text;
        }
      } else {
        result.summary = '⚠️ ' + r.error;
      }
      break;
    }
    case 'daily_report': {
      const r = await ai.dailyReport(userId);
      result.summary = r.ok ? r.text : '⚠️ ' + r.error;
      break;
    }
    case 'weekly_report': {
      const r = await ai.weeklyReport(userId);
      result.summary = r.ok ? r.text : '⚠️ ' + r.error;
      break;
    }
    case 'monthly_review': {
      const r = await ai.monthlyReview(userId);
      result.summary = r.ok ? r.text : '⚠️ ' + r.error;
      break;
    }
    case 'summarize': {
      const r = await ai.summarize(userId);
      result.summary = r.ok ? r.text : '⚠️ ' + r.error;
      break;
    }
    default:
      result.summary = intent.reply || '我能帮你管理待办、日程、提醒，或者聊聊天。试试：明天下午3点开会 / 提醒我买牛奶 / 今日日报';
  }
  return result;
}

// 模糊匹配 todo 标题
function findByTitle(rows, target) {
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
  return best || rows[0]; // 兜底：第一个
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

// ===== 主入口 =====
async function chat(userId, message) {
  const intent = await classifyIntent(message);
  logger.info(`nlp: "${message}" → ${intent.intent} (${intent.confidence})`);

  // 写记忆（包括失败的情况也记，方便后续分析）
  remember(userId, message, intent);

  // classify 失败（LLM 错误）→ 友好提示
  if (intent.error) {
    return {
      intent: 'error',
      confidence: 0,
      reply: '⚠️ 助手暂时连不上：' + intent.error + '\n\n试试：明天下午3点开会 / 提醒我买牛奶 / 今日日报',
      data: null,
    };
  }

  if (intent.intent === 'unknown' || (intent.confidence || 0) < 0.3) {
    return {
      intent: 'unknown',
      confidence: intent.confidence,
      reply: '没太听懂，试试："明天下午3点开会"、"提醒我买牛奶"、"今天日报"、"我还有什么没做"',
      data: null,
    };
  }

  if (intent.intent === 'chat') {
    // 直接 LLM 闲聊
    const r = await llm.chat(
      [
        { role: 'system', content: '你是 WorkBuddy 助手，简洁友好，100 字内回答。可用能力：待办 / 日程 / 提醒 / 今日摘要 / 日报 / 周报 / 月度复盘。' },
        { role: 'user', content: message },
      ],
      { temperature: 0.7, max_tokens: 300 }
    );
    return { intent: 'chat', confidence: 1, reply: r.ok ? r.text : '⚠️ ' + r.error, data: null };
  }

  const exec = await executeIntent(intent, userId, message);
  return {
    intent: intent.intent,
    confidence: intent.confidence,
    reply: exec.summary,
    data: exec.data,
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
  chat,
  getMemories,
  inferCronFromMessage,
  executeIntent,
};
