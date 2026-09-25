'use strict';

/**
 * Scheduled tasks（仿 Codex automations）：
 *   - cron + prompt 定时让 Agent 在后台执行任务
 *   - 支持启用/停用、立即运行、运行历史
 */

const cron = require('node-cron');
const db = require('../db');
const logger = require('../logger');
const config = require('../config');

function notifyDone(title, message) {
  if (!config.notify.tasks) return;
  try {
    require('./notifier').alert(title, String(message || '').slice(0, 220)).catch(() => {});
  } catch (_) {}
}

const jobs = new Map();
const running = new Set();

function addColumnIfMissing(table, column, definition) {
  try {
    const result = db.rawDb().exec(`PRAGMA table_info(${table})`);
    const names = (result[0]?.values || []).map((row) => row[1]);
    if (!names.includes(column)) db.rawDb().run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (_) {}
}

function ensureTables() {
  db.rawDb().run(`
    CREATE TABLE IF NOT EXISTS automations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cron TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      run_mode TEXT DEFAULT 'local',
      kind TEXT DEFAULT 'agent',
      payload TEXT DEFAULT '{}',
      last_run_at TEXT,
      last_status TEXT,
      last_result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_automation_runs ON automation_runs(automation_id, id);
  `);
  addColumnIfMissing('automations', 'kind', "TEXT DEFAULT 'agent'");
  addColumnIfMissing('automations', 'payload', "TEXT DEFAULT '{}'");
}

function lastId() {
  const r = db.rawDb().exec('SELECT last_insert_rowid() AS id');
  return r.length && r[0].values.length ? r[0].values[0][0] : null;
}

function mapRow(r) {
  let payload = {};
  try {
    payload = JSON.parse(String(r.payload || '{}'));
  } catch (_) {}
  return {
    ...r,
    enabled: !!r.enabled,
    kind: r.kind || 'agent',
    payload: payload && typeof payload === 'object' ? payload : {},
  };
}

function get(userId, id) {
  ensureTables();
  const rows = db.query('SELECT * FROM automations WHERE id = ? AND user_id = ?', [Number(id), Number(userId)]);
  return rows.length ? mapRow(rows[0]) : null;
}

function list(userId, opts = {}) {
  ensureTables();
  let rows = db.query('SELECT * FROM automations WHERE user_id = ? ORDER BY id DESC', [Number(userId)]).map(mapRow);
  const status = opts && opts.status;
  if (status === 'enabled') rows = rows.filter((a) => a.enabled);
  else if (status === 'paused') rows = rows.filter((a) => !a.enabled);
  else if (status === 'error') rows = rows.filter((a) => a.last_status === 'error');
  return rows;
}

function stats(userId) {
  const rows = list(userId);
  return {
    total: rows.length,
    enabled: rows.filter((a) => a.enabled).length,
    paused: rows.filter((a) => !a.enabled).length,
    errors: rows.filter((a) => a.last_status === 'error').length,
    last_run_at: rows.map((a) => a.last_run_at).filter(Boolean).sort().pop() || null,
  };
}

function setAllEnabled(userId, enabled) {
  ensureTables();
  db.rawDb().run('UPDATE automations SET enabled = ?, updated_at = ? WHERE user_id = ?', [enabled ? 1 : 0, db.nowIso(), Number(userId)]);
  db.persist();
  const rows = list(userId);
  for (const a of rows) {
    unregister(a.id);
    if (a.enabled) register(a);
  }
  return rows;
}

function duplicate(userId, id) {
  const src = get(userId, id);
  if (!src) return null;
  const created = create(userId, {
    name: (src.name + ' copy').slice(0, 80),
    prompt: src.prompt,
    cron: src.cron,
    enabled: false,
    run_mode: src.run_mode,
    kind: src.kind,
    payload: src.payload,
  });
  return created;
}

function create(userId, data = {}) {
  ensureTables();
  const name = String(data.name || '').trim().slice(0, 80);
  const prompt = String(data.prompt || '').trim().slice(0, 4000);
  const expr = String(data.cron || '').trim();
  const kind = data.kind === 'news_digest' ? 'news_digest' : 'agent';
  const payload = JSON.stringify(data.payload && typeof data.payload === 'object' ? data.payload : {});
  if (!name || !prompt || !expr) throw new Error('name / prompt / cron 必填');
  if (!cron.validate(expr)) throw new Error('cron 表达式无效');
  const now = db.nowIso();
  db.rawDb().run(
    `INSERT INTO automations (user_id, name, prompt, cron, enabled, run_mode, kind, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(userId), name, prompt, expr, data.enabled === false ? 0 : 1,
      data.run_mode || 'local', kind, payload, now, now,
    ]
  );
  const row = get(userId, lastId());
  register(row);
  db.persist();
  return row;
}

function update(userId, id, patch = {}) {
  const cur = get(userId, id);
  if (!cur) return null;
  if (patch.cron && !cron.validate(String(patch.cron))) throw new Error('cron 表达式无效');
  const next = { ...cur, ...patch };
  const kind = next.kind === 'news_digest' ? 'news_digest' : 'agent';
  const payload = JSON.stringify(next.payload && typeof next.payload === 'object' ? next.payload : {});
  db.rawDb().run(
    `UPDATE automations SET name=?, prompt=?, cron=?, enabled=?, run_mode=?, kind=?, payload=?, updated_at=? WHERE id=? AND user_id=?`,
    [
      String(next.name).slice(0, 80),
      String(next.prompt).slice(0, 4000),
      String(next.cron),
      next.enabled ? 1 : 0,
      next.run_mode || 'local',
      kind,
      payload,
      db.nowIso(), Number(id), Number(userId),
    ]
  );
  db.persist();
  unregister(id);
  const updated = get(userId, id);
  register(updated);
  return updated;
}

function remove(userId, id) {
  const cur = get(userId, id);
  if (!cur) return false;
  unregister(id);
  db.rawDb().run('DELETE FROM automation_runs WHERE automation_id = ?', [Number(id)]);
  db.rawDb().run('DELETE FROM automations WHERE id = ? AND user_id = ?', [Number(id), Number(userId)]);
  db.persist();
  return true;
}

function runs(userId, id, limit = 20) {
  const cur = get(userId, id);
  if (!cur) return null;
  return db.query(
    'SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?',
    [Number(id), Math.min(parseInt(limit, 10) || 20, 100)]
  );
}

async function execute(userId, automation) {
  const aid = Number(automation.id);
  if (running.has(aid)) return { ok: false, error: 'automation 正在运行中' };
  running.add(aid);
  const started = db.nowIso();
  db.rawDb().run(
    'INSERT INTO automation_runs (automation_id, status, result, started_at) VALUES (?, ?, ?, ?)',
    [aid, 'running', '', started]
  );
  const runId = lastId();
  try {
    let result = '';
    if (automation.kind === 'news_digest') {
      const news = require('./news');
      const digest = await news.digest(userId, {
        boardId: automation.payload && automation.payload.boardId,
      });
      result = String(digest.text || '').slice(0, 8000);
    } else {
      const nlp = require('./nlp');
      const r = await nlp.chat(userId, automation.prompt, {
        approvalMode: 'auto',
        deepThink: false,
        onDelta: () => {},
      });
      result = r && r.reply ? String(r.reply).slice(0, 8000) : '';
    }
    db.rawDb().run(
      'UPDATE automation_runs SET status=?, result=?, finished_at=? WHERE id=?',
      ['success', result, db.nowIso(), runId]
    );
    db.rawDb().run(
      'UPDATE automations SET last_run_at=?, last_status=?, last_result=?, updated_at=? WHERE id=?',
      [db.nowIso(), 'success', result, db.nowIso(), aid]
    );
    db.persist();
    logger.info(`automation #${aid} completed`);
    notifyDone(
      automation.kind === 'news_digest' ? '新闻推送' : 'Scheduled task 完成',
      `${automation.name}\n${result.slice(0, 180)}`
    );
    return { ok: true, result };
  } catch (e) {
    const result = String(e.message || e).slice(0, 4000);
    db.rawDb().run(
      'UPDATE automation_runs SET status=?, result=?, finished_at=? WHERE id=?',
      ['error', result, db.nowIso(), runId]
    );
    db.rawDb().run(
      'UPDATE automations SET last_run_at=?, last_status=?, last_result=?, updated_at=? WHERE id=?',
      [db.nowIso(), 'error', result, db.nowIso(), aid]
    );
    db.persist();
    logger.warn(`automation #${aid} failed: ${result}`);
    notifyDone('Scheduled task 失败', `${automation.name}\n${result}`);
    return { ok: false, error: result };
  } finally {
    running.delete(aid);
  }
}

function register(automation) {
  if (!automation || !automation.enabled) return;
  const id = Number(automation.id);
  const existing = jobs.get(id);
  if (existing) existing.stop();
  const job = cron.schedule(automation.cron, () => {
    execute(automation.user_id, automation).catch((e) => logger.warn('automation run failed:', e.message));
  });
  jobs.set(id, job);
}

function unregister(id) {
  const job = jobs.get(Number(id));
  if (job) {
    try { job.stop(); } catch (_) {}
    jobs.delete(Number(id));
  }
}

function loadAll() {
  ensureTables();
  const rows = db.query('SELECT * FROM automations WHERE enabled = 1');
  rows.forEach((r) => register(mapRow(r)));
  logger.info(`scheduler loaded ${rows.length} automation(s)`);
}

function shutdown() {
  for (const job of jobs.values()) {
    try { job.stop(); } catch (_) {}
  }
  jobs.clear();
}

module.exports = {
  list, get, create, update, remove, runs, stats, setAllEnabled, duplicate,
  execute, register, unregister, loadAll, shutdown,
};
