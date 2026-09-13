'use strict';

const express = require('express');
const sandbox = require('../services/sandbox');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/search', (req, res) => {
  res.json({ items: sandbox.searchFiles(req.user.id, req.query.q || '', req.query.limit) });
});

router.get('/list', (req, res) => {
  try {
    res.json(sandbox.listDir(req.user.id, req.query.path || '.'));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/write', (req, res) => {
  const { path: file, content } = req.body || {};
  if (!file) return res.status(400).json({ error: 'path 必填' });
  try {
    res.json(sandbox.writeFile(req.user.id, file, content || '', { fullAccess: false }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/read', (req, res) => {
  try {
    const r = sandbox.readFile(req.user.id, req.query.path || '', { limit: req.query.limit });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
