'use strict';

/**
 * MCP OAuth（简化版 authorization code + PKCE）：
 *   - 生成授权 URL，用户在浏览器完成授权
 *   - 本地回调交换 token，存入用户 settings
 *   - accessToken() 自动刷新过期 token
 */

const crypto = require('crypto');
const db = require('../db');
const logger = require('../logger');

const pending = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function tokenKey(name) {
  return `MCP_OAUTH_${name}`;
}

function getTokens(userId, name) {
  try {
    const raw = db.getSetting(tokenKey(name), userId);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function saveTokens(userId, name, tokens) {
  db.setSetting(tokenKey(name), JSON.stringify(tokens || {}), userId);
}

function clearTokens(userId, name) {
  db.setSetting(tokenKey(name), '', userId);
}

function cleanup() {
  const now = Date.now();
  for (const [k, v] of pending.entries()) {
    if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  }
}

function start(userId, server) {
  cleanup();
  if (!server.authorizationUrl || !server.clientId) {
    throw new Error('OAuth 需要 authorizationUrl 与 clientId');
  }
  const state = b64url(crypto.randomBytes(16));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const redirectUri = server.redirectUri || 'http://localhost:3000/api/mcp/oauth/callback';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: server.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (server.scopes) {
    params.set('scope', Array.isArray(server.scopes) ? server.scopes.join(' ') : String(server.scopes));
  }
  pending.set(state, { userId: Number(userId), name: server.name, verifier, redirectUri, createdAt: Date.now() });
  const sep = server.authorizationUrl.includes('?') ? '&' : '?';
  return { url: server.authorizationUrl + sep + params.toString(), state };
}

async function exchangeToken(server, body) {
  const res = await fetch(server.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OAuth token ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  data.expires_at = Date.now() + ((data.expires_in || 3600) * 1000) - 60_000;
  return data;
}

async function handleCallback(code, state) {
  cleanup();
  const p = pending.get(state);
  if (!p) throw new Error('OAuth state 无效或已过期');
  pending.delete(state);
  const mcp = require('./mcp');
  const server = mcp.listConfigs(p.userId).find((s) => s.name === p.name);
  if (!server) throw new Error('MCP server 不存在');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: p.redirectUri,
    client_id: server.clientId,
    code_verifier: p.verifier,
  });
  if (server.clientSecret) body.set('client_secret', server.clientSecret);
  const tokens = await exchangeToken(server, body);
  saveTokens(p.userId, p.name, tokens);
  logger.info(`MCP OAuth authorized: ${p.name}`);
  return { ok: true, name: p.name };
}

async function accessToken(userId, server) {
  const tokens = getTokens(userId, server.name);
  if (!tokens || !tokens.access_token) return null;
  if (!tokens.expires_at || Date.now() < tokens.expires_at) return tokens.access_token;
  if (!tokens.refresh_token || !server.tokenUrl) return tokens.access_token;
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: server.clientId,
    });
    if (server.clientSecret) body.set('client_secret', server.clientSecret);
    const next = await exchangeToken(server, body);
    if (!next.refresh_token) next.refresh_token = tokens.refresh_token;
    saveTokens(userId, server.name, next);
    return next.access_token;
  } catch (e) {
    logger.warn('MCP OAuth refresh failed:', e.message);
    return tokens.access_token;
  }
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * MCP OAuth 自动发现：
 *   - protected-resource metadata -> authorization server metadata
 *   - 提供 registration_endpoint 时执行动态客户端注册
 */
async function discover(userId, name) {
  const mcp = require('./mcp');
  const conf = mcp.listConfigs(userId).find((s) => s.name === name);
  if (!conf) throw new Error('MCP server 不存在');
  if (conf.transport !== 'http') throw new Error('仅 HTTP MCP 支持 OAuth 自动发现');
  const base = new URL(conf.url);
  const origin = base.origin;
  const redirectUri = conf.redirectUri || 'http://localhost:3000/api/mcp/oauth/callback';

  let protectedMeta = null;
  const protectedCandidates = [
    new URL('/.well-known/oauth-protected-resource', origin).toString(),
    conf.url.replace(/\/$/, '') + '/.well-known/oauth-protected-resource',
  ];
  for (const u of protectedCandidates) {
    try { protectedMeta = await fetchJson(u); break; } catch (_) {}
  }
  const authServer = (protectedMeta && protectedMeta.authorization_servers && protectedMeta.authorization_servers[0]) || origin;

  let meta = null;
  const authCandidates = [
    new URL('/.well-known/oauth-authorization-server', authServer).toString(),
    new URL('/.well-known/openid-configuration', authServer).toString(),
  ];
  for (const u of authCandidates) {
    try { meta = await fetchJson(u); break; } catch (_) {}
  }
  if (!meta || !meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error('未发现 OAuth authorization/token endpoint');
  }

  let clientId = conf.clientId || '';
  let clientSecret = conf.clientSecret || '';
  if (!clientId && meta.registration_endpoint) {
    const reg = await fetchJson(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'WorkBuddy',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    clientId = reg.client_id || '';
    clientSecret = reg.client_secret || '';
  }

  const updated = {
    ...conf,
    auth: 'oauth',
    authorizationUrl: meta.authorization_endpoint,
    tokenUrl: meta.token_endpoint,
    clientId,
    clientSecret,
    scopes: conf.scopes || (Array.isArray(meta.scopes_supported) ? meta.scopes_supported.join(' ') : ''),
    redirectUri,
  };
  mcp.upsertServer(userId, updated);
  return {
    ok: true,
    authorization_server: authServer,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    registration_endpoint: meta.registration_endpoint || null,
    client_id: clientId,
  };
}

module.exports = { start, handleCallback, accessToken, getTokens, saveTokens, clearTokens, discover };
