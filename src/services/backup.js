'use strict';

/**
 * 备份/导入服务（按用户隔离）
 */

const db = require('../db');
const logger = require('../logger');

function exportSnapshot(userId) {
  const filter = userId != null ? (r) => r.user_id === userId : null;
  return {
    version: 2,
    exported_at: db.nowIso(),
    user_id: userId || null,
    tables: {
      todos: filter ? db.list('todos', filter) : db.list('todos'),
      schedule_events: filter ? db.list('schedule_events', filter) : db.list('schedule_events'),
      reminders: filter ? db.list('reminders', filter) : db.list('reminders'),
      settings: filter ? db.list('settings', filter) : db.list('settings'),
    },
  };
}

function importSnapshot(snapshot, mode, userId) {
  if (!snapshot || !snapshot.tables) throw new Error('invalid snapshot: missing tables');
  if (mode === 'merge') return mergeSnapshot(snapshot, userId);
  return replaceSnapshot(snapshot, userId);
}

function replaceSnapshot(snapshot, userId) {
  // 删除当前用户的全部数据
  for (const t of ['todos', 'schedule_events', 'reminders', 'settings']) {
    if (userId != null) {
      db.rawDb().run(`DELETE FROM ${t} WHERE user_id = ?`, [userId]);
    } else {
      db.rawDb().run(`DELETE FROM ${t}`);
    }
  }
  const counts = insertSnapshot(snapshot, userId);
  logger.info(`import: replaced (user=${userId || 'all'}) ${JSON.stringify(counts)}`);
  return { mode: 'replace', counts };
}

function mergeSnapshot(snapshot, userId) {
  const counts = { todos: 0, schedule_events: 0, reminders: 0, settings: 0 };
  const t = snapshot.tables;
  const uid = userId;
  for (const row of t.todos || []) {
    if (!db.find('todos', row.id, uid)) {
      const copy = { ...row };
      delete copy.id;
      copy.user_id = uid;
      db.insert('todos', copy);
      counts.todos++;
    }
  }
  for (const row of t.schedule_events || []) {
    if (!db.find('schedule_events', row.id, uid)) {
      const copy = { ...row };
      delete copy.id;
      copy.user_id = uid;
      db.insert('schedule_events', copy);
      counts.schedule_events++;
    }
  }
  for (const row of t.reminders || []) {
    if (!db.find('reminders', row.id, uid)) {
      const copy = { ...row };
      delete copy.id;
      copy.user_id = uid;
      db.insert('reminders', copy);
      counts.reminders++;
    }
  }
  for (const row of t.settings || []) {
    if (db.getSetting(row.key, uid) == null) {
      db.setSetting(row.key, row.value, uid);
      counts.settings++;
    }
  }
  logger.info(`import: merged (user=${uid || 'all'}) ${JSON.stringify(counts)}`);
  return { mode: 'merge', counts };
}

function insertSnapshot(snapshot, userId) {
  const counts = { todos: 0, schedule_events: 0, reminders: 0, settings: 0 };
  const uid = userId;
  for (const row of snapshot.tables.todos || []) {
    const copy = { ...row };
    delete copy.id; // 让 DB 自增
    copy.user_id = uid;
    db.insert('todos', copy);
    counts.todos++;
  }
  for (const row of snapshot.tables.schedule_events || []) {
    const copy = { ...row };
    delete copy.id;
    copy.user_id = uid;
    db.insert('schedule_events', copy);
    counts.schedule_events++;
  }
  for (const row of snapshot.tables.reminders || []) {
    const copy = { ...row };
    delete copy.id;
    copy.user_id = uid;
    db.insert('reminders', copy);
    counts.reminders++;
  }
  for (const row of snapshot.tables.settings || []) {
    db.setSetting(row.key, row.value, uid);
    counts.settings++;
  }
  return counts;
}

module.exports = { exportSnapshot, importSnapshot };
