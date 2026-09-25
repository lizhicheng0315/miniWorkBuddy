'use strict';

/**
 * Hierarchical personal planning:
 *   month goal -> weekly task -> daily todo
 *
 * Derived completion is calculated from linked records. Deadlines that pass
 * are rolled forward by the service and also by a daily server-side job.
 */

const db = require('../db');
const logger = require('../logger');

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function isoAtLocal(date, hours = 18, minutes = 0) {
  const next = new Date(date);
  next.setHours(hours, minutes, 0, 0);
  return next.toISOString();
}

function parseMonth(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  return { key: `${year}-${pad(month + 1)}`, year, month, first, last };
}

function startOfWeek(value = new Date()) {
  const date = new Date(value);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfWeek(value = new Date()) {
  const date = startOfWeek(value);
  date.setDate(date.getDate() + 6);
  return date;
}

function endOfMonth(month) {
  const parsed = parseMonth(month || monthKey());
  return parsed ? parsed.last : new Date();
}

function dateOnly(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : dateKey(date);
}

function addDays(value, count) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setDate(date.getDate() + count);
  return date;
}

function weeksOfMonth(month) {
  const parsed = parseMonth(month || monthKey());
  if (!parsed) return [];
  const weeks = [];
  let cursor = startOfWeek(parsed.first);
  while (cursor <= parsed.last) {
    const end = endOfWeek(cursor);
    weeks.push({
      start: dateKey(cursor),
      end: dateKey(end),
      label: `${cursor.getMonth() + 1}/${cursor.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`,
      isCurrent: dateKey(startOfWeek()) === dateKey(cursor),
    });
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

function clampProgress(value) {
  const number = Number(value);
  return Math.min(Math.max(Number.isFinite(number) ? Math.round(number) : 0, 0), 100);
}

function addColumnIfMissing(table, column, definition) {
  try {
    const result = db.rawDb().exec(`PRAGMA table_info(${table})`);
    const names = (result[0]?.values || []).map((row) => row[1]);
    if (!names.includes(column)) db.rawDb().run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (_) {}
}

function ensureTables() {
  db.rawDb().run(`
    CREATE TABLE IF NOT EXISTS plan_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      month TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      weight INTEGER NOT NULL DEFAULT 1,
      progress INTEGER NOT NULL DEFAULT 0,
      due_date TEXT,
      original_due_date TEXT,
      rollover_count INTEGER NOT NULL DEFAULT 0,
      last_rolled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS plan_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      goal_id INTEGER,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      week_start TEXT NOT NULL,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      progress INTEGER NOT NULL DEFAULT 0,
      estimate_minutes INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      original_due_date TEXT,
      rollover_count INTEGER NOT NULL DEFAULT 0,
      last_rolled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_plan_goals_user_month ON plan_goals(user_id, month, id);
    CREATE INDEX IF NOT EXISTS idx_plan_tasks_user_week ON plan_tasks(user_id, week_start, id);
    CREATE INDEX IF NOT EXISTS idx_plan_tasks_goal ON plan_tasks(goal_id, id);
  `);
  addColumnIfMissing('todos', 'plan_goal_id', 'INTEGER');
  addColumnIfMissing('todos', 'plan_task_id', 'INTEGER');
  addColumnIfMissing('todos', 'planned_for', 'TEXT');
  addColumnIfMissing('todos', 'original_due_at', 'TEXT');
  addColumnIfMissing('todos', 'rollover_count', 'INTEGER DEFAULT 0');
  addColumnIfMissing('todos', 'last_rolled_at', 'TEXT');
  addColumnIfMissing('todos', 'rollover_enabled', 'INTEGER DEFAULT 1');
  db.rawDb().run('CREATE INDEX IF NOT EXISTS idx_todos_plan_task ON todos(user_id, plan_task_id, planned_for)');
}

function lastId() {
  const result = db.rawDb().exec('SELECT last_insert_rowid() AS id');
  return result.length && result[0].values.length ? result[0].values[0][0] : null;
}

function mapGoal(row) {
  if (!row) return null;
  return {
    ...row,
    weight: Math.max(1, Number(row.weight) || 1),
    progress: clampProgress(row.progress),
    rollover_count: Number(row.rollover_count) || 0,
  };
}

function mapTask(row) {
  if (!row) return null;
  return {
    ...row,
    progress: clampProgress(row.progress),
    estimate_minutes: Math.max(0, Number(row.estimate_minutes) || 0),
    sort_order: Number(row.sort_order) || 0,
    rollover_count: Number(row.rollover_count) || 0,
  };
}

function listGoals(userId, month) {
  ensureTables();
  return db.query(
    'SELECT * FROM plan_goals WHERE user_id = ? AND month = ? ORDER BY status = "active" DESC, id ASC',
    [Number(userId), month || monthKey()]
  ).map(mapGoal);
}

function getGoal(userId, id) {
  ensureTables();
  const rows = db.query('SELECT * FROM plan_goals WHERE id = ? AND user_id = ?', [Number(id), Number(userId)]);
  return rows.length ? mapGoal(rows[0]) : null;
}

function createGoal(userId, data = {}) {
  ensureTables();
  const title = String(data.title || '').trim().slice(0, 160);
  if (!title) throw new Error('月目标标题不能为空');
  const month = parseMonth(data.month)?.key || monthKey();
  const now = db.nowIso();
  const dueDate = dateOnly(data.dueDate || data.due_date) || dateKey(endOfMonth(month));
  db.rawDb().run(
    `INSERT INTO plan_goals
      (user_id, title, description, month, status, weight, progress, due_date, original_due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(userId),
      title,
      String(data.description || '').slice(0, 4000),
      month,
      data.status === 'completed' ? 'completed' : 'active',
      Math.min(Math.max(parseInt(data.weight, 10) || 1, 1), 10),
      clampProgress(data.progress),
      dueDate,
      dueDate,
      now,
      now,
    ]
  );
  db.persist();
  return getGoal(userId, lastId());
}

function updateGoal(userId, id, patch = {}) {
  const current = getGoal(userId, id);
  if (!current) return null;
  const next = { ...current, ...patch };
  if (!String(next.title || '').trim()) throw new Error('月目标标题不能为空');
  const month = parseMonth(next.month)?.key || current.month;
  const status = ['active', 'completed', 'archived'].includes(next.status) ? next.status : current.status;
  db.rawDb().run(
    `UPDATE plan_goals SET title=?, description=?, month=?, status=?, weight=?, progress=?, due_date=?,
      completed_at=?, updated_at=? WHERE id=? AND user_id=?`,
    [
      String(next.title).trim().slice(0, 160),
      String(next.description || '').slice(0, 4000),
      month,
      status,
      Math.min(Math.max(parseInt(next.weight, 10) || 1, 1), 10),
      clampProgress(next.progress),
      dateOnly(next.due_date || next.dueDate) || current.due_date,
      status === 'completed' ? (current.completed_at || db.nowIso()) : null,
      db.nowIso(),
      Number(id),
      Number(userId),
    ]
  );
  db.persist();
  return getGoal(userId, id);
}

function removeGoal(userId, id) {
  const current = getGoal(userId, id);
  if (!current) return false;
  db.rawDb().run('UPDATE plan_tasks SET goal_id = NULL, updated_at = ? WHERE goal_id = ? AND user_id = ?', [db.nowIso(), Number(id), Number(userId)]);
  db.rawDb().run('UPDATE todos SET plan_goal_id = NULL, updated_at = ? WHERE plan_goal_id = ? AND user_id = ?', [db.nowIso(), Number(id), Number(userId)]);
  db.rawDb().run('DELETE FROM plan_goals WHERE id = ? AND user_id = ?', [Number(id), Number(userId)]);
  db.persist();
  return true;
}

function listTasks(userId, options = {}) {
  ensureTables();
  let rows = db.query(
    'SELECT * FROM plan_tasks WHERE user_id = ? ORDER BY week_start ASC, sort_order ASC, id ASC',
    [Number(userId)]
  ).map(mapTask);
  if (options.goalId) rows = rows.filter((task) => task.goal_id === Number(options.goalId));
  if (options.weekStart) rows = rows.filter((task) => task.week_start === options.weekStart);
  if (options.month) {
    const weeks = weeksOfMonth(options.month);
    const allowed = new Set(weeks.map((week) => week.start));
    rows = rows.filter((task) => allowed.has(task.week_start));
  }
  return rows;
}

function getTask(userId, id) {
  ensureTables();
  const rows = db.query('SELECT * FROM plan_tasks WHERE id = ? AND user_id = ?', [Number(id), Number(userId)]);
  return rows.length ? mapTask(rows[0]) : null;
}

function createTask(userId, data = {}) {
  ensureTables();
  const title = String(data.title || '').trim().slice(0, 200);
  if (!title) throw new Error('周任务标题不能为空');
  const goal = data.goalId || data.goal_id ? getGoal(userId, data.goalId || data.goal_id) : null;
  if ((data.goalId || data.goal_id) && !goal) throw new Error('月目标不存在');
  const weekStart = dateOnly(data.weekStart || data.week_start) || dateKey(startOfWeek());
  const dueDate = dateOnly(data.dueDate || data.due_date) || dateKey(endOfWeek(weekStart));
  const now = db.nowIso();
  db.rawDb().run(
    `INSERT INTO plan_tasks
      (user_id, goal_id, title, description, week_start, due_date, status, progress, estimate_minutes, sort_order,
       original_due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(userId),
      goal ? goal.id : null,
      title,
      String(data.description || '').slice(0, 4000),
      weekStart,
      dueDate,
      data.status === 'done' ? 'done' : 'open',
      clampProgress(data.progress),
      Math.max(0, parseInt(data.estimateMinutes || data.estimate_minutes, 10) || 0),
      parseInt(data.sortOrder || data.sort_order, 10) || 0,
      dueDate,
      now,
      now,
    ]
  );
  db.persist();
  return getTask(userId, lastId());
}

function updateTask(userId, id, patch = {}) {
  const current = getTask(userId, id);
  if (!current) return null;
  const next = { ...current, ...patch };
  if (!String(next.title || '').trim()) throw new Error('周任务标题不能为空');
  const goalId = next.goal_id || next.goalId;
  const goal = goalId ? getGoal(userId, goalId) : null;
  if (goalId && !goal) throw new Error('月目标不存在');
  const status = ['open', 'done', 'cancelled'].includes(next.status) ? next.status : current.status;
  db.rawDb().run(
    `UPDATE plan_tasks SET goal_id=?, title=?, description=?, week_start=?, due_date=?, status=?, progress=?,
      estimate_minutes=?, sort_order=?, completed_at=?, updated_at=? WHERE id=? AND user_id=?`,
    [
      goal ? goal.id : null,
      String(next.title).trim().slice(0, 200),
      String(next.description || '').slice(0, 4000),
      dateOnly(next.week_start || next.weekStart) || current.week_start,
      dateOnly(next.due_date || next.dueDate) || current.due_date,
      status,
      clampProgress(next.progress),
      Math.max(0, parseInt(next.estimate_minutes || next.estimateMinutes, 10) || 0),
      parseInt(next.sort_order || next.sortOrder, 10) || 0,
      status === 'done' ? (current.completed_at || db.nowIso()) : null,
      db.nowIso(),
      Number(id),
      Number(userId),
    ]
  );
  db.persist();
  return getTask(userId, id);
}

function removeTask(userId, id) {
  const current = getTask(userId, id);
  if (!current) return false;
  db.rawDb().run('UPDATE todos SET plan_task_id = NULL, updated_at = ? WHERE plan_task_id = ? AND user_id = ?', [db.nowIso(), Number(id), Number(userId)]);
  db.rawDb().run('DELETE FROM plan_tasks WHERE id = ? AND user_id = ?', [Number(id), Number(userId)]);
  db.persist();
  return true;
}

function createDailyTodo(userId, data = {}) {
  ensureTables();
  const title = String(data.title || '').trim().slice(0, 200);
  if (!title) throw new Error('每日待办标题不能为空');
  const task = data.taskId || data.plan_task_id ? getTask(userId, data.taskId || data.plan_task_id) : null;
  if ((data.taskId || data.plan_task_id) && !task) throw new Error('周任务不存在');
  const goalId = task?.goal_id || (data.goalId || data.goal_id ? Number(data.goalId || data.goal_id) : null);
  const plannedFor = dateOnly(data.plannedFor || data.planned_for) || dateKey();
  const dueAt = data.dueAt || data.due_at || isoAtLocal(plannedFor, 18, 0);
  const row = db.insert('todos', {
    user_id: Number(userId),
    title,
    notes: String(data.notes || '').slice(0, 4000),
    priority: parseInt(data.priority, 10) || 2,
    category: data.category || (task ? '计划' : ''),
    due_at: dueAt,
    status: 'open',
    plan_goal_id: goalId || null,
    plan_task_id: task ? task.id : null,
    planned_for: plannedFor,
    original_due_at: dueAt,
    rollover_enabled: data.rolloverEnabled === false || data.rollover_enabled === 0 ? 0 : 1,
    rollover_count: 0,
  });
  return row;
}

function taskProgress(task, todos) {
  const linked = todos.filter((todo) => Number(todo.plan_task_id) === Number(task.id));
  if (linked.length) {
    const done = linked.filter((todo) => todo.status === 'done').length;
    return {
      progress: Math.round((done / linked.length) * 100),
      done: done,
      total: linked.length,
      effectiveStatus: done === linked.length && linked.length > 0 ? 'done' : 'open',
    };
  }
  return {
    progress: task.status === 'done' ? 100 : clampProgress(task.progress),
    done: task.status === 'done' ? 1 : 0,
    total: 1,
    effectiveStatus: task.status,
  };
}

function goalProgress(goal, tasks, todos) {
  if (goal.status === 'completed') return { progress: 100, taskCount: tasks.length, doneTasks: tasks.length };
  const linked = tasks.filter((task) => Number(task.goal_id) === Number(goal.id));
  if (!linked.length) return { progress: clampProgress(goal.progress), taskCount: 0, doneTasks: 0 };
  const values = linked.map((task) => taskProgress(task, todos).progress);
  return {
    progress: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    taskCount: linked.length,
    doneTasks: values.filter((value) => value === 100).length,
  };
}

function currentUserMonth(userId, month) {
  const key = parseMonth(month)?.key || monthKey();
  const goals = listGoals(userId, key);
  const weeks = weeksOfMonth(key);
  const allowedWeeks = new Set(weeks.map((week) => week.start));
  const goalIds = new Set(goals.map((goal) => goal.id));
  const tasks = listTasks(userId).filter((task) => allowedWeeks.has(task.week_start) || goalIds.has(task.goal_id));
  const allTodos = db.list('todos', null, userId);
  const linkedTodos = allTodos.filter((todo) => {
    if (todo.plan_task_id && tasks.some((task) => task.id === Number(todo.plan_task_id))) return true;
    const planned = dateOnly(todo.planned_for) || dateOnly(todo.due_at);
    return planned && planned.startsWith(key);
  });
  return { key, goals, tasks, todos: linkedTodos, allTodos };
}

function rolloverOverdue(userId) {
  ensureTables();
  const now = new Date();
  const today = dateKey(now);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  let todos = 0;
  let tasks = 0;
  let goals = 0;

  const overdueTodos = db.list('todos', (todo) => {
    if (todo.status !== 'open' || !todo.due_at || todo.rollover_enabled === 0) return false;
    const due = new Date(todo.due_at);
    return !Number.isNaN(due.getTime()) && due < todayStart;
  }, userId);
  for (const todo of overdueTodos) {
    const original = new Date(todo.due_at);
    const rolled = new Date(now);
    rolled.setHours(original.getHours(), original.getMinutes(), 0, 0);
    db.rawDb().run(
      `UPDATE todos SET due_at=?, planned_for=?, original_due_at=COALESCE(original_due_at, due_at),
        rollover_count=COALESCE(rollover_count, 0)+1, last_rolled_at=?, updated_at=? WHERE id=? AND user_id=?`,
      [rolled.toISOString(), today, db.nowIso(), db.nowIso(), todo.id, Number(userId)]
    );
    todos++;
  }

  const weekStart = startOfWeek(now);
  const overdueTasks = db.list('plan_tasks', (task) => {
    if (task.status !== 'open' || !task.due_date) return false;
    return task.due_date < today;
  }, userId);
  for (const task of overdueTasks) {
    const due = endOfWeek(now);
    db.rawDb().run(
      `UPDATE plan_tasks SET week_start=?, due_date=?, original_due_date=COALESCE(original_due_date, due_date),
        rollover_count=COALESCE(rollover_count, 0)+1, last_rolled_at=?, updated_at=? WHERE id=? AND user_id=?`,
      [dateKey(weekStart), dateKey(due), db.nowIso(), db.nowIso(), task.id, Number(userId)]
    );
    tasks++;
  }

  const overdueGoals = db.list('plan_goals', (goal) => {
    if (goal.status !== 'active' || !goal.due_date) return false;
    return goal.due_date < today;
  }, userId);
  const currentMonth = monthKey(now);
  for (const goal of overdueGoals) {
    db.rawDb().run(
      `UPDATE plan_goals SET month=?, due_date=?, original_due_date=COALESCE(original_due_date, due_date),
        rollover_count=COALESCE(rollover_count, 0)+1, last_rolled_at=?, updated_at=? WHERE id=? AND user_id=?`,
      [currentMonth, dateKey(endOfMonth(currentMonth)), db.nowIso(), db.nowIso(), goal.id, Number(userId)]
    );
    goals++;
  }

  if (todos || tasks || goals) db.persist();
  return { todos, tasks, goals, total: todos + tasks + goals };
}

function rolloverAll() {
  const users = db.query('SELECT DISTINCT id AS user_id FROM users WHERE id IS NOT NULL');
  const totals = { users: users.length, todos: 0, tasks: 0, goals: 0, total: 0 };
  for (const row of users) {
    try {
      const result = rolloverOverdue(row.user_id);
      totals.todos += result.todos;
      totals.tasks += result.tasks;
      totals.goals += result.goals;
      totals.total += result.total;
    } catch (error) {
      logger.warn(`plan rollover failed for user ${row.user_id}: ${error.message}`);
    }
  }
  return totals;
}

function dashboard(userId, month) {
  ensureTables();
  const rollover = rolloverOverdue(userId);
  const context = currentUserMonth(userId, month);
  const taskViews = context.tasks.map((task) => {
    const progress = taskProgress(task, context.todos);
    const goal = context.goals.find((item) => item.id === Number(task.goal_id)) || null;
    const overdue = task.status === 'open' && task.due_date && task.due_date < dateKey();
    return {
      ...task,
      goal_title: goal ? goal.title : '',
      ...progress,
      overdue,
      rolled: Number(task.rollover_count) > 0,
    };
  });
  const goalViews = context.goals.map((goal) => {
    const progress = goalProgress(goal, context.tasks, context.todos);
    return {
      ...goal,
      ...progress,
      overdue: goal.status === 'active' && goal.due_date && goal.due_date < dateKey(),
      rolled: Number(goal.rollover_count) > 0,
    };
  });
  const weekViews = weeksOfMonth(context.key).map((week) => {
    const tasksInWeek = taskViews.filter((task) => task.week_start === week.start);
    const todosInWeek = context.todos.filter((todo) => {
      const planned = dateOnly(todo.planned_for) || dateOnly(todo.due_at);
      return planned && planned >= week.start && planned <= week.end;
    });
    return {
      ...week,
      tasks: tasksInWeek,
      taskCount: tasksInWeek.length,
      doneTasks: tasksInWeek.filter((task) => task.progress === 100).length,
      todoCount: todosInWeek.length,
      doneTodos: todosInWeek.filter((todo) => todo.status === 'done').length,
      progress: tasksInWeek.length
        ? Math.round(tasksInWeek.reduce((sum, task) => sum + task.progress, 0) / tasksInWeek.length)
        : 0,
    };
  });
  const today = dateKey();
  const todayTodos = context.todos
    .filter((todo) => (dateOnly(todo.planned_for) || dateOnly(todo.due_at)) === today || todo.status === 'open')
    .sort((a, b) => (a.status === 'done' ? 1 : b.status === 'done' ? -1 : 0) || (a.priority || 2) - (b.priority || 2));
  const doneToday = todayTodos.filter((todo) => todo.status === 'done').length;
  const overdueTodos = context.todos.filter((todo) => todo.status === 'open' && todo.due_at && new Date(todo.due_at) < new Date(`${today}T00:00:00`));
  const totalWeight = goalViews.reduce((sum, goal) => sum + goal.weight, 0);
  const monthProgress = totalWeight
    ? Math.round(goalViews.reduce((sum, goal) => sum + goal.progress * goal.weight, 0) / totalWeight)
    : 0;
  const taskAverage = taskViews.length
    ? Math.round(taskViews.reduce((sum, task) => sum + task.progress, 0) / taskViews.length)
    : 0;
  return {
    month: context.key,
    weeks: weekViews,
    goals: goalViews,
    tasks: taskViews,
    todayTodos,
    rollover,
    metrics: {
      monthProgress,
      taskProgress: taskAverage,
      todayProgress: todayTodos.length ? Math.round((doneToday / todayTodos.length) * 100) : 0,
      goalCount: goalViews.length,
      completedGoals: goalViews.filter((goal) => goal.progress === 100).length,
      taskCount: taskViews.length,
      completedTasks: taskViews.filter((task) => task.progress === 100).length,
      todayCount: todayTodos.length,
      doneToday,
      overdueCount: overdueTodos.length,
      rolledCount: context.todos.filter((todo) => Number(todo.rollover_count) > 0).length
        + taskViews.filter((task) => task.rolled).length
        + goalViews.filter((goal) => goal.rolled).length,
    },
  };
}

module.exports = {
  ensureTables,
  dateKey,
  monthKey,
  startOfWeek,
  endOfWeek,
  weeksOfMonth,
  listGoals,
  getGoal,
  createGoal,
  updateGoal,
  removeGoal,
  listTasks,
  getTask,
  createTask,
  updateTask,
  removeTask,
  createDailyTodo,
  rolloverOverdue,
  rolloverAll,
  dashboard,
  _test: {
    weeksOfMonth,
    taskProgress,
    goalProgress,
  },
};
