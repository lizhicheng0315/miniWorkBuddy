'use strict';

/**
 * Code review（仿 Codex /review）：
 *   - collect() 收集 git status + diff stat + diff
 *   - run() 让 LLM 按 P0/P1/P2 输出 findings，不修改工作区
 */

const sandbox = require('./sandbox');
const llm = require('./llm');

async function collect(userId, base) {
  const status = await sandbox.gitStatus(userId);
  const stat = await sandbox.gitDiff(userId, { stat: true, base });
  const diff = await sandbox.gitDiff(userId, { base });
  return {
    status: status.output || '',
    stat: stat.output || '',
    diff: diff.output || '',
    hasChanges: Boolean((diff.output || '').trim() || (stat.output || '').trim()),
  };
}

async function files(userId) {
  const st = await sandbox.gitStatus(userId);
  const out = [];
  for (const line of String(st.output || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim();
    let p = line.slice(3).trim();
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    out.push({ status, path: p });
  }
  return out;
}

async function hunks(userId, file) {
  const r = await sandbox.gitFileDiff(userId, file, false);
  const lines = String(r.output || '').split('\n');
  const header = [];
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) header.push(lines[i++]);
  const list = [];
  while (i < lines.length) {
    const start = i;
    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) i++;
    list.push({ index: list.length, text: lines.slice(start, i).join('\n') });
  }
  return { header: header.join('\n'), hunks: list };
}

async function stageHunks(userId, file, indexes) {
  const parsed = await hunks(userId, file);
  const selected = parsed.hunks.filter((h) => indexes.includes(h.index));
  if (!selected.length) return { ok: false, error: '没有选择 hunk' };
  const patch = parsed.header + '\n' + selected.map((h) => h.text).join('\n') + '\n';
  return sandbox.gitApplyToIndex(userId, patch, false);
}

async function unstageHunks(userId, file, indexes) {
  const staged = await sandbox.gitFileDiff(userId, file, true);
  const lines = String(staged.output || '').split('\n');
  const header = [];
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) header.push(lines[i++]);
  const list = [];
  while (i < lines.length) {
    const start = i;
    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) i++;
    list.push({ index: list.length, text: lines.slice(start, i).join('\n') });
  }
  const selected = list.filter((h) => indexes.includes(h.index));
  if (!selected.length) return { ok: false, error: '没有选择 hunk' };
  const patch = header.join('\n') + '\n' + selected.map((h) => h.text).join('\n') + '\n';
  return sandbox.gitApplyToIndex(userId, patch, true);
}

async function discardHunks(userId, file, indexes, opts = {}) {
  const parsed = await hunks(userId, file);
  const selected = parsed.hunks.filter((h) => indexes.includes(h.index));
  if (!selected.length) return { ok: false, error: '没有选择 hunk' };
  const patch = parsed.header + '\n' + selected.map((h) => h.text).join('\n') + '\n';
  return sandbox.gitApplyToWorktree(userId, patch, true, opts);
}

async function run(userId, base) {
  const context = await collect(userId, base);
  if (!context.hasChanges) {
    return { ok: true, text: '当前工作区没有未提交的变更，无需审阅。', context };
  }
  const r = await llm.chat(
    [
      {
        role: 'system',
        content: '你是资深代码审查员（仿 Codex /review）。只输出审查结论，不修改工作区。' +
          '先按严重程度列出 findings（P0/P1/P2），每条给出文件与行号、问题、影响、修复建议；' +
          '再列出测试缺口/残余风险；如果没有问题就明确说没有发现问题。中文，简洁、可执行。',
      },
      {
        role: 'user',
        content: `git status:\n${context.status || '(clean)'}\n\ndiff stat:\n${context.stat}\n\ndiff:\n${context.diff.slice(0, 45_000)}`,
      },
    ],
    { temperature: 0.2, max_tokens: 1600, userId, intent: 'code_review' }
  );
  return {
    ok: r.ok,
    text: r.ok ? r.text : '⚠️ 审阅失败：' + r.error,
    error: r.ok ? null : r.error,
    context,
  };
}

module.exports = { collect, files, hunks, stageHunks, unstageHunks, discardHunks, run };
