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

// ===== 待办（带筛选 + 排序 + 优先级颜色）=====
let todoFilter = 'all';
let todoSort = 'priority';
let todoAllCache = [];

/**
 * 截止时间相对格式：
 *   已过期 N 分钟/小时/天
 *   N 分钟后 / 今天 HH:MM / 明天 HH:MM / N 天后 / M/D
 * @param {string|Date} due
 * @returns {{ text:string, class:string }}
 */
function fmtDue(due) {
  if (!due) return null;
  const d = new Date(due);
  if (isNaN(d)) return null;
  const ms = d.getTime() - Date.now();
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  const h = d.getHours(), m = d.getMinutes();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(h)}:${pad(m)}`;

  if (ms < 0) {
    // 已过期
    let text = '已过期 ';
    if (min < 60) text += `${min} 分钟`;
    else if (min < 1440) text += `${Math.floor(min / 60)} 小时`;
    else text += `${Math.floor(min / 1440)} 天`;
    return { text, class: 'due-overdue' };
  }
  if (min < 60) return { text: `${min} 分钟后`, class: 'due-soon' };
  if (min < 1440) return { text: `今天 ${hm}`, class: 'due-soon' };
  if (min < 2880) return { text: `明天 ${hm}`, class: 'due-soon' };
  if (min < 10080) return { text: `${Math.floor(min / 1440)} 天后`, class: 'due-marker' };
  return { text: `${d.getMonth() + 1}/${d.getDate()}`, class: 'due-marker' };
}

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
    const due = t.due_at ? new Date(t.due_at) : null;
    const overdue = due && t.status !== 'done' && due < new Date();
    el.className = 'item p' + (t.priority || 2) + (t.status === 'done' ? ' done' : '') + (overdue ? ' overdue' : '');
    const dueInfo = t.due_at ? fmtDue(t.due_at) : null;
    const dueText = dueInfo ? `截止 ${dueInfo.text}` : '';
    const dueCls = dueInfo ? dueInfo.class : '';
    el.innerHTML = `
      <input type="checkbox" ${t.status === 'done' ? 'checked' : ''} data-id="${t.id}" class="toggle" />
      <div class="body">
        <div class="title">${escapeHtml(t.title)}</div>
        <div class="meta">
          <span class="badge p${t.priority}">${['','🔴 高','🟡 中','🔵 低'][t.priority] || '🟡 中'}</span>
          ${t.category ? `<span class="badge">${escapeHtml(t.category)}</span>` : ''}
          ${dueText ? `<span class="${dueCls}">${dueText}</span>` : ''}
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

// ===== 快速添加待办（轻量解析：标题 + 优先级 + 分类；时间走高级表单）=====
const PRIORITY_KEYWORDS = [
  { kw: /^(?:高|重要|紧急|urgent|高优先级)/i, p: 1, label: '🔴 高' },
  { kw: /^(?:低|不急|稍后|later)/i, p: 3, label: '🔵 低' },
];
function parseQuickInput(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  let priority = parseInt($('#quickTodoPriority').value, 10) || 2;
  // 解析优先级关键字
  for (const r of PRIORITY_KEYWORDS) {
    if (r.kw.test(text)) { priority = r.p; text = text.replace(r.kw, '').trim(); break; }
  }
  // 解析分类 "工作：写周报" 或 "写周报 #工作" 或 "写周报 @工作"
  let category = '';
  const catColon = text.match(/^([\u4e00-\u9fa5A-Za-z0-9]+)\s*[:：]\s*(.+)$/);
  if (catColon && catColon[1].length <= 8) { category = catColon[1]; text = catColon[2].trim(); }
  else {
    const hashCat = text.match(/[#@]([\u4e00-\u9fa5A-Za-z0-9]+)\s*$/);
    if (hashCat) { category = hashCat[1]; text = text.replace(hashCat[0], '').trim(); }
  }
  // 清理残留分隔符
  text = text.replace(/^[，。、\s]+|[，。、\s]+$/g, '').trim();
  if (!text) return null;
  return { title: text, priority, category: category || null };
}

function renderQuickHint() {
  const raw = $('#quickTodoInput').value;
  const hint = $('#quickTodoHint');
  if (!raw.trim()) { hint.textContent = ''; return; }
  const parsed = parseQuickInput(raw);
  if (!parsed) { hint.textContent = ''; return; }
  const parts = [];
  parts.push(`将创建：<b>${escapeHtml(parsed.title)}</b>`);
  parts.push(parsed.priority === 1 ? '🔴 高' : parsed.priority === 3 ? '🔵 低' : '🟡 中');
  if (parsed.category) parts.push(`分类 <b>${escapeHtml(parsed.category)}</b>`);
  hint.innerHTML = parts.join(' · ');
}
$('#quickTodoInput').addEventListener('input', renderQuickHint);
$('#quickTodoPriority').addEventListener('change', renderQuickHint);
$('#quickTodoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#quickTodoInput');
  const parsed = parseQuickInput(input.value);
  if (!parsed) { input.focus(); return; }
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = '…';
  try {
    await api('/api/todos', { method: 'POST', body: parsed });
    input.value = '';
    $('#quickTodoHint').textContent = '';
    await loadTodos();
  } catch (err) {
    alert('添加失败：' + (err.message || err));
  } finally {
    btn.disabled = false; btn.textContent = '添加';
    input.focus();
  }
});
// 进入待办页自动聚焦快速输入框
function focusQuickTodoOnTab() { setTimeout(() => { const inp = $('#quickTodoInput'); if (inp) inp.focus(); }, 50); }
// 切到 todos 标签时聚焦
$$('.tab').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab === 'todos') focusQuickTodoOnTab(); }));
focusQuickTodoOnTab();
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
  // 汇总
  const sum = $('#usageSummary');
  if (!sum) return;
  const t = u.totals || {};
  const fmt = (n) => (n >= 1000000 ? (n / 1000000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n));
  sum.innerHTML = ''
    + `<div class="usage-stat"><span class="num">${fmt(t.total_tokens || 0)}</span><span class="lbl">总 Token</span></div>`
    + `<div class="usage-stat"><span class="num">${fmt(t.prompt_tokens || 0)}</span><span class="lbl">输入 Token</span></div>`
    + `<div class="usage-stat"><span class="num">${fmt(t.completion_tokens || 0)}</span><span class="lbl">输出 Token</span></div>`
    + `<div class="usage-stat"><span class="num">${t.calls || 0}</span><span class="lbl">调用次数</span></div>`
    + `<div class="usage-stat"><span class="num">${t.models || 0}</span><span class="lbl">使用模型数</span></div>`;

  // 按模型（横向条形）
  const bm = $('#usageByModel');
  if (bm) {
    const models = u.by_model || [];
    if (models.length) {
      const max = Math.max(...models.map((m) => m.total_tokens || 0));
      bm.innerHTML = models.map((m) => `
        <div class="usage-model">
          <span class="mname">${escapeHtml(m.model)}</span>
          <span class="mbar"><i style="width:${max ? Math.round((m.total_tokens / max) * 100) : 0}%"></i></span>
          <span class="mval">${fmt(m.total_tokens)} tokens · ${m.calls} 次</span>
        </div>`).join('');
    } else {
      bm.innerHTML = '';
    }
  }

  // 按日期（柱状图）
  const chart = $('#usageChart');
  if (chart) {
    const days = u.by_day || [];
    if (!days.length) {
      chart.innerHTML = '<span class="muted" style="margin:auto">近 ' + usageDays + ' 天无调用记录</span>';
      return;
    }
    const maxV = Math.max(...days.map((d) => d.total_tokens || 0));
    chart.innerHTML = days.slice().reverse().map((d) => {
      const h = maxV ? Math.max(6, Math.round(((d.total_tokens || 0) / maxV) * 100)) : 6;
      return `<div class="bar" style="height:${h}%" data-date="${escapeHtml(d.date)}" title="${escapeHtml(d.date)} · ${fmt(d.total_tokens)} tokens · ${d.calls}次"></div>`;
    }).join('');
  }
}

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

function sendChat() {
  const inp = $('#chatInput');
  const v = inp ? inp.value.trim() : '';
  if (!v) return;
  inp.value = '';
  autoResizeInput();
  sendChatMessage(v, $('#chatWindow'), { onStop: $('#btnChatStop') });
}

function autoResizeInput() {
  const t = $('#chatInput');
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = Math.max(40, Math.min(140, t.scrollHeight)) + 'px';
}

async function sendChatMessage(message, container, opts = {}) {
  if (!message || !message.trim()) return;
  appendChat(container, 'user', message);
  setChatStatus('思考中…');
  const thinking = appendChat(container, 'thinking', '正在理解…');
  if (opts.onStop) opts.onStop.classList.remove('hidden');

  let botTextEl = null;
  try {
    const res = await fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
      body: JSON.stringify({ message, enableSearch: webSearchEnabled() }),
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
          // thinking 就是 appendChat 返回的 .text span
          thinking.textContent = '正在生成回复…';
        } else if (event === 'intent') {
          intent = payload.intent;
          setChatStatus(`意图识别: ${intent}`);
        } else if (event === 'delta') {
          if (thinking.parentNode) thinking.remove();
          if (!botTextEl) {
            botTextEl = appendChat(container, 'bot', '', intent);
          }
          fullText += payload.text || '';
          botTextEl.textContent = fullText;
          container.scrollTop = container.scrollHeight;
        } else if (event === 'done') {
          setChatStatus('已回复 ✓');
        } else if (event === 'error') {
          if (thinking.parentNode) thinking.remove();
          appendChat(container, 'bot', '❌ ' + (payload.error || '出错了'));
          setChatStatus('出错');
        }
      }
    }
  } catch (e) {
    if (thinking && thinking.parentNode) thinking.remove();
    appendChat(container, 'bot', '❌ ' + e.message);
    setChatStatus('网络错误');
  } finally {
    if (opts.onStop) opts.onStop.classList.add('hidden');
  }
}

// 主对话 Tab 事件
$('#chatInput').addEventListener('input', autoResizeInput);
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
$('#btnChatSend').addEventListener('click', sendChat);
$('#btnChatClear').addEventListener('click', () => clearChat());
$('#btnChatStop').addEventListener('click', () => {
  if (chatAbort) { chatAbort.abort(); chatAbort = null; setChatStatus('⏹ 已停止'); }
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

bindChips();

// 切到 chat tab 时聚焦输入框
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'chat') setTimeout(() => $('#chatInput').focus(), 50);
  });
});
