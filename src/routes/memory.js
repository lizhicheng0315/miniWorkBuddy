'use strict';

const express = require('express');
const memory = require('../services/memory');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({ items: memory.list(req.user.id, req.query) });
});

router.post('/', (req, res) => {
  try {
    const item = memory.create(req.user.id, req.body || {});
    res.status(201).json(item);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/stats', (req, res) => {
  res.json(memory.getStats(req.user.id));
});

router.get('/events', (req, res) => {
  res.json({ items: memory.listEvents(req.user.id, req.query.limit) });
});

router.post('/recall', (req, res) => {
  const { query, limit } = req.body || {};
  res.json({ items: memory.recall(req.user.id, query || '', limit) });
});

router.post('/extract', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages 必填' });
  }
  const r = await memory.autoExtract(req.user.id, messages);
  res.status(r.ok ? 200 : 400).json(r);
});

router.get('/:id', (req, res) => {
  const item = memory.getById(req.user.id, req.params.id);
  if (!item) return res.status(404).json({ error: '记忆不存在' });
  res.json(item);
});

router.patch('/:id', (req, res) => {
  try {
    const item = memory.update(req.user.id, req.params.id, req.body || {});
    if (!item) return res.status(404).json({ error: '记忆不存在' });
    res.json(item);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/pin', (req, res) => {
  const item = memory.setPinned(req.user.id, req.params.id, !!(req.body || {}).pinned);
  if (!item) return res.status(404).json({ error: '记忆不存在' });
  res.json(item);
});

router.delete('/:id', (req, res) => {
  if (!memory.remove(req.user.id, req.params.id)) return res.status(404).json({ error: '记忆不存在' });
  res.json({ ok: true });
});

module.exports = router;
