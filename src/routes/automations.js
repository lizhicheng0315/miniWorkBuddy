'use strict';

const express = require('express');
const automations = require('../services/automations');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({ items: automations.list(req.user.id, { status: req.query.status }) });
});

router.post('/', (req, res) => {
  try {
    res.status(201).json(automations.create(req.user.id, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/stats', (req, res) => {
  res.json(automations.stats(req.user.id));
});

router.post('/pause-all', (req, res) => {
  res.json({ ok: true, items: automations.setAllEnabled(req.user.id, false) });
});

router.post('/resume-all', (req, res) => {
  res.json({ ok: true, items: automations.setAllEnabled(req.user.id, true) });
});

router.get('/:id', (req, res) => {
  const item = automations.get(req.user.id, req.params.id);
  if (!item) return res.status(404).json({ error: 'automation 不存在' });
  res.json(item);
});

router.patch('/:id', (req, res) => {
  try {
    const item = automations.update(req.user.id, req.params.id, req.body || {});
    if (!item) return res.status(404).json({ error: 'automation 不存在' });
    res.json(item);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  if (!automations.remove(req.user.id, req.params.id)) return res.status(404).json({ error: 'automation 不存在' });
  res.json({ ok: true });
});

router.post('/:id/duplicate', (req, res) => {
  const item = automations.duplicate(req.user.id, req.params.id);
  if (!item) return res.status(404).json({ error: 'automation 不存在' });
  res.status(201).json(item);
});

router.post('/:id/run', async (req, res) => {
  const item = automations.get(req.user.id, req.params.id);
  if (!item) return res.status(404).json({ error: 'automation 不存在' });
  const r = await automations.execute(req.user.id, item);
  res.status(r.ok ? 200 : 400).json(r);
});

router.get('/:id/runs', (req, res) => {
  const items = automations.runs(req.user.id, req.params.id, req.query.limit);
  if (items === null) return res.status(404).json({ error: 'automation 不存在' });
  res.json({ items });
});

module.exports = router;
