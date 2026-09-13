'use strict';

/**
 * Remote hosts / handoff（Codex Remote 的本地等价）：
 *   - 配置远程 WorkBuddy 实例（baseUrl + token）
 *   - 远程执行 Agent、列出远程会话
 *   - 把本地会话消息 handoff 到远程实例
 */

const db = require('../db');
const chatstore = require('./chatstore');

function listHosts(userId) {
  try {
    const raw = db.getSetting('REMOTE_HOSTS', userId);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function saveHosts(userId, list) {
  db.setSetting('REMOTE_HOSTS', JSON.stringify(list || []), userId);
}

function getHost(userId, name) {
  return listHosts(userId).find((h) => h.name === name) || null;
}

function upsertHost(userId, input = {}) {
  const name = String(input.name || '').trim();
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/$/, '');
  if (!name || !baseUrl) throw new Error('name / baseUrl 必填');
  const host = { name, baseUrl, token: String(input.token || '') };
  const list = listHosts(userId);
  const idx = list.findIndex((h) => h.name === name);
  if (idx >= 0) list[idx] = host;
  else list.push(host);
  saveHosts(userId, list);
  return host;
}

function removeHost(userId, name) {
  saveHosts(userId, listHosts(userId).filter((h) => h.name !== name));
  return true;
}

function publicHosts(userId) {
  return listHosts(userId).map((h) => ({ name: h.name, baseUrl: h.baseUrl, has_token: !!h.token }));
}

async function request(host, path, opts = {}) {
  const res = await fetch(host.baseUrl + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(host.token ? { Authorization: 'Bearer ' + host.token } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!res.ok) throw new Error(`远程 ${res.status}: ${(data && (data.error || data.raw)) || text}`);
  return data;
}

async function testHost(userId, name) {
  const host = getHost(userId, name);
  if (!host) throw new Error('远程主机不存在');
  const data = await request(host, '/api/health');
  return { ok: true, host: name, health: data };
}

async function runRemote(userId, name, prompt, opts = {}) {
  const host = getHost(userId, name);
  if (!host) throw new Error('远程主机不存在');
  const data = await request(host, '/api/agent/run', {
    method: 'POST',
    body: {
      message: prompt,
      approvalMode: opts.approvalMode || 'auto',
      planMode: !!opts.planMode,
      model: opts.model || undefined,
    },
  });
  return data;
}

async function listRemoteSessions(userId, name) {
  const host = getHost(userId, name);
  if (!host) throw new Error('远程主机不存在');
  return request(host, '/api/agent/sessions');
}

async function handoff(userId, name, sessionId) {
  const host = getHost(userId, name);
  if (!host) throw new Error('远程主机不存在');
  const local = chatstore.getSession(userId, sessionId);
  if (!local) throw new Error('本地会话不存在');
  const remoteSession = await request(host, '/api/agent/sessions', { method: 'POST', body: { title: local.title || 'Handoff' } });
  const messages = chatstore.getMessages(userId, sessionId) || [];
  for (const m of messages) {
    await request(host, `/api/agent/sessions/${remoteSession.id}/messages`, {
      method: 'POST',
      body: { role: m.role, content: m.content, intent: m.intent || '' },
    });
  }
  return { ok: true, remoteSessionId: remoteSession.id, messages: messages.length };
}

module.exports = { listHosts, upsertHost, removeHost, getHost, publicHosts, testHost, runRemote, listRemoteSessions, handoff };
