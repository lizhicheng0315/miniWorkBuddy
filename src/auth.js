'use strict';

/**
 * 用户与认证：
 *   - 密码用 scrypt 哈希（Node 内置 crypto，PBKDF2/scrypt 比 bcrypt 简单且无 native 依赖）
 *   - session 用 32 字节随机 token，存在 sessions 表
 *   - 启动时如果没有任何用户，自动创建一个 admin（用户名/密码从 .env 读，或随机生成并打印）
 */

const crypto = require('crypto');
const db = require('./db');
const logger = require('./logger');
const config = require('./config');

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 32;

function hashPassword(plain, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const buf = crypto.scryptSync(String(plain), s, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return { hash: buf.toString('hex'), salt: s };
}

function verifyPassword(plain, salt, expectedHash) {
  try {
    const { hash } = hashPassword(plain, salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
  } catch (_) {
    return false;
  }
}

function createUser(username, plainPassword, isAdmin = 0) {
  const { hash, salt } = hashPassword(plainPassword);
  const info = db.rawDb().run(
    'INSERT INTO users (username, password_hash, salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
    [String(username).trim(), hash, salt, isAdmin ? 1 : 0, db.nowIso()]
  );
  return getUserById(db.rawDb().exec('SELECT last_insert_rowid() AS id')[0].values[0][0]);
}

function getUserById(id) {
  if (!id) return null;
  const rows = db.list('users', (u) => u.id === Number(id));
  return rows[0] || null;
}

function getUserByUsername(username) {
  if (!username) return null;
  const rows = db.list('users', (u) => u.username === String(username).trim());
  return rows[0] || null;
}

function authenticate(username, plainPassword) {
  const u = getUserByUsername(username);
  if (!u) return null;
  if (!verifyPassword(plainPassword, u.salt, u.password_hash)) return null;
  return u;
}

function changePassword(userId, newPlain) {
  const { hash, salt } = hashPassword(newPlain);
  db.update('users', userId, { password_hash: hash, salt });
  return true;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.rawDb().run(
    'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)'
  );
  db.rawDb().run('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [token, userId, expires, db.nowIso()]);
  return { token, expires_at: expires };
}

/**
 * 滑动续期：剩余有效期 < 1 天时自动延长到 7 天后。
 * 每次鉴权时调用。
 */
function maybeRefreshSession(token) {
  try {
    const r = db.rawDb().exec('SELECT expires_at FROM sessions WHERE token = ?', [token]);
    if (!r.length || !r[0].values.length) return;
    const expiresAt = new Date(r[0].values[0][0]);
    if (Number.isNaN(expiresAt.getTime())) return;
    if (expiresAt.getTime() - Date.now() < 24 * 3600 * 1000) {
      const newExp = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      db.rawDb().run('UPDATE sessions SET expires_at = ? WHERE token = ?', [newExp, token]);
    }
  } catch (_) { /* 忽略 */ }
}

function destroySession(token) {
  if (!token) return;
  db.rawDb().run('DELETE FROM sessions WHERE token = ?', [token]);
}

function userFromToken(token) {
  if (!token) return null;
  const rows = db.rawDb().exec('SELECT user_id, expires_at FROM sessions WHERE token = ?', [token]);
  if (!rows.length || !rows[0].values.length) return null;
  const [userId, expiresAt] = rows[0].values[0];
  if (new Date(expiresAt).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  const u = getUserById(userId);
  if (u) maybeRefreshSession(token); // 续期
  return u;
}

// ===== 登录失败计数（按用户名，5 次/15 分钟） =====
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 5;
const loginFailures = new Map(); // username -> { count, firstAt }

function recordLoginFailure(username) {
  const now = Date.now();
  const u = String(username).toLowerCase();
  const cur = loginFailures.get(u);
  if (!cur || now - cur.firstAt > FAIL_WINDOW_MS) {
    loginFailures.set(u, { count: 1, firstAt: now });
  } else {
    cur.count++;
  }
}
function clearLoginFailures(username) {
  loginFailures.delete(String(username).toLowerCase());
}
function isLoginLocked(username) {
  const u = String(username).toLowerCase();
  const cur = loginFailures.get(u);
  if (!cur) return false;
  if (Date.now() - cur.firstAt > FAIL_WINDOW_MS) {
    loginFailures.delete(u);
    return false;
  }
  return cur.count >= FAIL_LIMIT;
}

function bootstrapAdmin() {
  const all = db.list('users');
  if (all.length > 0) return;
  let username = config.auth.bootstrapUser;
  let password = config.auth.bootstrapPassword;
  if (!password) {
    password = crypto.randomBytes(8).toString('hex');
    logger.warn('=' .repeat(60));
    logger.warn('首次启动自动创建管理员账户（请立即修改密码！）：');
    logger.warn(`  用户名: ${username}`);
    logger.warn(`  密  码: ${password}`);
    logger.warn('=' .repeat(60));
  }
  createUser(username, password, 1);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createUser,
  getUserById,
  getUserByUsername,
  authenticate,
  changePassword,
  createSession,
  destroySession,
  userFromToken,
  maybeRefreshSession,
  bootstrapAdmin,
  recordLoginFailure,
  clearLoginFailures,
  isLoginLocked,
};
