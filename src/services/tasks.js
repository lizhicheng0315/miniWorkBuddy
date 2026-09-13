'use strict';

/**
 * Background tasks（Codex cloud task 的本地等价）：
 *   - 创建后台 Agent 任务，异步执行并持久化状态/结果
 *   - 支持列出、查看、取消
 */

const db = require('../db');
const logger = require('../logger');
const config = require('../config');

function notifyDone(title, message) {
  if (!config.notify.tasks) return;
  try {
    require('./notifier').alert(title, String(message || '').slice(0, 220)).catch(() => {});
  } catch (_) {}
}

function ensureTables() {
  db.rawDb().run(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      cancel_requested INTEGER DEFAULT 0,
      result TEXT,
      error TEXT,
      model TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_user ON agent_tasks(user_id, id);
  `);
  try { db.rawDb().run("ALTER TABLE agent_tasks ADD COLUMN type TEXT DEFAULT 'task'"); } catch (_) {}
}

function lastId() {
  const r = db.rawDb().exec('SELECT last_insert_rowid() AS id');
  return r.length && r[0].values.length ? r[0].values[0][0] : null;
}

function mapRow(r) {
  return { ...r, cancel_requested: !!r.cancel_requested };
}

function get(userId, id) {
  ensureTables();
  const rows = db.query('SELECT * FROM agent_tasks WHERE id = ? AND user_id = ?', [Number(id), Number(userId)]);
  return rows.length ? mapRow(rows[0]) : null;
}

function list(userId, opts = {}) {
  ensureTables();
  const limit = typeof opts === 'number' ? opts : (parseInt(opts.limit, 10) || 50);
  const type = typeof opts === 'object' ? opts.type : null;
  let rows = db.query(
    'SELECT * FROM agent_tasks WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [Number(userId), Math.min(limit, 200)]
  ).map(mapRow);
  if (type && type !== 'all') rows = rows.filter((t) => (t.type || 'task') === type);
  return rows;
}

async function run(userId, id) {
  const task = get(userId, id);
  if (!task) return null;
  db.rawDb().run('UPDATE agent_tasks SET status=?, started_at=? WHERE id=?', ['running', db.nowIso(), Number(id)]);
  db.persist();
  try {
    const nlp = require('./nlp');
    const r = await nlp.chat(userId, task.prompt, {
      approvalMode: 'auto',
      model: task.model || undefined,
      onDelta: () => {},
    });
    const current = get(userId, id);
    if (current && current.cancel_requested) {
      db.rawDb().run('UPDATE agent_tasks SET status=?, finished_at=? WHERE id=?', ['canceled', db.nowIso(), Number(id)]);
      db.persist();
      return get(userId, id);
    }
    const result = r && r.reply ? String(r.reply).slice(0, 20_000) : '';
    db.rawDb().run('UPDATE agent_tasks SET status=?, result=?, finished_at=? WHERE id=?', ['success', result, db.nowIso(), Number(id)]);
    db.persist();
    notifyDone('后台任务完成', `${task.title}\n${result.slice(0, 180)}`);
    return get(userId, id);
  } catch (e) {
    db.rawDb().run(
      'UPDATE agent_tasks SET status=?, error=?, finished_at=? WHERE id=?',
      ['error', String(e.message || e).slice(0, 4000), db.nowIso(), Number(id)]
    );
    db.persist();
    logger.warn(`background task #${id} failed: ${e.message}`);
    notifyDone('后台任务失败', `${task.title}\n${e.message}`);
    return get(userId, id);
  }
}

function create(userId, data = {}) {
  ensureTables();
  const title = String(data.title || data.prompt || '后台任务').slice(0, 80);
  const prompt = String(data.prompt || data.message || '').trim().slice(0, 4000);
  if (!prompt) throw new Error('prompt 必填');
  db.rawDb().run(
    'INSERT INTO agent_tasks (user_id, title, prompt, status, model, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [Number(userId), title, prompt, 'queued', data.model || '', data.type || 'task', db.nowIso()]
  );
  const id = lastId();
  db.persist();
  setImmediate(() => run(userId, id).catch((e) => logger.warn('background task run failed:', e.message)));
  return get(userId, id);
}

function cancel(userId, id) {
  const task = get(userId, id);
  if (!task) return null;
  if (task.status === 'queued') {
    db.rawDb().run('UPDATE agent_tasks SET status=?, cancel_requested=?, finished_at=? WHERE id=?', ['canceled', 1, db.nowIso(), Number(id)]);
  } else if (task.status === 'running') {
    db.rawDb().run('UPDATE agent_tasks SET cancel_requested=? WHERE id=?', [1, Number(id)]);
  }
  db.persist();
  return get(userId, id);
}

function remove(userId, id) {
  const task = get(userId, id);
  if (!task) return false;
  db.rawDb().run('DELETE FROM agent_tasks WHERE id=? AND user_id=?', [Number(id), Number(userId)]);
  db.persist();
  return true;
}

/** 记录一次外部/内联执行的子代理活动 */
function record(userId, data = {}) {
  ensureTables();
  db.rawDb().run(
    'INSERT INTO agent_tasks (user_id, title, prompt, status, result, error, type, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      Number(userId),
      String(data.title || '子代理').slice(0, 80),
      String(data.prompt || '').slice(0, 4000),
      data.status || 'success',
      String(data.result || '').slice(0, 20_000),
      String(data.error || '').slice(0, 4000),
      data.type || 'subagent',
      db.nowIso(),
      db.nowIso(),
    ]
  );
  db.persist();
  return get(userId, lastId());
}

module.exports = { list, get, create, run, cancel, remove, record };
