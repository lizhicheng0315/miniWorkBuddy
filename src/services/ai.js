'use strict';

const llm = require('./llm');
const db = require('../db');

/**
 * 业务逻辑层。所有"读数据"接口都接收 userId 显式过滤。
 * 路由层把 req.user.id 透传进来，确保多用户隔离。
 */

function todayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  return { start, end };
}

function weekRange() {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 7);
  return { start: monday.toISOString(), end: sunday.toISOString() };
}

function monthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start: first.toISOString(), end: next.toISOString() };
}

function fetchTodaySnapshot(userId) {
  const { start, end } = todayRange();
  const todos = db
    .list('todos', (t) => t.status === 'open' || (t.due_at && t.due_at >= start && t.due_at < end), userId)
    .slice(0, 50)
    .map(({ title, priority, status, due_at, category }) => ({ title, priority, status, due_at, category }));
  const events = db
    .list('schedule_events', (ev) => ev.start_at >= start && ev.start_at < end, userId)
    .map(({ title, start_at, end_at, location }) => ({ title, start_at, end_at, location }));
  const reminders = db
    .list('reminders', (r) => r.enabled, userId)
    .map(({ title, cron, message }) => ({ title, cron, message }));
  return { todos, events, reminders };
}

async function summarize(userId) {
  const snapshot = fetchTodaySnapshot(userId);
  return llm.chat(
    [
      {
        role: 'system',
        content:
          '你是一个高效的个人助理。请基于用户的待办、日程、提醒生成简洁的中文摘要。' +
          '按【今日重点】【日程安排】【重复提醒】【建议】四段输出，控制在 300 字以内。',
      },
      { role: 'user', content: `以下是当前的数据快照（JSON）：\n${JSON.stringify(snapshot, null, 2)}` },
    ],
    { temperature: 0.3, max_tokens: 700 }
  );
}

async function advise(taskText) {
  if (!taskText || !taskText.trim()) return { ok: false, error: '请提供要分析的任务文本' };
  return llm.chat(
    [
      {
        role: 'system',
        content:
          '你是一个务实的工作教练。给定一个任务，请给出：1) 拆解步骤（3-5 条）；' +
          '2) 可能的风险/卡点；3) 一句鼓励。语言简洁中文，200 字内。',
      },
      { role: 'user', content: taskText },
    ],
    { temperature: 0.6, max_tokens: 500 }
  );
}

async function breakdown(taskText) {
  if (!taskText || !taskText.trim()) return { ok: false, error: '请提供要拆解的任务' };
  return llm.chat(
    [
      {
        role: 'system',
        content:
          '你是一个项目管理专家。给定一个任务，把它拆解成可执行子任务。' +
          '要求：1) 子任务用 JSON 数组返回，每项 {step, estimate_min, deps?};' +
          '2) 标明执行顺序（deps 数组里写前置 step 名）；' +
          '3) 同时给出一段 80 字内的中文总览。' +
          '严格用下面的 JSON 格式返回，不要 Markdown 代码块：\n' +
          '{"summary":"...","steps":[{"step":"...","estimate_min":30,"deps":[]},...]}',
      },
      { role: 'user', content: taskText },
    ],
    { temperature: 0.3, max_tokens: 800 }
  );
}

async function dailyReport(userId) {
  const { start, end } = todayRange();
  const completed = db
    .list('todos', (t) => t.status === 'done' && t.completed_at && t.completed_at >= start && t.completed_at < end, userId)
    .map(({ title, priority, category, completed_at }) => ({ title, priority, category, completed_at }));
  const stillOpen = db
    .list('todos', (t) => t.status === 'open' && (!t.due_at || t.due_at < end), userId)
    .map(({ title, priority, due_at }) => ({ title, priority, due_at }));
  const events = db
    .list('schedule_events', (ev) => ev.start_at >= start && ev.start_at < end, userId)
    .map(({ title, start_at, location }) => ({ title, start_at, location }));

  return llm.chat(
    [
      {
        role: 'system',
        content:
          '你是用户的个人助理。基于今日已完成、未完成、日程数据生成一份「今日日报」。' +
          '包含【今日完成】【未完成 / 推迟】【明日建议】三部分，中文 250 字内。',
      },
      { role: 'user', content: JSON.stringify({ completed, stillOpen, events }, null, 2) },
    ],
    { temperature: 0.4, max_tokens: 600 }
  );
}

async function weeklyReport(userId) {
  const { start, end } = weekRange();
  const completed = db
    .list('todos', (t) => t.status === 'done' && t.completed_at && t.completed_at >= start && t.completed_at < end, userId)
    .map(({ title, priority, category, completed_at }) => ({ title, priority, category, completed_at }));
  const stillOpen = db
    .list('todos', (t) => t.status === 'open', userId)
    .map(({ title, priority, due_at, category }) => ({ title, priority, due_at, category }));
  const events = db
    .list('schedule_events', (ev) => ev.start_at >= start && ev.start_at < end, userId)
    .map(({ title, start_at, location }) => ({ title, start_at, location }));
  const byCategory = completed.reduce((acc, t) => {
    const k = t.category || '未分类';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  return llm.chat(
    [
      {
        role: 'system',
        content:
          '你是用户的个人助理。基于本周数据生成一份「周报」。' +
          '包含【本周完成概览】【按分类产出】【未完成 & 风险】【下周建议】四段，中文 400 字内。语气专业但不官方。',
      },
      {
        role: 'user',
        content: JSON.stringify(
          { range: { start, end }, completed_count: completed.length, by_category: byCategory, still_open_count: stillOpen.length, still_open: stillOpen.slice(0, 20), events_count: events.length, sample_completed: completed.slice(0, 20) },
          null,
          2
        ),
      },
    ],
    { temperature: 0.4, max_tokens: 900 }
  );
}

async function monthlyReview(userId) {
  const { start, end } = monthRange();
  const completed = db.list('todos', (t) => t.status === 'done' && t.completed_at && t.completed_at >= start && t.completed_at < end, userId);
  const all = db.list('todos', null, userId);
  const completionRate = all.length === 0 ? null : completed.length / all.length;
  const byCategory = completed.reduce((acc, t) => {
    const k = t.category || '未分类';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const byPriority = completed.reduce((acc, t) => {
    const k = 'p' + (t.priority || 2);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const events = db.list('schedule_events', (ev) => ev.start_at >= start && ev.start_at < end, userId);
  const reminders = db.list('reminders', null, userId);

  return llm.chat(
    [
      {
        role: 'system',
        content:
          '你是用户的个人助理。基于本月数据做「月度复盘」。' +
          '包含【数据概览】【产出分布】【习惯信号】【下月建议】四段，中文 500 字内。要给出有洞察的判断，不只是数字罗列。',
      },
      {
        role: 'user',
        content: JSON.stringify(
          { range: { start, end }, completion_rate: completionRate, completed_count: completed.length, by_category: byCategory, by_priority: byPriority, events_count: events.length, active_reminders: reminders.filter((r) => r.enabled).length },
          null,
          2
        ),
      },
    ],
    { temperature: 0.5, max_tokens: 1000 }
  );
}

module.exports = { summarize, advise, breakdown, dailyReport, weeklyReport, monthlyReview };
