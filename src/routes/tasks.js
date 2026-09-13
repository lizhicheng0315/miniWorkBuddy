'use strict';

const express = require('express');
const tasks = require('../services/tasks');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({ items: tasks.list(req.user.id, { limit: req.query.limit, type: req.query.type }) });
});

router.post('/', (req, res) => {
  try {
    res.status(201).json(tasks.create(req.user.id, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  const t = tasks.get(req.user.id, req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  res.json(t);
});

router.post('/:id/cancel', (req, res) => {
  const t = tasks.cancel(req.user.id, req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  res.json(t);
});

router.delete('/:id', (req, res) => {
  if (!tasks.remove(req.user.id, req.params.id)) return res.status(404).json({ error: '任务不存在' });
  res.json({ ok: true });
});

module.exports = router;
