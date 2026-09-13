'use strict';

const express = require('express');
const fs = require('fs');
const media = require('../services/media');
const auth = require('../auth');

const router = express.Router();

router.get('/screenshot', (req, res) => {
  // 允许 img 标签通过 ?token= 鉴权加载截图，避免跨过 Authorization 头
  if (!req.user && req.query.token) {
    try { req.user = auth.userFromToken(req.query.token); } catch (_) {}
  }
  if (!req.user) return res.status(401).json({ error: '未登录' });
  const full = media.resolve(req.query.name);
  if (!full) return res.status(404).json({ error: '截图不存在' });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=60');
  fs.createReadStream(full).pipe(res);
});

module.exports = router;
