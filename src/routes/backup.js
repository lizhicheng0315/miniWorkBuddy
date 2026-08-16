'use strict';

const express = require('express');
const backup = require('../services/backup');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.use(requireAuth);

router.get('/export', (req, res) => {
  try {
    const snap = backup.exportSnapshot(req.user.id);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="workbuddy-backup-${ts}.json"`);
    res.send(JSON.stringify(snap, null, 2));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stats', (req, res) => {
  const snap = backup.exportSnapshot(req.user.id);
  res.json({
    exported_at: snap.exported_at,
    version: snap.version,
    counts: {
      todos: (snap.tables.todos || []).length,
      schedule_events: (snap.tables.schedule_events || []).length,
      reminders: (snap.tables.reminders || []).length,
      settings: (snap.tables.settings || []).length,
    },
  });
});

router.post('/import', (req, res) => {
  const mode = (req.body && req.body.mode) || 'replace';
  if (!['replace', 'merge'].includes(mode)) {
    return res.status(400).json({ error: 'mode 必须为 replace 或 merge' });
  }
  try {
    const result = backup.importSnapshot(req.body, mode, req.user.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
