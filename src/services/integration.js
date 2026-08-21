'use strict';

/**
 * 对接配置服务：飞书 / 企业微信 / 钉钉 自定义机器人 webhook 推送。
 *
 * 设计：
 *   - 每个渠道 = integrations 表一行（channel / name / enabled / config(JSON)）
 *   - 仅做“出站推送”（提醒 / 日报 / 手动测试），不做消息接收回调
 *   - webhook 凭据存在本地 SQLite（明文，后续可加加密）
 *
 * 支持渠道：
 *   - feishu (飞书)：签名版 webhook（timestamp+sign）或纯 webhook
 *   - wecom (企业微信)：纯 webhook key
 *   - dingtalk (钉钉)：加签 webhook（timestamp+sign）
 */

const crypto = require('crypto');
const db = require('../db');
const logger = require('../logger');

const CHANNELS = {
  feishu: { label: '飞书', needSecret: false, sign: true, signType: 'hmac_sha256_base64' },
  wecom: { label: '企业微信', needSecret: false, sign: false },
  dingtalk: { label: '钉钉', needSecret: true, sign: true, signType: 'hmac_sha256_hex' },
};

function list() {
  return db.list('integrations', () => true).map(row => ({
    id: row.id,
    channel: row.channel,
    name: row.name,
    enabled: !!row.enabled,
    config: safeParse(row.config),
  }));
}

function get(id) {
  const row = db.find('integrations', Number(id));
  if (!row) return null;
  return { id: row.id, channel: row.channel, name: row.name, enabled: !!row.enabled, config: safeParse(row.config) };
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch (_) { return {}; }
}

/**
 * 创建 / 更新一个渠道配置
 * @param {string} channel feishu|wecom|dingtalk
 * @param {{name?,enabled?,webhook?,secret?,app_id?,app_secret?}} cfg
 */
function upsert(channel, cfg = {}) {
  if (!CHANNELS[channel]) throw new Error('未知渠道: ' + channel);
  const existing = db.list('integrations', (r) => r.channel === channel).slice(-1)[0];
  const configObj = {
    webhook: cfg.webhook || (existing && existing.config && existing.config.webhook) || '',
    secret: cfg.secret || (existing && existing.config && existing.config.secret) || '',
  };
  const row = {
    channel,
    name: cfg.name || CHANNELS[channel].label,
    enabled: cfg.enabled != null ? (cfg.enabled ? 1 : 0) : (existing ? existing.enabled : 0),
    config: JSON.stringify(configObj),
    created_at: existing ? existing.created_at : db.nowIso(),
    updated_at: db.nowIso(),
  };
  if (existing) {
    return db.update('integrations', existing.id, { name: row.name, enabled: row.enabled, config: row.config, updated_at: row.updated_at });
  }
  return db.insert('integrations', row);
}

function setEnabled(id, enabled) {
  return db.update('integrations', Number(id), { enabled: enabled ? 1 : 0, updated_at: db.nowIso() });
}

function remove(id) {
  return db.remove('integrations', Number(id));
}

/** 构造带签名的 url（飞书/钉钉需要） */
function signedUrl(channel, webhook, secret) {
  if (channel === 'feishu' && secret) {
    const ts = Math.floor(Date.now() / 1000);
    const stringToSign = `${ts}\n${secret}`;
    const sign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
    return `${webhook}${webhook.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }
  if (channel === 'dingtalk' && secret) {
    const ts = Date.now();
    const stringToSign = `${ts}\n${secret}`;
    const sign = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
    return `${webhook}${webhook.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }
  return webhook;
}

/** 构造各渠道的 payload */
function buildPayload(channel, title, text, opts = {}) {
  const msgType = opts.msgType || 'text';
  if (channel === 'feishu') {
    return { msg_type: 'text', content: { text: `${title}\n${text}` } };
  }
  if (channel === 'wecom') {
    return { msgtype: 'text', text: { content: `${title}\n${text}` } };
  }
  if (channel === 'dingtalk') {
    return { msgtype: 'text', text: { content: `${title}\n${text}` } };
  }
  return { msgtype: 'text', text: { content: `${title}\n${text}` } };
}

/**
 * 推送到指定渠道
 * @returns {{ok:boolean, status?, error?}}
 */
async function push(channel, cfg, title, text, opts = {}) {
  const webhook = (cfg.webhook || '').trim();
  if (!webhook) return { ok: false, error: '未配置 webhook' };
  const url = signedUrl(channel, webhook, cfg.secret);
  const body = buildPayload(channel, title, text, opts);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const raw = await res.text();
    // 飞书/钉钉返回 {"code":0,"msg":"success"} 或 {"errcode":0}
    let code = 0, msg = '';
    try { const j = JSON.parse(raw); code = j.code ?? j.errcode ?? 0; msg = j.msg ?? j.errmsg ?? ''; } catch (_) {}
    if (res.ok && (code === 0 || code === 200)) {
      return { ok: true, status: res.status };
    }
    return { ok: false, status: res.status, error: `渠道返回错误: ${msg || raw}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 测试推送（用默认标题） */
async function testPush(id) {
  const item = get(id);
  if (!item) return { ok: false, error: '配置不存在' };
  const r = await push(item.channel, item.config, '✅ WorkBuddy 测试', `来自 WorkBuddy 的对接测试消息\n渠道：${CHANNELS[item.channel].label}`);
  return r;
}

/** 推送到所有已启用渠道 */
async function broadcast(title, text, opts = {}) {
  const items = list().filter(i => i.enabled && i.config.webhook);
  const results = [];
  for (const it of items) {
    results.push({ id: it.id, channel: it.channel, ...(await push(it.channel, it.config, title, text, opts)) });
  }
  return results;
}

module.exports = {
  CHANNELS,
  list, get, upsert, setEnabled, remove,
  push, testPush, broadcast, signedUrl,
};
