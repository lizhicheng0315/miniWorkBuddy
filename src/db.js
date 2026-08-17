'use strict';

/**
 * 数据访问层（DAL）：用 sql.js (SQLite WASM) 实现，零原生编译。
 * 接口保持 db.list/find/insert/update/remove/getSetting/setSetting 不变，
 * 业务代码无需感知底层是 JSON 还是 SQLite。
 *
 * 持久化策略：
 *   - 启动时从 .db 文件加载到内存
 *   - 每次写操作后把内存 DB 序列化回 .db（先写 .tmp 再 rename 原子替换）
 *   - 启动时若不存在则建表
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const config = require('./config');
const logger = require('./logger');

let SQL = null;
let db = null;
let dbFile = null;

async function init() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  dbFile = path.join(config.dataDir, 'workbuddy.db');

  // sql.js 的 wasm 文件：开发模式从 node_modules 复制；pkg 模式下从虚拟 fs 提取
  const wasmDst = path.join(config.dataDir, 'sql-wasm.wasm');
  if (process.pkg) {
    // pkg 模式：从虚拟文件系统读取
    const wasmBuf = fs.readFileSync(path.join(path.dirname(process.execPath), 'sql-wasm.wasm'));
    fs.writeFileSync(wasmDst, wasmBuf);
    logger.info('pkg mode: extracted sql-wasm.wasm to data dir');
  } else {
    const wasmSrc = require.resolve('sql.js/dist/sql-wasm.wasm');
    if (!fs.existsSync(wasmDst) || fs.statSync(wasmSrc).mtimeMs > fs.statSync(wasmDst).mtimeMs) {
      fs.copyFileSync(wasmSrc, wasmDst);
    }
  }

  SQL = await initSqlJs({
    locateFile: () => wasmDst,
  });

  if (fs.existsSync(dbFile)) {
    const buf = fs.readFileSync(dbFile);
    db = new SQL.Database(buf);
    logger.info(`SQLite loaded from ${dbFile} (${buf.length} bytes)`);
  } else {
    db = new SQL.Database();
    logger.info('SQLite created in memory (will persist on first write)');
  }

  migrate();
  persist();
}

function migrate() {
  db.run(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      notes TEXT DEFAULT '',
      priority INTEGER DEFAULT 2,
      category TEXT DEFAULT '',
      due_at TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_todos_status   ON todos(status);
    CREATE INDEX IF NOT EXISTS idx_todos_due      ON todos(due_at);
    -- 复合索引：覆盖"今日待办"和"打开状态按截止时间排序"两类高频查询
    CREATE INDEX IF NOT EXISTS idx_todos_status_due ON todos(status, due_at);

    CREATE TABLE IF NOT EXISTS schedule_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT,
      location TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      remind_before_min INTEGER DEFAULT 15,
      fired INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_start ON schedule_events(start_at);
    -- 复合索引：覆盖"未触发且 start_at 在窗口内"扫描（每分钟一次，热点路径）
    CREATE INDEX IF NOT EXISTS idx_schedule_fired_start ON schedule_events(fired, start_at);

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      cron TEXT NOT NULL,
      message TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );
    -- 高频："启动时查所有 enabled" 与 "scheduler 同步"
    CREATE INDEX IF NOT EXISTS idx_reminders_enabled ON reminders(enabled);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- ===== v2：多用户支持 =====
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- ===== v3：LLM token 用量记录 =====
    CREATE TABLE IF NOT EXISTS llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      intent TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_user_time ON llm_usage(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_model ON llm_usage(model);

    -- 给所有数据表加 user_id 列（如不存在），用于多用户隔离
  `);

  // 幂等添加 user_id 列（ALTER 在 sql.js 里不支持 IF NOT EXISTS，用 try/catch）
  addColumnIfMissing('todos', 'user_id', 'INTEGER');
  addColumnIfMissing('schedule_events', 'user_id', 'INTEGER');
  addColumnIfMissing('reminders', 'user_id', 'INTEGER');
  addColumnIfMissing('settings', 'user_id', 'INTEGER');

  // 多用户复合索引
  db.run('CREATE INDEX IF NOT EXISTS idx_todos_user_status_due ON todos(user_id, status, due_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_schedule_user_start ON schedule_events(user_id, start_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_reminders_user_enabled ON reminders(user_id, enabled)');
  db.run('CREATE INDEX IF NOT EXISTS idx_settings_user_key ON settings(user_id, key)');
}

function addColumnIfMissing(table, col, type) {
  try {
    const cols = db.exec(`PRAGMA table_info(${table})`);
    const names = (cols[0]?.values || []).map((r) => r[1]);
    if (!names.includes(col)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  } catch (e) {
    // 已存在或列冲突，忽略
  }
}

let writeQueue = Promise.resolve();
function persist() {
  // 串行化写：避免并发写竞争，原子替换文件
  writeQueue = writeQueue.then(async () => {
    const data = Buffer.from(db.export());
    const tmp = dbFile + '.tmp';
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, dbFile);
  }).catch((e) => {
    logger.error('persist failed:', e.message);
  });
  return writeQueue;
}

function nowIso() {
  return new Date().toISOString();
}

// ===== 行映射：sql.js 返回 {columns, values}，转成对象数组 =====
function rowsOf(result) {
  if (!result || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map((arr) => {
    const o = {};
    columns.forEach((c, i) => (o[c] = arr[i]));
    return o;
  });
}

function exec(sql, params = []) {
  // sql.js 的 run 不返回 lastInsertRowid，需要单独查
  db.run(sql, params);
  const idRes = db.exec('SELECT last_insert_rowid() AS id');
  return { lastId: idRes.length ? idRes[0].values[0][0] : null };
}

function query(sql, params = []) {
  return rowsOf(db.exec(sql, params));
}

// ===== 对外 API（保持与之前 JSON 版本同名） =====

function list(table, where, userId) {
  // where 可以是过滤函数 (row) => boolean
  // userId: 若提供则附加 user_id 过滤（多用户隔离）
  const all = query(`SELECT * FROM ${table}`);
  let rows = all;
  if (typeof where === 'function') rows = rows.filter(where);
  if (userId != null) rows = rows.filter((r) => r.user_id === Number(userId));
  return rows;
}

function find(table, id, userId) {
  const rows = query(`SELECT * FROM ${table} WHERE id = ?`, [Number(id)]);
  const r = rows[0] || null;
  if (!r) return null;
  if (userId != null && r.user_id !== Number(userId)) return null;
  return r;
}

function insert(table, obj) {
  // 自动补 created_at/updated_at（如果调用方没传）
  const row = { ...obj };
  if (row.created_at === undefined) row.created_at = nowIso();
  if (row.updated_at === undefined && table === 'todos') row.updated_at = nowIso();

  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  const { lastId } = exec(sql, cols.map((c) => row[c]));
  // 触发持久化（不 await，调用方不会阻塞）
  persist();
  return find(table, lastId);
}

function update(table, id, patch, userId) {
  const cur = find(table, id, userId);
  if (!cur) return null;
  const cols = Object.keys(patch);
  if (cols.length === 0) return cur;
  const setSql = cols.map((c) => `${c} = ?`).join(', ');
  exec(`UPDATE ${table} SET ${setSql} WHERE id = ?`, [...cols.map((c) => patch[c]), Number(id)]);
  persist();
  return find(table, id, userId);
}

function remove(table, id, userId) {
  const before = find(table, id, userId);
  if (!before) return false;
  exec(`DELETE FROM ${table} WHERE id = ?`, [Number(id)]);
  persist();
  return true;
}

function getSetting(key, userId) {
  const sql = userId != null
    ? 'SELECT value FROM settings WHERE key = ? AND user_id = ?'
    : 'SELECT value FROM settings WHERE key = ?';
  const args = userId != null ? [key, Number(userId)] : [key];
  const r = query(sql, args);
  return r[0] ? r[0].value : null;
}

function setSetting(key, value, userId) {
  if (userId != null) {
    // 先删后插（用 user_id + key 唯一定位）
    exec('DELETE FROM settings WHERE key = ? AND user_id = ?', [key, Number(userId)]);
    exec('INSERT INTO settings (key, value, user_id) VALUES (?, ?, ?)', [key, String(value), Number(userId)]);
  } else {
    exec('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
  }
  persist();
}

// ===== 备份/导入用：序列化所有数据 =====
function snapshotAll() {
  return {
    version: 1,
    exported_at: nowIso(),
    tables: {
      todos: query('SELECT * FROM todos ORDER BY id'),
      schedule_events: query('SELECT * FROM schedule_events ORDER BY id'),
      reminders: query('SELECT * FROM reminders ORDER BY id'),
      settings: query('SELECT * FROM settings'),
    },
  };
}

function replaceAll(snapshot) {
  if (!snapshot || !snapshot.tables) throw new Error('invalid snapshot');
  db.run('BEGIN');
  try {
    db.run('DELETE FROM todos');
    db.run('DELETE FROM schedule_events');
    db.run('DELETE FROM reminders');
    db.run('DELETE FROM settings');

    for (const t of snapshot.tables.todos || []) {
      const cols = Object.keys(t);
      const placeholders = cols.map(() => '?').join(', ');
      db.run(`INSERT INTO todos (${cols.join(',')}) VALUES (${placeholders})`, cols.map((c) => t[c]));
    }
    for (const t of snapshot.tables.schedule_events || []) {
      const cols = Object.keys(t);
      const placeholders = cols.map(() => '?').join(', ');
      db.run(
        `INSERT INTO schedule_events (${cols.join(',')}) VALUES (${placeholders})`,
        cols.map((c) => t[c])
      );
    }
    for (const t of snapshot.tables.reminders || []) {
      const cols = Object.keys(t);
      const placeholders = cols.map(() => '?').join(', ');
      db.run(`INSERT INTO reminders (${cols.join(',')}) VALUES (${placeholders})`, cols.map((c) => t[c]));
    }
    for (const t of snapshot.tables.settings || []) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [t.key, t.value]);
    }
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
  persist();
}

function rawDb() {
  return db;
}

module.exports = {
  init,
  list,
  find,
  insert,
  update,
  remove,
  getSetting,
  setSetting,
  nowIso,
  snapshotAll,
  replaceAll,
  persist,
  rawDb,
  _path: config.dataDir,
};
