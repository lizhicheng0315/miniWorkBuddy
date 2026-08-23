'use strict';

const express = require('express');
const chatstore = require('../services/chatstore');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// 会话列表
router.get('/sessions', (req, res) => {
  res.json({ items: chatstore.listSessions(req.user.id) });
});

// 新建会话
router.post('/sessions', (req, res) => {
  const s = chatstore.createSession(req.user.id, (req.body || {}).title);
  res.status(201).json(s);
});

// 某会话全部消息
router.get('/sessions/:id/messages', (req, res) => {
  const msgs = chatstore.getMessages(req.user.id, req.params.id);
  if (msgs === null) return res.status(404).json({ error: '会话不存在' });
  res.json({ items: msgs });
});

// 追加消息（user/bot）
router.post('/sessions/:id/messages', (req, res) => {
  const { role, content, intent } = req.body || {};
  if (!['user', 'bot'].includes(role)) return res.status(400).json({ error: 'role 必须是 user 或 bot' });
  const ok = chatstore.addMessage(req.user.id, req.params.id, role, content, intent);
  if (!ok) return res.status(404).json({ error: '会话不存在' });
  res.status(201).json({ ok: true });
});

// 重命名
router.patch('/sessions/:id', (req, res) => {
  const ok = chatstore.renameSession(req.user.id, req.params.id, (req.body || {}).title || '');
  if (!ok) return res.status(404).json({ error: '会话不存在' });
  res.json({ ok: true });
});

// 删除（连带消息）
router.delete('/sessions/:id', (req, res) => {
  const ok = chatstore.deleteSession(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: '会话不存在' });
  res.json({ ok: true });
});

module.exports = router;
