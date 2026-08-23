'use strict';

const express = require('express');
const ppt = require('../services/ppt');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// 当前用户 PPT 草稿（预览用）
router.get('/draft', requireAuth, (req, res) => {
  const d = ppt.getDraft(req.user.id);
  if (!d) return res.json({ has: false });
  res.json({ has: true, draft: d, theme: ppt.THEMES[d.theme] || null });
});

// 票据下载（<a href> 点击无法带 Authorization 头，用短时票据替代）——无需登录态
router.get('/download/t/:ticket', (req, res) => {
  const rec = ppt.verifyTicket(req.params.ticket);
  if (!rec) return res.status(403).json({ error: '下载链接无效或已过期（10分钟有效），请重新生成 PPT' });
  if (!require('fs').existsSync(rec.filePath)) return res.status(404).json({ error: '文件已被清理' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rec.fileName)}`);
  res.sendFile(rec.filePath);
});

// 登录态下载（编程调用用）
router.get('/download/:exportId', requireAuth, (req, res) => {
  const rec = ppt.getExport(req.params.exportId);
  if (!rec) return res.status(404).json({ error: '文件不存在或已过期（服务重启后失效）' });
  if (!require('fs').existsSync(rec.filePath)) return res.status(404).json({ error: '文件已被清理' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rec.fileName)}`);
  res.sendFile(rec.filePath);
});

module.exports = router;
