'use strict';

/**
 * 沙箱执行策略（仿 Codex exec policy / sandbox）：
 *   - 读写只在工作区（workspace）内放开；工作区外只读
 *   - 任意 PowerShell 命令需要先开启 COMPUTER_ALLOW_SHELL
 *   - 危险/破坏性命令默认拒绝；所有操作写入审计日志
 *   - 生成文件默认拒绝（防覆盖/越权写文件）
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const logger = require('../logger');
const db = require('../db');

const WORKSPACE = path.resolve(config.root);
const WORKSPACE_DESC = config.root;

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bRemove-Item\b/i,
  /\bRemove-Item\s+-Recurse\b/i,
  /\bdel\s+\/f\s+\/s\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\breg\s+delete\b/i,
  /\bschtasks\s+\/delete\b/i,
  /\bsc\s+delete\b/i,
  /\bStop-Process\s+-Name\s+explorer\b/i,
  /\bClear-Content\b/i,
];

function allowShell() {
  try {
    const v = db.getSetting('COMPUTER_ALLOW_SHELL');
    if (v) return /^(1|true|yes|on)$/i.test(v);
  } catch (_) {}
  return !!config.computer.allowShell;
}

function isDangerous(command) {
  const s = String(command || '');
  return DANGEROUS_PATTERNS.some((re) => re.test(s));
}

function audit(userId, action, detail, extra = {}) {
  try {
    const dir = path.join(config.dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `sandbox-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      userId: Number(userId) || 0,
      action,
      detail: String(detail || '').slice(0, 1000),
      ...extra,
    });
    fs.appendFileSync(file, line + '\n');
  } catch (e) {
    logger.warn('sandbox audit failed:', e.message);
  }
}

function safeResolve(relPath, opts = {}) {
  const requested = String(relPath || '').trim();
  if (!requested) throw new Error('路径不能为空');
  const full = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(WORKSPACE, requested);
  if (!opts.fullAccess && full !== WORKSPACE && !full.startsWith(WORKSPACE + path.sep)) {
    throw new Error('路径超出工作区沙箱：' + requested);
  }
  return full;
}

function runCommand(userId, command, opts = {}) {
  return new Promise((resolve) => {
    const cmd = String(command || '').trim();
    const fullAccess = !!opts.fullAccess;
    if (!cmd) return resolve({ ok: false, denied: 'sandbox_policy', error: '命令为空' });
    if (!fullAccess && !allowShell()) {
      const err = '沙箱策略：未开启「允许命令」。在对话工具台打开开关后，Agent 才能执行 PowerShell。';
      audit(userId, 'command:denied', cmd, { reason: 'shell_disabled' });
      return resolve({ ok: false, denied: 'sandbox_policy', error: err });
    }
    if (!fullAccess && isDangerous(cmd)) {
      audit(userId, 'command:denied', cmd, { reason: 'destructive_pattern' });
      return resolve({ ok: false, denied: 'sandbox_policy', error: '沙箱策略：拒绝破坏性命令（删除/格式化/改注册表等）' });
    }

    let child;
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      try { child && child.kill(); } catch (_) {}
      finish({ ok: false, denied: 'sandbox_timeout', error: '命令执行超时（20s）' });
    }, 20_000);
    try {
      const full = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Set-Location -LiteralPath '${WORKSPACE_DESC.replace(/'/g, "''")}'; ${cmd}`;
      const enc = Buffer.from(full, 'utf16le').toString('base64');
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', enc], {
        cwd: WORKSPACE,
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out = (out + d).slice(0, 64_000); });
      child.stderr.on('data', (d) => { err = (err + d).slice(0, 16_000); });
      child.on('error', (e) => finish({ ok: false, denied: 'spawn_error', error: e.message }));
      child.on('close', (code) => {
        audit(userId, 'command:executed', cmd, { code, fullAccess });
        finish({ ok: code === 0, code, stdout: out, stderr: err, sandbox: fullAccess ? 'danger-full-access' : 'workspace-write' });
      });
    } catch (e) {
      finish({ ok: false, denied: 'spawn_error', error: e.message });
    }
  });
}

function readFile(userId, relPath, opts = {}) {
  const full = safeResolve(relPath, opts);
  if (fs.statSync(full).isDirectory()) throw new Error('目标是一个目录');
  const limit = Math.min(parseInt(opts.limit, 10) || 60_000, 200_000);
  const buf = fs.readFileSync(full);
  let text = buf.toString('utf8');
  const truncated = text.length > limit;
  text = text.slice(0, limit);
  audit(userId, 'file:read', relPath, { bytes: buf.length, truncated });
  return { ok: true, path: relPath, bytes: buf.length, truncated, content: text };
}

function writeFile(userId, relPath, content, opts = {}) {
  const full = safeResolve(relPath, opts);
  const text = String(content || '');
  if (Buffer.byteLength(text, 'utf8') > 250_000) throw new Error('文件过大，沙箱限制 250KB');
  const lower = String(relPath).toLowerCase();
  if (!opts.fullAccess && /\.env($|\.)|\.key$|\.pem$|\.crt$|\.p12$/.test(lower)) {
    throw new Error('沙箱策略：拒绝写入密钥/证书类文件');
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (opts.backup !== false && fs.existsSync(full)) {
    try {
      const bak = full + '.sandbox-bak';
      fs.copyFileSync(full, bak);
      audit(userId, 'file:backup', relPath, { backup: bak });
    } catch (_) {}
  }
  fs.writeFileSync(full, text, 'utf8');
  audit(userId, 'file:write', relPath, { bytes: Buffer.byteLength(text, 'utf8'), fullAccess: !!opts.fullAccess });
  return { ok: true, path: relPath, bytes: Buffer.byteLength(text, 'utf8'), sandbox: opts.fullAccess ? 'danger-full-access' : 'workspace-write' };
}

function listDir(userId, relPath, opts = {}) {
  const full = safeResolve(relPath || '.', opts);
  const items = fs.readdirSync(full, { withFileTypes: true }).map((e) => ({
    name: e.name,
    type: e.isDirectory() ? 'dir' : 'file',
  }));
  audit(userId, 'dir:list', relPath || '.', { count: items.length });
  return { ok: true, path: relPath || '.', items };
}

function searchFiles(userId, query, limit = 50) {
  const q = String(query || '').toLowerCase();
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'data', '.npm-cache', '.codex', '.agents']);
  const max = Math.min(parseInt(limit, 10) || 50, 200);
  function walk(dir, rel, depth) {
    if (out.length >= max * 4 || depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      const childAbs = path.join(dir, e.name);
      if (e.isDirectory()) walk(childAbs, childRel, depth + 1);
      else if (!q || childRel.toLowerCase().includes(q)) out.push(childRel);
      if (out.length >= max * 4) return;
    }
  }
  walk(WORKSPACE, '', 0);
  audit(userId, 'files:search', q, { count: out.length });
  return out.slice(0, max);
}

function gitStatus(userId) {
  return new Promise((resolve) => {
    const gitPath = WORKSPACE.replace(/\\/g, '/');
    const child = spawn('git', ['-c', 'safe.directory=' + gitPath, 'status', '--short'], {
      cwd: WORKSPACE,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message, stderr: err }));
    child.on('close', (code) => {
      audit(userId, 'git:status', '', { code });
      resolve({ ok: code === 0, sandbox: 'workspace-write', output: out.slice(0, 8000), stderr: err.slice(0, 2000) });
    });
  });
}

/**
 * git diff（用于 /review / 审阅变更）
 */
function gitDiff(userId, opts = {}) {
  return new Promise((resolve) => {
    const gitPath = WORKSPACE.replace(/\\/g, '/');
    const args = ['-c', 'safe.directory=' + gitPath, 'diff', '--no-color'];
    if (opts.stat) args.push('--stat');
    if (opts.base) args.push(String(opts.base));
    args.push('--');
    const child = spawn('git', args, { cwd: WORKSPACE, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      audit(userId, 'git:diff', opts.base || 'working-tree', { code, stat: !!opts.stat });
      resolve({ ok: code === 0, code, output: out.slice(0, 80_000), stderr: err.slice(0, 2000) });
    });
  });
}

function gitWorktreeList(userId) {
  return new Promise((resolve) => {
    const gitPath = WORKSPACE.replace(/\\/g, '/');
    const child = spawn('git', ['-c', 'safe.directory=' + gitPath, 'worktree', 'list', '--porcelain'], {
      cwd: WORKSPACE, windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      audit(userId, 'git:worktree:list', '', { code });
      resolve({ ok: code === 0, code, output: out.slice(0, 20_000), stderr: err.slice(0, 2000) });
    });
  });
}

function gitWorktreeAdd(userId, relPath, branch, opts = {}) {
  return new Promise((resolve) => {
    if (!opts.fullAccess && !allowShell()) {
      return resolve({ ok: false, denied: 'sandbox_policy', error: '创建 worktree 需要开启「允许命令」或使用完全访问模式' });
    }
    const target = safeResolve(relPath, opts);
    const gitPath = WORKSPACE.replace(/\\/g, '/');
    const args = ['-c', 'safe.directory=' + gitPath, 'worktree', 'add'];
    if (branch) args.push('-b', String(branch));
    args.push(target);
    const child = spawn('git', args, { cwd: WORKSPACE, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      audit(userId, 'git:worktree:add', target, { code, branch, fullAccess: !!opts.fullAccess });
      resolve({ ok: code === 0, code, output: out.slice(0, 10_000), stderr: err.slice(0, 2000), path: target, branch });
    });
  });
}

function gitWorktreeRemove(userId, relPath, opts = {}) {
  return new Promise((resolve) => {
    if (!opts.fullAccess && !allowShell()) {
      return resolve({ ok: false, denied: 'sandbox_policy', error: '删除 worktree 需要开启「允许命令」或使用完全访问模式' });
    }
    const target = safeResolve(relPath, opts);
    const gitPath = WORKSPACE.replace(/\\/g, '/');
    const child = spawn('git', ['-c', 'safe.directory=' + gitPath, 'worktree', 'remove', '--force', target], {
      cwd: WORKSPACE, windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      audit(userId, 'git:worktree:remove', target, { code, fullAccess: !!opts.fullAccess });
      resolve({ ok: code === 0, code, output: out.slice(0, 10_000), stderr: err.slice(0, 2000), path: target });
    });
  });
}

function runGitFile(userId, args, action, opts = {}) {
  return new Promise((resolve) => {
    const gitPath = WORKSPACE.replace(/\\/g, '/');
    const child = spawn('git', ['-c', 'safe.directory=' + gitPath, ...args], { cwd: WORKSPACE, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      audit(userId, action, args.join(' '), { code, fullAccess: !!opts.fullAccess });
      resolve({ ok: code === 0, code, output: out.slice(0, 10_000), stderr: err.slice(0, 2000) });
    });
  });
}

function gitStageFile(userId, file) {
  const target = safeResolve(file, { fullAccess: false });
  return runGitFile(userId, ['add', '--', target], 'git:stage');
}

function gitUnstageFile(userId, file) {
  const target = safeResolve(file, { fullAccess: false });
  return runGitFile(userId, ['reset', 'HEAD', '--', target], 'git:unstage');
}

function gitDiscardFile(userId, file, opts = {}) {
  if (!opts.fullAccess && !allowShell()) {
    return Promise.resolve({ ok: false, denied: 'sandbox_policy', error: '丢弃变更需要开启「允许命令」或使用完全访问模式' });
  }
  const target = safeResolve(file, { fullAccess: !!opts.fullAccess });
  return runGitFile(userId, ['checkout', '--', target], 'git:discard', opts);
}

function gitFileDiff(userId, file, staged = false) {
  const target = safeResolve(file, { fullAccess: false });
  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  args.push('--', target);
  return runGitFile(userId, args, staged ? 'git:diff:cached' : 'git:diff:file');
}

function gitApplyToIndex(userId, patchText, reverse = false) {
  return new Promise((resolve) => {
    const gitPath = WORKSPACE.replace(/\\/g, '/');
    const args = ['-c', 'safe.directory=' + gitPath, 'apply', '--cached', '--whitespace=nowarn'];
    if (reverse) args.push('--reverse');
    args.push('-');
    const child = spawn('git', args, { cwd: WORKSPACE, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      audit(userId, reverse ? 'git:unstage-hunks' : 'git:stage-hunks', '', { code });
      resolve({ ok: code === 0, code, output: out.slice(0, 10_000), stderr: err.slice(0, 2000) });
    });
    try {
      child.stdin.end(String(patchText || ''));
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

function gitApplyToWorktree(userId, patchText, reverse = false, opts = {}) {
  return new Promise((resolve) => {
    if (!opts.fullAccess && !allowShell()) {
      return resolve({ ok: false, denied: 'sandbox_policy', error: '丢弃 hunk 需要开启「允许命令」或使用完全访问模式' });
    }
    const gitPath = WORKSPACE.replace(/\\/g, '/');
    const args = ['-c', 'safe.directory=' + gitPath, 'apply', '--whitespace=nowarn'];
    if (reverse) args.push('--reverse');
    args.push('-');
    const child = spawn('git', args, { cwd: WORKSPACE, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      audit(userId, 'git:discard-hunks', '', { code, fullAccess: !!opts.fullAccess });
      resolve({ ok: code === 0, code, output: out.slice(0, 10_000), stderr: err.slice(0, 2000) });
    });
    try {
      child.stdin.end(String(patchText || ''));
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

function policy(userId) {
  return {
    ok: true,
    sandbox: 'workspace-write',
    workspace: WORKSPACE_DESC,
    dataDir: config.dataDir,
    allowShell: allowShell(),
    readOutsideWorkspace: false,
    writeOutsideWorkspace: false,
    destructiveCommands: false,
    commandTimeoutSec: 20,
    fileLimitBytes: 250_000,
  };
}

module.exports = {
  policy,
  allowShell,
  isDangerous,
  audit,
  runCommand,
  readFile,
  writeFile,
  listDir,
  searchFiles,
  gitStatus,
  gitDiff,
  gitWorktreeList,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitStageFile,
  gitUnstageFile,
  gitDiscardFile,
  gitFileDiff,
  gitApplyToIndex,
  gitApplyToWorktree,
  safeResolve,
  WORKSPACE,
};
