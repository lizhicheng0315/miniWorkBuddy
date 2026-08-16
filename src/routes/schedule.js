'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.use(requireAuth);

router.get('/', (req, res) => {
  const { from, to } = req.query;
  const rows = db.list(
    'schedule_events',
    (ev) => {
      if (from && ev.start_at < from) return false;
      if (to && ev.start_at > to) return false;
      return true;
    },
    req.user.id
  );
  rows.sort((a, b) => (a.start_at || '').localeCompare(b.start_at || ''));
  res.json(rows);
});

router.post('/', (req, res) => {
  const { title, start_at, end_at, location, notes, remind_before_min } = req.body || {};
  if (!title || !start_at) {
    return res.status(400).json({ error: 'title 与 start_at 必填' });
  }
  const row = db.insert('schedule_events', {
    user_id: req.user.id,
    title: String(title).trim(),
    start_at,
    end_at: end_at || null,
    location: location || '',
    notes: notes || '',
    remind_before_min: Number.isFinite(remind_before_min) ? remind_before_min : 15,
    fired: 0,
  });
  res.status(201).json(row);
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.find('schedule_events', id, req.user.id)) return res.status(404).json({ error: 'not found' });
  const fields = ['title', 'start_at', 'end_at', 'location', 'notes', 'remind_before_min', 'fired'];
  const patch = {};
  for (const f of fields) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
      patch[f] = req.body[f];
    }
  }
  res.json(db.update('schedule_events', id, patch, req.user.id));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.remove('schedule_events', id, req.user.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

module.exports = router;
