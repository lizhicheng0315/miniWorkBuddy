'use strict';

const express = require('express');
const ai = require('../services/ai');
const llm = require('../services/llm');
const nlp = require('../services/nlp');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.use(requireAuth);

router.get('/status', (req, res) => {
  const v = llm.getConfigView();
  res.json({ enabled: v.configured, ...v });
});

// ===== LLM 配置（admin only） =====
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: '需要 admin 权限' });
  next();
}

router.get('/config', requireAuth, requireAdmin, (req, res) => {
  res.json(llm.getConfigView());
});

router.patch('/config', requireAuth, requireAdmin, (req, res) => {
  try {
    llm.updateConfig(req.body || {});
    res.json({ ok: true, config: llm.getConfigView() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/config/test', requireAuth, requireAdmin, async (req, res) => {
  const r = await llm.testConnection();
  res.status(r.ok ? 200 : 400).json(r);
});

// ===== LLM token 用量统计（admin only）=====
router.get('/usage', requireAuth, requireAdmin, (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
    const db = require('../db');
    const raw = db.rawDb();
    if (!raw) return res.status(500).json({ error: '数据库不可用' });

    // 汇总（全部时间）
    const totalRes = raw.exec(`SELECT
        COALESCE(SUM(prompt_tokens),0) AS prompt,
        COALESCE(SUM(completion_tokens),0) AS completion,
        COALESCE(SUM(total_tokens),0) AS total,
        COUNT(*) AS calls,
        COUNT(DISTINCT model) AS models
      FROM llm_usage`);
    const totals = totalRes.length ? totalRes[0].values[0] : [0, 0, 0, 0, 0];

    // 按日期（近 N 天）
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const byDayRes = raw.exec(
      `SELECT substr(created_at, 1, 10) AS d,
              COUNT(*) AS calls,
              SUM(prompt_tokens) AS prompt,
              SUM(completion_tokens) AS completion,
              SUM(total_tokens) AS total
       FROM llm_usage
       WHERE created_at >= ?
       GROUP BY d
       ORDER BY d DESC`,
      [since]
    );
    const byDay = (byDayRes[0]?.values || []).map((r) => ({
      date: r[0], calls: r[1], prompt_tokens: r[2], completion_tokens: r[3], total_tokens: r[4],
    }));

    // 按模型
    const byModelRes = raw.exec(
      `SELECT model, COUNT(*) AS calls, SUM(total_tokens) AS total
       FROM llm_usage
       GROUP BY model
       ORDER BY total DESC`
    );
    const byModel = (byModelRes[0]?.values || []).map((r) => ({
      model: r[0], calls: r[1], total_tokens: r[2],
    }));

    res.json({
      totals: {
        prompt_tokens: totals[0],
        completion_tokens: totals[1],
        total_tokens: totals[2],
        calls: totals[3],
        models: totals[4],
      },
      by_day: byDay,
      by_model: byModel,
      days,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 自然语言对话 =====
router.post('/chat', requireAuth, async (req, res) => {
  const { message, enableSearch } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message 必填' });
  }
  try {
    const r = await nlp.chat(req.user.id, message, { enableSearch: !!enableSearch });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/chat/history', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  res.json({ items: nlp.getMemories(req.user.id, limit) });
});

// ===== 联网搜索 =====
router.post('/search', requireAuth, async (req, res) => {
  const { query, count } = req.body || {};
  if (!query || !String(query).trim()) return res.status(400).json({ error: 'query 必填' });
  try {
    const websearch = require('../services/websearch');
    const r = await websearch.search(String(query).trim(), { count: parseInt(count, 10) || 6 });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/chat/stream', requireAuth, async (req, res) => {
  const { message, enableSearch } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message 必填' });
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15_000);

  try {
    write('thinking', { stage: 'classify' });
    const result = await nlp.chat(req.user.id, message, { enableSearch: !!enableSearch });
    write('intent', { intent: result.intent, confidence: result.confidence, data: result.data });
    // 流式输出 reply
    const reply = result.reply || '';
    const chunkSize = 8;
    for (let i = 0; i < reply.length; i += chunkSize) {
      write('delta', { text: reply.slice(i, i + chunkSize) });
      await new Promise((r) => setTimeout(r, 12));
    }
    write('done', { reply });
  } catch (e) {
    write('error', { error: e.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

router.post('/summarize', async (req, res) => {
  const r = await ai.summarize(req.user.id);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

router.post('/advise', async (req, res) => {
  const { task } = req.body || {};
  const r = await ai.advise(task);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

router.post('/breakdown', async (req, res) => {
  const { task } = req.body || {};
  const r = await ai.breakdown(task);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

router.post('/daily-report', async (req, res) => {
  const r = await ai.dailyReport(req.user.id);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

router.post('/weekly-report', async (req, res) => {
  const r = await ai.weeklyReport(req.user.id);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

router.post('/monthly-review', async (req, res) => {
  const r = await ai.monthlyReview(req.user.id);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// ===== SSE 流式端点 =====
router.post('/stream', async (req, res) => {
  const { messages, temperature, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 必填（chat messages 数组）' });
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 15_000);

  try {
    const r = await llm.chatStream(
      messages,
      { temperature: Number(temperature) || 0.5, max_tokens: Number(max_tokens) || 800 },
      (delta, full) => write('delta', { delta, full })
    );
    if (!r.ok) write('error', { error: r.error });
    else write('done', { text: r.text });
  } catch (e) {
    write('error', { error: e.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

module.exports = router;
