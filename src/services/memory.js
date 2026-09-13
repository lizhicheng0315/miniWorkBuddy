'use strict';

/**
 * 长期记忆模块（仿 Codex 的 memory 能力）：
 *   - memory_items：结构化持久记忆（事实/偏好/习惯/事件/上下文）
 *   - memory_events：操作留痕（记住/回忆/提取/删除）
 *   - recall()：按关键词 + 重要度 + 时效性打分召回，供 agent 注入上下文
 *   - autoExtract()：让 LLM 从对话里提炼值得长期保存的事实
 */

const db = require('../db');
const logger = require('../logger');
const llm = require('./llm');

const KINDS = ['fact', 'preference', 'event', 'context', 'habit'];

function ensureTable() {
  const raw = db.rawDb();
  raw.run(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT DEFAULT 'manual',
      importance INTEGER DEFAULT 1,
      pinned INTEGER DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_user_time ON memory_items(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_memory_user_kind ON memory_items(user_id, kind);

    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_events_user ON memory_events(user_id, created_at);
  `);
}

function nowIso() {
  return db.nowIso();
}

function parseTags(tags) {
  if (Array.isArray(tags)) return tags.map(String).filter(Boolean).slice(0, 20);
  if (typeof tags === 'string') {
    return tags.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  }
  return [];
}

function toItem(row) {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    tags: parseTags(row.tags),
    source: row.source || '',
    importance: Number(row.importance) || 1,
    pinned: !!Number(row.pinned),
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_accessed_at: row.last_accessed_at,
  };
}

function getById(userId, id) {
  ensureTable();
  const rows = db.query('SELECT * FROM memory_items WHERE id = ? AND user_id = ?', [Number(id), Number(userId)]);
  return rows.length ? toItem(rows[0]) : null;
}

function list(userId, opts = {}) {
  ensureTable();
  const limit = Math.min(parseInt(opts.limit, 10) || 50, 200);
  let rows = db.query('SELECT * FROM memory_items WHERE user_id = ?', [Number(userId)]);
  if (opts.kind && opts.kind !== 'all') rows = rows.filter((r) => r.kind === opts.kind);
  if (opts.pinned) rows = rows.filter((r) => Number(r.pinned) === 1);
  if (opts.q && String(opts.q).trim()) {
    const terms = String(opts.q).trim().toLowerCase().split(/[\s,，;；]+/).filter(Boolean);
    rows = rows.filter((r) => {
      const text = [r.content, r.tags, r.kind, r.source].join(' ').toLowerCase();
      return terms.every((t) => text.includes(t));
    });
  }
  rows.sort((a, b) => recallScore(b, []) - recallScore(a, []));
  return rows.slice(0, limit).map(toItem);
}

function recallScore(row, terms) {
  let s = (Number(row.importance) || 1) * 2;
  if (Number(row.pinned)) s += 8;
  const text = [row.content, row.tags, row.kind].join(' ').toLowerCase();
  for (const t of terms || []) {
    if (text.includes(t)) s += 3;
  }
  try {
    const age = Date.now() - new Date(row.updated_at || nowIso()).getTime();
    s += Math.max(0, 1 - age / (90 * 86400000));
  } catch (_) {}
  return s;
}

function logEvent(userId, action, summary) {
  try {
    ensureTable();
    db.rawDb().run(
      'INSERT INTO memory_events (user_id, action, summary, created_at) VALUES (?, ?, ?, ?)',
      [Number(userId), String(action), String(summary).slice(0, 500), nowIso()]
    );
    db.rawDb().run(
      `DELETE FROM memory_events WHERE user_id = ? AND id NOT IN (
        SELECT id FROM memory_events WHERE user_id = ? ORDER BY id DESC LIMIT 500
      )`,
      [Number(userId), Number(userId)]
    );
    db.persist();
  } catch (e) {
    logger.warn('memory logEvent failed:', e.message);
  }
}

function create(userId, data = {}) {
  ensureTable();
  const content = String(data.content || '').trim().slice(0, 2000);
  if (!content) throw new Error('记忆内容不能为空');
  const kind = KINDS.includes(data.kind) ? data.kind : 'fact';
  const importance = Math.min(5, Math.max(1, parseInt(data.importance, 10) || 1));
  const now = nowIso();
  const result = db.rawDb().run(
    `INSERT INTO memory_items
      (user_id, kind, content, tags, source, importance, pinned, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(userId), kind, content, JSON.stringify(parseTags(data.tags)),
      String(data.source || 'manual').slice(0, 40), importance,
      data.pinned ? 1 : 0, data.expires_at || null, now, now,
    ]
  );
  db.persist();
  const idRows = db.rawDb().exec('SELECT last_insert_rowid() AS id');
  const id = idRows.length ? idRows[0].values[0][0] : null;
  logEvent(userId, 'remember', `${kind}: ${content.slice(0, 120)}`);
  return getById(userId, id);
}

function update(userId, id, patch = {}) {
  const cur = getById(userId, id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  if (next.tags !== undefined) next.tags = parseTags(next.tags);
  if (next.content !== undefined && !String(next.content).trim()) throw new Error('内容不能为空');
  if (next.importance !== undefined) next.importance = Math.min(5, Math.max(1, parseInt(next.importance, 10) || 1));
  db.rawDb().run(
    `UPDATE memory_items SET kind=?, content=?, tags=?, source=?, importance=?, pinned=?, expires_at=?, updated_at=?
     WHERE id=? AND user_id=?`,
    [
      KINDS.includes(next.kind) ? next.kind : cur.kind,
      String(next.content).trim().slice(0, 2000),
      JSON.stringify(next.tags),
      String(next.source || cur.source || 'manual').slice(0, 40),
      next.importance, next.pinned ? 1 : 0, next.expires_at || null, nowIso(),
      Number(id), Number(userId),
    ]
  );
  db.persist();
  logEvent(userId, 'update', `#${id} ${String(next.content || cur.content).slice(0, 100)}`);
  return getById(userId, id);
}

function remove(userId, id) {
  const cur = getById(userId, id);
  if (!cur) return false;
  db.rawDb().run('DELETE FROM memory_items WHERE id=? AND user_id=?', [Number(id), Number(userId)]);
  db.persist();
  logEvent(userId, 'forget', `#${id} ${cur.content.slice(0, 100)}`);
  return true;
}

function setPinned(userId, id, pinned) {
  const cur = getById(userId, id);
  if (!cur) return null;
  db.rawDb().run(
    'UPDATE memory_items SET pinned=?, updated_at=? WHERE id=? AND user_id=?',
    [pinned ? 1 : 0, nowIso(), Number(id), Number(userId)]
  );
  db.persist();
  logEvent(userId, pinned ? 'pin' : 'unpin', `#${id} ${cur.content.slice(0, 80)}`);
  return getById(userId, id);
}

/**
 * 召回：关键词打分 + 记忆增强，供 agent 每次对话自动注入
 */
function recall(userId, query, limit = 6) {
  ensureTable();
  const rows = db.query('SELECT * FROM memory_items WHERE user_id = ?', [Number(userId)])
    .filter((r) => {
      if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) return false;
      return true;
    });
  const terms = String(query || '').toLowerCase().split(/[\s,，;；]+/).filter(Boolean);
  rows.sort((a, b) => recallScore(b, terms) - recallScore(a, terms));
  const top = rows.slice(0, limit);
  const now = nowIso();
  for (const r of top) {
    db.rawDb().run(
      'UPDATE memory_items SET last_accessed_at=? WHERE id=? AND user_id=?',
      [now, r.id, Number(userId)]
    );
  }
  db.persist();
  if (top.length) logEvent(userId, 'recall', `${String(query || '').slice(0, 80)} → ${top.length} 条`);
  return top.map(toItem);
}

function renderContext(items) {
  if (!items || !items.length) return '';
  return '\n[长期记忆] ' + items.map((it) =>
    `#${it.kind}${it.importance >= 3 ? '★' : ''}${it.pinned ? '📌' : ''}: ${it.content}`
  ).join(' | ');
}

function safeParseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try { return JSON.parse(s); } catch (_) { return null; }
}

/**
 * 让 LLM 从最近对话提炼长期记忆（可用于"从对话提取"按钮）
 */
async function autoExtract(userId, messages = [], opts = {}) {
  const cfg = llm.resolveConfig();
  if (!cfg.apiKey) return { ok: false, extracted: 0, error: '提取记忆需要配置 LLM' };
  if (!Array.isArray(messages) || !messages.length) return { ok: false, extracted: 0, error: '没有可分析的对话' };
  const transcript = messages.slice(-20)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${String(m.content || '').slice(0, 500)}`)
    .join('\n');
  const r = await llm.chat(
    [
      {
        role: 'system',
        content: '你是记忆提炼器。从对话里找出值得长期记住的用户事实、偏好、习惯、目标和重要事件。' +
          '只返回 JSON：{"items":[{"kind":"fact|preference|event|context|habit","content":"一句话","tags":["标签"],"importance":1}]}。' +
          'ignore 闲聊、临时指令、无价值信息；每轮最多 5 条；content 用第三人称、完整、可独立理解。',
      },
      { role: 'user', content: transcript },
    ],
    { temperature: 0.2, max_tokens: 900, userId, intent: 'memory_extract' }
  );
  if (!r.ok) return { ok: false, extracted: 0, error: r.error };
  const parsed = safeParseJson(r.text);
  const items = (parsed && Array.isArray(parsed.items) ? parsed.items : []).filter((x) => x && String(x.content || '').trim());
  let created = 0;
  for (const it of items) {
    try {
      // 内容去重：已有几乎一致的记忆就不重复写入
      const existing = db.query('SELECT content FROM memory_items WHERE user_id = ?', [Number(userId)]);
      const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '');
      if (existing.some((e) => norm(e.content) === norm(it.content))) continue;
      create(userId, {
        kind: it.kind, content: it.content, tags: it.tags, importance: it.importance, source: 'llm-extract',
      });
      created++;
    } catch (e) {
      logger.warn('memory autoExtract item failed:', e.message);
    }
  }
  logEvent(userId, 'extract', `从对话提炼 ${created} 条记忆`);
  return { ok: true, extracted: created, items: items.slice(0, created) };
}

/**
 * 最近记忆操作记录（前端"事件流"用）
 */
function listEvents(userId, limit = 20) {
  try {
    ensureTable();
    const r = db.rawDb().exec(
      'SELECT action, summary, created_at FROM memory_events WHERE user_id=? ORDER BY id DESC LIMIT ?',
      [Number(userId), Math.min(parseInt(limit, 10) || 20, 100)]
    );
    if (!r.length) return [];
    return r[0].values.map((v) => ({ action: v[0], summary: v[1], created_at: v[2] }));
  } catch (_) { return []; }
}

function getStats(userId) {
  try {
    ensureTable();
    const rows = db.query('SELECT * FROM memory_items WHERE user_id = ?', [Number(userId)]);
    const byKind = {};
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    const pinned = rows.filter((r) => Number(r.pinned) === 1).length;
    const recalled = rows.filter((r) => r.last_accessed_at).length;
    return {
      total: rows.length,
      by_kind: byKind,
      pinned,
      recalled,
      events: listEvents(userId, 6),
    };
  } catch (_) {
    return { total: 0, by_kind: {}, pinned: 0, recalled: 0, events: [] };
  }
}

/**
 * 记录一次对话（轻量流水，不占 memory_items 额度）
 */
function logConversation(userId, message, intent) {
  logEvent(userId, 'conversation', `${intent || ''}: ${String(message || '').slice(0, 200)}`);
}

module.exports = {
  create,
  update,
  remove,
  list,
  recall,
  renderContext,
  autoExtract,
  listEvents,
  getStats,
  getById,
  setPinned,
  logEvent,
  logConversation,
};
