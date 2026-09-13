'use strict';

const express = require('express');
const remote = require('../services/remote');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/hosts', (req, res) => {
  res.json({ items: remote.publicHosts(req.user.id) });
});

router.post('/hosts', (req, res) => {
  try {
    const h = remote.upsertHost(req.user.id, req.body || {});
    res.status(201).json({ name: h.name, baseUrl: h.baseUrl, has_token: !!h.token });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/hosts/:name', (req, res) => {
  remote.removeHost(req.user.id, req.params.name);
  res.json({ ok: true });
});

router.post('/hosts/:name/test', async (req, res) => {
  try {
    res.json(await remote.testHost(req.user.id, req.params.name));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/hosts/:name/run', async (req, res) => {
  const { prompt, planMode, model } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt 必填' });
  try {
    res.json(await remote.runRemote(req.user.id, req.params.name, prompt, { planMode, model }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/hosts/:name/sessions', async (req, res) => {
  try {
    res.json(await remote.listRemoteSessions(req.user.id, req.params.name));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/hosts/:name/handoff', async (req, res) => {
  const sessionId = (req.body || {}).sessionId;
  if (!sessionId) return res.status(400).json({ error: 'sessionId 必填' });
  try {
    res.json(await remote.handoff(req.user.id, req.params.name, sessionId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
