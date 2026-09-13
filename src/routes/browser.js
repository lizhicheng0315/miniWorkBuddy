'use strict';

const express = require('express');
const browser = require('../services/browser');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/status', async (req, res) => {
  res.json(await browser.status());
});

router.post('/start', async (req, res) => {
  const { url } = req.body || {};
  const r = await browser.start({ url });
  res.status(r.ok ? 200 : 500).json(r);
});

router.get('/tabs', async (req, res) => {
  res.json({ tabs: await browser.listTabs() });
});

router.post('/open', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url 必填' });
  const r = await browser.open(String(url));
  res.status(r.ok ? 200 : 500).json(r);
});

router.post('/navigate', async (req, res) => {
  const { tabId, url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url 必填' });
  try {
    const r = await browser.navigate(tabId, String(url));
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/snapshot', async (req, res) => {
  try {
    const r = await browser.snapshot((req.body || {}).tabId);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/screenshot', async (req, res) => {
  try {
    const r = await browser.screenshot((req.body || {}).tabId);
    res.status(r.ok ? 200 : 500).json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/click', async (req, res) => {
  try {
    const r = await browser.click((req.body || {}).tabId, req.body || {});
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/type', async (req, res) => {
  try {
    const r = await browser.type((req.body || {}).tabId, req.body || {});
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/key', async (req, res) => {
  const { tabId, key } = req.body || {};
  try {
    const r = await browser.key(tabId, key);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/scroll', async (req, res) => {
  const { tabId, dx, dy } = req.body || {};
  try {
    const r = await browser.scroll(tabId, dx, dy);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/evaluate', async (req, res) => {
  const { tabId, expression } = req.body || {};
  if (!expression) return res.status(400).json({ error: 'expression 必填' });
  try {
    res.json({ ok: true, value: await browser.evaluate(tabId, String(expression)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/close', async (req, res) => {
  const r = await browser.closeTab((req.body || {}).tabId);
  res.status(r.ok ? 200 : 400).json(r);
});

router.post('/stop', async (req, res) => {
  res.json(await browser.stop());
});

module.exports = router;
