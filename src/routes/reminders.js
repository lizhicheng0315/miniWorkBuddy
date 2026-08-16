'use strict';

const express = require('express');
const db = require('../db');
const scheduler = require('../services/scheduler');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.list('reminders', null, req.user.id);
  rows.sort((a, b) => b.id - a.id);
  res.json(rows);
});

router.get('/cron-validate', (req, res) => {
  const { expr } = req.query;
  res.json({ valid: scheduler.isValidCron(expr) });
});

router.post('/', (req, res) => {
  const { title, cron: cronExpr, message, enabled } = req.body || {};
  if (!title || !cronExpr) {
    return res.status(400).json({ error: 'title 与 cron 必填' });
  }
  if (!scheduler.isValidCron(cronExpr)) {
    return res.status(400).json({ error: 'cron 表达式无效', hint: '5 段：分 时 日 月 周，例如 0 9 * * *' });
  }
  const row = db.insert('reminders', {
    user_id: req.user.id,
    title: String(title).trim(),
    cron: String(cronExpr).trim(),
    message: message || '',
    enabled: enabled === false ? 0 : 1,
  });
  if (row.enabled) scheduler.register(row);
  res.status(201).json(row);
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.find('reminders', id, req.user.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'cron') && !scheduler.isValidCron(req.body.cron)) {
    return res.status(400).json({ error: 'cron 表达式无效' });
  }
  const fields = ['title', 'cron', 'message', 'enabled'];
  const patch = {};
  for (const f of fields) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
      patch[f] = req.body[f];
    }
  }
  const row = db.update('reminders', id, patch, req.user.id);
  scheduler.unregister(id);
  if (row.enabled) scheduler.register(row);
  res.json(row);
});

router.post('/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.find('reminders', id, req.user.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const next = cur.enabled ? 0 : 1;
  const row = db.update('reminders', id, { enabled: next }, req.user.id);
  if (next) scheduler.register(row);
  else scheduler.unregister(id);
  res.json(row);
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  scheduler.unregister(id);
  if (!db.remove('reminders', id, req.user.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

module.exports = router;
