'use strict';

const express = require('express');
const review = require('../services/review');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/status', async (req, res) => {
  try {
    const ctx = await review.collect(req.user.id, req.query.base);
    res.json({
      has_changes: ctx.hasChanges,
      status: ctx.status,
      stat: ctx.stat,
      diff: ctx.diff.slice(0, 60_000),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/diff', async (req, res) => {
  try {
    const ctx = await review.collect(req.user.id, req.query.base);
    res.json({ diff: ctx.diff, stat: ctx.stat, status: ctx.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/files', async (req, res) => {
  try {
    res.json({ items: await review.files(req.user.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/stage', async (req, res) => {
  const file = (req.body || {}).path;
  if (!file) return res.status(400).json({ error: 'path 必填' });
  const sandbox = require('../services/sandbox');
  const r = await sandbox.gitStageFile(req.user.id, file);
  res.status(r.ok ? 200 : 400).json(r);
});

router.post('/unstage', async (req, res) => {
  const file = (req.body || {}).path;
  if (!file) return res.status(400).json({ error: 'path 必填' });
  const sandbox = require('../services/sandbox');
  const r = await sandbox.gitUnstageFile(req.user.id, file);
  res.status(r.ok ? 200 : 400).json(r);
});

router.post('/discard', async (req, res) => {
  const { path: file, fullAccess } = req.body || {};
  if (!file) return res.status(400).json({ error: 'path 必填' });
  const sandbox = require('../services/sandbox');
  const r = await sandbox.gitDiscardFile(req.user.id, file, { fullAccess: !!fullAccess });
  res.status(r.ok ? 200 : 400).json(r);
});

router.get('/hunks', async (req, res) => {
  const file = req.query.path;
  if (!file) return res.status(400).json({ error: 'path 必填' });
  try {
    res.json(await review.hunks(req.user.id, file));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/stage-hunks', async (req, res) => {
  const { path: file, indexes } = req.body || {};
  if (!file || !Array.isArray(indexes)) return res.status(400).json({ error: 'path / indexes 必填' });
  const r = await review.stageHunks(req.user.id, file, indexes);
  res.status(r.ok ? 200 : 400).json(r);
});

router.post('/unstage-hunks', async (req, res) => {
  const { path: file, indexes } = req.body || {};
  if (!file || !Array.isArray(indexes)) return res.status(400).json({ error: 'path / indexes 必填' });
  const r = await review.unstageHunks(req.user.id, file, indexes);
  res.status(r.ok ? 200 : 400).json(r);
});

router.post('/discard-hunks', async (req, res) => {
  const { path: file, indexes, fullAccess } = req.body || {};
  if (!file || !Array.isArray(indexes)) return res.status(400).json({ error: 'path / indexes 必填' });
  const r = await review.discardHunks(req.user.id, file, indexes, { fullAccess: !!fullAccess });
  res.status(r.ok ? 200 : 400).json(r);
});

router.post('/run', async (req, res) => {
  try {
    const r = await review.run(req.user.id, (req.body || {}).base);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
