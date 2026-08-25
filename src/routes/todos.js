'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.use(requireAuth);

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
