'use strict';

const express = require('express');
const sandbox = require('../services/sandbox');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const r = await sandbox.gitWorktreeList(req.user.id);
  res.status(r.ok ? 200 : 500).json(r);
});

router.post('/', async (req, res) => {
  const { path: wtPath, branch, fullAccess } = req.body || {};
  if (!wtPath) return res.status(400).json({ error: 'path 必填' });
  const r = await sandbox.gitWorktreeAdd(req.user.id, wtPath, branch, { fullAccess: !!fullAccess });
  res.status(r.ok ? 201 : 400).json(r);
});

router.delete('/', async (req, res) => {
  const { path: wtPath, fullAccess } = req.body || {};
  if (!wtPath) return res.status(400).json({ error: 'path 必填' });
  const r = await sandbox.gitWorktreeRemove(req.user.id, wtPath, { fullAccess: !!fullAccess });
  res.status(r.ok ? 200 : 400).json(r);
});

module.exports = router;
