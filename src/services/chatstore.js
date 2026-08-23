'use strict';

/**
 * 对话历史持久化：会话（session）+ 消息（message）两级
 * - 发消息时自动落库（无会话则自动创建，标题取首条消息前 20 字）
 * - 左栏历史列表按 updated_at 倒序
 */

const db = require('../db');
const logger = require('../logger');

function ensureTables() {
  db.rawDb().run(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '新对话',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      intent TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  // 幂等加列（sql.js 不支持 ALTER ... IF NOT EXISTS）
  try { db.rawDb().run('ALTER TABLE chat_sessions ADD COLUMN summary TEXT'); } catch (_) {}
  try { db.rawDb().run('ALTER TABLE chat_sessions ADD COLUMN summarized_msg_id INTEGER DEFAULT 0'); } catch (_) {}
}

/** 取用户的某个会话；不存在或越权返回 null */
function getSession(userId, sessionId) {
  try {
    ensureTables();
    const rows = db.rawDb().exec(
      'SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = ? AND user_id = ?',
      [Number(sessionId), Number(userId)]
    );
    if (!rows.length || !rows[0].values.length) return null;
    const v = rows[0].values[0];
    return { id: v[0], title: v[1], created_at: v[2], updated_at: v[3] };
  } catch (e) {
    logger.warn('getSession failed:', e.message);
    return null;
  }
}

/**
 * 上下文压缩（DeerFlow SummarizationMiddleware 思路）：
 * 把 summarized_msg_id 之前（含）的旧消息压缩成摘要存入会话，
 * 之后 getMessages 只返回未压缩的新消息 + 摘要标记。
 * @param {string} summaryText LLM 生成的摘要
 * @param {number} untilMsgId 压缩覆盖到的最后一条消息 id
 */
function saveSummary(userId, sessionId, summaryText, untilMsgId) {
  const s = getSession(userId, sessionId);
  if (!s) return false;
  db.rawDb().run(
    'UPDATE chat_sessions SET summary = ?, summarized_msg_id = ? WHERE id = ?',
    [String(summaryText || ''), Number(untilMsgId) || 0, Number(sessionId)]
  );
  return true;
}

/**
 * 取"LLM 视角"的上下文：摘要（如有）+ 未压缩的消息
 * @returns {{summary: string|null, messages: Array}} messages 为 [{id, role, content}]
 */
function getContext(userId, sessionId) {
  const s = getSession(userId, sessionId);
  if (!s) return null;
  ensureTables();
  let summary = null, untilId = 0;
  try {
    const r = db.rawDb().exec(
      'SELECT summary, summarized_msg_id FROM chat_sessions WHERE id = ?', [Number(sessionId)]
    );
    if (r.length && r[0].values.length) { summary = r[0].values[0][0]; untilId = r[0].values[0][1] || 0; }
  } catch (_) {}
  let msgs = [];
  try {
    const rows = db.rawDb().exec(
      'SELECT id, role, content FROM chat_messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT 100',
      [Number(sessionId), Number(untilId)]
    );
    if (rows.length) msgs = rows[0].values.map((v) => ({ id: v[0], role: v[1], content: v[2] }));
  } catch (_) {}
  return { summary: summary || null, messages: msgs };
}

/** 某会话最大消息 id（前端判断是否需要压缩用） */
function maxMessageId(userId, sessionId) {
  try {
    const r = db.rawDb().exec(
      'SELECT MAX(id) FROM chat_messages WHERE session_id = ?', [Number(sessionId)]
    );
    return r.length && r[0].values.length ? (r[0].values[0][0] || 0) : 0;
  } catch (_) { return 0; }
}

/** 用户所有会话（倒序） */
function listSessions(userId, limit = 50) {
  try {
    ensureTables();
    const rows = db.rawDb().exec(
      'SELECT id, title, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
      [Number(userId), Number(limit)]
    );
    if (!rows.length) return [];
    return rows[0].values.map((v) => ({ id: v[0], title: v[1], updated_at: v[2] }));
  } catch (e) {
    logger.warn('listSessions failed:', e.message);
    return [];
  }
}

/** 创建会话 */
function createSession(userId, title) {
  ensureTables();
  const now = db.nowIso();
  db.rawDb().run(
    'INSERT INTO chat_sessions (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [Number(userId), String(title || '新对话').slice(0, 40), now, now]
  );
  return getSession(userId, lastRowId());
}

function lastRowId() {
  const r = db.rawDb().exec('SELECT last_insert_rowid() AS id');
  return r.length && r[0].values.length ? r[0].values[0][0] : null;
}

/** 追加消息；若 session 标题还是默认且这是第一条用户消息，用它命名会话
 *  @returns {{ok:boolean, msgId:number}} */
function addMessage(userId, sessionId, role, content, intent = '') {
  ensureTables();
  const s = getSession(userId, sessionId);
  if (!s) return null;
  const now = db.nowIso();
  db.rawDb().run(
    'INSERT INTO chat_messages (session_id, role, content, intent, created_at) VALUES (?, ?, ?, ?, ?)',
    [Number(sessionId), String(role), String(content || ''), String(intent || ''), now]
  );
  const msgId = lastRowId() || 0;
  // 首条用户消息命名会话
  if (role === 'user' && (s.title === '新对话' || !s.title)) {
    const t = String(content).trim().slice(0, 20) || '新对话';
    db.rawDb().run('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?', [t, now, Number(sessionId)]);
  } else {
    db.rawDb().run('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', [now, Number(sessionId)]);
  }
  return { ok: true, msgId };
}

/** 会话内全部消息（正序） */
function getMessages(userId, sessionId) {
  const s = getSession(userId, sessionId);
  if (!s) return null; // 越权/不存在
  try {
    const rows = db.rawDb().exec(
      'SELECT role, content, intent, created_at FROM chat_messages WHERE session_id = ? ORDER BY id ASC LIMIT 500',
      [Number(sessionId)]
    );
    if (!rows.length) return [];
    return rows[0].values.map((v) => ({ role: v[0], content: v[1], intent: v[2], created_at: v[3] }));
  } catch (_) { return []; }
}

/** 删除会话（连带消息） */
function deleteSession(userId, sessionId) {
  const s = getSession(userId, sessionId);
  if (!s) return false;
  db.rawDb().run('DELETE FROM chat_messages WHERE session_id = ?', [Number(sessionId)]);
  db.rawDb().run('DELETE FROM chat_sessions WHERE id = ?', [Number(sessionId)]);
  return true;
}

/** 重命名会话 */
function renameSession(userId, sessionId, title) {
  const s = getSession(userId, sessionId);
  if (!s) return false;
  db.rawDb().run('UPDATE chat_sessions SET title = ? WHERE id = ?', [String(title).slice(0, 40), Number(sessionId)]);
  return true;
}

module.exports = {
  getSession, listSessions, createSession, addMessage,
  getMessages, deleteSession, renameSession,
  saveSummary, getContext, maxMessageId,
};
