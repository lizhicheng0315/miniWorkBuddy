'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const logger = require('../logger');

const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.csv', '.tsv',
  '.html', '.htm', '.xml', '.json', '.txt', '.md', '.markdown', '.rst',
  '.epub', '.msg', '.ipynb', '.zip', '.rtf', '.log',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.cpp',
  '.h', '.hpp', '.cs', '.php', '.rb', '.sh', '.ps1', '.sql', '.yml', '.yaml',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.json', '.xml', '.csv', '.tsv', '.log',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.cpp',
  '.h', '.hpp', '.cs', '.php', '.rb', '.sh', '.ps1', '.sql', '.yml', '.yaml',
]);

function safeFileName(name) {
  const base = path.basename(String(name || 'document'));
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return (cleaned || 'document').slice(0, 160);
}

function extensionOf(name) {
  return path.extname(safeFileName(name)).toLowerCase();
}

function resolveHome() {
  const candidates = [
    config.documents.home,
    path.join(config.root, '.tools', 'markitdown'),
  ];
  if (process.pkg) candidates.push(path.join(path.dirname(process.execPath), '.tools', 'markitdown'));
  return candidates.find((p) => p && fs.existsSync(p)) || config.documents.home;
}

function buildPythonEnv() {
  const env = { ...process.env };
  const home = resolveHome();
  if (home && fs.existsSync(home)) {
    env.PYTHONPATH = env.PYTHONPATH ? home + path.delimiter + env.PYTHONPATH : home;
  }
  env.PYTHONUTF8 = '1';
  return env;
}

function runMarkItDown(inputPath, outputPath, extension) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.documents.python,
      ['-m', 'markitdown', inputPath, '-o', outputPath, '-x', extension.replace(/^\./, '')],
      {
        env: buildPythonEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`MarkItDown 转换超时（${Math.round(config.documents.timeoutMs / 1000)}s）`));
    }, config.documents.timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function nativeTextResult(buffer, filename) {
  const markdown = buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  return {
    ok: true,
    engine: 'native-text',
    vendor: null,
    filename,
    extension: extensionOf(filename),
    markdown,
    characters: markdown.length,
    lines: markdown ? markdown.split('\n').length : 0,
    truncated: false,
  };
}

async function convertBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('文件内容为空');
  }
  if (buffer.length > config.documents.maxBytes) {
    throw new Error(`文件超过 ${Math.round(config.documents.maxBytes / 1024 / 1024)} MB 上限`);
  }

  const filename = safeFileName(options.filename || 'document');
  const ext = extensionOf(filename);
  if (ext && !SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`暂不支持 ${ext} 文件`);
  }

  const tempRoot = path.join(os.tmpdir(), 'workbuddy-markitdown');
  await fs.promises.mkdir(tempRoot, { recursive: true });
  const tempDir = await fs.promises.mkdtemp(path.join(tempRoot, 'job-'));
  const inputPath = path.join(tempDir, filename);
  const outputPath = path.join(tempDir, 'converted.md');

  try {
    await fs.promises.writeFile(inputPath, buffer);
    let result;
    try {
      result = await runMarkItDown(inputPath, outputPath, ext);
    } catch (err) {
      if (TEXT_EXTENSIONS.has(ext)) return nativeTextResult(buffer, filename);
      throw new Error(`MarkItDown 无法启动：${err.message}`);
    }

    if (result.code !== 0) {
      if (TEXT_EXTENSIONS.has(ext)) return nativeTextResult(buffer, filename);
      const detail = String(result.stderr || result.stdout || '').trim().slice(-500);
      throw new Error(detail || `MarkItDown 退出码 ${result.code}`);
    }

    let markdown = await fs.promises.readFile(outputPath, 'utf8');
    markdown = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
    if (!markdown) throw new Error('MarkItDown 没有提取到可用文本');

    const originalChars = markdown.length;
    const maxChars = config.documents.maxChars;
    const truncated = originalChars > maxChars;
    if (truncated) markdown = markdown.slice(0, maxChars) + '\n\n> 内容过长，已截断用于当前对话上下文。';

    return {
      ok: true,
      engine: 'markitdown',
      vendor: 'Microsoft MarkItDown',
      filename,
      extension: ext,
      markdown,
      characters: markdown.length,
      original_characters: originalChars,
      lines: markdown ? markdown.split('\n').length : 0,
      truncated,
      warnings: String(result.stderr || '').trim().slice(-800),
    };
  } finally {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn('markitdown temp cleanup failed:', err.message);
    }
  }
}

function status() {
  const home = resolveHome();
  const installed = Boolean(home && fs.existsSync(path.join(home, 'markitdown')));
  return {
    available: installed,
    vendor: 'Microsoft MarkItDown',
    engine: 'markitdown',
    version: '0.1.7',
    home: installed ? home : null,
    max_mb: Math.round(config.documents.maxBytes / 1024 / 1024),
    supported_extensions: [...SUPPORTED_EXTENSIONS],
  };
}

module.exports = {
  convertBuffer,
  status,
  supportedExtensions: [...SUPPORTED_EXTENSIONS],
};
