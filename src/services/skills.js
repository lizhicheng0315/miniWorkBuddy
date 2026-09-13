'use strict';

/**
 * 技能区封装（仿 Codex skills）：
 *   - 项目根目录 skills/<skill-name>/SKILL.md 即一个技能
 *   - SKILL.md 允许 YAML 风格 frontmatter：name / description / when_to_use / version
 *   - 技能内容在 agent 调用 use_skill 时注入 LLM 上下文，形成可复用的方法论
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');
const logger = require('../logger');
const llm = require('./llm');

// 运行期技能放在数据目录（pkg 打包后也可写）；内置模板从项目 skills/ 首次启动自动复制
const SOURCE_ROOT = path.join(config.root, 'skills');
const ROOT = path.join(config.dataDir, 'skills');
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function copyRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
  try {
    if (fs.existsSync(SOURCE_ROOT) && fs.readdirSync(ROOT).length === 0) {
      copyRecursive(SOURCE_ROOT, ROOT);
    }
  } catch (e) {
    logger.warn('skill seed copy failed:', e.message);
  }
}

function safeName(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

function dirFor(name) {
  const n = safeName(name);
  if (!SKILL_NAME_RE.test(n)) throw new Error('技能名只能包含字母/数字/下划线/连字符');
  return path.join(ROOT, n);
}

function parseFrontmatter(text) {
  const src = String(text || '');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const meta = { name: '', description: '', when_to_use: '', version: '1.0' };
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      value = value.replace(/^["']|["']$/g, '');
      if (key && value) meta[key] = value;
    }
  }
  const body = m ? src.slice(m[0].length) : src;
  return { meta, body };
}

function collectAssets(dir) {
  const assetsDir = path.join(dir, 'assets');
  if (!fs.existsSync(assetsDir)) return [];
  const out = [];
  const walk = (p, rel) => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const abs = path.join(p, entry.name);
      if (entry.isDirectory()) walk(abs, path.join(rel, entry.name));
      else out.push(rel ? path.join(rel, entry.name) : entry.name);
    }
  };
  walk(assetsDir, '');
  return out.slice(0, 100);
}

function list() {
  ensureRoot();
  const out = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(ROOT, entry.name);
    const mdPath = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(mdPath)) continue;
    try {
      const text = fs.readFileSync(mdPath, 'utf8');
      const { meta, body } = parseFrontmatter(text);
      const assets = collectAssets(dir);
      const stat = fs.statSync(mdPath);
      out.push({
        name: meta.name || entry.name,
        folder: entry.name,
        description: meta.description || body.trim().slice(0, 140),
        when_to_use: meta.when_to_use || '',
        version: meta.version || '1.0',
        assets: assets.length ? assets : null,
        char_count: text.length,
        updated_at: stat.mtime.toISOString(),
      });
    } catch (e) {
      logger.warn('skill scan failed:', entry.name, e.message);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function read(name) {
  ensureRoot();
  const dir = dirFor(name);
  const mdPath = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(mdPath)) return null;
  const text = fs.readFileSync(mdPath, 'utf8');
  const { meta, body } = parseFrontmatter(text);
  return {
    name: meta.name || safeName(name),
    folder: path.basename(dir),
    description: meta.description || '',
    when_to_use: meta.when_to_use || '',
    version: meta.version || '1.0',
    assets: collectAssets(dir),
    content: text,
    body,
  };
}

function save(name, data = {}) {
  ensureRoot();
  const n = safeName(name);
  const dir = dirFor(n);
  fs.mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, 'SKILL.md');
  const existing = read(n);
  const description = String(data.description || existing?.description || '').trim();
  const whenToUse = String(data.when_to_use || existing?.when_to_use || '').trim();
  let body = String(data.content || existing?.body || '');
  // 编辑器如果直接粘贴了完整 SKILL.md（含 frontmatter），自动拆出正文
  if (body.trim().startsWith('---')) {
    const parsed = parseFrontmatter(body);
    if (parsed.body.trim()) body = parsed.body;
  }
  const front = [
    '---',
    'name: ' + n,
    'description: ' + description,
    'when_to_use: ' + whenToUse,
    'version: ' + String(data.version || existing?.version || '1.0'),
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(mdPath, front + (body.startsWith('\n') ? body : '\n' + body), 'utf8');
  logger.info(`skill saved: ${n}`);
  return read(n);
}

function remove(name) {
  const dir = dirFor(name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  logger.info(`skill removed: ${safeName(name)}`);
  return true;
}

function listForAgent(maxChars = 8000) {
  const out = [];
  let budget = maxChars;
  for (const s of list().slice(0, 30)) {
    let desc = (s.description || '').slice(0, 80);
    let entry = `${s.name}（${desc}）`;
    if (entry.length > budget) {
      if (budget < 40) break;
      desc = desc.slice(0, Math.max(0, budget - s.name.length - 4));
      entry = `${s.name}（${desc}…）`;
    }
    out.push(entry);
    budget -= entry.length + 1;
    if (budget <= 0) break;
  }
  return out;
}

function deriveSkillName(url) {
  try {
    const u = new URL(String(url));
    const parts = u.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    return safeName(parts[parts.length - 1] || 'skill');
  } catch (_) {
    return safeName(String(url || 'skill'));
  }
}

function installFromGitHub(userId, url, name) {
  const repo = String(url || '').trim();
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/i.test(repo)) {
    throw new Error('只支持 https://github.com/... 仓库地址');
  }
  const n = safeName(name || deriveSkillName(repo));
  const dir = dirFor(n);
  if (fs.existsSync(dir)) throw new Error('技能目录已存在：' + n);
  ensureRoot();
  return new Promise((resolve, reject) => {
    execFile('git', ['clone', '--depth', '1', repo, dir], { timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        return reject(new Error((err.message + ' ' + (stderr || '')).slice(0, 400)));
      }
      try {
        const skill = read(n);
        if (!skill) throw new Error('仓库里没有找到 SKILL.md');
        logger.info('skill installed:', n);
        resolve(skill);
      } catch (e) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        reject(e);
      }
    });
  });
}

function assetsContext(skill) {
  if (!skill.assets || !skill.assets.length) return '';
  return '\n可引用的技能资源：' + skill.assets.map((a) => `assets/${a}`).join(', ') + '（这些文件可被技能内的方法论或脚本引用）';
}

/**
 * 执行一个技能：技能内容作为 system 指令注入 LLM
 */
async function runSkill(userId, name, task, opts = {}) {
  const skill = read(name);
  if (!skill) return { ok: false, error: `技能「${name}」不存在` };
  if (!String(task || '').trim()) return { ok: false, error: '请说明要技能完成什么任务' };
  if (!llm.resolveConfig().apiKey) return { ok: false, error: '执行技能需要先配置 LLM' };

  const system = `你是 WorkBuddy 的技能执行器。请严格按下面的技能说明完成任务，并遵循技能里的步骤/约束/输出格式。

【技能 ${skill.name}】
${skill.description ? '描述：' + skill.description + '\n' : ''}
${skill.when_to_use ? '适用场景：' + skill.when_to_use + '\n' : ''}

【技能正文】
${skill.body.trim()}${assetsContext(skill)}

要求：中文回答、给出可执行的结论；如果技能要求分阶段，先完成当前阶段并明确下一步。`;

  const maxTokens = parseInt(opts.max_tokens, 10) || 1200;
  const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: String(task) },
  ];
  const llmOpts = { temperature: 0.4, max_tokens: maxTokens, userId, intent: 'skill:' + skill.name };
  const r = onDelta
    ? await llm.chatStream(messages, llmOpts, onDelta)
    : await llm.chat(messages, llmOpts);
  return {
    ok: r.ok,
    text: r.ok ? r.text : '⚠️ ' + r.error,
    error: r.ok ? null : r.error,
    skill: skill.name,
  };
}

module.exports = {
  ROOT,
  list,
  read,
  save,
  remove,
  listForAgent,
  runSkill,
  safeName,
  deriveSkillName,
  installFromGitHub,
};
