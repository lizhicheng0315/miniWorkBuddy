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

router.get('/search', (req, res) => {
  res.json({ items: chatstore.searchMessages(req.user.id, req.query.q, req.query.limit) });
});

router.get('/projects', (req, res) => {
  res.json({ items: chatstore.listProjects(req.user.id) });
});

// 新建会话
router.post('/sessions', (req, res) => {
  const s = chatstore.createSession(req.user.id, (req.body || {}).title);
  res.status(201).json(s);
});

// LLM 视角上下文：摘要 + 未压缩消息
router.get('/sessions/:id/context', requireAuth, (req, res) => {
  const ctx = chatstore.getContext(req.user.id, req.params.id);
  if (!ctx) return res.status(404).json({ error: '会话不存在' });
  res.json(ctx);
});

router.get('/sessions/:id/context-stats', (req, res) => {
  const stats = chatstore.contextStats(req.user.id, req.params.id);
  if (!stats) return res.status(404).json({ error: '会话不存在' });
  res.json(stats);
});

// 某会话全部消息
router.get('/sessions/:id/messages', (req, res) => {
  const msgs = chatstore.getMessages(req.user.id, req.params.id);
  if (msgs === null) return res.status(404).json({ error: '会话不存在' });
  res.json({ items: msgs });
});

// 追加消息（user/bot），返回消息 id（前端用于压缩水位计算）
router.post('/sessions/:id/messages', (req, res) => {
  const { role, content, intent, meta } = req.body || {};
  if (!['user', 'bot'].includes(role)) return res.status(400).json({ error: 'role 必须是 user 或 bot' });
  const r = chatstore.addMessage(req.user.id, req.params.id, role, content, intent, meta);
  if (!r) return res.status(404).json({ error: '会话不存在' });
  res.status(201).json({ ok: true, msgId: r.msgId, maxId: chatstore.maxMessageId(req.user.id, req.params.id) });
});

// 上下文压缩：把旧消息摘要成一段 summary（DeerFlow SummarizationMiddleware 思路）
router.post('/sessions/:id/summarize', async (req, res) => {
  const { untilId: untilIdReq } = req.body || {};
  const llm = require('../services/llm');
  if (!llm.resolveConfig().apiKey) return res.status(400).json({ error: '摘要压缩需要配置 LLM' });
  // 取未压缩的全部消息
  const ctx = chatstore.getContext(req.user.id, req.params.id);
  if (!ctx) return res.status(404).json({ error: '会话不存在' });
  if (!ctx.messages.length) return res.json({ ok: true, skipped: '没有需要压缩的新消息' });
  const transcript = ctx.messages
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${String(m.content).slice(0, 300)}`)
    .join('\n');
  const r = await llm.chat(
    [
      { role: 'system', content: '你是对话记忆压缩器。把历史对话压缩成一份"记忆摘要"，保留：用户的偏好/目标、已完成的重要操作及其结果、未完成事项、关键上下文。500 字以内，第三人称叙述。只输出摘要正文。' },
      { role: 'user', content: `${ctx.summary ? '已有更早的摘要：\n' + ctx.summary + '\n\n' : ''}新对话记录：\n${transcript}` },
    ],
    { temperature: 0.3, max_tokens: 700, userId: req.user.id, intent: 'context_summarize' }
  );
  if (!r.ok) return res.status(502).json({ error: r.error });
  const untilIdFinal = Number(untilIdReq) > 0 ? Number(untilIdReq) : chatstore.maxMessageId(req.user.id, req.params.id);
  chatstore.saveSummary(req.user.id, req.params.id, r.text.trim(), untilIdFinal);
  res.json({ ok: true, summaryLen: r.text.length, summarizedUntil: untilIdFinal });
});

// 重命名
router.patch('/sessions/:id', (req, res) => {
  const ok = chatstore.renameSession(req.user.id, req.params.id, (req.body || {}).title || '');
  if (!ok) return res.status(404).json({ error: '会话不存在' });
  res.json({ ok: true });
});

router.patch('/sessions/:id/project', (req, res) => {
  const s = chatstore.updateProject(req.user.id, req.params.id, (req.body || {}).project);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  res.json({ ok: true, project: s.project });
});

// 当前会话的工作区环境（Local / Worktree）
router.get('/sessions/:id/environment', (req, res) => {
  const s = chatstore.getSession(req.user.id, req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  res.json({
    workspace_mode: s.workspace_mode || 'local',
    worktree_path: s.worktree_path || null,
    worktree_branch: s.worktree_branch || null,
  });
});

router.patch('/sessions/:id/environment', (req, res) => {
  const s = chatstore.updateEnvironment(req.user.id, req.params.id, req.body || {});
  if (!s) return res.status(404).json({ error: '会话不存在' });
  res.json({
    ok: true,
    workspace_mode: s.workspace_mode || 'local',
    worktree_path: s.worktree_path || null,
    worktree_branch: s.worktree_branch || null,
  });
});

// 创建 worktree 并绑定到当前会话
router.post('/sessions/:id/worktree', async (req, res) => {
  const { path: wtPath, branch, fullAccess } = req.body || {};
  if (!wtPath) return res.status(400).json({ error: 'path 必填' });
  const sandbox = require('../services/sandbox');
  const r = await sandbox.gitWorktreeAdd(req.user.id, wtPath, branch, { fullAccess: !!fullAccess });
  if (!r.ok) return res.status(400).json(r);
  const s = chatstore.updateEnvironment(req.user.id, req.params.id, {
    workspace_mode: 'worktree',
    worktree_path: wtPath,
    worktree_branch: branch || null,
  });
  if (!s) return res.status(404).json({ error: '会话不存在' });
  res.status(201).json({ ok: true, worktree: r, environment: s });
});

// Fork 当前会话（复制消息与工作区绑定）
router.post('/sessions/:id/fork', (req, res) => {
  const s = chatstore.forkSession(req.user.id, req.params.id, (req.body || {}).title);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  res.status(201).json(s);
});

// 删除（连带消息）
router.delete('/sessions/:id', (req, res) => {
  const ok = chatstore.deleteSession(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: '会话不存在' });
  res.json({ ok: true });
});

module.exports = router;
