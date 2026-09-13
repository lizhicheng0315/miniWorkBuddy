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
      meta TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  // 幂等加列（sql.js 不支持 ALTER ... IF NOT EXISTS）
  try { db.rawDb().run('ALTER TABLE chat_sessions ADD COLUMN summary TEXT'); } catch (_) {}
  try { db.rawDb().run('ALTER TABLE chat_sessions ADD COLUMN summarized_msg_id INTEGER DEFAULT 0'); } catch (_) {}
  try { db.rawDb().run("ALTER TABLE chat_messages ADD COLUMN meta TEXT DEFAULT ''"); } catch (_) {}
}

/** 取用户的某个会话；不存在或越权返回 null */
function getSession(userId, sessionId) {
  try {
    ensureTables();
    const rows = db.rawDb().exec(
      'SELECT id, title, created_at, updated_at, workspace_mode, worktree_path, worktree_branch, project FROM chat_sessions WHERE id = ? AND user_id = ?',
      [Number(sessionId), Number(userId)]
    );
    if (!rows.length || !rows[0].values.length) return null;
    const v = rows[0].values[0];
    return {
      id: v[0], title: v[1], created_at: v[2], updated_at: v[3],
      workspace_mode: v[4] || 'local',
      worktree_path: v[5] || null,
      worktree_branch: v[6] || null,
      project: v[7] || 'WorkBuddy',
    };
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

/** 上下文用量估算（供 UI 显示 & 自动压缩判断） */
function contextStats(userId, sessionId) {
  const ctx = getContext(userId, sessionId);
  if (!ctx) return null;
  const summaryChars = (ctx.summary || '').length;
  const messageChars = ctx.messages.reduce((n, m) => n + String(m.content || '').length, 0);
  const chars = summaryChars + messageChars;
  return {
    messages: ctx.messages.length,
    has_summary: !!ctx.summary,
    summary_chars: summaryChars,
    chars,
    estimated_tokens: Math.ceil(chars / 4),
    threshold: 12,
  };
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
      'SELECT id, title, updated_at, workspace_mode, worktree_path, project FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
      [Number(userId), Number(limit)]
    );
    if (!rows.length) return [];
    return rows[0].values.map((v) => ({
      id: v[0], title: v[1], updated_at: v[2],
      workspace_mode: v[3] || 'local',
      worktree_path: v[4] || null,
      project: v[5] || 'WorkBuddy',
    }));
  } catch (e) {
    logger.warn('listSessions failed:', e.message);
    return [];
  }
}

/** 创建会话 */
function createSession(userId, title, project) {
  ensureTables();
  const now = db.nowIso();
  db.rawDb().run(
    'INSERT INTO chat_sessions (user_id, title, project, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [Number(userId), String(title || '新对话').slice(0, 40), String(project || 'WorkBuddy').slice(0, 60), now, now]
  );
  return getSession(userId, lastRowId());
}

function lastRowId() {
  const r = db.rawDb().exec('SELECT last_insert_rowid() AS id');
  return r.length && r[0].values.length ? r[0].values[0][0] : null;
}

/** 追加消息；若 session 标题还是默认且这是第一条用户消息，用它命名会话
 *  @returns {{ok:boolean, msgId:number}} */
function addMessage(userId, sessionId, role, content, intent = '', meta = null) {
  ensureTables();
  const s = getSession(userId, sessionId);
  if (!s) return null;
  const now = db.nowIso();
  let metaJson = '';
  if (meta && typeof meta === 'object') {
    try { metaJson = JSON.stringify(meta).slice(0, 180_000); } catch (_) {}
  }
  db.rawDb().run(
    'INSERT INTO chat_messages (session_id, role, content, intent, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [Number(sessionId), String(role), String(content || ''), String(intent || ''), metaJson, now]
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
      'SELECT role, content, intent, meta, created_at FROM chat_messages WHERE session_id = ? ORDER BY id ASC LIMIT 500',
      [Number(sessionId)]
    );
    if (!rows.length) return [];
    return rows[0].values.map((v) => {
      let meta = null;
      if (v[3]) {
        try { meta = JSON.parse(v[3]); } catch (_) {}
      }
      return { role: v[0], content: v[1], intent: v[2], meta, created_at: v[4] };
    });
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

/** 更新会话的工作区绑定（local / worktree） */
function updateEnvironment(userId, sessionId, patch = {}) {
  const s = getSession(userId, sessionId);
  if (!s) return null;
  const mode = patch.workspace_mode === 'worktree' ? 'worktree' : 'local';
  const wtPath = mode === 'worktree' ? (patch.worktree_path || s.worktree_path || null) : null;
  const branch = mode === 'worktree' ? (patch.worktree_branch || s.worktree_branch || null) : null;
  db.rawDb().run(
    'UPDATE chat_sessions SET workspace_mode = ?, worktree_path = ?, worktree_branch = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    [mode, wtPath, branch, db.nowIso(), Number(sessionId), Number(userId)]
  );
  db.persist();
  return getSession(userId, sessionId);
}

/** Fork 一个会话：复制消息与工作区绑定到新会话 */
function forkSession(userId, sessionId, title) {
  const src = getSession(userId, sessionId);
  if (!src) return null;
  const created = createSession(userId, title || (src.title + ' · fork'));
  db.rawDb().run(
    'UPDATE chat_sessions SET workspace_mode = ?, worktree_path = ?, worktree_branch = ?, updated_at = ? WHERE id = ?',
    [src.workspace_mode || 'local', src.worktree_path || null, src.worktree_branch || null, db.nowIso(), Number(created.id)]
  );
  const msgs = getMessages(userId, sessionId) || [];
  for (const m of msgs) {
    addMessage(userId, created.id, m.role, m.content, m.intent || '', m.meta || null);
  }
  db.persist();
  return getSession(userId, created.id);
}

/** 跨会话搜索消息 */
function searchMessages(userId, query, limit = 50) {
  ensureTables();
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const rows = db.rawDb().exec(
      `SELECT m.session_id, s.title, m.role, m.content, m.created_at
       FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id
       WHERE s.user_id = ? AND m.content LIKE ?
       ORDER BY m.id DESC LIMIT ?`,
      [Number(userId), '%' + q.replace(/[%_]/g, '') + '%', Math.min(parseInt(limit, 10) || 50, 200)]
    );
    if (!rows.length) return [];
    return rows[0].values.map((v) => ({
      session_id: v[0], title: v[1], role: v[2], content: v[3], created_at: v[4],
    }));
  } catch (_) {
    return [];
  }
}

function listProjects(userId) {
  try {
    ensureTables();
    const rows = db.query(
      'SELECT project, COUNT(*) AS count FROM chat_sessions WHERE user_id = ? GROUP BY project ORDER BY count DESC',
      [Number(userId)]
    );
    return rows.map((r) => ({ project: r.project || 'WorkBuddy', count: r.count }));
  } catch (_) {
    return [];
  }
}

function updateProject(userId, sessionId, project) {
  const s = getSession(userId, sessionId);
  if (!s) return null;
  db.rawDb().run(
    'UPDATE chat_sessions SET project = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    [String(project || 'WorkBuddy').slice(0, 60), db.nowIso(), Number(sessionId), Number(userId)]
  );
  db.persist();
  return getSession(userId, sessionId);
}

module.exports = {
  getSession, listSessions, createSession, addMessage,
  getMessages, deleteSession, renameSession,
  saveSummary, getContext, maxMessageId,
  contextStats,
  updateEnvironment,
  forkSession,
  searchMessages,
  listProjects,
  updateProject,
};
