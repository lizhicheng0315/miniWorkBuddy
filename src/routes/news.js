'use strict';

const express = require('express');
const news = require('../services/news');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
news.ensureTables();

router.get('/catalog', (req, res) => {
  res.json(news.publicCatalog());
});

router.get('/boards', (req, res) => {
  res.json({ items: news.listBoards(req.user.id) });
});

router.post('/boards', (req, res) => {
  try {
    res.status(201).json(news.createBoard(req.user.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.patch('/boards/:id', (req, res) => {
  try {
    const board = news.updateBoard(req.user.id, req.params.id, req.body || {});
    if (!board) return res.status(404).json({ error: '新闻板块不存在' });
    res.json(board);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/boards/:id', (req, res) => {
  if (!news.removeBoard(req.user.id, req.params.id)) {
    return res.status(404).json({ error: '新闻板块不存在' });
  }
  res.json({ ok: true });
});

router.post('/boards/:id/schedule', (req, res) => {
  try {
    const result = news.scheduleBoard(req.user.id, req.params.id, req.body && req.body.cron);
    if (!result) return res.status(404).json({ error: '新闻板块不存在' });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/boards/:id/run', async (req, res) => {
  try {
    res.json(await news.digest(req.user.id, {
      boardId: req.params.id,
      limit: req.body && req.body.limit,
      force: !!(req.body && req.body.force),
    }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/items', async (req, res) => {
  try {
    const sourceIds = String(req.query.sources || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    res.json(await news.articlesFor(req.user.id, {
      boardId: req.query.boardId,
      sourceIds,
      query: req.query.q,
      limit: req.query.limit,
      sinceHours: req.query.hours,
      force: req.query.force === '1',
    }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/search', async (req, res) => {
  try {
    res.json(await news.search(req.user.id, req.body && req.body.query, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
