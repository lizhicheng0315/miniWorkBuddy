'use strict';

const path = require('path');
require('dotenv').config();

const root = path.resolve(__dirname, '..');

function envStr(name, fallback) {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

const dataDir = path.resolve(root, envStr('DATA_DIR', './data'));

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  port: parseInt(envStr('PORT', '3000'), 10),
  dataDir,
  tz: envStr('TZ', 'Asia/Shanghai'),
  llm: {
    baseURL: envStr('LLM_BASE_URL', 'https://api.deepseek.com/v1'),
    apiKey: envStr('LLM_API_KEY', ''),
    model: envStr('LLM_MODEL', 'deepseek-chat'),
    timeoutMs: envInt('LLM_TIMEOUT_MS', 30000),
    maxRetries: envInt('LLM_MAX_RETRIES', 3),
  },
  notify: {
    sound: envBool('NOTIFY_SOUND', true),
  },
  auth: {
    bootstrapUser: envStr('BOOTSTRAP_USER', 'admin'),
    bootstrapPassword: envStr('BOOTSTRAP_PASSWORD', ''),
    enabled: envBool('AUTH_ENABLED', true),
  },
  log: {
    toFile: envBool('LOG_TO_FILE', true),
  },
  rateLimit: {
    loginPer15min: envInt('RATELIMIT_LOGIN', 20),
    apiPerMin: envInt('RATELIMIT_API', 300),
    aiPerMin: envInt('RATELIMIT_AI', 30),
  },
  tls: {
    enabled: envBool('TLS_ENABLED', false),
    key: envStr('TLS_KEY', './certs/server.key'),
    cert: envStr('TLS_CERT', './certs/server.crt'),
  },
  root,
};

module.exports = config;
