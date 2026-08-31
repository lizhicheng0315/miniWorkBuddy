'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.use(requireAuth);

// 今日仪表盘概览
router.get('/dashboard', (req, res) => {
  const rows = db.list('todos', null, req.user.id);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(todayStart.getTime() + 86400000);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // 周日
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);

  const pending = rows.filter((t) => t.status === 'open');
  const overdue = pending.filter((t) => t.due_at && new Date(t.due_at) < todayStart);
  const dueToday = pending.filter((t) => {
    const d = new Date(t.due_at);
    return t.due_at && d >= todayStart && d < todayEnd;
  });
  const highPriority = pending.filter((t) => t.priority === 1);
  const completedToday = rows.filter((t) => t.status === 'done' && t.completed_at && new Date(t.completed_at) >= todayStart);
  const completedThisWeek = rows.filter((t) => t.status === 'done' && t.completed_at && new Date(t.completed_at) >= weekStart && new Date(t.completed_at) < weekEnd);
  const doneAll = rows.filter((t) => t.status === 'done');
  const totalActive = rows.filter((t) => t.status !== 'archived');

  res.json({
    pending: pending.length,
    overdue: overdue.length,
    dueToday: dueToday.length,
    highPriority: highPriority.length,
    completedToday: completedToday.length,
    completedThisWeek: completedThisWeek.length,
    doneRate: totalActive.length ? Math.round((doneAll.length / totalActive.length) * 100) : 0,
    overdueTasks: overdue.slice(0, 5).map((t) => ({ id: t.id, title: t.title, priority: t.priority, due_at: t.due_at })),
    dueTodayTasks: dueToday.slice(0, 5).map((t) => ({ id: t.id, title: t.title, priority: t.priority })),
  });
});

// AI 每日简报（基于今日任务生成建议）
router.get('/daily-brief', async (req, res) => {
  const llm = require('../services/llm');
  if (!llm.resolveConfig().apiKey) return res.json({ brief: '配置 LLM 后可生成每日简报' });
  const rows = db.list('todos', null, req.user.id);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const pending = rows.filter((t) => t.status === 'open');
  const overdue = pending.filter((t) => t.due_at && new Date(t.due_at) < todayStart);
  const dueToday = pending.filter((t) => {
    const d = new Date(t.due_at);
    return t.due_at && d >= todayStart && d < new Date(todayStart.getTime() + 86400000);
  });
  const highP = pending.filter((t) => t.priority === 1);
  const completedToday = rows.filter((t) => t.status === 'done' && t.completed_at && new Date(t.completed_at) >= todayStart);
  const taskSummary = `今日待办: ${pending.length}条(过期${overdue.length}, 今日截止${dueToday.length}, 高优${highP.length}); 已完成: ${completedToday.length}条。`
    + `\n过期任务: ${overdue.map((t) => t.title).join('、') || '无'}`
    + `\n高优任务: ${highP.slice(0, 5).map((t) => t.title + (t.due_at ? '(' + new Date(t.due_at).toLocaleDateString() + ')' : '')).join('、') || '无'}`;
  try {
    const r = await llm.chat([
      { role: 'system', content: '你是个人工作助手。根据今日任务数据，给出简洁的一日工作建议（2-4句），包括：优先处理什么、需要关注的过期任务、今天的目标建议。语气友好、具体、可执行。' },
      { role: 'user', content: taskSummary },
    ], { temperature: 0.5, max_tokens: 300, userId: req.user.id, intent: 'daily_brief' });
    res.json({ brief: r.ok ? r.text : '生成失败: ' + r.error, stats: { pending: pending.length, overdue: overdue.length, completedToday: completedToday.length } });
  } catch (e) {
    res.json({ brief: '简报生成失败: ' + e.message });
  }
});

// 待办列表
router.get('/', (req, res) => {
  const { status, category } = req.query;
  const rows = db.list(
    'todos',
    (t) => {
      if (status && t.status !== status) return false;
      if (category && t.category !== category) return false;
      return true;
    },
    req.user.id
  );
  rows.sort((a, b) => (a.priority || 2) - (b.priority || 2));
  res.json(rows);
});

// 分类列表（去重）
router.get('/categories', (req, res) => {
  const rows = db.list('todos', null, req.user.id);
  const cats = [...new Set(rows.map((t) => t.category).filter(Boolean))].sort();
  res.json(cats);
});

// 批量操作
router.post('/batch', (req, res) => {
  const { ids, action, priority } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids 必填' });
  const allowed = ['complete', 'delete', 'priority'];
  if (!allowed.includes(action)) return res.status(400).json({ error: 'action 必须是 complete/delete/priority' });
  let count = 0;
  for (const id of ids) {
    const numId = Number(id);
    if (action === 'complete') {
      const cur = db.find('todos', numId, req.user.id);
      if (cur && cur.status !== 'done') {
        db.update('todos', numId, { status: 'done', completed_at: db.nowIso(), updated_at: db.nowIso() }, req.user.id);
        count++;
      }
    } else if (action === 'delete') {
      if (db.remove('todos', numId, req.user.id)) count++;
    } else if (action === 'priority') {
      const p = Number(priority) || 2;
      if (db.update('todos', numId, { priority: p, updated_at: db.nowIso() }, req.user.id)) count++;
    }
  }
  res.json({ ok: true, count });
});

router.post('/', (req, res) => {
  const { title, notes, priority, category, due_at } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'title 必填' });
  }
  const row = db.insert('todos', {
    user_id: req.user.id,
    title: String(title).trim(),
    notes: notes || '',
    priority: Number.isFinite(priority) ? priority : 2,
    category: category || '',
    due_at: due_at || null,
    status: 'open',
  });
  res.status(201).json(row);
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.find('todos', id, req.user.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const fields = ['title', 'notes', 'priority', 'category', 'due_at', 'status'];
  const patch = {};
  for (const f of fields) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
      patch[f] = req.body[f];
    }
  }
  if (patch.status === 'done' && cur.status !== 'done') {
    patch.completed_at = db.nowIso();
  } else if (patch.status === 'open') {
    patch.completed_at = null;
  }
  patch.updated_at = db.nowIso();
  res.json(db.update('todos', id, patch, req.user.id));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.remove('todos', id, req.user.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

module.exports = router;
