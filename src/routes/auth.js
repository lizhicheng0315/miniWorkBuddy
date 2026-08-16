'use strict';

const express = require('express');
const auth = require('../auth');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username 与 password 必填' });
  }
  // 失败计数（防爆破）
  if (auth.isLoginLocked(username)) {
    return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' });
  }
  const u = auth.authenticate(username, password);
  if (!u) {
    auth.recordLoginFailure(username);
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  auth.clearLoginFailures(username);
  const { token, expires_at } = auth.createSession(u.id);
  res.json({
    token,
    expires_at,
    user: { id: u.id, username: u.username, is_admin: !!u.is_admin },
  });
});

router.post('/logout', (req, res) => {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) auth.destroySession(m[1]);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, is_admin: !!req.user.is_admin });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 4) {
    return res.status(400).json({ error: '新密码至少 4 位' });
  }
  if (old_password) {
    if (!auth.authenticate(req.user.username, old_password)) {
      return res.status(401).json({ error: '旧密码错误' });
    }
  }
  auth.changePassword(req.user.id, new_password);
  res.json({ ok: true });
});

// ===== Admin 专属 =====
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: '需要 admin 权限' });
  next();
}

router.post('/register', requireAuth, requireAdmin, (req, res) => {
  const { username, password, is_admin } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username 与 password 必填' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  if (auth.getUserByUsername(username)) return res.status(409).json({ error: '用户名已存在' });
  const u = auth.createUser(username, password, is_admin ? 1 : 0);
  res.status(201).json({ id: u.id, username: u.username, is_admin: !!u.is_admin });
});

router.get('/users', requireAuth, requireAdmin, (req, res) => {
  const all = require('../db').list('users');
  res.json(all.map((u) => ({ id: u.id, username: u.username, is_admin: !!u.is_admin, created_at: u.created_at })));
});

module.exports = router;
