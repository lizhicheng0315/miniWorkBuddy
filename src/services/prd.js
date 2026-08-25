'use strict';

/**
 * 智能需求分析服务（CodeBuddy PRD 能力借鉴）
 * - prd_generate:  话题 → LLM 结构化 PRD → 预览文本
 * - prd_review:     PRD 全文 → LLM 审查 → 优化建议
 * - prd_export:     PRD → Markdown 文件 → 下载
 *
 * PRD 结构（LLM 产出的 JSON schema）：
 *   { title, version, author, overview, targetUsers, goals, userStories:[], features:[{name, priority, description, acceptance}], constraints:[], timeline, metrics }
 *
 * 草稿存内存 Map（userId → prd draft），导出后签发票据。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('../logger');

const drafts = new Map();
const exportsMap = new Map();
const downloadTickets = new Map();

function getDraft(userId) { return drafts.get(userId) || null; }

/** LLM 生成 PRD（调用方提供 prompt，本模块负责解析+存草稿） */
function createDraft(userId, topic, parsedJson) {
  const draft = {
    topic,
    title: parsedJson.title || topic,
    version: parsedJson.version || 'v1.0',
    overview: parsedJson.overview || '',
    targetUsers: parsedJson.targetUsers || '',
    goals: parsedJson.goals || [],
    userStories: parsedJson.userStories || [],
    features: (parsedJson.features || []).map((f, i) => ({
      no: i + 1, name: f.name || '', priority: f.priority || '中',
      description: f.description || '', acceptance: f.acceptance || [],
    })),
    constraints: parsedJson.constraints || [],
    timeline: parsedJson.timeline || '',
    metrics: parsedJson.metrics || [],
    reviewNotes: null,
    createdAt: new Date().toISOString(),
  };
  drafts.set(userId, draft);
  return draft;
}

/** 更新 PRD（LLM 审查后返回的修订） */
function updateDraft(userId, patch) {
  const d = drafts.get(userId);
  if (!d) return null;
  if (patch.overview) d.overview = patch.overview;
  if (patch.goals) d.goals = patch.goals;
  if (patch.features) {
    d.features = patch.features.map((f, i) => ({
      no: f.no || i + 1, name: f.name || '', priority: f.priority || '中',
      description: f.description || '', acceptance: f.acceptance || [],
    }));
  }
  if (patch.userStories) d.userStories = patch.userStories;
  if (patch.constraints) d.constraints = patch.constraints;
  if (patch.reviewNotes) d.reviewNotes = patch.reviewNotes;
  return d;
}

/** PRD 预览文本（给用户确认） */
function previewText(draft) {
  // targetUsers 可能是对象数组或字符串，统一渲染
  const users = Array.isArray(draft.targetUsers)
    ? draft.targetUsers.map((u) => typeof u === 'object' ? `${Object.keys(u)[0]}：${Object.values(u)[0]}` : String(u)).join('\n  ')
    : draft.targetUsers || '（待补充）';
  const lines = [
    `📋 ${draft.title}（${draft.version}）`,
    '',
    '📝 概述', draft.overview || '（待补充）', '',
    '🎯 目标用户', '  ' + users, '',
    '🏆 核心目标',
    ...draft.goals.map((g) => `  • ${g}`), '',
    '📋 用户故事',
    ...draft.userStories.map((s) => `  • ${s}`), '',
    '⚡ 功能清单',
    ...draft.features.map((f) => [
      `  ${f.no}. ${f.name} [${f.priority}]`,
      `     ${f.description}`,
      ...f.acceptance.map((a) => `     ✓ ${a}`),
    ].join('\n')), '',
    '⚠️ 约束条件',
    ...draft.constraints.map((c) => `  • ${c}`), '',
    '📅 时间节点', draft.timeline || '（待补充）', '',
    '📊 成功指标',
    ...draft.metrics.map((m) => `  • ${m}`), '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '⛔ 请确认这份 PRD：',
    '  • 回复「确认」→ 导出为 Markdown 文件',
    '  • 说「第X条功能展开描述」「加一条目标」来修改',
    '  • 说「帮我审查一下」→ AI 给优化建议',
  ];
  if (draft.reviewNotes) {
    lines.push('', '🔍 审查意见', ...draft.reviewNotes.split('\n').map((l) => '  ' + l));
  }
  return lines.join('\n');
}

/** PRD → Markdown 文件 */
function toMarkdown(draft) {
  const lines = [
    `# ${draft.title}`,
    '',
    `> 版本：${draft.version}  ·  生成于：${draft.createdAt}`,
    '',
    '## 概述', draft.overview, '',
    '## 目标用户', draft.targetUsers, '',
    '## 核心目标',
    ...draft.goals.map((g) => `- ${g}`), '',
    '## 用户故事',
    ...draft.userStories.map((s) => `- ${s}`), '',
    '## 功能清单',
    ...draft.features.map((f) => [
      `### ${f.no}. ${f.name}`,
      `**优先级**：${f.priority}`, '',
      f.description, '',
      f.acceptance.length ? '**验收标准**：' + f.acceptance.map((a) => `- [ ] ${a}`).join('\n') : '',
    ].filter(Boolean).join('\n')), '',
    '## 约束条件',
    ...draft.constraints.map((c) => `- ${c}`), '',
    '## 时间节点', draft.timeline, '',
    '## 成功指标',
    ...draft.metrics.map((m) => `- ${m}`),
  ];
  if (draft.reviewNotes) lines.push('', '## 审查意见', draft.reviewNotes);
  return lines.join('\n');
}

/** PRD 预览文本精简版（供 review 审查用，防超长超时） */
function reviewPreviewText(draft) {
  return [
    `《${draft.title}》${draft.version}`,
    `概述：${draft.overview || '无'}`,
    `目标：${draft.goals.join('；')}`,
    `功能：${draft.features.map((f) => `${f.name}[${f.priority}]:${f.description}`).join('；')}`,
    `约束：${draft.constraints.join('；')}`,
    `指标：${draft.metrics.join('；')}`,
  ].join('\n');
}

/** 导出并签发票据 */
function exportMd(userId) {
  const d = getDraft(userId);
  if (!d) return { ok: false, error: '没有 PRD 草稿' };
  const outDir = path.resolve(__dirname, '../../data/prd');
  fs.mkdirSync(outDir, { recursive: true });
  const safeName = (d.title || 'prd').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const fileName = `${safeName}_${Date.now()}.md`;
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, toMarkdown(d), 'utf-8');
  const ticket = crypto.randomBytes(16).toString('hex');
  downloadTickets.set(ticket, { filePath, fileName, expires: Date.now() + 10 * 60 * 1000 });
  logger.info(`prd exported: ${fileName}`);
  return { ok: true, ticket, fileName };
}

function getExport(ticket) {
  const rec = downloadTickets.get(String(ticket));
  if (!rec) return null;
  if (rec.expires < Date.now()) { downloadTickets.delete(ticket); return null; }
  return rec;
}

module.exports = {
  getDraft, createDraft, updateDraft, previewText, reviewPreviewText,
  exportMd, getExport,
};
