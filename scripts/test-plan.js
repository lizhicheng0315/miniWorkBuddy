'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-plan-'));
  const db = require('../src/db');
  await db.init();
  const plan = require('../src/services/plan');
  plan.ensureTables();

  const month = plan.monthKey();
  const goal = plan.createGoal(1, {
    title: '完成个人工作台第一版',
    month,
    weight: 2,
  });
  const task = plan.createTask(1, {
    title: '完成计划工作台页面',
    goalId: goal.id,
    weekStart: plan.dateKey(plan.startOfWeek()),
  });
  const todo = plan.createDailyTodo(1, {
    title: '实现月目标列表',
    taskId: task.id,
    plannedFor: plan.dateKey(),
  });

  let dashboard = plan.dashboard(1, month);
  assert.strictEqual(dashboard.metrics.goalCount, 1);
  assert.strictEqual(dashboard.metrics.taskCount, 1);
  assert.ok(dashboard.metrics.todayCount >= 1);
  assert.strictEqual(dashboard.goals[0].taskCount, 1);

  db.update('todos', todo.id, { status: 'done', completed_at: db.nowIso() }, 1);
  dashboard = plan.dashboard(1, month);
  assert.strictEqual(dashboard.goals[0].progress, 100);
  assert.strictEqual(dashboard.metrics.completedGoals, 1);

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const overdue = plan.createDailyTodo(1, {
    title: '逾期自动顺延测试',
    taskId: task.id,
    plannedFor: plan.dateKey(yesterday),
    dueAt: new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 9, 0).toISOString(),
  });
  const overdueTask = plan.createTask(1, {
    title: '周任务逾期顺延测试',
    goalId: goal.id,
    weekStart: plan.dateKey(plan.startOfWeek(yesterday)),
    dueDate: plan.dateKey(yesterday),
  });
  const rollover = plan.rolloverOverdue(1);
  assert.ok(rollover.todos >= 1);
  assert.ok(rollover.tasks >= 1);
  const rolled = db.find('todos', overdue.id, 1);
  assert.strictEqual(rolled.planned_for, plan.dateKey());
  assert.ok(rolled.rollover_count >= 1);
  assert.ok(rolled.original_due_at);
  const rolledTask = plan.getTask(1, overdueTask.id);
  assert.strictEqual(rolledTask.week_start, plan.dateKey(plan.startOfWeek()));
  assert.strictEqual(rolledTask.due_date, plan.dateKey(plan.endOfWeek()));
  assert.ok(rolledTask.rollover_count >= 1);
  assert.ok(plan.rolloverAll().users >= 0);

  assert.strictEqual(plan.removeTask(1, overdueTask.id), true);
  assert.strictEqual(plan.removeTask(1, task.id), true);
  assert.strictEqual(plan.removeGoal(1, goal.id), true);

  const llm = require('../src/services/llm');
  const originalChat = llm.chat;
  llm.chat = async () => ({
    ok: true,
    text: JSON.stringify({
      goal: { title: '测试对话拆解目标', description: '验收三层联动' },
      tasks: [{
        title: '第一周完成数据模型',
        weekStart: plan.dateKey(plan.startOfWeek()),
        dueDate: plan.dateKey(plan.endOfWeek()),
        todos: [{ title: '创建数据表', plannedFor: plan.dateKey(), priority: 1 }],
      }],
    }),
  });
  try {
    const nlp = require('../src/services/nlp');
    const result = await nlp.executeIntent(
      { intent: 'plan_breakdown', goal: '测试对话拆解' },
      1,
      '把测试对话拆解目标拆成周任务和每日待办'
    );
    assert.strictEqual(result.data.taskCount, 1);
    assert.strictEqual(result.data.todoCount, 1);
    assert.ok(plan.listGoals(1, month).some((item) => item.title === '测试对话拆解目标'));
  } finally {
    llm.chat = originalChat;
  }

  console.log('✅ 计划层级、完成率、逾期顺延与对话拆解测试通过');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
