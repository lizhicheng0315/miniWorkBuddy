'use strict';

const express = require('express');
const computer = require('../services/computer');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: '需要 admin 权限' });
  next();
}

router.get('/status', async (req, res) => {
  res.json(await computer.status());
});

router.get('/windows', async (req, res) => {
  const r = await computer.listWindows();
  res.status(r.ok ? 200 : 500).json(r);
});

router.post('/screenshot', async (req, res) => {
  const { windowId } = req.body || {};
  const r = await computer.screenshot({ windowId });
  res.status(r.ok ? 200 : 500).json(r);
});

router.post('/mouse', async (req, res) => {
  const { x, y, action } = req.body || {};
  const r = await computer.mouse(x, y, action);
  res.status(r.ok ? 200 : 500).json(r);
});

router.post('/type', async (req, res) => {
  const { text } = req.body || {};
  const r = await computer.typeText(text);
  res.status(r.ok ? 200 : 400).json(r);
});

router.post('/key', async (req, res) => {
  const { key, modifiers } = req.body || {};
  const r = await computer.pressKey(key, modifiers);
  res.status(r.ok ? 200 : 400).json(r);
});

router.post('/scroll', async (req, res) => {
  const { dx, dy } = req.body || {};
  const r = await computer.scroll(dx, dy);
  res.status(r.ok ? 200 : 500).json(r);
});

router.post('/activate', async (req, res) => {
  const { windowId } = req.body || {};
  const r = await computer.activateWindow(windowId);
  res.status(r.ok ? 200 : 500).json(r);
});

router.post('/launch', requireAdmin, async (req, res) => {
  const { app, args } = req.body || {};
  if (!app) return res.status(400).json({ error: 'app 必填' });
  const r = await computer.launch(app, args);
  res.status(r.ok ? 200 : 400).json(r);
});

router.post('/run', requireAdmin, async (req, res) => {
  const { command } = req.body || {};
  if (!command || !String(command).trim()) return res.status(400).json({ error: 'command 必填' });
  const r = await computer.runCommand(command);
  res.status(r.ok ? 200 : 400).json(r);
});

router.patch('/allow-shell', requireAdmin, (req, res) => {
  const enabled = !!(req.body || {}).enabled;
  res.json({ ok: true, allow_shell: computer.setAllowShell(enabled) });
});

module.exports = router;
