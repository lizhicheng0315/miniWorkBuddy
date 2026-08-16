'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

/**
 * 丰富版 /api/health（公开）：
 *   - 数据库大小
 *   - 用户数、在线 session 数、提醒数、待办数、日程数
 *   - LLM 状态
 *   - 启动时间 + 运行时长
 */

let startTime = Date.now();

router.get('/', (req, res) => {
  const dbFile = path.join(config.dataDir, 'workbuddy.db');
  let dbSize = 0;
  try { dbSize = fs.statSync(dbFile).size; } catch (_) {}

  const userCount = db.list('users').length;
  const reminderCount = db.list('reminders').length;
  const enabledReminders = db.list('reminders', (r) => r.enabled).length;
  // 在线 session：未过期
  let activeSessions = 0;
  try {
    const r = db.rawDb().exec(
      "SELECT COUNT(*) FROM sessions WHERE expires_at > datetime('now')"
    );
    if (r.length) activeSessions = r[0].values[0][0];
  } catch (_) {}
  // 今日待办 / 今日日程
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const openTodos = db.list('todos', (t) => t.status === 'open').length;
  const todayEvents = db.list('schedule_events', (ev) => ev.start_at >= todayStart && ev.start_at < todayEnd).length;

  res.json({
    ok: true,
    time: new Date().toISOString(),
    uptime_sec: Math.floor((Date.now() - startTime) / 1000),
    llm: require('../services/llm').isEnabled(),
    llm_model: config.llm.apiKey ? config.llm.model : null,
    db: {
      engine: 'sqlite (sql.js)',
      file: dbFile,
      size_bytes: dbSize,
      size_mb: +(dbSize / 1024 / 1024).toFixed(3),
    },
    users: { total: userCount },
    sessions: { active: activeSessions },
    reminders: { total: reminderCount, enabled: enabledReminders },
    todos: { open: openTodos },
    events: { today: todayEvents },
    auth_enabled: config.auth.enabled,
    tls_enabled: config.tls.enabled,
  });
});

/**
 * Prometheus 风格 /api/metrics（仅 admin）
 */
router.get('/metrics', requireAuth, (req, res) => {
  if (!req.user.is_admin) return res.status(403).send('# forbidden\n');
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  const lines = [];
  const push = (name, help, value) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  };
  push('workbuddy_uptime_seconds', 'Process uptime', Math.floor((Date.now() - startTime) / 1000));
  push('workbuddy_users_total', 'Total registered users', db.list('users').length);
  push('workbuddy_todos_open', 'Open todos', db.list('todos', (t) => t.status === 'open').length);
  push('workbuddy_todos_done_total', 'Completed todos', db.list('todos', (t) => t.status === 'done').length);
  push('workbuddy_reminders_enabled', 'Enabled reminders', db.list('reminders', (r) => r.enabled).length);
  push('workbuddy_sessions_active', 'Active sessions', (() => {
    try { return db.rawDb().exec("SELECT COUNT(*) FROM sessions WHERE expires_at > datetime('now')")[0].values[0][0]; }
    catch { return 0; }
  })());
  res.send(lines.join('\n') + '\n');
});

module.exports = router;
