'use strict';

const express = require('express');
const plan = require('../services/plan');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
plan.ensureTables();

router.get('/dashboard', (req, res) => {
  try {
    res.json(plan.dashboard(req.user.id, req.query.month));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/goals', (req, res) => {
  res.json({ items: plan.listGoals(req.user.id, req.query.month) });
});

router.post('/goals', (req, res) => {
  try {
    res.status(201).json(plan.createGoal(req.user.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.patch('/goals/:id', (req, res) => {
  try {
    const item = plan.updateGoal(req.user.id, req.params.id, req.body || {});
    if (!item) return res.status(404).json({ error: '月目标不存在' });
    res.json(item);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/goals/:id', (req, res) => {
  if (!plan.removeGoal(req.user.id, req.params.id)) return res.status(404).json({ error: '月目标不存在' });
  res.json({ ok: true });
});

router.get('/tasks', (req, res) => {
  res.json({
    items: plan.listTasks(req.user.id, {
      month: req.query.month,
      weekStart: req.query.weekStart,
      goalId: req.query.goalId,
    }),
  });
});

router.post('/tasks', (req, res) => {
  try {
    res.status(201).json(plan.createTask(req.user.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.patch('/tasks/:id', (req, res) => {
  try {
    const item = plan.updateTask(req.user.id, req.params.id, req.body || {});
    if (!item) return res.status(404).json({ error: '周任务不存在' });
    res.json(item);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/tasks/:id', (req, res) => {
  if (!plan.removeTask(req.user.id, req.params.id)) return res.status(404).json({ error: '周任务不存在' });
  res.json({ ok: true });
});

router.post('/todos', (req, res) => {
  try {
    res.status(201).json(plan.createDailyTodo(req.user.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/rollover', (req, res) => {
  res.json(plan.rolloverOverdue(req.user.id));
});

module.exports = router;
