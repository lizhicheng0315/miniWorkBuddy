'use strict';

const express = require('express');
const db = require('../db');
const chatstore = require('../services/chatstore');
const llm = require('../services/llm');
const sandbox = require('../services/sandbox');
const computer = require('../services/computer');
const browser = require('../services/browser');
const mcp = require('../services/mcp');
const skills = require('../services/skills');
const memory = require('../services/memory');
const automations = require('../services/automations');
const news = require('../services/news');
const plan = require('../services/plan');
const tasks = require('../services/tasks');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const userId = req.user.id;
  const out = { ok: true, time: db.nowIso() };
  try { out.llm = llm.getConfigView(); } catch (e) { out.llm = { error: e.message }; }
  try { out.sandbox = sandbox.policy(userId); } catch (e) { out.sandbox = { error: e.message }; }
  try { out.computer = await computer.status(); } catch (e) { out.computer = { error: e.message }; }
  try { out.browser = await browser.status(); } catch (e) { out.browser = { error: e.message }; }
  try { out.mcp = mcp.status(userId); } catch (e) { out.mcp = { error: e.message }; }
  try { out.skills = { count: skills.list().length }; } catch (e) { out.skills = { error: e.message }; }
  try { out.memory = memory.getStats(userId); } catch (e) { out.memory = { error: e.message }; }
  try { out.automations = automations.stats(userId); } catch (e) { out.automations = { error: e.message }; }
  try {
    news.ensureTables();
    const catalog = news.publicCatalog();
    const rows = db.query('SELECT COUNT(*) AS count FROM news_boards WHERE user_id = ?', [Number(userId)]);
    out.news = {
      sources: catalog.sources.length,
      templates: catalog.templates.length,
      boards: rows[0]?.count || 0,
    };
  } catch (e) { out.news = { error: e.message }; }
  try {
    plan.ensureTables();
    const data = plan.dashboard(userId);
    out.plan = data.metrics;
  } catch (e) { out.plan = { error: e.message }; }
  try { out.tasks = { count: tasks.list(userId, { limit: 200 }).length }; } catch (e) { out.tasks = { error: e.message }; }
  try { out.sessions = { count: chatstore.listSessions(userId).length }; } catch (e) { out.sessions = { error: e.message }; }
  res.json(out);
});

module.exports = router;
