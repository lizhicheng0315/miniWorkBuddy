'use strict';

const express = require('express');
const mcp = require('../services/mcp');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// OAuth 回调是浏览器重定向，必须放在 requireAuth 之前（用 state 识别用户）
router.get('/oauth/callback', async (req, res) => {
  try {
    const r = await require('../services/mcpOAuth').handleCallback(req.query.code, req.query.state);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<html><body style="font-family:system-ui;padding:40px"><h2>MCP 授权成功</h2><p>' + r.name + ' 已完成 OAuth 授权，可以关闭此窗口。</p></body></html>');
  } catch (e) {
    res.status(400).send('<html><body style="font-family:system-ui;padding:40px"><h2>MCP 授权失败</h2><p>' + e.message + '</p></body></html>');
  }
});

router.use(requireAuth);

router.get('/servers', (req, res) => {
  res.json({ items: mcp.status(req.user.id) });
});

router.post('/servers', (req, res) => {
  try {
    const server = mcp.upsertServer(req.user.id, req.body || {});
    res.status(201).json(server);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/servers/:name', (req, res) => {
  mcp.removeServer(req.user.id, req.params.name);
  res.json({ ok: true });
});

router.post('/servers/:name/connect', async (req, res) => {
  try {
    const conf = mcp.listConfigs(req.user.id).find((s) => s.name === req.params.name);
    if (!conf) return res.status(404).json({ error: 'MCP server 不存在' });
    const conn = await mcp.connect(req.user.id, conf);
    res.json({ ok: true, connected: !!conn });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/servers/:name/disconnect', (req, res) => {
  res.json({ ok: true, disconnected: mcp.disconnect(req.user.id, req.params.name) });
});

router.post('/servers/:name/oauth/start', (req, res) => {
  const conf = mcp.listConfigs(req.user.id).find((s) => s.name === req.params.name);
  if (!conf) return res.status(404).json({ error: 'MCP server 不存在' });
  try {
    res.json(require('../services/mcpOAuth').start(req.user.id, conf));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/servers/:name/discover', async (req, res) => {
  try {
    res.json(await require('../services/mcpOAuth').discover(req.user.id, req.params.name));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/servers/:name/tools', async (req, res) => {
  try {
    const tools = await mcp.listTools(req.user.id, req.params.name);
    res.json({ items: tools });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/servers/:name/call', async (req, res) => {
  const { tool, arguments: args } = req.body || {};
  if (!tool) return res.status(400).json({ error: 'tool 必填' });
  try {
    const r = await mcp.callTool(req.user.id, req.params.name, tool, args || {});
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
