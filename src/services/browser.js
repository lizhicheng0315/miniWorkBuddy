'use strict';

/**
 * Browser Use 服务（仿 Codex browser use）：
 *   - 用系统 Edge / Chrome / Chromium 的 remote debugging 协议（CDP）驱动真实浏览器
 *   - 零额外依赖：Node >= 22 提供内置 WebSocket，服务只做 CDP 客户端
 *   - 支持开标签、导航、页面快照、截图、点击、输入、按键、滚动、关闭
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const config = require('../config');
const logger = require('../logger');
const media = require('./media');

const state = {
  process: null,
  port: null,
  executable: null,
  sessions: new Map(),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findExecutable() {
  if (config.browser.executable && fs.existsSync(config.browser.executable)) {
    return { name: 'custom', path: config.browser.executable };
  }
  const candidates = [
    { name: 'Edge', path: path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Edge', path: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Chrome', path: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Chrome', path: path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Chromium', path: process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe') : '' },
    { name: 'Brave', path: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
  ].filter((c) => c.path);
  return candidates.find((c) => fs.existsSync(c.path)) || null;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function alive(port) {
  try {
    await fetchJson(`http://127.0.0.1:${port}/json/version`);
    return true;
  } catch (_) {
    return false;
  }
}

async function start(opts = {}) {
  if (state.process && state.port && await alive(state.port)) {
    if (opts.url) { try { await open(opts.url); } catch (_) {} }
    return status();
  }
  const exe = findExecutable();
  if (!exe) {
    return { ok: false, error: '未找到 Edge/Chrome/Chromium。请安装浏览器，或在 .env 设置 BROWSER_EXECUTABLE 指向浏览器程序。' };
  }
  state.executable = exe;
  state.port = await findFreePort();
  const profile = path.join(config.dataDir, 'browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${state.port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--window-size=1280,800',
  ];
  if (config.browser.headless) args.push('--headless=new', '--disable-gpu');

  logger.info('browser launching:', exe.path);
  state.process = spawn(exe.path, args, {
    windowsHide: !!config.browser.headless,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.process.stderr.on('data', () => {});
  state.process.on('error', (e) => logger.warn('browser process error:', e.message));
  state.process.on('exit', () => {
    state.process = null;
    state.port = null;
    closeSessions();
  });

  for (let i = 0; i < 40; i++) {
    try {
      await fetchJson(`http://127.0.0.1:${state.port}/json/version`);
      if (opts.url) {
        try { await open(opts.url); } catch (e) { logger.warn('open initial url failed:', e.message); }
      }
      return status();
    } catch (_) {
      await sleep(250);
    }
  }
  try { state.process.kill(); } catch (_) {}
  state.process = null;
  state.port = null;
  return { ok: false, error: '浏览器启动超时。请检查 BROWSER_EXECUTABLE 或换个浏览器。' };
}

async function listTabs() {
  if (!state.port) return [];
  try {
    const list = await fetchJson(`http://127.0.0.1:${state.port}/json/list`);
    return (list || [])
      .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      .map((t) => ({ id: t.id, wsUrl: t.webSocketDebuggerUrl, title: t.title || '', url: t.url || '' }));
  } catch (_) {
    return [];
  }
}

async function open(url = 'about:blank') {
  if (!state.port || !(await alive(state.port))) {
    const r = await start({ url });
    if (!r.ok) return r;
  }
  const targetUrl = `http://127.0.0.1:${state.port}/json/new?${encodeURIComponent(url)}`;
  let target;
  try {
    target = await fetchJson(targetUrl, { method: 'PUT' });
  } catch (_) {
    target = await fetchJson(targetUrl, { method: 'GET' });
  }
  if (!target || !target.webSocketDebuggerUrl) return { ok: false, error: '浏览器没有返回新标签' };
  return {
    ok: true,
    tab: { id: target.id, wsUrl: target.webSocketDebuggerUrl, title: '', url },
    tabs: await listTabs(),
  };
}

function attach(tabId, wsUrl) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') {
      return reject(new Error('当前 Node 版本不支持内置 WebSocket，浏览器模块需要 Node >= 22'));
    }
    const existing = state.sessions.get(tabId);
    if (existing && existing.ws.readyState === 1) return resolve(existing);
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const session = { ws, pending, nextId: 1, tabId };
    ws.onopen = () => {
      state.sessions.set(tabId, session);
      resolve(session);
    };
    ws.onerror = () => reject(new Error('无法连接页面调试通道（CDP WebSocket）'));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (!msg || !msg.id || !pending.has(msg.id)) return;
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else waiter.resolve(msg.result || {});
    };
    ws.onclose = () => {
      pending.forEach((p) => p.reject(new Error('页面调试通道已关闭')));
      state.sessions.delete(tabId);
    };
  });
}

async function sendCdp(session, method, params = {}) {
  if (!session || session.ws.readyState !== 1) throw new Error('页面通道未连接');
  const id = session.nextId++;
  return new Promise((resolve, reject) => {
    session.pending.set(id, { resolve, reject });
    session.ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (session.pending.has(id)) {
        session.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }
    }, 15_000);
  });
}

async function sessionFor(tabId) {
  let tabs = await listTabs();
  if (!tabs.length) return { tab: null, session: null };
  let tab = tabId ? tabs.find((t) => t.id === String(tabId)) : null;
  if (!tab) tab = tabs[0];
  const session = await attach(tab.id, tab.wsUrl);
  return { tab, session };
}

async function evaluate(tabId, expression) {
  const { session } = await sessionFor(tabId);
  if (!session) throw new Error('没有可用标签页');
  const r = await sendCdp(session, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本执行失败');
  return r.result && r.result.value;
}

async function navigate(tabId, url) {
  const { tab, session } = await sessionFor(tabId);
  if (!session) throw new Error('没有可用标签页');
  await sendCdp(session, 'Page.navigate', { url: String(url) });
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    try {
      const r = await sendCdp(session, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r.result && r.result.value === 'complete') break;
    } catch (_) { break; }
  }
  return snapshot(tabId);
}

const SNAPSHOT_EXPR = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  const els = [];
  Array.from(document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[tabindex],[contenteditable]')).forEach((el) => {
    if (els.length >= 80 || !visible(el)) return;
    const r = el.getBoundingClientRect();
    els.push({
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      text: clean(el.innerText || el.value || el.getAttribute('aria-label') || el.title || ''),
      href: el.href || '',
      id: el.id || '',
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    });
  });
  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    viewport: { w: innerWidth, h: innerHeight },
    elements: els,
    text: (document.body.innerText || '').slice(0, 6000)
  };
})()`;

async function snapshot(tabId) {
  const value = await evaluate(tabId, SNAPSHOT_EXPR);
  if (!value || typeof value !== 'object') return { ok: false, error: '快照失败' };
  const lines = [
    `页面：${value.title || ''}`,
    `地址：${value.url || ''}`,
    `状态：${value.readyState || ''} · 视口 ${value.viewport.w}×${value.viewport.h}`,
  ];
  if (Array.isArray(value.elements) && value.elements.length) {
    lines.push('可交互元素：');
    value.elements.slice(0, 60).forEach((e, i) => {
      lines.push(`${i + 1}. <${e.tag}${e.type ? ' type=' + e.type : ''}> ${e.text || '(无文本)'}${e.href ? ' → ' + e.href : ''} [${e.x},${e.y}]`);
    });
  }
  if (value.text) {
    lines.push('正文：');
    lines.push(value.text.replace(/\n{3,}/g, '\n\n').slice(0, 3000));
  }
  return {
    ok: true,
    title: value.title,
    url: value.url,
    readyState: value.readyState,
    viewport: value.viewport,
    elements: value.elements,
    text: value.text,
    render: lines.join('\n'),
  };
}

async function screenshot(tabId) {
  const { session } = await sessionFor(tabId);
  if (!session) return { ok: false, error: '没有可用标签页' };
  const r = await sendCdp(session, 'Page.captureScreenshot', { format: 'png', fromSurface: true });
  if (!r.data) return { ok: false, error: '截图失败' };
  const file = media.newFile('browser');
  fs.writeFileSync(file.full, Buffer.from(r.data, 'base64'));
  return {
    ok: true,
    name: file.name,
    path: file.full,
    url: media.urlFor(file.name),
    bytes: Math.round((r.data.length * 3) / 4),
  };
}

function centerExpr(selector, text, x, y) {
  const sel = JSON.stringify(selector || '');
  const txt = JSON.stringify(text || '');
  return `(() => {
    const all = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[tabindex],[contenteditable]'));
    let el = null;
    if (${sel}) el = document.querySelector(${sel});
    if (!el && ${txt}) {
      el = all.find((e) => (e.innerText || e.value || '').trim().includes(${txt})) || null;
    }
    if (!el) {
      const cx = Number(${JSON.stringify(x || 0)});
      const cy = Number(${JSON.stringify(y || 0)});
      if (cx || cy) return { x: cx, y: cy, manual: true };
      return null;
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: (el.innerText || el.value || '').trim().slice(0, 80) };
  })()`;
}

async function click(tabId, opts = {}) {
  const { session } = await sessionFor(tabId);
  if (!session) return { ok: false, error: '没有可用标签页' };
  const point = await evaluate(
    tabId,
    centerExpr(opts.selector || '', opts.text || '', opts.x || 0, opts.y || 0)
  );
  if (!point) return { ok: false, error: '找不到要点击的元素；请提供 selector / text / x / y' };
  await sendCdp(session, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
  });
  await sendCdp(session, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
  });
  return { ok: true, point };
}

async function type(tabId, opts = {}) {
  const { session } = await sessionFor(tabId);
  if (!session) return { ok: false, error: '没有可用标签页' };
  const text = String(opts.text || '');
  if (opts.selector) {
    const sel = JSON.stringify(opts.selector);
    const ok = await evaluate(tabId, `(() => {
      const el = document.querySelector(${sel});
      if (!el) return false;
      el.focus();
      if (el.value !== undefined) { el.value = ''; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }
      return true;
    })()`);
    if (!ok) return { ok: false, error: `找不到输入框：${opts.selector}` };
  }
  if (text) await sendCdp(session, 'Input.insertText', { text });
  if (opts.enter) {
    await sendCdp(session, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sendCdp(session, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  return { ok: true, chars: text.length, enter: !!opts.enter };
}

const BROWSER_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Space: { key: ' ', code: 'Space', vk: 32 },
};
for (let i = 1; i <= 24; i++) {
  BROWSER_KEYS['F' + i] = { key: 'F' + i, code: 'F' + i, vk: 111 + i };
}

async function key(tabId, name) {
  const { session } = await sessionFor(tabId);
  if (!session) return { ok: false, error: '没有可用标签页' };
  const k = BROWSER_KEYS[name] || BROWSER_KEYS[String(name || '').toLowerCase()];
  if (!k) return { ok: false, error: `未知按键 ${name}` };
  await sendCdp(session, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk,
  });
  await sendCdp(session, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk,
  });
  return { ok: true, key: k.key };
}

async function scroll(tabId, dx, dy) {
  const pos = await evaluate(tabId, `(() => { const bx = window.scrollX, by = window.scrollY; window.scrollBy(${Number(dx) || 0}, ${Number(dy) || 0}); return { beforeX: bx, beforeY: by, x: window.scrollX, y: window.scrollY }; })()`);
  return { ok: true, ...pos };
}

async function closeTab(tabId) {
  if (!state.port) return { ok: false, error: '浏览器未启动' };
  const tab = String(tabId || '');
  const url = `http://127.0.0.1:${state.port}/json/close/${tab}`;
  try {
    await fetchJson(url, { method: 'GET' });
  } catch (_) {
    try { await fetchJson(url, { method: 'PUT' }); } catch (_) {}
  }
  state.sessions.delete(tab);
  return { ok: true, tabs: await listTabs() };
}

function closeSessions() {
  for (const s of state.sessions.values()) {
    try { s.ws.close(); } catch (_) {}
  }
  state.sessions.clear();
}

async function stop() {
  if (state.process) {
    try { state.process.kill(); } catch (_) {}
    await sleep(600);
  }
  closeSessions();
  const wasRunning = !!state.process || !!state.port;
  state.process = null;
  state.port = null;
  return { ok: true, stopped: wasRunning };
}

async function status() {
  let running = false;
  let tabs = [];
  if (state.port) {
    try {
      await fetchJson(`http://127.0.0.1:${state.port}/json/version`);
      running = true;
      tabs = await listTabs();
    } catch (_) {
      state.process = null;
      state.port = null;
    }
  }
  return {
    ok: true,
    running,
    port: state.port,
    executable: (state.executable || findExecutable()) || null,
    headless: !!config.browser.headless,
    tabs,
  };
}

module.exports = {
  start,
  stop,
  status,
  open,
  listTabs,
  navigate,
  snapshot,
  screenshot,
  click,
  type,
  key,
  scroll,
  closeTab,
  evaluate,
  alive,
};
