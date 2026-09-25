'use strict';

/**
 * News aggregation service.
 *
 * The source registry is intentionally fixed and local. Users can select
 * sources, filters, templates and schedules, but cannot make the server fetch
 * an arbitrary URL through this module.
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const db = require('../db');
const logger = require('../logger');
const config = require('../config');

const registry = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'news-sources.json'), 'utf8')
);
const sourceMap = new Map(registry.sources.map((source) => [source.id, source]));
const templateMap = new Map(registry.templates.map((template) => [template.id, template]));
const cache = new Map();

const DEFAULT_SOURCE_ITEMS = 24;
const DEFAULT_BOARD_LIMIT = 12;
const DEFAULT_CACHE_TTL_MS = config.news?.cacheTtlMs || 10 * 60 * 1000;

function ensureTables() {
  db.rawDb().run(`
    CREATE TABLE IF NOT EXISTS news_boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      source_ids TEXT NOT NULL DEFAULT '[]',
      include_keywords TEXT NOT NULL DEFAULT '',
      exclude_keywords TEXT NOT NULL DEFAULT '',
      limit_count INTEGER NOT NULL DEFAULT 12,
      sort_mode TEXT NOT NULL DEFAULT 'latest',
      enabled INTEGER NOT NULL DEFAULT 1,
      automation_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_news_boards_user ON news_boards(user_id, id);
    CREATE TABLE IF NOT EXISTS news_preferences (
      user_id INTEGER PRIMARY KEY,
      initialized INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function lastId() {
  const r = db.rawDb().exec('SELECT last_insert_rowid() AS id');
  return r.length && r[0].values.length ? r[0].values[0][0] : null;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function splitKeywords(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeLimit(value, fallback = DEFAULT_BOARD_LIMIT) {
  const parsed = parseInt(value, 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : fallback, 3), 50);
}

function mapBoard(row) {
  if (!row) return null;
  return {
    ...row,
    source_ids: parseJsonArray(row.source_ids).filter((id) => sourceMap.has(id)),
    include_keywords: splitKeywords(row.include_keywords),
    exclude_keywords: splitKeywords(row.exclude_keywords),
    limit_count: normalizeLimit(row.limit_count),
    enabled: !!row.enabled,
    automation_id: row.automation_id == null ? null : Number(row.automation_id),
  };
}

function enrichBoard(board) {
  if (!board) return null;
  let cron = null;
  if (board.automation_id) {
    try {
      const automation = require('./automations').get(board.user_id, board.automation_id);
      if (automation && automation.enabled) cron = automation.cron;
    } catch (_) {}
  }
  return { ...board, cron };
}

function templateById(id) {
  return templateMap.get(String(id || '')) || null;
}

function sourceById(id) {
  return sourceMap.get(String(id || '')) || null;
}

function publicCatalog() {
  return {
    version: registry.version,
    sources: registry.sources.map((source) => ({ ...source })),
    templates: registry.templates.map((template) => ({ ...template, sourceIds: [...template.sourceIds] })),
  };
}

function listBoards(userId) {
  ensureTables();
  let rows = db.query('SELECT * FROM news_boards WHERE user_id = ? ORDER BY id ASC', [Number(userId)])
    .map(mapBoard)
    .map(enrichBoard);
  const preference = db.query('SELECT initialized FROM news_preferences WHERE user_id = ?', [Number(userId)])[0];
  const initialized = !!preference?.initialized;
  if (!rows.length && !initialized) {
    createBoard(userId, { templateId: 'daily-cn', name: '今日要闻' });
    createBoard(userId, { templateId: 'tech-cn', name: '中文科技' });
    db.rawDb().run('INSERT OR REPLACE INTO news_preferences (user_id, initialized) VALUES (?, 1)', [Number(userId)]);
    db.persist();
    rows = db.query('SELECT * FROM news_boards WHERE user_id = ? ORDER BY id ASC', [Number(userId)])
      .map(mapBoard)
      .map(enrichBoard);
  } else if (rows.length && !initialized) {
    db.rawDb().run('INSERT OR REPLACE INTO news_preferences (user_id, initialized) VALUES (?, 1)', [Number(userId)]);
    db.persist();
  }
  return rows;
}

function getBoard(userId, id) {
  ensureTables();
  const rows = db.query(
    'SELECT * FROM news_boards WHERE id = ? AND user_id = ?',
    [Number(id), Number(userId)]
  );
  return rows.length ? enrichBoard(mapBoard(rows[0])) : null;
}

function resolveBoardInput(userId, input = {}) {
  const boards = listBoards(userId);
  if (input.boardId != null) {
    const byId = boards.find((board) => board.id === Number(input.boardId));
    if (byId) return byId;
  }
  const needle = String(input.board || input.name || input.template || '').trim().toLowerCase();
  if (!needle) return boards[0] || null;
  return boards.find((board) => String(board.name).toLowerCase() === needle)
    || boards.find((board) => String(board.name).toLowerCase().includes(needle))
    || boards.find((board) => String(board.id) === needle)
    || null;
}

function createBoard(userId, data = {}) {
  ensureTables();
  const template = templateById(data.templateId || data.template);
  const sourceIds = (Array.isArray(data.sourceIds) ? data.sourceIds : template?.sourceIds || [])
    .map((id) => String(id))
    .filter((id) => sourceMap.has(id));
  const name = String(data.name || template?.name || '我的新闻').trim().slice(0, 60);
  if (!name) throw new Error('板块名称不能为空');
  if (!sourceIds.length) throw new Error('至少选择一个新闻源');
  if (data.cron && !cron.validate(String(data.cron))) throw new Error('cron 表达式无效');
  const now = db.nowIso();
  db.rawDb().run(
    `INSERT INTO news_boards
      (user_id, name, source_ids, include_keywords, exclude_keywords, limit_count, sort_mode, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(userId),
      name,
      JSON.stringify(sourceIds),
      splitKeywords(data.includeKeywords || data.include_keywords).join(', '),
      splitKeywords(data.excludeKeywords || data.exclude_keywords).join(', '),
      normalizeLimit(data.limit || data.limit_count, template?.limit || DEFAULT_BOARD_LIMIT),
      data.sort === 'source' ? 'source' : 'latest',
      data.enabled === false ? 0 : 1,
      now,
      now,
    ]
  );
  const board = getBoard(userId, lastId());
  if (data.cron) scheduleBoard(userId, board.id, data.cron);
  return getBoard(userId, board.id);
}

function updateBoard(userId, id, patch = {}) {
  const current = getBoard(userId, id);
  if (!current) return null;
  if (patch.name !== undefined) {
    patch.name = String(patch.name || '').trim().slice(0, 60);
    if (!patch.name) throw new Error('板块名称不能为空');
  }
  if (patch.sourceIds || patch.source_ids) {
    const sourceIds = (patch.sourceIds || patch.source_ids)
      .map((sourceId) => String(sourceId))
      .filter((sourceId) => sourceMap.has(sourceId));
    if (!sourceIds.length) throw new Error('至少选择一个新闻源');
    patch.source_ids = JSON.stringify(sourceIds);
  }
  if (patch.includeKeywords !== undefined || patch.include_keywords !== undefined) {
    patch.include_keywords = splitKeywords(
      patch.includeKeywords !== undefined ? patch.includeKeywords : patch.include_keywords
    ).join(', ');
  }
  if (patch.excludeKeywords !== undefined || patch.exclude_keywords !== undefined) {
    patch.exclude_keywords = splitKeywords(
      patch.excludeKeywords !== undefined ? patch.excludeKeywords : patch.exclude_keywords
    ).join(', ');
  }
  if (patch.limit !== undefined || patch.limit_count !== undefined) {
    patch.limit_count = normalizeLimit(
      patch.limit !== undefined ? patch.limit : patch.limit_count,
      current.limit_count
    );
  }
  if (patch.sort !== undefined || patch.sort_mode !== undefined) {
    patch.sort_mode = patch.sort === 'source' || patch.sort_mode === 'source' ? 'source' : 'latest';
  }
  if (patch.enabled !== undefined) patch.enabled = patch.enabled ? 1 : 0;
  if (patch.cron !== undefined && patch.cron && !cron.validate(String(patch.cron))) {
    throw new Error('cron 表达式无效');
  }

  const allowed = new Set([
    'name', 'source_ids', 'include_keywords', 'exclude_keywords',
    'limit_count', 'sort_mode', 'enabled',
  ]);
  const fields = Object.keys(patch).filter((key) => allowed.has(key));
  if (fields.length) {
    db.rawDb().run(
      `UPDATE news_boards SET ${fields.map((field) => field + ' = ?').join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`,
      [...fields.map((field) => patch[field]), db.nowIso(), Number(id), Number(userId)]
    );
    db.persist();
  }
  const board = getBoard(userId, id);
  if (patch.cron !== undefined) scheduleBoard(userId, id, patch.cron);
  return getBoard(userId, id) || board;
}

function removeBoard(userId, id) {
  const board = getBoard(userId, id);
  if (!board) return false;
  if (board.automation_id) {
    try {
      require('./automations').remove(userId, board.automation_id);
    } catch (_) {}
  }
  db.rawDb().run('DELETE FROM news_boards WHERE id = ? AND user_id = ?', [Number(id), Number(userId)]);
  db.persist();
  return true;
}

function scheduleBoard(userId, id, cron) {
  const board = getBoard(userId, id);
  if (!board) return null;
  const automations = require('./automations');
  const expression = String(cron || '').trim();
  const name = `新闻推送 · ${board.name}`;
  const prompt = `生成「${board.name}」新闻简报`;
  const payload = { boardId: board.id };

  if (!expression) {
    if (board.automation_id) {
      automations.update(userId, board.automation_id, { enabled: false, name, prompt, kind: 'news_digest', payload });
    }
    return { enabled: false, automation_id: board.automation_id };
  }

  let automation;
  if (board.automation_id) {
    automation = automations.update(userId, board.automation_id, {
      name, prompt, cron: expression, enabled: true, kind: 'news_digest', payload,
    });
  }
  if (!automation) {
    automation = automations.create(userId, {
      name, prompt, cron: expression, enabled: true, kind: 'news_digest', payload,
    });
    db.rawDb().run(
      'UPDATE news_boards SET automation_id = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [automation.id, db.nowIso(), Number(id), Number(userId)]
    );
    db.persist();
  }
  return { enabled: true, automation_id: automation.id, cron: expression };
}

function decodeEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1].toLowerCase() === 'x';
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, entity.toLowerCase())
      ? named[entity.toLowerCase()]
      : match;
  });
}

function cleanText(value, maxLength = 800) {
  const text = decodeEntities(
    String(value || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxLength);
}

function firstTag(block, names) {
  for (const name of names) {
    const match = String(block).match(
      new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')
    );
    if (match) return cleanText(match[1]);
  }
  return '';
}

function attribute(block, tagName, attributeName) {
  const match = String(block).match(
    new RegExp(`<${tagName}\\b[^>]*\\b${attributeName}=["']([^"']+)["'][^>]*>`, 'i')
  );
  return match ? decodeEntities(match[1]) : '';
}

function safeUrl(value, base) {
  try {
    const url = new URL(String(value || ''), base);
    return /^https?:$/.test(url.protocol) ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

function dateValue(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseFeed(xml, source) {
  const text = String(xml || '').replace(/^\uFEFF/, '');
  const blocks = [
    ...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ];
  return blocks.map((match, index) => {
    const block = match[1];
    const title = firstTag(block, ['title']) || '无标题';
    const link = safeUrl(
      firstTag(block, ['link', 'guid', 'id']) || attribute(block, 'link', 'href'),
      source.homepage
    );
    const summary = firstTag(block, [
      'description', 'summary', 'content:encoded', 'content', 'media:description',
    ]);
    const publishedAt = dateValue(firstTag(block, [
      'pubDate', 'published', 'updated', 'dc:date', 'date',
    ]));
    return {
      id: `${source.id}:${firstTag(block, ['guid', 'id']) || link || index}`,
      title,
      url: link,
      summary,
      publishedAt,
      sourceId: source.id,
      sourceName: source.name,
      category: source.category,
      language: source.language,
      region: source.region,
      trust: source.trust,
      order: index,
    };
  }).filter((item) => item.title && item.url);
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'User-Agent': config.news?.userAgent || 'WorkBuddy/0.1 (+local news reader)',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2_500_000) return text.slice(0, 2_500_000);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSource(source, options = {}) {
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cached = cache.get(source.id);
  if (!options.force && cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, cached: true };
  }
  try {
    const text = await fetchText(source.url, options.timeoutMs || config.news?.timeoutMs || 12_000);
    const items = parseFeed(text, source);
    const value = {
      source,
      items,
      fetchedAt: new Date().toISOString(),
    };
    cache.set(source.id, { expiresAt: Date.now() + ttl, value });
    return { ...value, cached: false };
  } catch (error) {
    logger.warn(`news source failed: ${source.id}: ${error.message}`);
    const value = {
      source,
      items: [],
      error: error.message,
      fetchedAt: new Date().toISOString(),
    };
    cache.set(source.id, { expiresAt: Date.now() + Math.min(ttl, 60_000), value });
    return { ...value, cached: false };
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function articleMatches(article, board, query = '') {
  const haystack = normalizeSearchText(`${article.title} ${article.summary}`);
  const includes = board.include_keywords || [];
  const excludes = board.exclude_keywords || [];
  const terms = splitKeywords(query);
  if (includes.length && !includes.some((term) => haystack.includes(normalizeSearchText(term)))) return false;
  if (excludes.some((term) => haystack.includes(normalizeSearchText(term)))) return false;
  if (terms.length && !terms.every((term) => haystack.includes(normalizeSearchText(term)))) return false;
  return true;
}

function dedupeArticles(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.url || ''}|${normalizeSearchText(item.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortArticles(items, mode) {
  if (mode === 'source') {
    return items.slice().sort((a, b) => {
      const sourceCompare = String(a.sourceName).localeCompare(String(b.sourceName), 'zh-CN');
      return sourceCompare || a.order - b.order;
    });
  }
  return items.slice().sort((a, b) => {
    const aTime = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bTime = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.sourceId.localeCompare(b.sourceId) || a.order - b.order;
  });
}

async function articlesFor(userId, input = {}) {
  const board = input.boardId != null || input.board || input.name || input.template
    ? resolveBoardInput(userId, input)
    : null;
  const sourceIds = (
    input.sourceIds
    || input.source_ids
    || board?.source_ids
    || registry.sources.map((source) => source.id)
  ).map(String).filter((id) => sourceMap.has(id));

  const sources = sourceIds.map(sourceById).filter(Boolean);
  const results = await mapLimit(
    sources,
    Math.max(1, Math.min(config.news?.concurrency || 4, 8)),
    (source) => fetchSource(source, input)
  );
  const errors = results
    .filter((result) => result.error)
    .map((result) => ({ sourceId: result.source.id, sourceName: result.source.name, error: result.error }));
  const sourceLimit = Math.min(
    Math.max(parseInt(input.sourceLimit || input.source_limit, 10) || DEFAULT_SOURCE_ITEMS, 5),
    60
  );
  let items = [];
  for (const result of results) {
    items.push(...sortArticles(result.items, 'latest').slice(0, sourceLimit));
  }

  const fakeBoard = board || {
    include_keywords: splitKeywords(input.includeKeywords || input.include_keywords),
    exclude_keywords: splitKeywords(input.excludeKeywords || input.exclude_keywords),
  };
  const query = input.query || input.q || '';
  items = items.filter((item) => articleMatches(item, fakeBoard, query));
  if (input.sinceHours) {
    const cutoff = Date.now() - Number(input.sinceHours) * 3600_000;
    items = items.filter((item) => !item.publishedAt || Date.parse(item.publishedAt) >= cutoff);
  }
  items = dedupeArticles(items);
  const limit = normalizeLimit(input.limit || board?.limit_count, 20);
  return {
    board,
    items: sortArticles(items, board?.sort_mode || input.sort || 'latest').slice(0, limit),
    sources: results.map((result) => ({
      id: result.source.id,
      name: result.source.name,
      count: result.items.length,
      cached: !!result.cached,
      fetchedAt: result.fetchedAt,
      error: result.error || null,
    })),
    errors,
  };
}

function mdText(value) {
  return String(value || '').replace(/([\\[\]()])/g, '\\$1').replace(/\s+/g, ' ').trim();
}

function relativeTime(value) {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

function renderDigest(board, result) {
  const title = board?.name || '新闻简报';
  const lines = [
    `## ${mdText(title)}`,
    `> ${result.items.length} 条 · 更新于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
  ];
  if (!result.items.length) {
    lines.push('暂时没有获取到符合条件的新闻。');
  } else {
    result.items.forEach((item, index) => {
      const meta = [item.sourceName, relativeTime(item.publishedAt)].filter(Boolean).join(' · ');
      lines.push(`${index + 1}. [${mdText(item.title)}](${item.url})`);
      lines.push(`   ${meta}`);
      if (item.summary) lines.push(`   ${mdText(item.summary).slice(0, 220)}`);
      lines.push('');
    });
  }
  if (result.errors.length) {
    lines.push(`> ${result.errors.length} 个信息源暂时不可用：${result.errors.map((item) => item.sourceName).join('、')}`);
  }
  return lines.join('\n').trim();
}

async function digest(userId, input = {}) {
  const board = resolveBoardInput(userId, input);
  if (!board) throw new Error('没有可用的新闻板块');
  const result = await articlesFor(userId, {
    ...input,
    boardId: board.id,
    limit: input.limit || board.limit_count,
  });
  return {
    ...result,
    board,
    text: renderDigest(board, result),
  };
}

async function search(userId, query, input = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) throw new Error('请输入新闻关键词');
  const result = await articlesFor(userId, { ...input, query: cleanQuery });
  return {
    ...result,
    query: cleanQuery,
    text: renderDigest({ name: `新闻搜索 · ${cleanQuery}` }, result),
  };
}

module.exports = {
  ensureTables,
  publicCatalog,
  listBoards,
  getBoard,
  createBoard,
  updateBoard,
  removeBoard,
  scheduleBoard,
  articlesFor,
  digest,
  search,
  sourceById,
  templateById,
  _test: {
    parseFeed,
    cleanText,
    articleMatches,
    sortArticles,
    renderDigest,
  },
};
