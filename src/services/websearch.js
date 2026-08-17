'use strict';

/**
 * 联网搜索服务。
 *
 * 后端策略（按优先级）：
 *   1. Bing Web Search v7 —— 需要订阅 key（质量最好，可选用）
 *   2. Bing HTML 搜索（cn.bing.com）—— 免费、无需 key，国内网络可达（默认）
 *   3. DuckDuckGo Instant Answer API —— 免费、无需 key，国外网络（兜底）
 *   4. DuckDuckGo HTML 搜索 —— 免费、无需 key（最终兜底）
 *
 * 注意：服务运行在宿主（用户本机）上。国内网络下 DuckDuckGo 不可达，
 * 所以默认走 Bing（cn.bing.com）。配置 BING_SEARCH_KEY 后可升级为 Bing API。
 */

const config = require('../config');
const logger = require('../logger');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** 从 settings/.env 读取 Bing key（可选） */
function bingKey() {
  return config.bingSearchKey || process.env.BING_SEARCH_KEY || '';
}

/**
 * Bing Web Search v5/v7
 */
async function searchBing(query, count = 5) {
  const key = bingKey();
  if (!key) return { ok: false, error: '未配置 BING_SEARCH_KEY' };
  const url = 'https://api.bing.microsoft.com/v7.0/search?q=' + encodeURIComponent(query) + '&count=' + count + '&mkt=zh-CN';
  const data = await fetchJson(url, { 'Ocp-Apim-Subscription-Key': key });
  const results = (data.webPages && data.webPages.value || []).map((r) => ({
    title: r.name,
    url: r.url,
    snippet: r.snippet,
  }));
  return { ok: true, results };
}

/**
 * DuckDuckGo Instant Answer（免费，无需 key）
 * 只返回结构化答案（Abstract / Definition / Answer），适合查定义、事实。
 */
async function searchDDGInstant(query) {
  const url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1';
  const data = await fetchJson(url);
  const results = [];
  if (data.AbstractText) {
    results.push({ title: data.Heading || query, url: data.AbstractURL || '', snippet: data.AbstractText });
  }
  if (data.Definition && data.Definition !== '') {
    results.push({ title: '定义', url: data.DefinitionURL || '', snippet: data.Definition });
  }
  if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
    for (const t of data.RelatedTopics) {
      const item = t.Topics ? t.Topics[0] : t; // 处理嵌套（categories）
      if (item && item.Text) {
        results.push({ title: item.Text.split(' - ')[0] || item.Text.slice(0, 40), url: item.FirstURL || '', snippet: item.Text });
      }
      if (results.length >= 5) break;
    }
  }
  return { ok: true, results, engine: 'duckduckgo-instant' };
}

/** 简单 HTML 实体解码 */
function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * DuckDuckGo HTML 搜索（免费，无需 key，更全面）
 * 解析 lite.duckduckgo.com 的搜索结果页。
 */
async function searchDDGHtml(query, count = 6) {
  const url = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query);
  const html = await fetchText(url);
  const results = [];
  // lite.duckduckgo.com 结果结构：<a rel="nofollow" href="实际URL">标题</a><td>摘要</td>
  const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
  const snippetRe = /<td class="result-snippet">(.*?)<\/td>/gis;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) !== null && links.length < count) {
    links.push({ url: decodeHtml(m[1]), title: decodeHtml(m[2].replace(/<[^>]+>/g, '')) });
  }
  const snippets = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < count) {
    snippets.push(decodeHtml(m[1].replace(/<[^>]+>/g, '')));
  }
  for (let i = 0; i < Math.min(count, links.length); i++) {
    results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] || '' });
  }
  return { ok: true, results, engine: 'duckduckgo-lite' };
}

/**
 * Bing HTML 搜索（免费，无需 key，cn.bing.com 国内可达）
 * 解析 cn.bing.com/search 的 b_algo 结果块。
 */
async function searchBingHtml(query, count = 6) {
  const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&setmkt=zh-CN&count=' + count;
  const html = await fetchText(url, {
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Accept': 'text/html,application/xhtml+xml',
  });
  const results = [];
  // b_algo 结果块：<li class="b_algo"> ... <h2><a href="URL">标题</a></h2> ... <p>摘要</p>
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/gi;
  const blocks = html.match(blockRe) || [];
  for (const block of blocks.slice(0, count)) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({
      title: decodeHtml(link[2].replace(/<[^>]+>/g, '')).trim(),
      url: decodeHtml(link[1]),
      snippet: snippetMatch ? decodeHtml(snippetMatch[1].replace(/<[^>]+>/g, '')).trim() : '',
    });
  }
  return { ok: true, results, engine: 'bing-html' };
}

/**
 * 对外主入口：按配置选择后端，返回统一结构
 * @param {string} query
 * @param {{count?:number}} opts
 */
async function search(query, opts = {}) {
  const count = opts.count || 6;
  if (!query || !query.trim()) return { ok: false, error: 'query 必填' };

  // 1. 优先 Bing API（配置了 key 时）
  if (bingKey()) {
    try {
      const r = await searchBing(query, count);
      if (r.ok && r.results.length) return { ok: true, results: r.results, engine: 'bing' };
      logger.warn('bing api returned no results, falling back');
    } catch (e) {
      logger.warn('bing api failed:', e.message);
    }
  }

  // 2. Bing HTML（cn.bing.com，国内可达，默认主力）
  try {
    const r = await searchBingHtml(query, count);
    if (r.ok && r.results.length) return r;
    logger.warn('bing-html returned no results, falling back');
  } catch (e) {
    logger.warn('bing-html failed:', e.message);
  }

  // 3. DDG Instant Answer（国外网络可用时兜底）
  try {
    const r = await searchDDGInstant(query);
    if (r.ok && r.results.length >= 2) return r;
  } catch (e) {
    logger.warn('ddg-instant failed:', e.message);
  }

  // 4. DDG HTML（最终兜底）
  try {
    const r = await searchDDGHtml(query, count);
    if (r.ok && r.results.length) return r;
    return { ok: true, results: [], engine: 'duckduckgo-lite' };
  } catch (e) {
    logger.warn('ddg-html failed:', e.message);
    return { ok: false, error: '所有搜索后端均失败: ' + e.message };
  }
}

module.exports = { search, searchBing, searchBingHtml, searchDDGInstant, searchDDGHtml };