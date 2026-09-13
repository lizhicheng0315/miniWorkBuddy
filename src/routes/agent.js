'use strict';

/**
 * Local Agent API（仿 Codex app-server 的 HTTP 面）：
 *   - 外部客户端可以用 HTTP/JSON 或 SSE 驱动同一个 Agent 内核
 *   - 复用 nlp.chat、chatstore、approvals、sandbox 等能力
 */

const express = require('express');
const nlp = require('../services/nlp');
const chatstore = require('../services/chatstore');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function runOptions(req) {
  const body = req.body || {};
  return {
    enableSearch: !!body.enableSearch,
    deepThink: !!body.deepThink,
    planMode: !!body.planMode,
    approvalMode: body.approvalMode || 'auto',
    model: body.model || undefined,
    goal: body.goal || '',
    outcomes: body.outcomes || '',
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    images: Array.isArray(body.images) ? body.images : [],
  };
}

router.get('/sessions', (req, res) => {
  res.json({ items: chatstore.listSessions(req.user.id) });
});

router.post('/sessions', (req, res) => {
  const s = chatstore.createSession(req.user.id, (req.body || {}).title);
  res.status(201).json(s);
});

router.get('/sessions/:id/messages', (req, res) => {
  const msgs = chatstore.getMessages(req.user.id, req.params.id);
  if (msgs === null) return res.status(404).json({ error: '会话不存在' });
  res.json({ items: msgs });
});

router.post('/sessions/:id/messages', (req, res) => {
  const { role, content, intent } = req.body || {};
  if (!['user', 'bot'].includes(role)) return res.status(400).json({ error: 'role 必须是 user 或 bot' });
  const r = chatstore.addMessage(req.user.id, req.params.id, role, content, intent);
  if (!r) return res.status(404).json({ error: '会话不存在' });
  res.status(201).json({ ok: true, msgId: r.msgId });
});

router.post('/run', async (req, res) => {
  const message = (req.body || {}).message || (req.body || {}).prompt;
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'message 必填' });
  try {
    const r = await nlp.chat(req.user.id, String(message), runOptions(req));
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/run/stream', async (req, res) => {
  const message = (req.body || {}).message || (req.body || {}).prompt;
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'message 必填' });
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15_000);
  try {
    const r = await nlp.chat(req.user.id, String(message), {
      ...runOptions(req),
      onDelta: (text) => write('delta', { text }),
      onStep: (step) => write('tool', step),
      onThought: (step) => write('thought', step),
      onApproval: (approval) => write('approval', approval),
    });
    write('done', { ok: true, result: r });
  } catch (e) {
    write('error', { error: e.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

module.exports = router;
