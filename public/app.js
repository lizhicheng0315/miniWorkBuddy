/* WorkBuddy 前端 v6.0 (calendar + todo filter/sort + safe $ + chat + LLM config) */
console.log('[WorkBuddy] app.js?v=6 loaded at', new Date().toISOString());

/** 安全 DOM 代理：元素不存在时静默 no-op，永不抛错 */
function _safeProxy() {
  const noop = () => {};
  const handler = {
    get: (t, p) => {
      if (p === 'then') return undefined; // not a thenable
      if (p === 'textContent' || p === 'innerHTML' || p === 'value' || p === 'placeholder' || p === 'disabled' || p === 'src' || p === 'href') return '';
      if (p === 'classList') return { add: noop, remove: noop, toggle: noop, contains: () => false };
      if (p === 'style') return new Proxy({}, { set: () => true, get: () => '' });
      if (p === 'dataset') return new Proxy({}, { set: () => true, get: () => '' });
      if (p === 'children' || p === 'childNodes') return [];
      if (p === 'parentNode' || p === 'parentElement' || p === 'firstChild' || p === 'lastChild') return null;
      if (p === 'addEventListener' || p === 'removeEventListener' || p === 'appendChild' || p === 'removeChild' ||
          p === 'insertBefore' || p === 'setAttribute' || p === 'removeAttribute' || p === 'focus' || p === 'click' ||
          p === 'reset' || p === 'submit' || p === 'play' || p === 'pause' || p === 'preventDefault' || p === 'stopPropagation') return noop;
      return undefined;
    },
    set: () => true,
  };
  return new Proxy({}, handler);
}
const $ = (sel) => document.querySelector(sel) || _safeProxy();

/** 显式安全绑定：元素不存在时打印警告但继续 */
function bind(elOrSel, event, handler) {
  const el = typeof elOrSel === 'string' ? $(elOrSel) : elOrSel;
  if (!el || typeof el.addEventListener !== 'function') { console.warn('[WorkBuddy] bind skipped, element not found:', elOrSel); return; }
  el.addEventListener(event, handler);
}
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const fmtDateTime = (s) => (s ? new Date(s).toLocaleString() : '');
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString() : '');

// ===== Token 管理 =====
const TOKEN_KEY = 'workbuddy_token';
const USER_KEY = 'workbuddy_user';
function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } }
function setUser(u) { if (u) localStorage.setItem(USER_KEY, JSON.stringify(u)); else localStorage.removeItem(USER_KEY); }

// ===== API（含 token） =====
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) {
    // 登录态失效，回退到登录页
    setToken(''); setUser(null);
    showLogin();
    throw new Error('未登录或登录已过期');
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error('HTTP ' + res.status + ': ' + t);
  }
  return res.json();
}

// 流式 API：EventSource 不支持 POST，用 fetch + ReadableStream
async function apiStream(path, body, onDelta) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('HTTP ' + res.status + ': ' + t);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 消息以 \n\n 分隔
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = raw.split('\n');
      let event = 'message', data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        const payload = JSON.parse(data);
        onDelta(event, payload);
        if (event === 'done' || event === 'error') return event;
      } catch (_) { /* ignore */ }
    }
  }
  return 'done';
}

// ===== 登录 =====
function showLogin() {
  $('#loginOverlay').classList.remove('hidden');
  $('#loginForm').dataset.mode = 'login';
  $('#loginForm').querySelector('h2').textContent = '🧭 WorkBuddy';
  $('#loginForm').querySelector('p.muted').textContent = '请登录以使用你的本地助手';
  $('#loginForm').querySelector('button[type=submit]').textContent = '登录';
  $('#userInfo').textContent = '';
  document.querySelector('main').style.display = 'none';
}
function hideLogin() {
  $('#loginOverlay').classList.add('hidden');
  document.querySelector('main').style.display = '';
  const u = getUser();
  if (u) $('#userInfo').textContent = '👤 ' + u.username;
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const username = fd.get('username');
  const password = fd.get('password');
  $('#loginErr').textContent = '';
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) {
      const t = await r.json().catch(() => ({}));
      $('#loginErr').textContent = t.error || '登录失败';
      return;
    }
    const data = await r.json();
    setToken(data.token);
    setUser(data.user);
    hideLogin();
    loadTodos();
    refreshAiStatus();
    refreshBackupStats();
  } catch (err) {
    $('#loginErr').textContent = err.message;
  }
});

$('#btnLogout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  setToken(''); setUser(null);
  showLogin();
});

// ===== Tab 切换 =====
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.remove('active'));
    $$('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $('#panel-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'todos') loadTodos();
    if (btn.dataset.tab === 'schedule') loadEvents();
    if (btn.dataset.tab === 'reminders') loadReminders();
    if (btn.dataset.tab === 'ai') refreshAiStatus();
  });
});

function showForm(id) { $('#' + id).classList.remove('hidden'); }

// ===== 待办（带筛选 + 排序 + 优先级颜色）=====
let todoFilter = 'all';
let todoSort = 'priority';
let todoAllCache = [];

async function loadTodos() {
  todoAllCache = await api('/api/todos');
  renderTodos();
}

function renderTodos() {
  const root = $('#todoList');
  root.innerHTML = '';
  // 计数
  const cnt = { all: todoAllCache.length, open: 0, p1: 0, p2: 0, p3: 0, done: 0 };
  for (const t of todoAllCache) {
    if (t.status === 'done') cnt.done++;
    else cnt.open++;
    if (t.priority === 1) cnt.p1++;
    else if (t.priority === 2) cnt.p2++;
    else if (t.priority === 3) cnt.p3++;
  }
  for (const k of Object.keys(cnt)) {
    const el = $('#cnt' + k.charAt(0).toUpperCase() + k.slice(1));
    if (el) el.textContent = cnt[k];
  }
  // 筛选
  let list = todoAllCache.slice();
  if (todoFilter === 'open') list = list.filter(t => t.status !== 'done');
  else if (todoFilter === 'done') list = list.filter(t => t.status === 'done');
  else if (todoFilter === 'p1' || todoFilter === 'p2' || todoFilter === 'p3') {
    const p = parseInt(todoFilter.slice(1), 10);
    list = list.filter(t => t.priority === p && t.status !== 'done');
  }
  // 排序
  if (todoSort === 'priority') {
    list.sort((a, b) => {
      if (a.status === 'done' && b.status !== 'done') return 1;
      if (a.status !== 'done' && b.status === 'done') return -1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(b.created_at) - new Date(a.created_at);
    });
  } else if (todoSort === 'due') {
    list.sort((a, b) => {
      if (!a.due_at && !b.due_at) return 0;
      if (!a.due_at) return 1;
      if (!b.due_at) return -1;
      return new Date(a.due_at) - new Date(b.due_at);
    });
  } else {
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  // 渲染
  if (!list.length) { root.innerHTML = '<div class="muted">没有匹配的待办。</div>'; return; }
  for (const t of list) {
    const el = document.createElement('div');
    const overdue = t.due_at && t.status !== 'done' && new Date(t.due_at) < new Date();
    el.className = 'item p' + (t.priority || 2) + (t.status === 'done' ? ' done' : '') + (overdue ? ' overdue' : '');
    const due = t.due_at ? new Date(t.due_at) : null;
    const dueText = due ? `截止 ${due.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
    el.innerHTML = `
      <input type="checkbox" ${t.status === 'done' ? 'checked' : ''} data-id="${t.id}" class="toggle" />
      <div class="body">
        <div class="title">${escapeHtml(t.title)}</div>
        <div class="meta">
          <span class="badge p${t.priority}">${['无','🔴 高','🟡 中','🔵 低'][t.priority] || '🟡 中'}</span>
          ${t.category ? `<span class="badge">${escapeHtml(t.category)}</span>` : ''}
          ${dueText ? `<span class="due-marker">${dueText}${overdue ? ' ⚠️已过期' : ''}</span>` : ''}
          ${t.notes ? `<span>· ${escapeHtml(t.notes)}</span>` : ''}
        </div>
      </div>
      <div class="ops"><button data-id="${t.id}" class="del danger">删除</button></div>`;
    root.appendChild(el);
  }
  $$('#todoList .toggle').forEach((cb) => cb.addEventListener('change', async (e) => {
    const id = e.target.dataset.id;
    await api('/api/todos/' + id, { method: 'PATCH', body: { status: e.target.checked ? 'done' : 'open' } });
    loadTodos();
  }));
  $$('#todoList .del').forEach((b) => b.addEventListener('click', async (e) => {
    if (!confirm('确定删除？')) return;
    await api('/api/todos/' + e.target.dataset.id, { method: 'DELETE' });
    loadTodos();
  }));
}

// 筛选芯片
$$('.filter-chip').forEach((b) => b.addEventListener('click', () => {
  todoFilter = b.dataset.filter;
  $$('.filter-chip').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  renderTodos();
}));
$('#todoSort').addEventListener('change', (e) => { todoSort = e.target.value; renderTodos(); });
$('#btnTodoNew').addEventListener('click', () => $('#todoForm').classList.toggle('hidden'));
$('#todoCancel').addEventListener('click', () => $('#todoForm').classList.add('hidden'));
$('#todoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  if (body.due_at) body.due_at = new Date(body.due_at).toISOString();
  body.priority = Number(body.priority) || 2;
  await api('/api/todos', { method: 'POST', body });
  e.target.reset(); e.target.classList.add('hidden'); loadTodos();
});

// ===== 日程（双视图：月历 + 列表）=====
let calView = 'month';
let calCursor = new Date(); // 当前显示的月份（任意一天）
let calSelected = null; // 选中的日期
let eventsCache = [];

async function loadEvents() {
  eventsCache = await api('/api/schedule');
  if (calView === 'month') renderCalendar();
  else renderEventList();
}

function renderCalendar() {
  // 标题
  $('#calTitle').textContent = `${calCursor.getFullYear()} 年 ${calCursor.getMonth() + 1} 月`;
  // 网格：找到本月 1 号是星期几，6 行 x 7 列
  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  const first = new Date(year, month, 1);
  // 中国习惯：一周从周一开始（周一=0, 周日=6）
  const startWeekday = (first.getDay() + 6) % 7;
  const grid = $('#calGrid');
  grid.innerHTML = '';
  // 起点：向前回溯 startWeekday 天
  const start = new Date(year, month, 1 - startWeekday);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const dayKey = d.toDateString();
    const isOther = d.getMonth() !== month;
    const isToday = d.getTime() === today.getTime();
    const isSelected = calSelected && d.toDateString() === calSelected.toDateString();
    const dayEl = document.createElement('div');
    dayEl.className = 'cal-day' + (isOther ? ' other-month' : '') + (isToday ? ' today' : '') + (isSelected ? ' selected' : '');
    dayEl.innerHTML = `<div class="cal-day-num">${d.getDate()}</div>`;
    // 当天事件
    const dayEvents = eventsCache.filter(ev => new Date(ev.start_at).toDateString() === dayKey);
    const max = 3;
    for (let j = 0; j < Math.min(max, dayEvents.length); j++) {
      const ev = dayEvents[j];
      const evEl = document.createElement('div');
      evEl.className = 'cal-event';
      evEl.textContent = (new Date(ev.start_at).getHours().toString().padStart(2, '0') + ':' +
        new Date(ev.start_at).getMinutes().toString().padStart(2, '0') + ' ') + ev.title;
      evEl.title = ev.title;
      evEl.addEventListener('click', (e) => { e.stopPropagation(); selectDay(d); });
      dayEl.appendChild(evEl);
    }
    if (dayEvents.length > max) {
      const more = document.createElement('div');
      more.className = 'cal-more';
      more.textContent = `+${dayEvents.length - max} 更多`;
      more.addEventListener('click', (e) => { e.stopPropagation(); selectDay(d); });
      dayEl.appendChild(more);
    }
    dayEl.addEventListener('click', () => selectDay(d));
    grid.appendChild(dayEl);
  }
  renderDayDetail();
}

function selectDay(d) {
  calSelected = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  renderCalendar();
}

function renderDayDetail() {
  const detail = $('#dayDetail');
  if (!calSelected) { detail.classList.add('hidden'); return; }
  detail.classList.remove('hidden');
  $('#dayDetailTitle').textContent = calSelected.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const dayEvents = eventsCache.filter(ev => new Date(ev.start_at).toDateString() === calSelected.toDateString())
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const root = $('#dayDetailList');
  root.innerHTML = '';
  if (!dayEvents.length) { root.innerHTML = '<div class="muted">这天没有日程。</div>'; return; }
  for (const ev of dayEvents) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `
      <div class="body">
        <div class="title">${escapeHtml(ev.title)}</div>
        <div class="meta">
          <span>🕒 ${new Date(ev.start_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}${ev.end_at ? ' → ' + new Date(ev.end_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
          ${ev.location ? `<span>📍 ${escapeHtml(ev.location)}</span>` : ''}
          <span>提前 ${ev.remind_before_min} 分钟提醒</span>
        </div>
        ${ev.notes ? `<div class="meta">${escapeHtml(ev.notes)}</div>` : ''}
      </div>
      <div class="ops"><button data-id="${ev.id}" class="del danger">删除</button></div>`;
    root.appendChild(el);
  }
  $$('#dayDetailList .del').forEach((b) => b.addEventListener('click', async (e) => {
    if (!confirm('确定删除？')) return;
    await api('/api/schedule/' + e.target.dataset.id, { method: 'DELETE' });
    loadEvents();
  }));
}

function renderEventList() {
  const root = $('#eventList');
  root.innerHTML = '';
  if (!eventsCache.length) { root.innerHTML = '<div class="muted">暂无日程。</div>'; return; }
  const list = eventsCache.slice().sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  for (const ev of list) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `
      <div class="body">
        <div class="title">${escapeHtml(ev.title)}</div>
        <div class="meta">
          <span>🕒 ${fmtDateTime(ev.start_at)}${ev.end_at ? ' → ' + fmtDateTime(ev.end_at) : ''}</span>
          ${ev.location ? `<span>📍 ${escapeHtml(ev.location)}</span>` : ''}
          <span>提前 ${ev.remind_before_min} 分钟提醒</span>
          ${ev.fired ? '<span class="badge">已提醒</span>' : ''}
        </div>
        ${ev.notes ? `<div class="meta">${escapeHtml(ev.notes)}</div>` : ''}
      </div>
      <div class="ops"><button data-id="${ev.id}" class="del danger">删除</button></div>`;
    root.appendChild(el);
  }
  $$('#eventList .del').forEach((b) => b.addEventListener('click', async (e) => {
    if (!confirm('确定删除？')) return;
    await api('/api/schedule/' + e.target.dataset.id, { method: 'DELETE' });
    loadEvents();
  }));
}

// 视图切换 + 日历控制
$$('.view-tab').forEach((b) => b.addEventListener('click', () => {
  calView = b.dataset.view;
  $$('.view-tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $('#calendarView').classList.toggle('hidden', calView !== 'month');
  $('#eventList').classList.toggle('hidden', calView !== 'agenda');
  if (calView === 'month') renderCalendar();
  else renderEventList();
}));
$('#calPrev').addEventListener('click', () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); renderCalendar(); });
$('#calNext').addEventListener('click', () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); renderCalendar(); });
$('#calToday').addEventListener('click', () => { calCursor = new Date(); selectDay(new Date()); });
$('#dayDetailClose').addEventListener('click', () => { calSelected = null; renderCalendar(); });
$('#btnEventNew').addEventListener('click', () => $('#eventForm').classList.toggle('hidden'));
$('#eventCancel').addEventListener('click', () => $('#eventForm').classList.add('hidden'));
$('#eventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  if (body.start_at) body.start_at = new Date(body.start_at).toISOString();
  if (body.end_at) body.end_at = new Date(body.end_at).toISOString();
  body.remind_before_min = Number(body.remind_before_min) || 15;
  await api('/api/schedule', { method: 'POST', body });
  e.target.reset(); e.target.classList.add('hidden'); loadEvents();
});

// ===== 提醒 =====
async function loadReminders() {
  const list = await api('/api/reminders');
  const root = $('#remList');
  root.innerHTML = '';
  if (!list.length) { root.innerHTML = '<div class="muted">还没有定时提醒。</div>'; return; }
  for (const r of list) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `
      <div class="body">
        <div class="title">${escapeHtml(r.title)}</div>
        <div class="meta">
          <span class="badge">cron: ${escapeHtml(r.cron)}</span>
          <span>${r.enabled ? '✅ 已启用' : '⏸ 已停用'}</span>
          ${r.message ? `<span>· ${escapeHtml(r.message)}</span>` : ''}
        </div>
      </div>
      <div class="ops">
        <button data-id="${r.id}" class="tog">${r.enabled ? '停用' : '启用'}</button>
        <button data-id="${r.id}" class="del danger">删除</button>
      </div>`;
    root.appendChild(el);
  }
  $$('#remList .tog').forEach((b) => b.addEventListener('click', async (e) => {
    await api('/api/reminders/' + e.target.dataset.id + '/toggle', { method: 'POST' });
    loadReminders();
  }));
  $$('#remList .del').forEach((b) => b.addEventListener('click', async (e) => {
    if (!confirm('确定删除？')) return;
    await api('/api/reminders/' + e.target.dataset.id, { method: 'DELETE' });
    loadReminders();
  }));
}
$('#btnRemNew').addEventListener('click', () => $('#remForm').classList.toggle('hidden'));
$('#remCancel').addEventListener('click', () => $('#remForm').classList.add('hidden'));
$('#remForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  try {
    await api('/api/reminders', { method: 'POST', body });
    e.target.reset(); e.target.classList.add('hidden'); loadReminders();
  } catch (err) { alert(err.message); }
});

// ===== AI 状态 + LLM 配置 =====
async function refreshAiStatus() {
  try {
    const s = await api('/api/ai/status');
    $('#llmStatus').textContent = s.enabled ? 'LLM: ✅' : 'LLM: ⚠️';
    $('#aiStatus').textContent = s.enabled ? '已连接 LLM' : '未配置 LLM_API_KEY，AI 功能不可用';
    // 顺便刷一下 LLM 配置卡片
    await refreshLlmConfig();
  } catch (e) { $('#aiStatus').textContent = '检测失败'; }
}

async function refreshLlmConfig() {
  const me = getUser();
  if (!me || !me.is_admin) {
    $('#llmConfigReadonly').textContent = '仅 admin 可见 / 可编辑';
    return;
  }
  try {
    const c = await api('/api/ai/config');
    const badge = c.source.apiKey ? '🟢 数据库' : (c.configured ? '🟡 .env' : '🔴 未配置');
    $('#llmConfigBadge').textContent = `来源: ${badge} · ${c.baseURL} · ${c.model}`;
    $('#llmConfigReadonly').textContent = c.configured
      ? `当前 Key: ${c.api_key_preview}`
      : '未配置 LLM，点击展开填写';
    $('#cfgBaseURL').value = c.baseURL || '';
    $('#cfgModel').value = c.model || '';
    $('#cfgApiKey').value = '';
  } catch (e) {
    $('#llmConfigReadonly').textContent = '读取失败：' + e.message;
  }
}

$('#btnCfgSave').addEventListener('click', async () => {
  const body = {};
  if ($('#cfgBaseURL').value.trim()) body.baseURL = $('#cfgBaseURL').value.trim();
  if ($('#cfgModel').value.trim()) body.model = $('#cfgModel').value.trim();
  if ($('#cfgApiKey').value) body.apiKey = $('#cfgApiKey').value;
  if (Object.keys(body).length === 0) {
    $('#cfgStatus').textContent = '⚠️ 没有改动（修改任意一项再保存）';
    return;
  }
  $('#cfgStatus').textContent = '保存中…';
  try {
    const r = await api('/api/ai/config', { method: 'PATCH', body });
    $('#cfgStatus').textContent = `✅ 已保存 · 来源: ${r.config.source.apiKey ? 'DB' : '.env'} / ${r.config.source.baseURL ? 'DB' : '.env'} / ${r.config.source.model ? 'DB' : '.env'}`;
    $('#cfgApiKey').value = '';
    // 回读一次，刷新表单显示（带最新脱敏 key preview）
    await refreshLlmConfig();
    await refreshAiStatus();
  } catch (e) {
    $('#cfgStatus').textContent = '❌ ' + e.message;
    console.error('save LLM config failed:', e);
  }
});

$('#btnCfgTest').addEventListener('click', async () => {
  // 如果有未保存的 key，先保存再测
  if ($('#cfgApiKey').value) {
    await $('#btnCfgSave').click();
  }
  $('#cfgStatus').textContent = '测试中…';
  try {
    const r = await api('/api/ai/config/test', { method: 'POST', body: {} });
    if (r.ok) {
      $('#cfgStatus').textContent = `✅ 通了（${r.latency_ms}ms · ${r.model}）`;
    } else {
      $('#cfgStatus').textContent = '❌ ' + (r.error || '失败');
    }
  } catch (e) {
    $('#cfgStatus').textContent = '❌ ' + e.message;
  }
});

// ===== 流式 AI 输出 =====
let currentStreamAbort = null;
function showAiOutput(text) {
  const box = $('#aiOutput');
  $('#aiOutputText').textContent = text;
  $('#aiOutputText').classList.remove('cursor-blink');
  box.classList.remove('hidden');
}
function showAiStatus(text) { $('#aiOutputStatus').textContent = text; }

async function streamAction(messagesBuilder, label) {
  // 取消上一次
  if (currentStreamAbort) currentStreamAbort.abort();
  currentStreamAbort = new AbortController();

  const messages = messagesBuilder();
  showAiOutput('');
  showAiStatus('⏳ ' + label + '…');
  $('#btnStop').classList.remove('hidden');
  $('#aiOutputText').classList.add('cursor-blink');

  try {
    const event = await apiStream('/api/ai/stream', { messages, max_tokens: 800 }, (ev, payload) => {
      if (ev === 'delta') {
        $('#aiOutputText').textContent = payload.full;
        showAiStatus('✍️ 正在生成…');
      } else if (ev === 'done') {
        showAiStatus('✅ 完成 · ' + (payload.text || '').length + ' 字');
      } else if (ev === 'error') {
        showAiOutput('❌ ' + (payload.error || '未知错误'));
        showAiStatus('❌ 失败');
      }
    });
    if (event === 'error') {
      // 已显示
    }
  } catch (e) {
    showAiOutput('❌ ' + e.message);
    showAiStatus('❌ 失败');
  } finally {
    $('#aiOutputText').classList.remove('cursor-blink');
    $('#btnStop').classList.add('hidden');
    currentStreamAbort = null;
  }
}

$('#btnStop').addEventListener('click', () => {
  if (currentStreamAbort) { currentStreamAbort.abort(); currentStreamAbort = null; showAiStatus('⏹ 已停止'); }
});

// 非流式按钮（用于不需要流式体验的简单建议）
$('#btnAdvise').addEventListener('click', async () => {
  const task = $('#adviseText').value.trim();
  if (!task) return alert('请先输入任务描述');
  streamAction(() => [
    { role: 'system', content: '你是一个务实的工作教练。给定一个任务，请给出：1) 拆解步骤（3-5 条）；2) 可能的风险/卡点；3) 一句鼓励。语言简洁中文，200 字内。' },
    { role: 'user', content: task },
  ], '生成建议');
});

$('#btnSummarize').addEventListener('click', () => streamAction(() => {
  // 让后端拿数据再发；这里直接构造请求让前端用 messages 模式
  // 简化：直接走非流式端点拿到完整 prompt 让用户感受到流式
  return [
    { role: 'system', content: '你是一个高效的个人助理。请基于下方数据生成中文摘要：今日重点 / 日程安排 / 建议。' },
    { role: 'user', content: '请帮我总结今天的任务（你需要假装看到一堆 todo 和日程）' },
  ];
}, '今日摘要'));

$('#btnReport').addEventListener('click', () => streamAction(() => [
  { role: 'system', content: '你是个人助理，请生成一份今日日报，包含：今日完成 / 未完成 / 明日建议。' },
  { role: 'user', content: '请生成今日日报样例' },
], '今日日报'));

$('#btnWeekly').addEventListener('click', () => streamAction(() => [
  { role: 'system', content: '你是个人助理，基于本周数据生成周报：本周完成概览 / 分类产出 / 风险 / 下周建议。' },
  { role: 'user', content: '请生成本周周报样例' },
], '本周周报'));

$('#btnMonthly').addEventListener('click', () => streamAction(() => [
  { role: 'system', content: '你是个人助理，基于本月数据做月度复盘：数据概览 / 产出分布 / 习惯信号 / 下月建议。' },
  { role: 'user', content: '请生成本月复盘样例' },
], '月度复盘'));

$('#btnBreakdown').addEventListener('click', async () => {
  const task = $('#breakdownText').value.trim();
  if (!task) return alert('请先输入要拆解的任务');
  const out = $('#breakdownOutput');
  out.classList.remove('hidden');
  out.textContent = '拆解中…';
  showAiOutput('');
  showAiStatus('⏳ 拆解任务…');
  try {
    const r = await api('/api/ai/breakdown', { method: 'POST', body: { task } });
    if (r.text) {
      try {
        const obj = JSON.parse(r.text);
        out.textContent = JSON.stringify(obj, null, 2);
        if (obj.summary) showAiOutput('🧩 ' + obj.summary);
      } catch {
        out.textContent = r.text;
      }
    } else {
      out.textContent = r.error || '无内容';
    }
  } catch (e) {
    out.textContent = '❌ ' + e.message;
  }
});

// ===== 备份/恢复 =====
async function refreshBackupStats() {
  try {
    const s = await api('/api/backup/stats');
    $('#backupStats').textContent =
      `导出时间 ${fmtDateTime(s.exported_at)} · ` +
      `待办 ${s.counts.todos} · 日程 ${s.counts.schedule_events} · ` +
      `提醒 ${s.counts.reminders} · 设置 ${s.counts.settings}`;
  } catch (e) { $('#backupStats').textContent = '读取失败'; }
}

$('#btnExport').addEventListener('click', () => {
  // 用 fetch + blob 下载（带 token）
  fetch('/api/backup/export', { headers: { Authorization: 'Bearer ' + getToken() } })
    .then((r) => r.blob())
    .then((b) => {
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      a.download = `workbuddy-backup-${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
});

let pickedFile = null;
$('#importFile').addEventListener('change', (e) => {
  pickedFile = e.target.files[0];
  if (pickedFile) alert('已选择文件：' + pickedFile.name + '\n点击「确认导入」生效。');
});

$('#btnImport').addEventListener('click', async () => {
  if (!pickedFile) return alert('请先选择备份文件');
  const mode = $('#importMode').value;
  if (mode === 'replace' && !confirm('「覆盖」将清空你当前账户的数据并替换为备份内容，确定继续？')) return;
  const text = await pickedFile.text();
  let payload;
  try { payload = JSON.parse(text); } catch (e) { return alert('文件不是有效 JSON：' + e.message); }
  try {
    const r = await api('/api/backup/import', { method: 'POST', body: { ...payload, mode } });
    alert('导入完成：' + JSON.stringify(r.counts));
    pickedFile = null;
    $('#importFile').value = '';
    refreshBackupStats();
    loadTodos();
  } catch (e) { alert('导入失败：' + e.message); }
});

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== 启动 =====
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (localStorage.getItem('workbuddy_install_dismissed') !== '1') {
    const b = $('#installBanner');
    if (b) b.classList.remove('hidden');
  }
});
bind('#btnInstall', 'click', async () => {
  const banner = $('#installBanner');
  if (banner) banner.classList.add('hidden');
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  if (choice.outcome === 'accepted') console.log('PWA installed');
  deferredInstallPrompt = null;
});
bind('#btnInstallDismiss', 'click', () => {
  const b = $('#installBanner');
  if (b) b.classList.add('hidden');
  localStorage.setItem('workbuddy_install_dismissed', '1');
});

// session 续期感知：每 10 分钟 ping 一次 /api/auth/me，触发服务端滑动续期
setInterval(async () => {
  if (!getToken()) return;
  try { await api('/api/auth/me'); } catch (_) {}
}, 10 * 60 * 1000);

(async function init() {
  if (getToken()) {
    try {
      // 验证 token 有效
      const me = await api('/api/auth/me');
      setUser(me);
      hideLogin();
      loadTodos();
      refreshAiStatus();
      refreshBackupStats();
      return;
    } catch (_) {
      setToken(''); setUser(null);
    }
  }
  showLogin();
})();

// ===== 对话 Tab =====
let chatAbort = null;

function appendChat(container, role, text, intent) {
  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'chat-msg ' + role;
  if (role === 'bot' && intent) {
    const tag = document.createElement('span');
    tag.className = 'intent-tag';
    tag.textContent = intent;
    el.appendChild(tag);
  }
  const span = document.createElement('span');
  span.className = 'text';
  span.textContent = text;
  el.appendChild(span);
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return span;
}

function setChatStatus(text) {
  $('#chatStatus').textContent = text || '—';
}

async function sendChatMessage(message, container, opts = {}) {
  if (!message || !message.trim()) return;
  appendChat(container, 'user', message);
  setChatStatus('思考中…');
  const thinking = appendChat(container, 'thinking', '正在理解…');
  if (opts.onStop) opts.onStop.classList.remove('hidden');

  let botEl = null, botText = null;
  try {
    const res = await fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error('HTTP ' + res.status + ': ' + t);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let intent = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = raw.split('\n');
        let event = 'message', data = '';
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let payload = {};
        try { payload = JSON.parse(data); } catch (_) {}
        if (event === 'thinking') {
          thinking.classList.remove('thinking');
          // thinking 就是 appendChat 返回的 .text span，直接 set textContent
          thinking.textContent = '正在生成回复…';
        } else if (event === 'intent') {
          intent = payload.intent;
          setChatStatus(`意图: ${intent}`);
        } else if (event === 'delta') {
          if (thinking.parentNode) thinking.remove();
          if (!botEl) {
            botEl = appendChat(container, 'bot', '', intent);
            botText = botEl;
          }
          fullText += payload.text || '';
          botText.textContent = fullText;
          container.scrollTop = container.scrollHeight;
        } else if (event === 'done') {
          setChatStatus('✅');
        } else if (event === 'error') {
          if (thinking.parentNode) thinking.remove();
          appendChat(container, 'bot', '❌ ' + (payload.error || '失败'));
          setChatStatus('❌');
        }
      }
    }
  } catch (e) {
    if (thinking.parentNode) thinking.remove();
    appendChat(container, 'bot', '❌ ' + e.message);
    setChatStatus('❌');
  } finally {
    if (opts.onStop) opts.onStop.classList.add('hidden');
  }
}

// 主对话 Tab
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const v = $('#chatInput').value.trim();
    if (!v) return;
    $('#chatInput').value = '';
    sendChatMessage(v, $('#chatWindow'), { onStop: $('#btnChatStop') });
  }
});
$('#btnChatSend').addEventListener('click', () => {
  const v = $('#chatInput').value.trim();
  if (!v) return;
  $('#chatInput').value = '';
  sendChatMessage(v, $('#chatWindow'), { onStop: $('#btnChatStop') });
});
$('#btnChatStop').addEventListener('click', () => {
  if (chatAbort) { chatAbort.abort(); chatAbort = null; setChatStatus('⏹ 已停止'); }
});
$$('#chatEmpty li').forEach((li) => {
  li.addEventListener('click', () => {
    $('#chatInput').value = li.textContent.replace(/[「」]/g, '');
    $('#btnChatSend').click();
  });
});

// 智能助手 Tab 快速对话
console.log('[WorkBuddy] binding quickChat handlers, btnQuickChat =', !!$('#btnQuickChat'), 'quickChatInput =', !!$('#quickChatInput'));
$('#btnQuickChat').addEventListener('click', () => {
  const v = $('#quickChatInput').value.trim();
  console.log('[WorkBuddy] quickChat send:', v);
  if (!v) return;
  $('#quickChatInput').value = '';
  sendChatMessage(v, $('#quickChatLog'));
});
$('#quickChatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#btnQuickChat').click(); }
});
$('#openFullChat').addEventListener('click', (e) => {
  e.preventDefault();
  $$('.tab').forEach((b) => b.classList.remove('active'));
  $$('.panel').forEach((p) => p.classList.remove('active'));
  document.querySelector('[data-tab="chat"]').classList.add('active');
  $('#panel-chat').classList.add('active');
  $('#chatInput').focus();
});

// 切到 chat tab 时聚焦输入框
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'chat') setTimeout(() => $('#chatInput').focus(), 50);
  });
});
