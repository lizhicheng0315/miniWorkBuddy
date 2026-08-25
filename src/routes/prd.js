'use strict';

const express = require('express');
const prd = require('../services/prd');
const fs = require('fs');

const router = express.Router();

// PRD Markdown 下载（票据免登录）
router.get('/download/t/:ticket', (req, res) => {
  const rec = prd.getExport(req.params.ticket);
  if (!rec) return res.status(403).json({ error: '下载链接无效或已过期（10分钟有效）' });
  if (!fs.existsSync(rec.filePath)) return res.status(404).json({ error: '文件已被清理' });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rec.fileName)}`);
  res.sendFile(rec.filePath);
});

module.exports = router;
