'use strict';

/**
 * OpenAI 兼容 LLM 客户端封装。
 * 关键能力：
 *   - 指数退避重试（最多 MAX_RETRIES 次）
 *   - 每次请求带超时（AbortController）
 *   - 只对 5xx / 408 / 429 / 网络错误重试；4xx 业务错误直接返回
 *   - 配置可在运行时通过 settings 覆盖 .env（热生效）
 */

const OpenAI = require('openai');
const config = require('../config');
const logger = require('../logger');
const db = require('../db');

let client = null;
let clientKey = ''; // 用于检测配置变化、决定是否重建 client

function resolveConfig() {
  // 优先 DB 里的 settings（L_* 三个 key），fallback 到 .env
  const baseURL = db.getSetting('LLM_BASE_URL') || config.llm.baseURL;
  const apiKey = db.getSetting('LLM_API_KEY') || config.llm.apiKey;
  const model = db.getSetting('LLM_MODEL') || config.llm.model;
  return { baseURL, apiKey, model };
}

function isEnabled() {
  const { apiKey } = resolveConfig();
  return !!apiKey;
}

function getClient() {
  const { apiKey, baseURL } = resolveConfig();
  if (!apiKey) return null;
  // 配置变了就重建
  const sig = `${baseURL}|${apiKey}`;
  if (!client || clientKey !== sig) {
    const http = require('http');
    const https = require('https');
    client = new OpenAI({
      apiKey,
      baseURL,
      maxRetries: 0,
      timeout: resolveTimeout(),
      httpAgent: new https.Agent({ keepAlive: true, timeout: resolveConnectTimeout() }),
    });
    clientKey = sig;
    logger.info(`LLM client (re)built: model=${resolveConfig().model}, baseURL=${baseURL}`);
  }
  return client;
}

function resolveTimeout() {
  const v = db.getSetting('LLM_TIMEOUT_MS');
  const n = v ? parseInt(v, 10) : config.llm.timeoutMs;
  return Number.isFinite(n) ? n : 30000;
}

// TCP 连接单独 timeout：比 LLM 整体 timeout 更短（默认 5s）
// 避免连不上时等 30 秒
function resolveConnectTimeout() {
  const v = db.getSetting('LLM_CONNECT_TIMEOUT_MS');
  const n = v ? parseInt(v, 10) : 5000;
  return Number.isFinite(n) ? n : 5000;
}

function resolveTimeout() {
  const v = db.getSetting('LLM_TIMEOUT_MS');
  const n = v ? parseInt(v, 10) : config.llm.timeoutMs;
  return Number.isFinite(n) ? n : 30000;
}

function resolveMaxRetries() {
  const v = db.getSetting('LLM_MAX_RETRIES');
  const n = v ? parseInt(v, 10) : config.llm.maxRetries;
  return Number.isFinite(n) ? n : 3;
}

const MAX_RETRIES = () => resolveMaxRetries();
const BASE_DELAY_MS = 500;
const TIMEOUT_MS = () => resolveTimeout();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(err) {
  if (!err) return false;
  const status = err.status || err?.response?.status;
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (err.code && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN)$/i.test(err.code)) return true;
  if (/timeout|aborted|network|socket hang up/i.test(err.message || '')) return true;
  return false;
}

async function callOnce(model, messages, opts) {
  const c = getClient();
  if (!c) throw new Error('LLM 未配置：请在 .env 或 Web 设置里填 LLM_API_KEY');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
  try {
    const resp = await c.chat.completions.create(
      {
        model,
        messages,
        temperature: opts.temperature ?? 0.5,
        max_tokens: opts.max_tokens ?? 800,
      },
      { signal: controller.signal }
    );
    return resp.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

async function chat(messages, opts = {}) {
  const { apiKey } = resolveConfig();
  if (!apiKey) {
    return { ok: false, error: 'LLM 未配置：请在 .env 或 Web 设置里填 LLM_API_KEY' };
  }
  const { model } = resolveConfig();
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES(); attempt++) {
    try {
      const text = await callOnce(model, messages, opts);
      if (attempt > 0) logger.info(`LLM recovered after ${attempt} retry`);
      return { ok: true, text, attempts: attempt + 1 };
    } catch (e) {
      lastErr = e;
      const status = e.status || e?.response?.status;
      const retryable = isRetryable(e);
      logger.warn(
        `LLM call failed (attempt ${attempt + 1}/${MAX_RETRIES() + 1}, status=${status}, retryable=${retryable}): ${e.message}`
      );
      if (!retryable || attempt === MAX_RETRIES()) break;
      // 429 限流：固定等 10s（上游明确告诉我们要等）
      // 其他可重试错误：指数退避（500ms / 1s / 2s / 4s ...）
      const delay = status === 429 ? 10_000 : BASE_DELAY_MS * Math.pow(2, attempt);
      logger.info(`LLM retrying in ${delay}ms (status=${status})…`);
      await sleep(delay);
    }
  }

  return {
    ok: false,
    error: lastErr?.message || 'LLM call failed',
    retries_exhausted: true,
  };
}

async function chatStream(messages, opts, onDelta) {
  const { apiKey } = resolveConfig();
  if (!apiKey) {
    return { ok: false, error: 'LLM 未配置：请在 .env 或 Web 设置里填 LLM_API_KEY' };
  }
  const c = getClient();
  if (!c) return { ok: false, error: 'LLM client unavailable' };
  const { model } = resolveConfig();

  // 流式也走 429 等待 10s
  for (let attempt = 0; attempt <= MAX_RETRIES(); attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS() * 2);
    let full = '';
    try {
      const stream = await c.chat.completions.create(
        {
          model,
          messages,
          temperature: opts.temperature ?? 0.5,
          max_tokens: opts.max_tokens ?? 800,
          stream: true,
        },
        { signal: controller.signal }
      );
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          try { onDelta(delta, full); } catch (_) {}
        }
      }
      clearTimeout(timer);
      return { ok: true, text: full };
    } catch (e) {
      clearTimeout(timer);
      const status = e.status || e?.response?.status;
      const retryable = isRetryable(e);
      if (retryable && status === 429 && attempt < MAX_RETRIES()) {
        logger.warn(`LLM stream 429, waiting 10s before retry ${attempt + 1}/${MAX_RETRIES()}`);
        try { onDelta('', full); onDelta('[限流，等待 10s 后重试…]', full); } catch (_) {}
        await sleep(10_000);
        continue;
      }
      logger.error('LLM stream failed:', e.message);
      return { ok: false, error: e.message };
    }
  }
  return { ok: false, error: '流式调用重试耗尽' };
}

/**
 * 测试当前 LLM 配置能否联通（用一个超简短的 chat）
 */
async function testConnection() {
  const { apiKey, model, baseURL } = resolveConfig();
  if (!apiKey) return { ok: false, error: '未配置 API Key' };
  const start = Date.now();
  // 短超时 + 不重试：测试连接必须 5s 内给答案
  const c = new (require('openai'))({
    apiKey,
    baseURL,
    maxRetries: 0,
    timeout: 5000,
    httpAgent: new (require('https').Agent)({ keepAlive: false, timeout: 3000 }),
  });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await c.chat.completions.create(
      { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4, temperature: 0 },
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    const latency = Date.now() - start;
    return { ok: true, latency_ms: latency, model, baseURL };
  } catch (e) {
    return { ok: false, error: e.message || String(e), latency_ms: Date.now() - start, baseURL };
  }
}

/**
 * 获取脱敏后的当前配置（不返回 key）
 */
function getConfigView() {
  const { baseURL, apiKey, model } = resolveConfig();
  return {
    baseURL,
    model,
    configured: !!apiKey,
    api_key_preview: apiKey ? apiKey.slice(0, 4) + '****' + apiKey.slice(-4) : null,
    source: {
      baseURL: !!db.getSetting('LLM_BASE_URL'),
      apiKey: !!db.getSetting('LLM_API_KEY'),
      model: !!db.getSetting('LLM_MODEL'),
    },
  };
}

/**
 * 更新 LLM 配置（写入 settings 表，下次 getClient() 自动用新值）
 */
function updateConfig(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('invalid patch');
  const map = { baseURL: 'LLM_BASE_URL', apiKey: 'LLM_API_KEY', model: 'LLM_MODEL' };
  for (const [k, v] of Object.entries(patch)) {
    const key = map[k];
    if (!key) continue;
    if (typeof v !== 'string') continue;
    if (v.length === 0) continue; // 留空忽略（不支持删除）
    db.setSetting(key, v);
  }
  client = null;
  clientKey = '';
  logger.info('LLM config updated, client will rebuild on next call');
}

module.exports = {
  isEnabled,
  chat,
  chatStream,
  testConnection,
  getConfigView,
  updateConfig,
  resolveConfig,
};
