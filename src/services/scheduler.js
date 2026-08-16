'use strict';

const cron = require('node-cron');
const db = require('../db');
const config = require('../config');
const logger = require('../logger');
const { alert } = require('./notifier');

const tasks = new Map(); // reminderId -> cronTask
let scheduleTimer = null;

function loadAll() {
  const rows = db.list('reminders', (r) => r.enabled);
  for (const r of rows) register(r);
  logger.info(`scheduler loaded ${rows.length} reminder(s)`);
  armSchedulePoller();
}

function isValidCron(expr) {
  return typeof expr === 'string' && cron.validate(expr);
}

function register(reminder) {
  if (!isValidCron(reminder.cron)) {
    logger.warn(`reminder #${reminder.id} invalid cron: ${reminder.cron}`);
    return false;
  }
  unregister(reminder.id);
  const task = cron.schedule(reminder.cron, () => {
    const owner = reminder.user_id ? db.find('users', reminder.user_id) : null;
    const ownerTag = owner ? `（@${owner.username}）` : '';
    const title = `⏰ ${reminder.title}${ownerTag}`;
    const message =
      reminder.message && reminder.message.length > 0
        ? reminder.message
        : '这是你设置的每日提醒';
    alert(title, message);
  });
  tasks.set(reminder.id, task);
  logger.info(`registered reminder #${reminder.id} cron=${reminder.cron}`);
  return true;
}

function unregister(id) {
  const t = tasks.get(id);
  if (t) {
    t.stop();
    tasks.delete(id);
    logger.info(`unregistered reminder #${id}`);
  }
}

function armSchedulePoller() {
  if (scheduleTimer) return;
  scheduleTimer = setInterval(() => {
    try {
      pollUpcomingEvents();
    } catch (e) {
      logger.error('schedule poll error:', e.message);
    }
  }, 60 * 1000);
  pollUpcomingEvents();
}

function pollUpcomingEvents() {
  const now = new Date();
  const rows = db.list('schedule_events', (ev) => !ev.fired && new Date(ev.start_at) >= new Date(now.getTime() - 24 * 3600 * 1000));

  for (const ev of rows) {
    const start = new Date(ev.start_at);
    if (Number.isNaN(start.getTime())) continue;
    const remindAt = new Date(start.getTime() - (ev.remind_before_min || 15) * 60 * 1000);
    if (now >= remindAt && now < start) {
      const where = ev.location ? `\n地点：${ev.location}` : '';
      alert(
        `📅 日程提醒：${ev.title}`,
        `${start.toLocaleString()}${where}\n（提前 ${ev.remind_before_min} 分钟）`
      );
      db.update('schedule_events', ev.id, { fired: 1 });
    } else if (now >= start && !ev.fired) {
      const where = ev.location ? `\n地点：${ev.location}` : '';
      alert(`📅 日程已到：${ev.title}`, `${start.toLocaleString()}${where}`);
      db.update('schedule_events', ev.id, { fired: 1 });
    }
  }
}

function shutdown() {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  }
  for (const t of tasks.values()) t.stop();
  tasks.clear();
}

module.exports = { loadAll, register, unregister, isValidCron, shutdown };
