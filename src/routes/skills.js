'use strict';

const express = require('express');
const skills = require('../services/skills');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({ items: skills.list() });
});

router.post('/', (req, res) => {
  const { name, description, when_to_use, content, version } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '技能名必填' });
  try {
    const skill = skills.save(name, { description, when_to_use, content, version });
    res.status(201).json(skill);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/install', async (req, res) => {
  const { url, name } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url 必填' });
  try {
    const skill = await skills.installFromGitHub(req.user.id, url, name);
    res.status(201).json(skill);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:name', (req, res) => {
  const skill = skills.read(req.params.name);
  if (!skill) return res.status(404).json({ error: '技能不存在' });
  res.json(skill);
});

router.patch('/:name', (req, res) => {
  try {
    const skill = skills.save(req.params.name, req.body || {});
    res.json(skill);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:name', (req, res) => {
  if (!skills.remove(req.params.name)) return res.status(404).json({ error: '技能不存在' });
  res.json({ ok: true });
});

router.post('/:name/run', async (req, res) => {
  const { task } = req.body || {};
  const r = await skills.runSkill(req.user.id, req.params.name, task || '');
  res.status(r.ok ? 200 : 400).json(r);
});

module.exports = router;
