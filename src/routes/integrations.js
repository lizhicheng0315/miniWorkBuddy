'use strict';

const express = require('express');
const integration = require('../services/integration');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// 列出所有渠道配置（脱敏：不返回 secret）
router.get('/', (req, res) => {
  const items = integration.list().map(i => ({
    id: i.id,
    channel: i.channel,
    name: i.name,
    enabled: i.enabled,
    webhook: i.config.webhook ? maskWebhook(i.config.webhook) : '',
    hasSecret: !!i.config.secret,
  }));
  res.json({ channels: integration.CHANNELS, items });
});

// 创建 / 更新某个渠道
router.post('/', (req, res) => {
  try {
    const { channel, ...rest } = req.body || {};
    if (!channel || !integration.CHANNELS[channel]) return res.status(400).json({ error: '无效 channel' });
    const row = integration.upsert(channel, rest);
    res.status(201).json({ ok: true, id: row.id, item: row });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 启用 / 停用
router.patch('/:id/enabled', (req, res) => {
  const id = Number(req.params.id);
  const enabled = !!((req.body || {}).enabled);
  try {
    integration.setEnabled(id, enabled);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 删除
router.delete('/:id', (req, res) => {
  integration.remove(Number(req.params.id));
  res.json({ ok: true });
});

// 测试推送
router.post('/:id/test', async (req, res) => {
  try {
    const r = await integration.testPush(Number(req.params.id));
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function maskWebhook(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop();
    const masked = last.length > 8 ? last.slice(0, 8) + '…' : last;
    return u.origin + u.pathname.replace(last, masked);
  } catch (_) {
    return url.slice(0, 24) + '…';
  }
}

module.exports = router;
