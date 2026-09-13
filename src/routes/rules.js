'use strict';

const express = require('express');
const rules = require('../services/rules');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({ files: rules.list(req.user.id) });
});

router.get('/file', (req, res) => {
  res.json(rules.get(req.user.id, req.query.path));
});

router.put('/', (req, res) => {
  try {
    const body = req.body || {};
    res.json(rules.save(req.user.id, body.content || '', body.path || 'AGENTS.md'));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
