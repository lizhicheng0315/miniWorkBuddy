'use strict';

/**
 * MCP（Model Context Protocol）客户端管理器（仿 Codex MCP）：
 *   - 支持 stdio server 与 streamable HTTP server
 *   - 保存/读取每个用户的 MCP server 配置
 *   - 提供 tools/list 与 tools/call，把 MCP 工具接入 Agent
 */

const { spawn } = require('child_process');
const logger = require('../logger');
const db = require('../db');

const PROTOCOL_VERSION = '2024-11-05';
const connections = new Map(); // `${userId}:${name}` -> connection

function key(userId, name) {
  return `${Number(userId)}:${name}`;
}

function listConfigs(userId) {
  try {
    const raw = db.getSetting('MCP_SERVERS', userId);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function saveConfigs(userId, list) {
  db.setSetting('MCP_SERVERS', JSON.stringify(list || []), userId);
}

function validate(server) {
  if (!server || !server.name) throw new Error('MCP server 需要 name');
  if (!/^[a-zA-Z0-9_.-]+$/.test(server.name)) throw new Error('MCP name 只允许字母/数字/._-');
  if (server.transport === 'http') {
    if (!server.url) throw new Error('HTTP MCP server 需要 url');
    return {
      name: server.name,
      transport: 'http',
      url: String(server.url),
      auth: server.auth === 'oauth' ? 'oauth' : 'none',
      headers: server.headers && typeof server.headers === 'object' ? server.headers : {},
      authorizationUrl: server.authorizationUrl || '',
      tokenUrl: server.tokenUrl || '',
      clientId: server.clientId || '',
      clientSecret: server.clientSecret || '',
      scopes: server.scopes || '',
      redirectUri: server.redirectUri || '',
    };
  }
  if (!server.command) throw new Error('stdio MCP server 需要 command');
  return {
    name: server.name,
    transport: 'stdio',
    command: String(server.command),
    args: Array.isArray(server.args) ? server.args.map(String) : [],
    env: server.env && typeof server.env === 'object' ? server.env : {},
  };
}

function upsertServer(userId, input) {
  const server = validate(input);
  const list = listConfigs(userId);
  const idx = list.findIndex((s) => s.name === server.name);
  if (idx >= 0) list[idx] = server;
  else list.push(server);
  saveConfigs(userId, list);
  disconnect(userId, server.name);
  return server;
}

function removeServer(userId, name) {
  disconnect(userId, name);
  const list = listConfigs(userId).filter((s) => s.name !== name);
  saveConfigs(userId, list);
  return true;
}

function disconnect(userId, name) {
  const k = key(userId, name);
  const conn = connections.get(k);
  if (!conn) return false;
  try {
    if (conn.proc) conn.proc.kill();
  } catch (_) {}
  for (const pending of conn.pending.values()) pending.reject(new Error('MCP connection closed'));
  conn.pending.clear();
  connections.delete(k);
  return true;
}

function disconnectAll() {
  for (const k of [...connections.keys()]) {
    const idx = k.indexOf(':');
    disconnect(k.slice(0, idx), k.slice(idx + 1));
  }
}

async function httpRequest(conn, method, params = {}) {
  const id = conn.nextId++;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(conn.headers || {}),
  };
  if (conn.auth === 'oauth') {
    try {
      const token = await require('./mcpOAuth').accessToken(conn.userId, conn);
      if (token) headers.Authorization = 'Bearer ' + token;
    } catch (_) {}
  }
  const res = await fetch(conn.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    const messages = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { messages.push(JSON.parse(line.slice(5).trim())); } catch (_) {}
    }
    const msg = messages.find((m) => m.id === id) || messages.find((m) => m.id !== undefined);
    if (!msg) throw new Error('MCP HTTP 没有返回 JSON-RPC 响应');
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result || {};
  }
  const msg = await res.json();
  if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
  return msg.result || {};
}

function request(conn, method, params = {}) {
  if (conn.type === 'http') return httpRequest(conn, method, params);
  return new Promise((resolve, reject) => {
    const id = conn.nextId++;
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`MCP ${method} 超时`));
    }, 30_000);
    conn.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      conn.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch (e) {
      conn.pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

async function connect(userId, server) {
  const conf = validate(server);
  const k = key(userId, conf.name);
  const existing = connections.get(k);
  if (existing) return existing;

  const conn = { ...conf, nextId: 1, pending: new Map(), tools: null };
  conn.userId = Number(userId);
  if (conf.transport === 'http') {
    conn.type = 'http';
  } else {
    conn.type = 'stdio';
    const proc = spawn(conf.command, conf.args || [], {
      env: { ...process.env, ...(conf.env || {}) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    conn.proc = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id !== undefined && conn.pending.has(msg.id)) {
          const pending = conn.pending.get(msg.id);
          conn.pending.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else pending.resolve(msg.result || {});
        }
      }
    });
    proc.stderr.on('data', (d) => logger.warn(`[mcp:${conf.name}] ${String(d).trim().slice(0, 300)}`));
    proc.on('error', (e) => {
      for (const pending of conn.pending.values()) pending.reject(e);
      conn.pending.clear();
      connections.delete(k);
    });
    proc.on('exit', () => {
      for (const pending of conn.pending.values()) pending.reject(new Error('MCP process exited'));
      conn.pending.clear();
      connections.delete(k);
    });
  }

  connections.set(k, conn);
  try {
    await request(conn, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'workbuddy', version: '0.1.0' },
    });
    if (conn.type === 'stdio') {
      try {
        conn.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
      } catch (_) {}
    }
    return conn;
  } catch (e) {
    disconnect(userId, conf.name);
    throw e;
  }
}

async function ensure(userId, name) {
  const conf = listConfigs(userId).find((s) => s.name === name);
  if (!conf) throw new Error(`MCP server 不存在：${name}`);
  return connect(userId, conf);
}

async function listTools(userId, name) {
  const conn = await ensure(userId, name);
  const r = await request(conn, 'tools/list', {});
  conn.tools = Array.isArray(r.tools) ? r.tools : [];
  return conn.tools;
}

async function callTool(userId, name, tool, args = {}) {
  const conn = await ensure(userId, name);
  return request(conn, 'tools/call', { name: tool, arguments: args || {} });
}

function status(userId) {
  return listConfigs(userId).map((s) => {
    const conn = connections.get(key(userId, s.name));
    return { ...s, connected: !!conn, toolCount: conn && conn.tools ? conn.tools.length : null };
  });
}

module.exports = {
  listConfigs,
  saveConfigs,
  upsertServer,
  removeServer,
  connect,
  disconnect,
  disconnectAll,
  listTools,
  callTool,
  status,
};
