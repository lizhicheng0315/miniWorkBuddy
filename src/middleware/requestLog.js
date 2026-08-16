'use strict';

/**
 * 请求日志中间件 + 文件落盘。
 *   - 控制台：彩色简化格式
 *   - 文件：JSON Lines（data/access-YYYY-MM-DD.log）
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

let logDir = null;
let stream = null;
let curDate = null;

function ensureStream() {
  if (!config.log.toFile) return null;
  if (!logDir) {
    logDir = path.join(config.dataDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
  }
  const d = new Date().toISOString().slice(0, 10);
  if (d !== curDate) {
    if (stream) stream.end();
    curDate = d;
    stream = fs.createWriteStream(path.join(logDir, `access-${d}.log`), { flags: 'a' });
  }
  return stream;
}

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const line = {
      t: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms,
      ip: req.ip || req.connection.remoteAddress,
      user_id: req.user ? req.user.id : null,
      ua: (req.headers['user-agent'] || '').slice(0, 100),
    };
    const color = res.statusCode >= 500 ? '\x1b[31m'
      : res.statusCode >= 400 ? '\x1b[33m'
      : res.statusCode >= 300 ? '\x1b[36m'
      : '\x1b[32m';
    const reset = '\x1b[0m';
    const user = line.user_id ? ` u=${line.user_id}` : '';
    process.stdout.write(
      `${color}${line.method} ${line.path} ${line.status} ${ms}ms${user}${reset}\n`
    );
    const s = ensureStream();
    if (s) s.write(JSON.stringify(line) + '\n');
  });
  next();
}

module.exports = { requestLogger };
