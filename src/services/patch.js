'use strict';

/**
 * Codex 风格 apply_patch：
 *   *** Begin Patch
 *   *** Update File: path
 *   @@
 *   -old
 *   +new
 *   *** End Patch
 * 支持 Add File / Update File / Delete File / Move to。
 */

const fs = require('fs');
const path = require('path');
const sandbox = require('./sandbox');

function fail(message) {
  return { ok: false, error: message, files: [] };
}

function collect(lines, start, predicate) {
  const out = [];
  let i = start;
  while (i < lines.length && !predicate(lines[i])) {
    out.push(lines[i]);
    i++;
  }
  return { lines: out, next: i };
}

function isDirective(line) {
  return /^\*\*\* (Add|Update|Delete|Move|End) File/.test(line) || /^\*\*\* End Patch/.test(line);
}

function applyHunks(content, hunks) {
  let lines = content.split('\n');
  let cursor = 0;
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    const oldLines = hunk.filter((l) => l.startsWith(' ') || l.startsWith('-')).map((l) => l.slice(1));
    const newLines = hunk.filter((l) => l.startsWith(' ') || l.startsWith('+')).map((l) => l.slice(1));
    if (!oldLines.length) {
      lines = lines.slice(0, cursor).concat(newLines, lines.slice(cursor));
      cursor += newLines.length;
      additions += newLines.length;
      continue;
    }
    let found = -1;
    for (let i = cursor; i <= lines.length - oldLines.length; i++) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (lines[i + j] !== oldLines[j]) { ok = false; break; }
      }
      if (ok) { found = i; break; }
    }
    if (found < 0) {
      throw new Error('patch hunk 上下文未匹配');
    }
    deletions += oldLines.length;
    additions += newLines.length;
    lines = lines.slice(0, found).concat(newLines, lines.slice(found + oldLines.length));
    cursor = found + newLines.length;
  }
  return { content: lines.join('\n'), additions, deletions };
}

function parse(patchText) {
  const lines = String(patchText || '').replace(/\r\n/g, '\n').split('\n');
  if (!lines.length || !/^\*\*\* Begin Patch/.test(lines[0].trim())) {
    throw new Error('patch 必须以 *** Begin Patch 开头');
  }
  const ops = [];
  let i = 1;
  let ended = false;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\*\*\* End Patch/.test(line)) { ended = true; break; }
    let m;
    if ((m = line.match(/^\*\*\* Add File: (.+)$/))) {
      const p = m[1].trim();
      i++;
      const body = [];
      while (i < lines.length && !isDirective(lines[i])) {
        if (lines[i].startsWith('+')) body.push(lines[i].slice(1));
        i++;
      }
      ops.push({ type: 'add', path: p, content: body.join('\n') });
      continue;
    }
    if ((m = line.match(/^\*\*\* Delete File: (.+)$/))) {
      ops.push({ type: 'delete', path: m[1].trim() });
      i++;
      continue;
    }
    if ((m = line.match(/^\*\*\* Update File: (.+)$/))) {
      const p = m[1].trim();
      i++;
      let moveTo = null;
      if (i < lines.length && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      const hunks = [];
      let current = null;
      while (i < lines.length && !isDirective(lines[i])) {
        const l = lines[i];
        if (l.startsWith('@@')) {
          if (current) hunks.push(current);
          current = [];
          i++;
          continue;
        }
        if (!current) current = [];
        if (l.startsWith(' ') || l.startsWith('+') || l.startsWith('-')) current.push(l);
        else if (l === '') current.push(' ');
        i++;
      }
      if (current) hunks.push(current);
      ops.push({ type: 'update', path: p, moveTo, hunks });
      continue;
    }
    i++;
  }
  if (!ended) throw new Error('patch 缺少 *** End Patch');
  if (!ops.length) throw new Error('patch 没有任何文件操作');
  return ops;
}

function applyPatch(userId, patchText, opts = {}) {
  const files = [];
  try {
    const ops = parse(patchText);
    for (const op of ops) {
      const target = sandbox.safeResolve(op.path, { fullAccess: !!opts.fullAccess });
      if (op.type === 'add') {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, op.content, 'utf8');
        files.push({ path: op.path, action: 'add', additions: op.content.split('\n').length, deletions: 0 });
        continue;
      }
      if (!fs.existsSync(target)) throw new Error(`文件不存在：${op.path}`);
      if (op.type === 'delete') {
        const old = fs.readFileSync(target, 'utf8');
        fs.unlinkSync(target);
        files.push({ path: op.path, action: 'delete', additions: 0, deletions: old.split('\n').length });
        continue;
      }
      if (op.type === 'update') {
        const old = fs.readFileSync(target, 'utf8');
        const applied = applyHunks(old, op.hunks || []);
        const dest = op.moveTo ? sandbox.safeResolve(op.moveTo, { fullAccess: !!opts.fullAccess }) : target;
        if (op.moveTo) fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, applied.content, 'utf8');
        if (op.moveTo && dest !== target) fs.unlinkSync(target);
        files.push({ path: op.moveTo || op.path, action: op.moveTo ? 'move' : 'update', additions: applied.additions, deletions: applied.deletions });
      }
    }
    sandbox.audit(userId, 'patch:applied', patchText.slice(0, 800), { files: files.map((f) => f.path), fullAccess: !!opts.fullAccess });
    return { ok: true, files };
  } catch (e) {
    sandbox.audit(userId, 'patch:failed', patchText.slice(0, 800), { error: e.message });
    return fail(e.message);
  }
}

module.exports = { applyPatch, parse };
