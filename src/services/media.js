'use strict';

/**
 * 截图/生成物存取：统一放到 DATA_DIR/screenshots，经 /api/media/screenshot 鉴权访问
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

function dir() {
  const d = path.join(config.dataDir, 'screenshots');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function newFile(prefix) {
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`;
  return { name, full: path.join(dir(), name) };
}

function resolve(name) {
  const d = path.resolve(dir());
  const full = path.resolve(d, String(name || ''));
  if (full !== d && !full.startsWith(d + path.sep)) return null;
  return fs.existsSync(full) ? full : null;
}

function urlFor(name) {
  return '/api/media/screenshot?name=' + encodeURIComponent(name);
}

module.exports = { dir, newFile, resolve, urlFor };
