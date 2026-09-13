'use strict';

/**
 * AGENTS.md 项目规则：
 *   - 支持嵌套发现（工作区内多层 AGENTS.md，跳过 node_modules/.git/data 等）
 *   - context() 把所有规则合并注入 Agent system prompt
 *   - save() 只允许创建/修改名为 AGENTS.md 的文件
 */

const fs = require('fs');
const path = require('path');
const sandbox = require('./sandbox');
const config = require('../config');

const DEFAULT_FILE = 'AGENTS.md';
const SKIP = new Set(['node_modules', '.git', 'dist', 'data', '.npm-cache', '.codex', '.agents']);
const WORKSPACE = path.resolve(config.root);

function validate(relPath) {
  const rel = String(relPath || DEFAULT_FILE).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!/AGENTS\.md$/i.test(rel)) throw new Error('规则文件必须命名为 AGENTS.md');
  const full = sandbox.safeResolve(rel, { fullAccess: false });
  return { rel, full };
}

function walkRules() {
  const out = [];
  function walk(dir, rel, depth) {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel, depth + 1);
      else if (e.name.toLowerCase() === 'agents.md') out.push(childRel);
    }
  }
  walk(WORKSPACE, '', 0);
  return out;
}

function get(userId, relPath) {
  const { rel, full } = validate(relPath);
  if (!fs.existsSync(full)) return { path: rel, exists: false, content: '', updated_at: null };
  const content = fs.readFileSync(full, 'utf8').slice(0, 50_000);
  return { path: rel, exists: true, content, updated_at: fs.statSync(full).mtime.toISOString() };
}

function list(userId) {
  const paths = walkRules();
  if (!paths.includes(DEFAULT_FILE)) paths.unshift(DEFAULT_FILE);
  return paths.map((p) => get(userId, p));
}

function save(userId, content, relPath) {
  const { rel } = validate(relPath);
  sandbox.writeFile(userId, rel, String(content || ''), { fullAccess: false });
  return get(userId, rel);
}

function context(userId) {
  try {
    const parts = [];
    for (const p of walkRules()) {
      const r = get(userId, p);
      if (r.exists && r.content.trim()) parts.push(`--- ${p} ---\n${r.content.slice(0, 8000)}`);
    }
    return parts.length ? `\n[项目规则 AGENTS.md]\n${parts.join('\n\n')}` : '';
  } catch (_) {
    return '';
  }
}

module.exports = { get, list, save, context, DEFAULT_FILE };
