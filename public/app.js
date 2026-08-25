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

// todo-section.js: 新版待办渲染逻辑
// 此文件在 build 时合并进 app.js（或作为 inline script 加载）
// 目前用 patch-todo.js 手动注入

// ===== 待办 P1 增强（多选/批量/分类标签/空状态/密度）=====
let todoFilter = 'all';
let todoSort = 'priority';
let todoAllCache = [];
let todoSelected = new Set();
const TODO_DENSITY_KEY = 'workbuddy_todo_density';

function fmtDue(due) {
  if (!due) return null;
  const d = new Date(due);
  if (isNaN(d)) return null;
  const ms = d.getTime() - Date.now();
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  const h = d.getHours(), m = d.getMinutes();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = pad(h) + ':' + pad(m);
  if (ms < 0) {
    let text = '已过期 ';
    if (min < 60) text += min + ' 分钟';
    else if (min < 1440) text += Math.floor(min / 60) + ' 小时';
    else text += Math.floor(min / 1440) + ' 天';
    return { text, class: 'due-overdue' };
  }
  if (min < 60) return { text: min + ' 分钟后', class: 'due-soon' };
  if (min < 1440) return { text: '今天 ' + hm, class: 'due-soon' };
  if (min < 2880) return { text: '明天 ' + hm, class: 'due-soon' };
  if (min < 10080) return { text: Math.floor(min / 1440) + ' 天后', class: 'due-marker' };
  return { text: (d.getMonth() + 1) + '/' + d.getDate(), class: 'due-marker' };
}

async function loadTodos() {
  todoAllCache = await api('/api/todos');
  renderTodos();
  loadCategoryChips();
}

async function loadCategoryChips() {
  try {
    const cats = await api('/api/todos/categories');
    const box = $('#categoryChips');
    if (!box) return;
    box.innerHTML = '';
    for (const c of cats) {
      const btn = document.createElement('button');
      btn.className = 'filter-chip cat-chip' + (todoFilter === 'cat:' + c ? ' active' : '');
      btn.textContent = c;
      btn.dataset.filter = 'cat:' + c;
      btn.addEventListener('click', () => {
        todoFilter = btn.dataset.filter;
        $$('.filter-chip').forEach((x) => x.classList.remove('active'));
        btn.classList.add('active');
        renderTodos();
      });
      box.appendChild(btn);
    }
  } catch (_) {}
}

function renderTodos() {
  const root = $('#todoList');
  const emptyEl = $('#todoEmpty');
  root.innerHTML = '';
  todoSelected.clear();
  updateBatchBar();
  const cnt = { all: todoAllCache.length, open: 0, p1: 0, p2: 0, p3: 0, done: 0 };
  for (const t of todoAllCache) {
    if (t.status === 'done') cnt.done++;
    else { cnt.open++; if (t.priority === 1) cnt.p1++; else if (t.priority === 2) cnt.p2++; else if (t.priority === 3) cnt.p3++; }
  }
  for (const k of Object.keys(cnt)) {
    const el = $('#cnt' + k.charAt(0).toUpperCase() + k.slice(1));
    if (el) el.textContent = cnt[k];
  }
  let list = todoAllCache.slice();
  if (todoFilter === 'open') list = list.filter((t) => t.status !== 'done');
  else if (todoFilter === 'done') list = list.filter((t) => t.status === 'done');
  else if (todoFilter.startsWith('cat:')) {
    const cat = todoFilter.slice(4);
    list = list.filter((t) => (t.category || '') === cat && t.status !== 'done');
  } else if (todoFilter === 'p1' || todoFilter === 'p2' || todoFilter === 'p3') {
    list = list.filter((t) => t.priority === parseInt(todoFilter[1]) && t.status !== 'done');
  }
  if (todoSort === 'priority') {
    list.sort((a, b) => (a.status === 'done' ? 1 : b.status === 'done' ? -1 : (a.priority || 2) - (b.priority || 2)));
  } else if (todoSort === 'due') {
    list.sort((a, b) => (!a.due_at ? 1 : !b.due_at ? -1 : new Date(a.due_at) - new Date(b.due_at)));
  } else {
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  if (!list.length) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');
  for (const t of list) {
    const el = document.createElement('div');
    const overdue = t.due_at && t.status !== 'done' && new Date(t.due_at) < new Date();
    el.className = 'item p' + (t.priority || 2) + (t.status === 'done' ? ' done' : '') + (overdue ? ' overdue' : '');
    el.dataset.id = t.id;
    const dueInfo = t.due_at ? fmtDue(t.due_at) : null;
    const dueText = dueInfo ? ('截止 ' + dueInfo.text) : '';
    const dueCls = dueInfo ? dueInfo.class : '';
    const catBadge = t.category ? '<span class="badge cat-badge">' + escapeHtml(t.category) + '</span>' : '';
    el.innerHTML = [
      '<input type="checkbox" class="toggle todo-cb" data-id="' + t.id + '" />',
      '<input type="checkbox" class="toggle" data-id="' + t.id + '"' + (t.status === 'done' ? ' checked' : '') + ' />',
      '<div class="body">',
      '  <div class="title">' + escapeHtml(t.title) + '</div>',
      '  <div class="meta">',
      '    <span class="badge p' + (t.priority || 2) + '">' + ['','🔴 高','🟡 中','🔵 低'][t.priority || 2] + '</span>',
      catBadge,
      dueText ? '<span class="' + dueCls + '">' + dueText + '</span>' : '',
      '  </div>',
      '</div>',
      '<div class="ops"><button data-id="' + t.id + '" class="del danger">删除</button></div>'
    ].join('');
    root.appendChild(el);
  }
  $$('#todoList .todo-cb').forEach((cb) => cb.addEventListener('change', (e) => {
    const id = e.target.dataset.id;
    if (e.target.checked) todoSelected.add(id); else todoSelected.delete(id);
    updateBatchBar();
  }));
  $$('#todoList .toggle:not(.todo-cb)').forEach((cb) => cb.addEventListener('change', async (e) => {
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

function updateBatchBar() {
  const bar = $('#batchBar');
  const count = $('#batchCount');
  if (!bar) return;
  if (todoSelected.size > 1) { bar.classList.remove('hidden'); count.textContent = todoSelected.size; }
  else { bar.classList.add('hidden'); }
}
$('#batchDone')?.addEventListener('click', async () => {
  if (!confirm('确认完成 ' + todoSelected.size + ' 项？')) return;
  await api('/api/todos/batch', { method: 'POST', body: { ids: [...todoSelected], action: 'complete' } });
  todoSelected.clear(); loadTodos();
});
$('#batchHigh')?.addEventListener('click', async () => {
  await api('/api/todos/batch', { method: 'POST', body: { ids: [...todoSelected], action: 'priority', priority: 1 } });
  loadTodos();
});
$('#batchDel')?.addEventListener('click', async () => {
  if (!confirm('确认删除 ' + todoSelected.size + ' 项？此操作不可恢复')) return;
  await api('/api/todos/batch', { method: 'POST', body: { ids: [...todoSelected], action: 'delete' } });
  todoSelected.clear(); loadTodos();
});
$('#batchClear')?.addEventListener('click', () => {
  todoSelected.clear(); $$('#todoList .todo-cb').forEach((c) => c.checked = false);
  updateBatchBar();
});
$('#todoDensity')?.addEventListener('change', (e) => {
  localStorage.setItem(TODO_DENSITY_KEY, e.target.value);
  const root = $('#todoList');
  if (root) root.className = 'list todo-' + e.target.value;
});
$('#todoDensity').value = localStorage.getItem(TODO_DENSITY_KEY) || 'normal';
$('#todoList').className = 'list todo-' + (localStorage.getItem(TODO_DENSITY_KEY) || 'normal');
// 筛选芯片
$$('.filter-chip').forEach((b) => b.addEventListener('click', () => {
  todoFilter = b.dataset.filter;
  $$('.filter-chip').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  renderTodos();
}));
$('#todoSort').addEventListener('change', (e) => { todoSort = e.target.value; renderTodos(); });
$('#btnTodoNew').addEventListener('click', () => $('#todoForm').classList.toggle('hidden'));
$('#todoCancel').addEventListener('click', () => $('#todoForm').classList.add('hidden'));

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
    const f = $('#llmConfigForm');
    if (f) f.classList.add('hidden');
    const uc = $('#usageCard');
    if (uc) uc.classList.add('hidden');
    return;
  }
  const f = $('#llmConfigForm');
  if (f) f.classList.remove('hidden');
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
    // 用量统计（admin 才能看到数据）
    const uc = $('#usageCard');
    if (uc) uc.classList.remove('hidden');
    await refreshUsage();
  } catch (e) {
    $('#llmConfigReadonly').textContent = '读取失败：' + e.message;
  }
}

// ===== Token 用量统计 =====
let usageDays = 7;
async function refreshUsage() {
  const me = getUser();
  if (!me || !me.is_admin) return;
  try {
    const u = await api('/api/ai/usage?days=' + usageDays);
    renderUsage(u);
  } catch (e) {
    const s = $('#usageSummary');
    if (s) s.textContent = '用量读取失败: ' + e.message;
  }
}

function renderUsage(u) {
  const sum = $('#usageSummary');
  if (!sum) return;
  const t = u.totals || {};
  const fmt = (n) => (n >= 1000000 ? (n / 1000000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n));
  const has = (t.total_tokens || 0) > 0;

  if (!has) {
    sum.innerHTML = '<div class="usage-empty">📭 近 ' + usageDays + ' 天暂无调用记录。<br>开始对话或生成报告后，这里会显示用量趋势。</div>';
    $('#usageChart').innerHTML = '';
    $('#usageByModel').innerHTML = '';
    return;
  }

  // 汇总指标卡
  sum.innerHTML = `
    <div class="ustat">
      <div class="ustat-ico" style="background:#eff6ff;color:#2563eb">∑</div>
      <div class="ustat-body"><div class="ustat-num">${fmt(t.total_tokens)}</div><div class="ustat-lbl">总 Token</div></div>
    </div>
    <div class="ustat">
      <div class="ustat-ico" style="background:#f0fdf4;color:#16a34a">↓</div>
      <div class="ustat-body"><div class="ustat-num">${fmt(t.prompt_tokens)}</div><div class="ustat-lbl">输入</div></div>
    </div>
    <div class="ustat">
      <div class="ustat-ico" style="background:#fef2f2;color:#dc2626">↑</div>
      <div class="ustat-body"><div class="ustat-num">${fmt(t.completion_tokens)}</div><div class="ustat-lbl">输出</div></div>
    </div>
    <div class="ustat">
      <div class="ustat-ico" style="background:#faf5ff;color:#9333ea">⚡</div>
      <div class="ustat-body"><div class="ustat-num">${t.calls}</div><div class="ustat-lbl">调用次数</div></div>
    </div>`;

  // 模型分布（横向条 + 百分比）
  const bm = $('#usageByModel');
  if (bm) {
    const models = u.by_model || [];
    const total = models.reduce((s, m) => s + (m.total_tokens || 0), 0) || 1;
    const max = Math.max(...models.map((m) => m.total_tokens || 0)) || 1;
    bm.innerHTML = models.map((m) => {
      const pct = Math.round(((m.total_tokens || 0) / total) * 100);
      const w = Math.round(((m.total_tokens || 0) / max) * 100);
      return `
        <div class="umodel">
          <span class="umname">${escapeHtml(m.model)}</span>
          <span class="umbar"><i style="width:${w}%"></i></span>
          <span class="umval">${fmt(m.total_tokens)} · ${pct}%</span>
        </div>`;
    }).join('');
  }

  // 每日趋势（平滑曲线面积图）
  const chart = $('#usageChart');
  if (chart) {
    const days = (u.by_day || []).slice().reverse();
    if (!days.length) {
      chart.innerHTML = '<span class="muted" style="margin:auto">近 ' + usageDays + ' 天无调用记录</span>';
    } else {
      chart.innerHTML = renderLineChart(days, fmt);
    }
  }
}

/**
 * 纯 SVG 平滑曲线面积图
 * @param {Array<{date,tokens,total_tokens,calls}>} days 升序
 */
function renderLineChart(days, fmt) {
  const W = 600, H = 140, PAD = 14;
  const n = days.length;
  const maxV = Math.max(...days.map((d) => d.total_tokens || 0)) || 1;
  const minV = 0;
  const x = (i) => PAD + (i * (W - 2 * PAD)) / Math.max(1, n - 1);
  const y = (v) => H - PAD - ((v - minV) / (maxV - minV)) * (H - 2 * PAD);

  const pts = days.map((d, i) => [x(i), y(d.total_tokens || 0)]);
  // 平滑曲线（Catmull-Rom → 三次贝塞尔）
  const linePath = smoothPath(pts);
  const areaPath = linePath + ` L ${x(n - 1)},${H - PAD} L ${x(0)},${H - PAD} Z`;

  const dots = pts.map(([px, py], i) => {
    const d = days[i];
    const tip = `${escapeHtml(d.date)} · ${fmt(d.total_tokens)} tokens · ${d.calls} 次`;
    return `<circle class="u-dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" data-tip="${tip}" />`;
  }).join('');

  // X 轴日期标签（最多显示 ~8 个避免拥挤）
  const labelStep = Math.ceil(n / 8);
  const labels = days.map((d, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return '';
    const md = (d.date || '').slice(5); // MM-DD
    return `<text x="${x(i).toFixed(1)}" y="${H - 2}" class="u-axis">${escapeHtml(md)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="u-linechart" style="width:100%;height:${H}px">
    <defs>
      <linearGradient id="uArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.02"/>
      </linearGradient>
      <linearGradient id="uStroke" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#2563eb"/>
        <stop offset="100%" stop-color="#60a5fa"/>
      </linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#uArea)" />
    <path d="${linePath}" fill="none" stroke="url(#uStroke)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    ${dots}
    ${labels}
  </svg>
  <div id="uTip" class="u-tooltip"></div>`;
}

/** Catmull-Rom 转平滑贝塞尔路径 */
function smoothPath(pts) {
  if (pts.length < 2) return pts.length ? `M ${pts[0][0]},${pts[0][1]}` : '';
  let d = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

// 曲线图 tooltip 交互（事件委托）
document.addEventListener('mouseover', (e) => {
  const dot = e.target.closest && e.target.closest('.u-dot');
  if (!dot) return;
  const tip = document.getElementById('uTip');
  if (!tip) return;
  tip.textContent = dot.dataset.tip;
  tip.style.opacity = '1';
  const svg = dot.ownerSVGElement;
  const rect = svg.getBoundingClientRect();
  tip.style.left = (dot.cx.baseVal.value / 600 * rect.width) + 'px';
  tip.style.top = (dot.cy.baseVal.value / 140 * rect.height - 30) + 'px';
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest && e.target.closest('.u-dot')) {
    const tip = document.getElementById('uTip');
    if (tip) tip.style.opacity = '0';
  }
});

$$('.usage-range-btn').forEach((b) => {
  b.addEventListener('click', () => {
    usageDays = parseInt(b.dataset.days, 10) || 7;
    $$('.usage-range-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    refreshUsage();
  });
});

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

const CHAT_EMPTY_HTML = ``
  + `<div class="chat-empty" id="chatEmpty">`
  + `  <div class="chat-empty-ico">💬</div>`
  + `  <div class="chat-empty-title">你好，我是 WorkBuddy 助手</div>`
  + `  <div class="chat-empty-sub">用自然语言管理待办、日程和提醒，试试这样说：</div>`
  + `  <div class="chat-empty-chips">`
  + `    <button class="chip" data-sample="明天下午3点开项目周会">📅 明天下午3点开会</button>`
  + `    <button class="chip" data-sample="提醒我买牛奶">✅ 提醒我买牛奶</button>`
  + `    <button class="chip" data-sample="每天9点提醒我写日报">⏰ 每天9点写日报</button>`
  + `    <button class="chip" data-sample="我今天还有什么没做">📋 我今天还有什么没做</button>`
  + `    <button class="chip" data-sample="生成今日日报">📝 生成今日日报</button>`
  + `    <button class="chip" data-sample="把买牛奶标记完成">✔️ 把买牛奶标记完成</button>`
  + `  </div>`
  + `</div>`;

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/**
 * 工具操作转录条：显示助手"正在/已经执行了什么"
 * @param {{icon?:string, text:string}} step
 */
function appendToolStep(container, step) {
  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'tool-step';
  el.innerHTML = `<span class="ts-icon">${step.icon || '🔧'}</span><span class="ts-text"></span>`;
  el.querySelector('.ts-text').textContent = step.text || '';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

/**
 * 轻量 Markdown 渲染器（零依赖、XSS 安全）
 * 策略：先整体 HTML 转义 → 再在"已转义文本"上做 md→html 转换
 */
function escapeMd(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderMarkdown(src) {
  const text = escapeMd(src);
  const codeBlocks = [];
  let t = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = codeBlocks.length;
    codeBlocks.push({ lang: (lang || '').toLowerCase(), code: code.replace(/\n$/, '') });
    return `\u0000CODE${i}\u0000`;
  });
  t = t
    .replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const lines = t.split('\n');
  const out = [];
  let listType = null;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (const line of lines) {
    if (/^\u0000CODE\d+\u0000$/.test(line.trim())) { flushPara(); closeList(); out.push(line.trim()); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); closeList(); out.push(`<h${Math.min(4, h[1].length + 2)} class="md-h">${h[2]}</h${Math.min(4, h[1].length + 2)}>`); continue; }
    const ul = line.match(/^\s*[-•*]\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)[.、]\s+(.*)$/);
    if (ul && !ol) {
      flushPara();
      if (listType !== 'ul') { closeList(); out.push('<ul class="md-list">'); listType = 'ul'; }
      out.push(`<li>${ul[1]}</li>`);
      continue;
    }
    if (ol) {
      flushPara();
      if (listType !== 'ol') { closeList(); out.push('<ol class="md-list">'); listType = 'ol'; }
      out.push(`<li>${ol[2]}</li>`);
      continue;
    }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    // PPT/PRD 下载链接（票据制）→ 可点击下载卡片
    const dl = line.match(/^(⬇️ 点击下载：)(\/api\/(?:ppt|prd)\/download\/t\/[0-9a-f]+)\s*$/);
    if (dl) {
      flushPara(); closeList();
      const url = dl[2];
      const isMd = url.includes('/prd/');
      out.push(`<a class="ppt-download-card${isMd ? ' is-md' : ''}" href="${url}" download>`
        + `<span class="pdc-icon">${isMd ? '📄' : '📊'}</span><span class="pdc-body"><span class="pdc-title">点击下载 ${isMd ? 'Markdown' : 'PPTX'}</span>`
        + `<span class="pdc-sub">${isMd ? '产品需求文档 · 可编辑' : '原生 PowerPoint 文件'} · 链接 10 分钟内有效</span></span>`
        + `<span class="pdc-arrow">⬇</span></a>`);
      continue;
    }
    para.push(line);
  }
  flushPara(); closeList();
  return out.join('\n').replace(/\u0000CODE(\d+)\u0000/g, (_, i) => {
    const cb = codeBlocks[Number(i)];
    if (!cb) return '';
    return renderCodeBlock(cb.code, cb.lang);
  });
}
/** 极简代码高亮 */
function highlightCode(code, lang) {
  let h = escapeMd(code);
  h = h.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g, '<span class="tok-str">$1</span>');
  if (!lang || /^(js|javascript|ts|typescript|json|jsx|tsx)$/i.test(lang)) {
    h = h.replace(/(\/\/[^\n]*)/g, '<span class="tok-com">$1</span>');
    h = h.replace(/\/\*[\s\S]*?\*\//g, '<span class="tok-com">$1</span>');
    h = h.replace(/\b(const|let|var|function|return|if|else|for|while|class|new|async|await|import|export|from|try|catch|throw|typeof|null|undefined|true|false|this)\b/g, '<span class="tok-kw">$1</span>');
  } else if (/^(py|python)$/i.test(lang)) {
    h = h.replace(/(#[^\n]*)/g, '<span class="tok-com">$1</span>');
    h = h.replace(/\b(def|return|if|elif|else|for|while|class|import|from|try|except|raise|with|as|lambda|None|True|False|self|print)\b/g, '<span class="tok-kw">$1</span>');
  }
  h = h.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
  return h;
}
function renderCodeBlock(code, lang) {
  const id = 'cb' + Math.random().toString(36).slice(2, 8);
  return `<div class="code-block"><div class="cb-head"><span class="cb-lang">${escapeMd(lang || 'code')}</span><button class="cb-copy" data-copy="${id}">复制</button></div><pre id="${id}"><code>${highlightCode(code, lang)}</code></pre></div>`;
}

/**
 * 追加一条聊天消息（新蓝白气泡结构）
 * @returns 消息正文的 .text span（供流式更新）
 */
function appendChat(container, role, text, intent) {
  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'chat-msg ' + role;

  // 头像
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = role === 'user' ? '👤' : '🤖';
  el.appendChild(avatar);

  // 主体（intent tag + 内容）
  const wrap = document.createElement('div');
  wrap.className = 'msg-main';
  if (role === 'bot' && intent) {
    const tag = document.createElement('span');
    tag.className = 'intent-tag';
    tag.textContent = intent;
    wrap.appendChild(tag);
  }
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  const span = document.createElement('span');
  span.className = 'text';
  span.textContent = text;
  bubble.appendChild(span);
  wrap.appendChild(bubble);

  // bot 消息操作栏（复制 / 重新生成）
  if (role === 'bot') {
    const ops = document.createElement('div');
    ops.className = 'msg-ops';
    ops.innerHTML = `
      <button class="msg-op" data-op="copy" title="复制回复">📋 复制</button>
      <button class="msg-op" data-op="regen" title="重新生成">🔄 重新生成</button>`;
    wrap.appendChild(ops);
  }

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = nowTime();
  wrap.appendChild(meta);
  el.appendChild(wrap);

  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return span;
}

function setChatStatus(text) {
  const el = $('#chatStatus');
  if (el) el.textContent = text || '为你服务';
}

function clearChat() {
  const win = $('#chatWindow');
  if (!win) return;
  win.innerHTML = CHAT_EMPTY_HTML;
  bindChips();
}

function bindChips() {
  $$('#chatEmpty .chip').forEach((c) => {
    c.addEventListener('click', () => {
      const v = c.dataset.sample || '';
      const inp = $('#chatInput');
      if (inp) inp.value = v;
      sendChat();
    });
  });
}

let chatSending = false; // 防重入锁：避免双击/回车连击导致重复提问
function sendChat() {
  if (chatSending) return; // 正在回复中，忽略重复提交
  const inp = $('#chatInput');
  const v = inp ? inp.value.trim() : '';
  if (!v) return;
  chatSending = true;
  const sendBtn = $('#btnChatSend');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = '0.5'; }
  inp.value = '';
  autoResizeInput();
  sendChatMessage(v, $('#chatWindow'), {
    onStop: $('#btnChatStop'),
    onSettled: () => {
      chatSending = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = ''; }
      const inp2 = $('#chatInput');
      if (inp2 && currentTabVisible('chat')) inp2.focus();
    },
  });
}

// 判断某个面板是否当前可见
function currentTabVisible(tabName) {
  const panel = document.getElementById('panel-' + tabName);
  return panel && panel.classList.contains('active');
}

function autoResizeInput() {
  const t = $('#chatInput');
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = Math.max(40, Math.min(140, t.scrollHeight)) + 'px';
}

/**
 * 创建 bot 消息骨架（NextChat 式数据驱动：消息节点一开始就存在，
 * 打字指示器在气泡内部，流式填充同一节点 —— 无临时元素、无残留可能）
 * @returns {{ el: HTMLElement, bubble: HTMLElement }}
 */
function appendBotSkeleton(container, intent) {
  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'chat-msg bot';
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = '🤖';
  el.appendChild(avatar);
  const wrap = document.createElement('div');
  wrap.className = 'msg-main';
  if (intent) {
    const tag = document.createElement('span');
    tag.className = 'intent-tag';
    tag.textContent = intent;
    wrap.appendChild(tag);
  }
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble typing';
  bubble.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span>';
  wrap.appendChild(bubble);
  // 操作栏（hover 显示）
  const ops = document.createElement('div');
  ops.className = 'msg-ops';
  ops.innerHTML = `
    <button class="msg-op" data-op="copy" title="复制回复">📋 复制</button>
    <button class="msg-op" data-op="regen" title="重新生成">🔄 重新生成</button>`;
  wrap.appendChild(ops);
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = nowTime();
  wrap.appendChild(meta);
  el.appendChild(wrap);
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return { el, bubble };
}

/** 在 bot 消息之前插入工具转录条（保持"先操作后回答"的视觉顺序） */
function insertToolStepBefore(container, botEl, step) {
  const stepEl = document.createElement('div');
  stepEl.className = 'tool-step';
  stepEl.innerHTML = `<span class="ts-icon">${step.icon || '🔧'}</span><span class="ts-text"></span>`;
  stepEl.querySelector('.ts-text').textContent = step.text || '';
  container.insertBefore(stepEl, botEl);
  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage(message, container, opts = {}) {
  if (!message || !message.trim()) return;
  appendChat(container, 'user', message);
  setChatStatus('思考中…');
  // bot 消息骨架立即存在（含打字点），后续所有更新都作用于它
  const { el: botEl, bubble } = appendBotSkeleton(container, null);
  if (opts.onStop) opts.onStop.classList.remove('hidden');

  // ===== 会话历史持久化：确保会话存在 + 落库用户消息 =====
  let sessionId = getCurrentSessionId();
  if (!sessionId) {
    try {
      const s = await api('/api/chathistory/sessions', { method: 'POST', body: {} });
      sessionId = s.id;
      setCurrentSessionId(sessionId);
    } catch (_) {}
  }
  let lastMsgId = 0;
  if (sessionId) {
    try {
      const r = await fetch('/api/chathistory/sessions/' + sessionId + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify({ role: 'user', content: message }),
      });
      if (r.ok) { const j = await r.json(); lastMsgId = j.msgId || 0; }
    } catch (_) {}
    loadSessionList();
  }

  let fullText = '';
  let streaming = false; // 是否已开始填充内容
  let pendingRender = null; // 节流渲染定时器
  const nearBottomRef = { v: true };
  chatAbort = new AbortController();
  try {
    const res = await fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
      body: JSON.stringify({ message, enableSearch: webSearchEnabled() }),
      signal: chatAbort.signal,
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
        if (event === 'tool') {
          insertToolStepBefore(container, botEl, payload);
          setChatStatus('🔧 ' + (payload.text || '执行操作…'));
        } else if (event === 'intent') {
          setChatStatus(`意图识别: ${payload.intent}`);
        } else if (event === 'delta') {
          if (!streaming) { bubble.classList.remove('typing'); bubble.classList.add('md-body', 'streaming'); streaming = true; }
          fullText += payload.text || '';
          // 节流渲染：delta 高频到达时全量 Markdown 解析会卡主线程（长大纲尤其明显）
          // 只累积文本，~90ms 渲染一次；done 时做最终完整渲染
          const now = performance.now();
          const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 140;
          if (!pendingRender) {
            pendingRender = setTimeout(() => {
              pendingRender = null;
              bubble.innerHTML = renderMarkdown(fullText);
              if (nearBottomRef.v) container.scrollTop = container.scrollHeight;
            }, 90);
          }
          nearBottomRef.v = nearBottom;
        } else if (event === 'done') {
          if (pendingRender) { clearTimeout(pendingRender); pendingRender = null; } // 取消挂起渲染，下面做最终渲染
          if (!fullText.trim() && payload.reply) fullText = payload.reply;
          if (fullText.trim()) {
            bubble.classList.remove('typing', 'streaming');
            bubble.classList.add('md-body');
            bubble.innerHTML = renderMarkdown(fullText);
            setChatStatus('已回复 ✓');
            if (voiceEnabled()) speakText(fullText.trim());
            saveBotMessage(sessionId, fullText.trim(), () => maybeSummarize(sessionId));
          } else {
            botEl.remove(); // 空回复：整个消息移除
            setChatStatus('已回复 ✓');
          }
        } else if (event === 'error') {
          const raw = payload.error || '出错了';
          let msg = '❌ ' + raw;
          if (/503|Endpoint is unavailable|server_error|upstream/i.test(raw)) {
            msg = '⚠️ LLM 上游暂时不可用（503）\n\n可能是：模型端点未部署 / 服务商限流 / 临时故障。\n建议：① 稍后重试 ② 在「LLM 配置」里换一个模型或 Base URL ③ 检查额度是否用完。';
          } else if (/401|403|unauthorized|api.?key/i.test(raw)) {
            msg = '⚠️ LLM 鉴权失败（401/403）\n\n请到「LLM 配置」检查 API Key 与 Base URL 是否正确。';
          } else if (/429|rate.?limit|限流/i.test(raw)) {
            msg = '⚠️ LLM 触发限流（429）\n\n请降低请求频率，或升级服务商配额。';
          }
          bubble.classList.remove('typing', 'streaming');
          bubble.classList.add('md-body', 'is-error');
          bubble.innerHTML = renderMarkdown(msg);
          setChatStatus('出错');
        }
      }
    }
  } catch (e) {
    if (pendingRender) { clearTimeout(pendingRender); pendingRender = null; }
    if (e.name === 'AbortError') {
      // 用户停止：有内容保留部分回答，没内容移除整条
      if (!fullText.trim()) botEl.remove();
      else { bubble.classList.remove('typing', 'streaming'); bubble.classList.add('md-body'); bubble.innerHTML = renderMarkdown(fullText); }
      setChatStatus('⏹ 已停止');
    } else {
      bubble.classList.remove('typing', 'streaming');
      bubble.classList.add('md-body', 'is-error');
      bubble.innerHTML = renderMarkdown('❌ ' + e.message);
      setChatStatus('网络错误');
    }
  } finally {
    if (opts.onStop) opts.onStop.classList.add('hidden');
    if (typeof opts.onSettled === 'function') opts.onSettled();
    // PPT 预览：对话结束后刷新草稿（ppt_* 工具可能已修改）
    if (typeof refreshPptPreview === 'function') setTimeout(refreshPptPreview, 300);
  }
}

// 主对话 Tab 事件
$('#chatInput').addEventListener('input', autoResizeInput);
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    // 中文输入法确认候选词时也是 Enter，不能当成"发送"
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    sendChat();
  }
});
$('#btnChatSend').addEventListener('click', sendChat);
$('#btnChatClear').addEventListener('click', () => clearChat());

// ===== 消息操作（复制 / 重新生成）+ 代码块复制 —— 事件委托 =====
function copyText(text, btn) {
  const done = () => { if (btn) { const old = btn.textContent; btn.textContent = '✓ 已复制'; setTimeout(() => btn.textContent = old, 1500); } };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (_) {}
  ta.remove();
}
// 取某条消息气泡的纯文本（代码块还原为 ``` 形式）
function bubbleText(msgEl) {
  const t = msgEl.querySelector('.msg-bubble .text');
  if (!t) return '';
  let out = '';
  t.childNodes.forEach((n) => {
    if (n.nodeType === 3) out += n.textContent;
    else if (n.classList && n.classList.contains('code-block')) {
      const pre = n.querySelector('pre code');
      out += '\n```\n' + (pre ? pre.textContent : '') + '\n```\n';
    } else if (n.nodeType === 1) out += n.textContent;
  });
  return out.trim();
}
$('#chatWindow').addEventListener('click', (e) => {
  // 代码块复制
  const cbBtn = e.target.closest('.cb-copy');
  if (cbBtn) {
    const pre = document.getElementById(cbBtn.dataset.copy);
    copyText(pre ? pre.textContent : '', cbBtn);
    return;
  }
  const op = e.target.closest('.msg-op');
  if (!op) return;
  const msgEl = op.closest('.chat-msg');
  const textEl = msgEl && msgEl.querySelector('.msg-bubble .text');
  if (op.dataset.op === 'copy' && textEl) {
    copyText(bubbleText(msgEl), op);
  } else if (op.dataset.op === 'regen') {
    // 防重入 + 删除旧回答（避免"两个回答"）
    if (chatSending) return;
    let prev = msgEl.previousElementSibling;
    while (prev && !prev.classList.contains('user')) prev = prev.previousElementSibling;
    const userText = prev ? (prev.querySelector('.text') || {}).textContent : '';
    if (!userText) return;
    chatSending = true;
    const sendBtn = $('#btnChatSend');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = '0.5'; }
    // 移除旧回答及其上方紧邻的 tool 转录条
    let toRemove = msgEl;
    let p = msgEl.previousElementSibling;
    while (p && p.classList.contains('tool-step')) { toRemove = p; p = p.previousElementSibling; }
    if (toRemove && toRemove.classList.contains('chat-msg')) toRemove.remove();
    sendChatMessage(userText, $('#chatWindow'), {
      onStop: $('#btnChatStop'),
      onSettled: () => {
        chatSending = false;
        if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = ''; }
      },
    });
  }
});
$('#btnChatClear').addEventListener('click', () => clearChat());
$('#btnChatStop').addEventListener('click', () => {
  if (chatAbort) {
    chatAbort.abort();
    chatAbort = null;
    setChatStatus('⏹ 已停止');
  }
});

// ===== 联网搜索开关 =====
const WS_KEY = 'workbuddy_websearch';
function webSearchEnabled() {
  return localStorage.getItem(WS_KEY) === '1';
}
function renderWebSearchToggle() {
  const btn = $('#btnWebSearchToggle');
  if (!btn) return;
  btn.classList.toggle('on', webSearchEnabled());
  btn.title = webSearchEnabled() ? '联网搜索已开启' : '联网搜索已关闭';
}
$('#btnWebSearchToggle').addEventListener('click', () => {
  const on = !webSearchEnabled();
  localStorage.setItem(WS_KEY, on ? '1' : '0');
  renderWebSearchToggle();
  setChatStatus(on ? '🔍 联网搜索已开启' : '🔌 联网搜索已关闭（仅本地智能）');
});
renderWebSearchToggle();

// ===== 语音模式（TTS 播报 + STT 语音输入）=====
const VOICE_KEY = 'workbuddy_voice';
function voiceEnabled() { return localStorage.getItem(VOICE_KEY) === '1'; }
function renderVoiceToggle() {
  const btn = $('#btnVoiceToggle');
  if (!btn) return;
  btn.classList.toggle('on', voiceEnabled());
  btn.title = voiceEnabled() ? '语音播报已开启' : '语音播报已关闭';
}
$('#btnVoiceToggle').addEventListener('click', () => {
  const on = !voiceEnabled();
  localStorage.setItem(VOICE_KEY, on ? '1' : '0');
  renderVoiceToggle();
  setChatStatus(on ? '🔊 语音播报已开启' : '🔇 语音播报已关闭');
  if (on) speakText('语音播报已开启');
});
renderVoiceToggle();

// ---- TTS：朗读文本 ----
let speechSynth = ('speechSynthesis' in window) ? window.speechSynthesis : null;
let zhVoice = null;
function pickVoice() {
  if (!speechSynth) return;
  const voices = speechSynth.getVoices();
  zhVoice = voices.find(v => /zh|cmn|Chinese/i.test(v.lang + v.name)) || null;
}
if (speechSynth) {
  pickVoice();
  speechSynth.onvoiceschanged = pickVoice;
}
function speakText(text) {
  if (!speechSynth || !voiceEnabled()) return;
  speechSynth.cancel(); // 打断上一条
  const u = new SpeechSynthesisUtterance(text.slice(0, 500)); // 限制长度避免过长
  if (zhVoice) u.voice = zhVoice;
  u.lang = 'zh-CN';
  u.rate = 1.05;
  u.pitch = 1;
  speechSynth.speak(u);
}

// ---- STT：语音输入 ----
const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let micRecognition = null;
let micRecording = false;
function setupMic() {
  if (!SR) {
    const mic = $('#btnMic');
    if (mic) { mic.disabled = true; mic.title = '当前浏览器不支持语音输入（推荐 Chrome）'; }
    return;
  }
  micRecognition = new SR();
  micRecognition.lang = 'zh-CN';
  micRecognition.continuous = false;
  micRecognition.interimResults = true;
  micRecognition.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res.isFinal) {
        const txt = res[0].transcript.trim();
        if (txt) {
          const inp = $('#chatInput');
          inp.value = (inp.value + ' ' + txt).trim();
          autoResizeInput();
        }
      } else {
        interim = ev.results[i][0].transcript;
      }
    }
    setChatStatus(interim ? '🎤 ' + interim : '聆听中…');
  };
  micRecognition.onerror = (e) => {
    setChatStatus('语音识别错误: ' + e.error);
    stopMic();
  };
  micRecognition.onend = () => stopMic();
}
function startMic() {
  if (!micRecognition) return;
  try {
    micRecognition.start();
    micRecording = true;
    $('#btnMic').classList.add('recording');
    $('#chatInput').closest('.chat-input').classList.add('recording-hint');
    setChatStatus('🎤 聆听中，请说话…');
  } catch (_) { /* 已在录音 */ }
}
function stopMic() {
  micRecording = false;
  const mic = $('#btnMic');
  if (mic) mic.classList.remove('recording');
  const ci = $('#chatInput') && $('#chatInput').closest('.chat-input');
  if (ci) ci.classList.remove('recording-hint');
  if (micRecording === false && micRecognition) {
    try { micRecognition.stop(); } catch (_) {}
  }
}
$('#btnMic').addEventListener('click', () => {
  if (!SR) { alert('当前浏览器不支持语音输入，请使用 Chrome / Edge'); return; }
  if (micRecording) {
    // 再次点击：结束并发送
    stopMic();
    sendChat();
  } else {
    startMic();
  }
});
if (SR) setupMic();

bindChips();

// 切到 chat tab 时聚焦输入框
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'chat') setTimeout(() => $('#chatInput').focus(), 50);
  });
});

// ===== 对接配置（飞书 / 企业微信 / 钉钉）=====
const CHANNEL_META = {
  feishu: { label: '飞书', icon: '🐦' },
  wecom: { label: '企业微信', icon: '💬' },
  dingtalk: { label: '钉钉', icon: '📣' },
};
async function loadIntegrations() {
  const root = $('#integrationList');
  if (!root) return;
  try {
    const r = await api('/api/integrations');
    if (!r.items.length) {
      root.innerHTML = '<div class="muted">还没有配置任何渠道。在下方填写 webhook 即可推送提醒/日报到团队 IM。</div>';
      return;
    }
    root.innerHTML = '';
    for (const it of r.items) {
      const meta = CHANNEL_META[it.channel] || { label: it.channel, icon: '🔌' };
      const el = document.createElement('div');
      el.className = 'integration-item';
      el.innerHTML = `
        <div class="ic-logo">${meta.icon}</div>
        <div class="ic-body">
          <div class="ic-name">${escapeHtml(it.name || meta.label)}</div>
          <div class="ic-meta">${meta.label} · ${escapeHtml(it.webhook || '未配置 webhook')}</div>
        </div>
        <div class="ic-actions">
          <button class="ghost small" data-test="${it.id}">测试</button>
          <button class="ghost small" data-del="${it.id}">删除</button>
          <label class="switch">
            <input type="checkbox" data-toggle="${it.id}" ${it.enabled ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>`;
      root.appendChild(el);
    }
    $$('#integrationList [data-toggle]').forEach(cb => cb.addEventListener('change', async (e) => {
      await api('/api/integrations/' + e.target.dataset.toggle + '/enabled', { method: 'PATCH', body: { enabled: e.target.checked } });
    }));
    $$('#integrationList [data-test]').forEach(b => b.addEventListener('click', async (e) => {
      b.textContent = '…';
      const r = await api('/api/integrations/' + e.target.dataset.test + '/test', { method: 'POST' });
      b.textContent = '测试';
      alert(r.ok ? '✅ 推送成功！' : '❌ 失败：' + (r.error || '未知错误'));
    }));
    $$('#integrationList [data-del]').forEach(b => b.addEventListener('click', async (e) => {
      if (!confirm('确定删除该渠道配置？')) return;
      await api('/api/integrations/' + e.target.dataset.del, { method: 'DELETE' });
      loadIntegrations();
    }));
  } catch (err) {
    root.innerHTML = '<div class="muted">加载失败：' + (err.message || err) + '</div>';
  }
}
$('#intChannel').addEventListener('change', (e) => {
  // 钉钉需要 secret
  $('#intSecretWrap').classList.toggle('hidden', e.target.value !== 'dingtalk');
});
$('#btnIntSave').addEventListener('click', async () => {
  const body = {
    channel: $('#intChannel').value,
    name: $('#intName').value.trim(),
    webhook: $('#intWebhook').value.trim(),
    secret: $('#intSecret').value.trim(),
  };
  if (!body.webhook) { $('#intStatus').textContent = '请填写 Webhook URL'; return; }
  const btn = $('#btnIntSave');
  btn.disabled = true;
  try {
    await api('/api/integrations', { method: 'POST', body });
    $('#intName').value = '';
    $('#intWebhook').value = '';
    $('#intSecret').value = '';
    $('#intStatus').textContent = '✅ 已保存';
    await loadIntegrations();
  } catch (err) {
    $('#intStatus').textContent = '❌ ' + (err.message || err);
  } finally {
    btn.disabled = false;
  }
});
// 进入 LLM 配置页时刷新对接列表
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => { if (btn.dataset.tab === 'ai') loadIntegrations(); });
});
loadIntegrations();

// ===== 左侧会话历史 =====
const SESSION_KEY = 'workbuddy_session_id';
const SUMMARIZE_THRESHOLD = 12; // 未压缩消息超过此数自动触发摘要压缩
/** 落库 bot 回复；完成后回调（用于链式触发压缩检查） */
function saveBotMessage(sessionId, content, onSaved) {
  if (!sessionId || !content) { if (onSaved) onSaved(); return; }
  fetch('/api/chathistory/sessions/' + sessionId + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: JSON.stringify({ role: 'bot', content }),
  }).then(async (r) => {
    if (onSaved) onSaved();
    loadSessionList();
    // 压缩检查：未压缩消息数 >= 阈值 → 后台静默触发摘要
    try {
      if (!r.ok) return;
      const ctx = await api('/api/chathistory/sessions/' + sessionId + '/context');
      const uncompressed = (ctx.messages || []).length;
      if (uncompressed >= SUMMARIZE_THRESHOLD) {
        setChatStatus('🧹 正在整理长期记忆…');
        await api('/api/chathistory/sessions/' + sessionId + '/summarize', { method: 'POST', body: {} });
        setChatStatus('已回复 ✓');
      }
    } catch (_) {}
  }).catch(() => { if (onSaved) onSaved(); });
}
/**
 * 压缩检查：未压缩消息数达到阈值时调用后端 summarize
 */
async function maybeSummarize(sessionId) {
  try {
    const ctx = await api('/api/chathistory/sessions/' + sessionId + '/context');
    const uncompressed = (ctx.messages || []).length;
    if (uncompressed < SUMMARIZE_THRESHOLD) return;
    await api('/api/chathistory/sessions/' + sessionId + '/summarize', { method: 'POST', body: {} });
  } catch (_) {}
}
function getCurrentSessionId() {
  const v = localStorage.getItem(SESSION_KEY);
  return v ? Number(v) : null;
}
function setCurrentSessionId(id) {
  if (id) localStorage.setItem(SESSION_KEY, String(id));
  else localStorage.removeItem(SESSION_KEY);
  // 高亮列表当前项
  $$('#sessionList .session-item').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.id) === Number(id));
  });
}
async function loadSessionList() {
  const box = $('#sessionList');
  if (!box) return;
  try {
    const r = await api('/api/chathistory/sessions');
    if (!r.items.length) {
      box.innerHTML = '<div class="muted" style="padding:8px;font-size:12px">还没有历史对话</div>';
      return;
    }
    box.innerHTML = '';
    for (const s of r.items) {
      const el = document.createElement('div');
      el.className = 'session-item' + (Number(s.id) === getCurrentSessionId() ? ' active' : '');
      el.dataset.id = s.id;
      el.innerHTML = `
        <span class="si-icon">💬</span>
        <span class="si-title">${escapeHtml(s.title || '新对话')}</span>
        <button class="si-del" title="删除会话">✕</button>`;
      // 点击主体 → 回放
      el.querySelector('.si-title').parentElement.addEventListener('click', async (e) => {
        if (e.target.classList.contains('si-del')) return;
        await openSession(s.id, s.title);
      });
      el.querySelector('.si-del').addEventListener('click', async () => {
        if (!confirm('删除这个对话？')) return;
        await api('/api/chathistory/sessions/' + s.id, { method: 'DELETE' });
        if (getCurrentSessionId() === s.id) {
          setCurrentSessionId(null);
          clearChat();
        }
        loadSessionList();
      });
      box.appendChild(el);
    }
  } catch (_) {
    box.innerHTML = '<div class="muted" style="padding:8px">加载失败</div>';
  }
}
/** 打开某个历史会话：回放消息到中间区 */
async function openSession(sessionId, title) {
  setCurrentSessionId(sessionId);
  const win = $('#chatWindow');
  win.innerHTML = '';
  try {
    const r = await api('/api/chathistory/sessions/' + sessionId + '/messages');
    for (const m of r.items) {
      if (m.role === 'user') {
        appendChat(win, 'user', m.content);
      } else {
        const span = appendChat(win, 'bot', '', null);
        span.classList.add('md-body');
        span.innerHTML = renderMarkdown(m.content);
      }
    }
    if (!r.items.length) clearChat();
    setChatStatus(title ? '已打开：' + title : '已打开历史对话');
    win.scrollTop = win.scrollHeight;
  } catch (_) {
    setChatStatus('打开失败');
  }
  loadSessionList();
}
$('#btnNewChat').addEventListener('click', () => {
  setCurrentSessionId(null); // 下次发消息自动建新会话
  clearChat();
  setChatStatus('新对话');
  $('#chatInput').focus();
});
loadSessionList();

// ===== PPT 实时预览侧栏 =====
const pvState = { draft: null, theme: null, page: 1 };
function pvThemeColors() {
  const t = pvState.theme || {};
  return {
    bg: '#' + (t.bg || 'FFFFFF'), title: '#' + (t.title || '1F3864'),
    text: '#' + (t.text || '333333'), accent: '#' + (t.accent || '2563EB'),
    sub: '#' + (t.sub || '5B7BB4'), light: '#' + (t.light || 'EAF1FB'),
  };
}
/** 渲染当前页到主舞台（16:9 缩略模拟） */
function pvRenderSlide() {
  const d = pvState.draft;
  const stage = $('#pvSlide');
  if (!d || !d.pages.length) { stage.innerHTML = '<div class="pv-empty">暂无草稿</div>'; return; }
  const p = d.pages[Math.min(pvState.page, d.pages.length) - 1] || d.pages[0];
  const c = pvThemeColors();
  stage.style.background = c.bg;
  stage.innerHTML = `
    <div class="pv-titlebar" style="background:${c.light}"><i style="background:${c.accent}"></i><b style="color:${c.title}">${escapeHtml(p.title)}</b></div>
    <ul class="pv-bullets">${p.bullets.slice(0, 6).map((b) => `<li style="color:${c.text}">${escapeHtml(b)}</li>`).join('') || '<li style="color:' + c.sub + '">（空页）</li>'}</ul>
    <div class="pv-accentline" style="background:${c.accent}"></div>
    <span class="pv-pageno" style="color:${c.sub}">${p.no} / ${d.pages.length}</span>`;
  $('#pvPage').textContent = `${p.no} / ${d.pages.length}`;
}
/** 渲染缩略图条 */
function pvRenderThumbs() {
  const d = pvState.draft;
  const box = $('#pvThumbs');
  if (!d) { box.innerHTML = ''; return; }
  const c = pvThemeColors();
  box.innerHTML = d.pages.map((p) => `
    <div class="pv-thumb ${p.no === pvState.page ? 'active' : ''}" data-page="${p.no}" title="${escapeHtml(p.title)}">
      <span class="pvt-no" style="background:${c.accent}">${p.no}</span>
      <span class="pvt-title">${escapeHtml(p.title.slice(0, 10))}</span>
    </div>`).join('');
  $$('#pvThumbs .pv-thumb').forEach((t) => t.addEventListener('click', () => {
    pvState.page = parseInt(t.dataset.page, 10);
    pvRenderSlide(); pvRenderThumbs();
  }));
}
/** 拉取草稿并刷新预览；有草稿展开，无则收起 */
async function refreshPptPreview() {
  try {
    const r = await api('/api/ppt/draft');
    pvState.draft = r.has ? r.draft : null;
    pvState.theme = r.has ? r.theme : null;
    if (r.has) {
      if (pvState.page > pvState.draft.pages.length) pvState.page = pvState.draft.pages.length;
      $('#pptPreview').classList.remove('hidden');
      pvRenderSlide(); pvRenderThumbs();
    } else {
      $('#pptPreview').classList.add('hidden');
    }
  } catch (_) { /* 静默 */ }
}
$('#btnPvPrev').addEventListener('click', () => {
  if (!pvState.draft) return;
  pvState.page = Math.max(1, pvState.page - 1);
  pvRenderSlide(); pvRenderThumbs();
});
$('#btnPvNext').addEventListener('click', () => {
  if (!pvState.draft) return;
  pvState.page = Math.min(pvState.draft.pages.length, pvState.page + 1);
  pvRenderSlide(); pvRenderThumbs();
});
$('#btnPvClose').addEventListener('click', () => $('#pptPreview').classList.add('hidden'));
// 页面加载时也检查一次（服务重启前有草稿的场景刷新后可见）
refreshPptPreview();
