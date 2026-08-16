'use strict';

const auth = require('../auth');
const logger = require('../logger');

/**
 * Express 中间件：从 Authorization: Bearer <token> 解析用户，挂到 req.user。
 * 关闭认证（AUTH_ENABLED=false）时放行所有请求。
 */
function attachUser(req, res, next) {
  req.user = null;
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) {
    req.user = auth.userFromToken(m[1]);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  next();
}

module.exports = { attachUser, requireAuth };
