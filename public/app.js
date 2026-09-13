/* WorkBuddy 前端 v6.0 (calendar + todo filter/sort + safe $ + chat + LLM config) */
console.log('[WorkBuddy] app ready', new Date().toISOString());

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
  if (u) $('#userInfo').textContent = u.username;
  loadSessionList();
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

// ===== 待办 P1 增强（多选/批量/分类标签/空状态/密度）=====
let todoFilter = 'all';
let todoSort = 'priority';
let todoAllCache = [];
let todoSelected = new Set();
let todoView = 'today'; // 'today' | 'all' | 'archive'
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
  if (todoView === 'today') {
    // 今日计划：今日截止 + 过期未完成 + 无截止的
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + 86400000);
    list = list.filter((t) => {
      if (t.status === 'done' || t.status === 'archived') return false;
      if (t.due_at) {
        const d = new Date(t.due_at);
        return (d >= start && d < end) || d < start;
      }
      return true;
    });
    list.sort((a, b) => {
      const aOv = a.due_at && new Date(a.due_at) < start;
      const bOv = b.due_at && new Date(b.due_at) < start;
      if (aOv && !bOv) return -1;
      if (!aOv && bOv) return 1;
      return (a.priority || 2) - (b.priority || 2);
    });
  } else if (todoView === 'archive') {
    list = list.filter((t) => t.status === 'archived');
    list.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  } else {
    // 全部视图
    if (todoFilter === 'open') list = list.filter((t) => t.status !== 'done' && t.status !== 'archived');
    else if (todoFilter === 'done') list = list.filter((t) => t.status === 'done');
    else if (todoFilter.startsWith('cat:')) {
      const cat = todoFilter.slice(4);
      list = list.filter((t) => (t.category || '') === cat && t.status !== 'done' && t.status !== 'archived');
    } else if (todoFilter === 'p1' || todoFilter === 'p2' || todoFilter === 'p3') {
      list = list.filter((t) => t.priority === parseInt(todoFilter[1]) && t.status !== 'done' && t.status !== 'archived');
    } else {
      list = list.filter((t) => t.status !== 'archived');
    }
    if (todoSort === 'priority') {
      list.sort((a, b) => (a.status === 'done' ? 1 : b.status === 'done' ? -1 : (a.priority || 2) - (b.priority || 2)));
    } else if (todoSort === 'due') {
      list.sort((a, b) => (!a.due_at ? 1 : !b.due_at ? -1 : new Date(a.due_at) - new Date(b.due_at)));
    } else {
      list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
  }
  if (!list.length) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');
  // 今日计划：加载简报
  if (todoView === 'today') {
    loadDailyBrief();
  } else {
    const briefCard = $('#dailyBriefCard');
    if (briefCard) briefCard.classList.add('hidden');
  }
  // 今日计划摘要卡片
  if (todoView === 'today') {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const end = new Date(start.getTime() + 86400000);
    const allToday = todoAllCache.filter((t) => {
      if (t.status === 'done' || t.status === 'archived') return false;
      if (t.due_at) { const d = new Date(t.due_at); return (d >= start && d < end) || d < start; }
      return true;
    });
    const overdueCount = allToday.filter((t) => t.due_at && new Date(t.due_at) < start).length;
    const totalActive = todoAllCache.filter((t) => t.status !== 'archived');
    const doneAll = todoAllCache.filter((t) => t.status === 'done');
    const doneRate = totalActive.length ? Math.round((doneAll.length / totalActive.length) * 100) : 0;
    const summaryEl = document.getElementById('todaySummary');
    if (summaryEl) {
      summaryEl.innerHTML =
        '<div class="today-stat"><div class="num mid">' + allToday.length + '</div><div class="lbl">待完成</div></div>' +
        '<div class="today-stat"><div class="num high">' + overdueCount + '</div><div class="lbl">已过期</div></div>' +
        '<div class="today-stat"><div class="num done">' + cnt.done + '</div><div class="lbl">今日完成</div></div>' +
        '<div class="today-stat"><div class="num blue">' + doneRate + '%</div><div class="lbl">总完成率</div></div>';
      summaryEl.classList.remove('hidden');
    }
  } else {
    const summaryEl = document.getElementById('todaySummary');
    if (summaryEl) summaryEl.classList.add('hidden');
  }
  for (const t of list) {
    const el = document.createElement('div');
    const overdue = t.due_at && t.status !== 'done' && new Date(t.due_at) < new Date();
    el.className = 'item p' + (t.priority || 2) + (t.status === 'done' ? ' done' : '') + (overdue ? ' overdue' : '');
    el.dataset.id = t.id;
    const dueInfo = t.due_at ? fmtDue(t.due_at) : null;
    const dueText = dueInfo ? ('截止 ' + dueInfo.text) : '';
    const dueCls = dueInfo ? dueInfo.class : '';
    const catBadge = t.category ? '<span class="badge cat-badge">' + escapeHtml(t.category) + '</span>' : '';
    const recurBadge = t.recur_rule ? '<span class="badge recur-badge" title="重复: ' + t.recur_rule + '">🔄</span>' : '';
    const descPreview = t.notes
      ? '<div class="todo-desc-preview" data-desc="' + encodeURIComponent(t.notes) + '">'
        + renderMarkdown(t.notes.slice(0, 200)) + '</div>'
        + '<button class="todo-desc-toggle" data-id="' + t.id + '">展开详情 ▾</button>'
      : '';
    el.innerHTML = [
      '<input type="checkbox" class="toggle todo-cb" data-id="' + t.id + '" title="选择任务" aria-label="选择任务" />',
      '<input type="checkbox" class="toggle" data-id="' + t.id + '" title="标记完成" aria-label="标记完成"' + (t.status === 'done' ? ' checked' : '') + ' />',
      '<div class="body">',
      '  <div class="title">' + escapeHtml(t.title) + '</div>',
      '  <div class="meta">',
      '    <span class="badge p' + (t.priority || 2) + '">' + ['','🔴 高','🟡 中','🔵 低'][t.priority || 2] + '</span>',
      catBadge,
      recurBadge,
      dueText ? '<span class="' + dueCls + '">' + dueText + '</span>' : '',
      '  </div>',
      descPreview,
      '</div>',
      '<div class="ops">',
      '<button data-id="' + t.id + '" class="del danger">删除</button>',
      (t.status === 'done' ? '<button data-id="' + t.id + '" class="archive-btn">🗄 归档</button>' : ''),
      '</div>'
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
  $$('#todoList .archive-btn').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/todos/' + b.dataset.id, { method: 'PATCH', body: { status: 'archived' } });
    loadTodos();
  }));
  // 描述展开/收起
  $$('.todo-desc-toggle').forEach((btn) => btn.addEventListener('click', () => {
    const preview = btn.previousElementSibling;
    const expanded = preview.classList.toggle('expanded');
    btn.textContent = expanded ? '收起 ▴' : '展开详情 ▾';
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
$$('.view-tab').forEach((b) => b.addEventListener('click', () => {
  todoView = b.dataset.view;
  $$('.view-tab').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  // 切视图时隐藏/显示筛选栏
  const filterBar = document.querySelector('#panel-todos .filter-bar');
  const newBtn = document.getElementById('btnTodoNew');
  if (filterBar) filterBar.classList.toggle('hidden', todoView !== 'all');
  if (newBtn) newBtn.classList.toggle('hidden', todoView === 'archive');
  renderTodos();
}));
$('#todoSort').addEventListener('change', (e) => { todoSort = e.target.value; renderTodos(); });
$('#btnTodoNew').addEventListener('click', () => $('#todoForm').classList.toggle('hidden'));
$('#todoCancel').addEventListener('click', () => $('#todoForm').classList.add('hidden'));

// 快速添加待办（解析优先级 + 分类 + 重复规则）
const PRIORITY_KW = [
  { kw: /^(?:高|重要|紧急|urgent)/i, p: 1 },
  { kw: /^(?:低|不急|稍后)/i, p: 3 },
];
function parseQuickInput(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  let priority = parseInt($('#quickTodoPriority')?.value, 10) || 2;
  for (const r of PRIORITY_KW) {
    if (r.kw.test(text)) { priority = r.p; text = text.replace(r.kw, '').trim(); break; }
  }
  let recurRule = '';
  if (/每天/.test(text)) { recurRule = 'daily'; text = text.replace(/每天/g, '').trim(); }
  else if (/每周/.test(text)) { recurRule = 'weekly'; text = text.replace(/每周/g, '').trim(); }
  let category = '';
  const catColon = text.match(/^([\u4e00-\u9fa5A-Za-z0-9]+)\s*[:：]\s*(.+)$/);
  if (catColon && catColon[1].length <= 8) { category = catColon[1]; text = catColon[2].trim(); }
  else {
    const hashCat = text.match(/[#@]([\u4e00-\u9fa5A-Za-z0-9]+)\s*$/);
    if (hashCat) { category = hashCat[1]; text = text.replace(hashCat[0], '').trim(); }
  }
  text = text.replace(/^[，。、\s]+|[，。、\s]+$/g, '').trim();
  if (!text) return null;
  return { title: text, priority, category: category || null, recur_rule: recurRule || null };
}
function renderQuickHint() {
  const raw = $('#quickTodoInput')?.value;
  const hint = $('#quickTodoHint');
  if (!raw?.trim()) { hint.textContent = ''; return; }
  const parsed = parseQuickInput(raw);
  if (!parsed) { hint.textContent = ''; return; }
  const parts = ['将创建：<b>' + escapeHtml(parsed.title) + '</b>'];
  parts.push(parsed.priority === 1 ? '🔴 高' : parsed.priority === 3 ? '🔵 低' : '🟡 中');
  if (parsed.category) parts.push('分类 <b>' + escapeHtml(parsed.category) + '</b>');
  if (parsed.recur_rule) parts.push(parsed.recur_rule === 'daily' ? '🔄 每天' : '🔄 每周');
  hint.innerHTML = parts.join(' · ');
}
$('#quickTodoInput')?.addEventListener('input', renderQuickHint);
$('#quickTodoPriority')?.addEventListener('change', renderQuickHint);
$('#quickTodoForm')?.addEventListener('submit', async (e) => {
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
function focusQuickTodoOnTab() { setTimeout(() => { const inp = $('#quickTodoInput'); if (inp) inp.focus(); }, 50); }
$$('.tab').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab === 'todos') focusQuickTodoOnTab(); }));
focusQuickTodoOnTab();

// 高级待办表单提交（含 Markdown 描述）
$('#todoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  if (body.due_at) body.due_at = new Date(body.due_at).toISOString();
  if (body.priority) body.priority = parseInt(body.priority, 10);
  try {
    await api('/api/todos', { method: 'POST', body });
    e.target.reset();
    e.target.classList.add('hidden');
    await loadTodos();
  } catch (err) {
    alert('添加失败：' + (err.message || err));
  }
});

// 描述编辑器：编辑/预览切换
$$('.desc-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.desc-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const input = $('.desc-input');
    const preview = $('.desc-preview');
    if (tab.dataset.view === 'preview') {
      input.classList.add('hidden');
      preview.classList.remove('hidden');
      preview.innerHTML = renderMarkdown(input.value || '*（无描述）*');
    } else {
      input.classList.remove('hidden');
      preview.classList.add('hidden');
    }
  });
});

// AI 每日简报
async function loadDailyBrief() {
  const card = $('#dailyBriefCard');
  const text = $('#dailyBriefText');
  if (!card || !text) return;
  card.classList.remove('hidden');
  text.innerHTML = '<span class="muted">正在生成今日建议…</span>';
  try {
    const r = await api('/api/todos/daily-brief');
    text.textContent = r.brief || '暂无简报';
  } catch (e) {
    text.textContent = '简报生成失败：' + (e.message || e);
  }
}
$('#btnRefreshBrief')?.addEventListener('click', loadDailyBrief);

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
  // 默认选中今天（首次加载时）
  if (!calSelected) selectDay(new Date());
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

function switchReminderView(view) {
  const target = view === 'automations' ? 'automations' : 'reminders';
  $$('.rem-view-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.remView === target));
  $('#remindersView')?.classList.toggle('hidden', target !== 'reminders');
  $('#automationsView')?.classList.toggle('hidden', target !== 'automations');
  const newBtn = $('#btnRemNew');
  if (newBtn) newBtn.style.display = target === 'reminders' ? '' : 'none';
  if (target === 'automations') loadAutomations();
  else loadReminders();
}
$$('.rem-view-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchReminderView(btn.dataset.remView));
});

// ===== AI 状态 + LLM 配置 =====
async function refreshAiStatus() {
  try {
    const s = await api('/api/ai/status');
    $('#llmStatus').textContent = s.enabled ? 'LLM 已连接' : 'LLM 未配置';
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
    $('#cfgReasoning').value = c.reasoningEffort || '';
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
      <div class="ustat-ico">∑</div>
      <div class="ustat-body"><div class="ustat-num">${fmt(t.total_tokens)}</div><div class="ustat-lbl">总 Token</div></div>
    </div>
    <div class="ustat">
      <div class="ustat-ico">↓</div>
      <div class="ustat-body"><div class="ustat-num">${fmt(t.prompt_tokens)}</div><div class="ustat-lbl">输入</div></div>
    </div>
    <div class="ustat">
      <div class="ustat-ico">↑</div>
      <div class="ustat-body"><div class="ustat-num">${fmt(t.completion_tokens)}</div><div class="ustat-lbl">输出</div></div>
    </div>
    <div class="ustat">
      <div class="ustat-ico">⚡</div>
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
    if (days.length < 2) {
      chart.innerHTML = '<div class="usage-empty">至少产生两次调用后显示趋势。</div>';
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

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="u-linechart">
    <defs>
      <linearGradient id="uArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--wb-jade)" stop-opacity="0.26"/>
        <stop offset="100%" stop-color="var(--wb-jade)" stop-opacity="0.02"/>
      </linearGradient>
      <linearGradient id="uStroke" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="var(--wb-jade)"/>
        <stop offset="100%" stop-color="var(--wb-jade-strong)"/>
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
  body.reasoningEffort = $('#cfgReasoning').value;
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
  + `  <div class="chat-empty-ico" aria-hidden="true">W</div>`
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

function nowTime(date) {
  return new Date(date || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
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
    .replace(/\[([^\]]+)\]\(\/api\/media\/screenshot\?name=([^)\s]+)\)/g, (_, label, q) =>
      `<img class="chat-shot" src="/api/media/screenshot?name=${q}&amp;token=${encodeURIComponent(getToken())}" alt="${label}" loading="lazy" />`)
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

function renderMessageAttachments(meta) {
  const box = document.createElement('div');
  box.className = 'msg-attachments';
  const attachments = Array.isArray(meta && meta.attachments) ? meta.attachments : [];
  const images = Array.isArray(meta && meta.images) ? meta.images : [];
  attachments.forEach((a) => {
    const chip = document.createElement('span');
    chip.className = 'msg-attachment';
    const kind = a.folder ? '文件夹' : (a.extension || '文件').replace(/^\./, '').toUpperCase();
    chip.textContent = (a.folder ? '📁 ' : '📄 ') + (a.name || '附件') + ' · ' + kind;
    chip.title = a.converted ? `${a.vendor || 'MarkItDown'} 解析 · ${a.characters || 0} 字` : (a.name || '附件');
    box.appendChild(chip);
  });
  images.forEach((img) => {
    const chip = document.createElement('span');
    chip.className = 'msg-attachment image';
    chip.textContent = '🖼 ' + (img.name || '图片');
    box.appendChild(chip);
  });
  return box;
}

function createMessageTrace(meta) {
  const root = document.createElement('details');
  root.className = 'msg-trace hidden';
  root.open = true;
  const head = document.createElement('summary');
  head.innerHTML = '<span class="mt-orb"></span><span class="mt-title">COT · 思考链路</span><span class="mt-count">0</span><span class="mt-state">准备中</span>';
  const list = document.createElement('div');
  list.className = 'mt-list';
  root.appendChild(head);
  root.appendChild(list);
  const trace = {
    root,
    list,
    head,
    items: [],
    countEl: head.querySelector('.mt-count'),
    stateEl: head.querySelector('.mt-state'),
  };

  const saved = Array.isArray(meta && meta.trace) ? meta.trace : [];
  saved.forEach((item) => appendTraceItem(trace, item, true));
  if (saved.length) {
    root.classList.remove('hidden', 'running');
    trace.countEl.textContent = String(saved.length);
    trace.stateEl.textContent = '已完成';
  }
  return trace;
}

function appendTraceItem(trace, item, record = true) {
  if (!trace || !item) return;
  const normalized = {
    icon: item.icon || (item.kind === 'tool' ? '🔧' : '🧠'),
    kind: item.kind || (item.label ? 'thought' : 'tool'),
    label: item.label || item.text || '执行操作',
    detail: item.detail || '',
    time: item.time || new Date().toISOString(),
  };
  const row = document.createElement('div');
  row.className = 'mt-item ' + normalized.kind;
  const marker = document.createElement('div');
  marker.className = 'mt-marker';
  marker.textContent = normalized.icon;
  const body = document.createElement('div');
  body.className = 'mt-body';
  const line = document.createElement('div');
  line.className = 'mt-line';
  const label = document.createElement('span');
  label.className = 'mt-label';
  label.textContent = normalized.label;
  const time = document.createElement('span');
  time.className = 'mt-time';
  time.textContent = nowTime(normalized.time);
  line.appendChild(label);
  line.appendChild(time);
  body.appendChild(line);
  if (normalized.detail) {
    const detail = document.createElement('div');
    detail.className = 'mt-detail';
    detail.textContent = normalized.detail;
    body.appendChild(detail);
  }
  row.appendChild(marker);
  row.appendChild(body);
  trace.list.appendChild(row);
  if (record) trace.items.push(normalized);
  trace.root.classList.remove('hidden');
  trace.countEl.textContent = String(trace.items.length);
  trace.stateEl.textContent = '进行中';
  trace.root.classList.add('running');
  trace.list.scrollTop = trace.list.scrollHeight;
}

function messageTraceAdd(botEl, item) {
  const trace = botEl && botEl.querySelector('.msg-trace');
  if (!trace || !trace.__wbTrace) return;
  appendTraceItem(trace.__wbTrace, item, true);
}

function messageTraceFinish(botEl, state = 'done') {
  const trace = botEl && botEl.querySelector('.msg-trace');
  if (!trace || !trace.__wbTrace) return;
  trace.classList.remove('running');
  trace.classList.toggle('failed', state === 'failed');
  const data = trace.__wbTrace;
  data.stateEl.textContent = state === 'failed'
    ? '已中断'
    : (data.items.length ? `完成 · ${data.items.length}` : '完成');
}

function messageTraceData(botEl) {
  const root = botEl && botEl.querySelector('.msg-trace');
  if (!root || !root.__wbTrace) return [];
  return root.__wbTrace.items.map((item) => ({
    icon: item.icon,
    kind: item.kind,
    label: item.label,
    detail: String(item.detail || '').slice(0, 600),
    time: item.time,
  }));
}

/**
 * 追加一条聊天消息（新蓝白气泡结构）
 * @returns 消息正文的 .text span（供流式更新）
 */
function appendChat(container, role, text, intent, messageMeta) {
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
  if (messageMeta && ((messageMeta.attachments || []).length || (messageMeta.images || []).length)) {
    bubble.appendChild(renderMessageAttachments(messageMeta));
  }
  const span = document.createElement('span');
  span.className = 'text';
  span.textContent = text;
  bubble.appendChild(span);
  let trace = null;
  if (role === 'bot' && messageMeta && Array.isArray(messageMeta.trace) && messageMeta.trace.length) {
    trace = createMessageTrace(messageMeta);
    trace.root.__wbTrace = trace;
    wrap.appendChild(trace.root);
  }
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

  const metaEl = document.createElement('div');
  metaEl.className = 'msg-meta';
  metaEl.textContent = nowTime();
  wrap.appendChild(metaEl);
  el.appendChild(wrap);

  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  span.__trace = trace;
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
  if (typeof cotClear === 'function') cotClear();
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

// ===== 斜杠命令（仿 Codex slash commands） =====
const SLASH_COMMANDS = [
  { cmd: '/plan', desc: '描述任务生成计划', usage: '/plan 给项目加权限系统' },
  { cmd: '/review', desc: '审阅未提交变更', usage: '/review [base]' },
  { cmd: '/goal', desc: '设置持续目标', usage: '/goal 把 WorkBuddy 做成 Codex 复刻' },
  { cmd: '/worktree', desc: '打开工作区 / Worktree 面板', usage: '/worktree' },
  { cmd: '/mcp', desc: '打开 MCP 管理', usage: '/mcp' },
  { cmd: '/automations', desc: '打开 Scheduled tasks', usage: '/automations' },
  { cmd: '/status', desc: '显示系统状态', usage: '/status' },
  { cmd: '/compact', desc: '压缩当前会话上下文', usage: '/compact' },
  { cmd: '/fork', desc: 'Fork 当前会话', usage: '/fork' },
  { cmd: '/task', desc: '创建后台任务', usage: '/task 总结本周未完成事项' },
  { cmd: '/help', desc: '列出所有命令', usage: '/help' },
];
let slashIndex = 0;

function appendSystemMessage(text) {
  const win = $('#chatWindow');
  const { el, bubble } = appendBotSkeleton(win, null);
  bubble.classList.remove('typing');
  bubble.classList.add('md-body');
  bubble.innerHTML = renderMarkdown(text);
  win.scrollTop = win.scrollHeight;
  return el;
}

function renderSlashMenu(value) {
  const menu = document.getElementById('slashMenu');
  if (!menu) return;
  const v = String(value || '');
  if (!v.startsWith('/') || v.includes(' ')) {
    menu.classList.add('hidden');
    menu.innerHTML = '';
    return;
  }
  const list = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(v.toLowerCase()));
  if (!list.length) { menu.classList.add('hidden'); return; }
  slashIndex = Math.min(slashIndex, list.length - 1);
  menu.innerHTML = list.map((c, i) => `<div class="slash-item${i === slashIndex ? ' active' : ''}" data-cmd="${c.cmd}"><b>${c.cmd}</b><span>${escapeHtml(c.desc)}</span></div>`).join('');
  menu.classList.remove('hidden');
  $$('#slashMenu .slash-item').forEach((el) => el.addEventListener('click', () => {
    const inp = $('#chatInput');
    inp.value = el.dataset.cmd + ' ';
    inp.focus();
    renderSlashMenu('');
  }));
}

function moveSlash(delta) {
  const menu = document.getElementById('slashMenu');
  if (!menu || menu.classList.contains('hidden')) return;
  const items = $$('#slashMenu .slash-item');
  if (!items.length) return;
  slashIndex = (slashIndex + delta + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('active', i === slashIndex));
}

function chooseSlashActive() {
  const active = document.querySelector('#slashMenu .slash-item.active') || document.querySelector('#slashMenu .slash-item');
  if (!active) return;
  const inp = $('#chatInput');
  inp.value = active.dataset.cmd + ' ';
  inp.focus();
  renderSlashMenu('');
}

// ===== @file 文件引用补全 =====
let mentionTimer = null;
let mentionIndex = 0;
function insertMention(path) {
  const inp = $('#chatInput');
  inp.value = inp.value.replace(/@([^\s@]*)$/, '@' + path + ' ');
  inp.focus();
  renderMentionMenu('');
}
function renderMentionMenu(value) {
  const menu = document.getElementById('mentionMenu');
  if (!menu) return;
  const m = String(value || '').match(/@([^\s@]*)$/);
  if (!m) { menu.classList.add('hidden'); menu.innerHTML = ''; return; }
  const q = m[1];
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(async () => {
    try {
      const r = await api('/api/files/search?q=' + encodeURIComponent(q) + '&limit=20');
      const items = r.items || [];
      mentionIndex = 0;
      menu.innerHTML = items.map((p, i) => `<div class="slash-item${i === 0 ? ' active' : ''}" data-path="${encodeURIComponent(p)}">📄 ${escapeHtml(p)}</div>`).join('') || '<div class="slash-item">无匹配文件</div>';
      menu.classList.remove('hidden');
      $$('#mentionMenu .slash-item').forEach((el) => el.addEventListener('click', () => {
        if (el.dataset.path) insertMention(decodeURIComponent(el.dataset.path));
      }));
    } catch (_) {
      menu.classList.add('hidden');
    }
  }, 120);
}
function moveMention(delta) {
  const items = $$('#mentionMenu .slash-item');
  if (!items.length) return;
  mentionIndex = (mentionIndex + delta + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('active', i === mentionIndex));
}
function chooseMentionActive() {
  const active = document.querySelector('#mentionMenu .slash-item.active');
  if (active && active.dataset.path) insertMention(decodeURIComponent(active.dataset.path));
}

function switchTab(name) {
  const btn = document.querySelector('.tab[data-tab="' + name + '"]');
  if (btn) btn.click();
}

async function handleSlashCommand(text) {
  const parts = String(text || '').trim().split(/\s+/);
  const cmd = (parts.shift() || '').toLowerCase();
  const rest = parts.join(' ').trim();
  if (cmd === '/help' || !cmd) {
    appendSystemMessage('**可用命令**\n\n' + SLASH_COMMANDS.map((c) => `- \`${c.cmd}\` — ${c.desc}（${c.usage}）`).join('\n'));
    return;
  }
  if (cmd === '/plan') {
    composerState.plan = true;
    localStorage.setItem(PLAN_KEY, '1');
    renderComposerTrigger();
    if (!rest) {
      appendSystemMessage('计划模式已开启。输入任务后发送，我会先生成计划。');
      $('#chatInput')?.focus();
      return;
    }
    const inp = $('#chatInput');
    inp.value = rest;
    sendChat({ planMode: true });
    return;
  }
  if (cmd === '/goal') {
    if (!rest) return appendSystemMessage('用法：`/goal 要持续输出的目标`；也可以点输入区的「目标」状态补成果。');
    composerState.goal = rest;
    localStorage.setItem(GOAL_KEY, rest);
    renderContextChips();
    appendSystemMessage('🎯 已设置持续目标：' + rest);
    return;
  }
  if (cmd === '/review') {
    localStorage.setItem(TK_KEY, '1');
    renderToolkit();
    activateTkMode('review');
    if (rest) $('#reviewBase').value = rest;
    setOut('#reviewResult', '审阅中…');
    try {
      const r = await api('/api/review/run', { method: 'POST', body: { base: rest } });
      setOut('#reviewResult', r.text || r.error || '完成');
      appendSystemMessage('🔍 **Code Review**\n\n' + (r.text || r.error || '完成'));
    } catch (e) {
      appendSystemMessage('审阅失败：' + e.message);
    }
    return;
  }
  if (cmd === '/worktree') {
    localStorage.setItem(TK_KEY, '1');
    renderToolkit();
    activateTkMode('workspace');
    appendSystemMessage('已打开「工作区」面板。');
    return;
  }
  if (cmd === '/mcp') {
    switchTab('ai');
    setTimeout(loadMcp, 50);
    appendSystemMessage('已打开 MCP 管理。');
    return;
  }
  if (cmd === '/automations') {
    switchTab('reminders');
    setTimeout(() => switchReminderView('automations'), 50);
    appendSystemMessage('已打开自动化任务。');
    return;
  }
  if (cmd === '/status') {
    try {
      const [ai, comp, br, mem, autos] = await Promise.all([
        api('/api/ai/status'),
        api('/api/computer/status'),
        api('/api/browser/status'),
        api('/api/memory/stats'),
        api('/api/automations'),
      ]);
      appendSystemMessage([
        '**系统状态**',
        `- LLM：${ai.enabled ? '已配置（' + ai.model + '）' : '未配置'}`,
        `- 电脑：${comp.windows ? '可用' : '不支持'} · 允许命令 ${comp.allow_shell ? '开' : '关'}`,
        `- 浏览器：${br.running ? '运行中' : '未运行'} · ${br.executable ? br.executable.name : '未找到'}`,
        `- 记忆：${mem.total || 0} 条`,
        `- Automations：${(autos.items || []).length} 个`,
      ].join('\n'));
    } catch (e) {
      appendSystemMessage('状态读取失败：' + e.message);
    }
    return;
  }
  if (cmd === '/compact') {
    const sid = getCurrentSessionId();
    if (!sid) return appendSystemMessage('当前没有会话可压缩。');
    try {
      setChatStatus('🧹 正在压缩上下文…');
      const r = await api('/api/chathistory/sessions/' + sid + '/summarize', { method: 'POST', body: {} });
      appendSystemMessage(r.skipped ? '无需压缩：' + r.skipped : `已压缩上下文（摘要 ${r.summaryLen || 0} 字）`);
    } catch (e) {
      appendSystemMessage('压缩失败：' + e.message);
    }
    return;
  }
  if (cmd === '/fork') {
    const sid = getCurrentSessionId();
    if (!sid) return appendSystemMessage('当前没有会话可 Fork。');
    try {
      const fork = await api('/api/chathistory/sessions/' + sid + '/fork', { method: 'POST', body: {} });
      setCurrentSessionId(fork.id);
      await loadSessionList();
      await openSession(fork.id, fork.title);
      appendSystemMessage('已 Fork 当前会话。');
    } catch (e) {
      appendSystemMessage('Fork 失败：' + e.message);
    }
    return;
  }
  if (cmd === '/task') {
    if (!rest) return appendSystemMessage('用法：`/task 要后台执行的任务`');
    try {
      const t = await api('/api/tasks', { method: 'POST', body: { prompt: rest, model: selectedModel() || undefined } });
      appendSystemMessage(`🚀 已创建后台任务 #${t.id}：${t.title}`);
    } catch (e) {
      appendSystemMessage('创建后台任务失败：' + e.message);
    }
    return;
  }
  appendSystemMessage('未知命令：`' + cmd + '`\n\n' + SLASH_COMMANDS.map((c) => `- \`${c.cmd}\` ${c.desc}`).join('\n'));
}

function sendChat(opts = {}) {
  if (chatSending) return; // 正在回复中，忽略重复提交
  const inp = $('#chatInput');
  const v = inp ? inp.value.trim() : '';
  if (!v) return;
  if (v.startsWith('/')) {
    inp.value = '';
    autoResizeInput();
    renderSlashMenu('');
    handleSlashCommand(v);
    return;
  }
  chatSending = true;
  const sendBtn = $('#btnChatSend');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = '0.5'; }
  inp.value = '';
  autoResizeInput();
  sendChatMessage(v, $('#chatWindow'), {
    onStop: $('#btnChatStop'),
    planModeOverride: opts.planMode === true || composerState.plan,
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
  const trace = createMessageTrace(null);
  trace.root.__wbTrace = trace;
  wrap.appendChild(trace.root);
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
  return { el, bubble, trace };
}

/** 审批卡片：等待用户点“批准/拒绝”，后端会阻塞工具执行直到响应 */
function insertApprovalCard(container, botEl, payload) {
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.dataset.id = payload.id;
  card.innerHTML = `
    <div class="approval-head">
      <span class="approval-icon">⏸</span>
      <span class="approval-title">需要批准：${escapeHtml(payload.tool || '工具操作')}</span>
    </div>
    <div class="approval-reason">${escapeHtml(payload.reason || '敏感操作')}</div>
    <div class="approval-args">${escapeHtml(JSON.stringify(payload.args || {}).slice(0, 500))}</div>
    <div class="approval-actions">
      <button class="primary small" data-approve="1">批准执行</button>
      <button class="small" data-approve="0">拒绝</button>
      <span class="approval-status muted">等待你的决定…</span>
    </div>`;
  const decide = async (approved) => {
    const status = card.querySelector('.approval-status');
    card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await api('/api/ai/approval/' + encodeURIComponent(payload.id), {
        method: 'POST',
        body: { approved },
      });
      card.classList.add(approved ? 'approved' : 'denied');
      card.querySelector('.approval-icon').textContent = approved ? '✅' : '⛔';
      status.textContent = approved ? '已批准，继续执行' : '已拒绝';
    } catch (e) {
      status.textContent = '审批失败：' + (e.message || e);
    }
  };
  card.querySelector('[data-approve="1"]').addEventListener('click', () => decide(true));
  card.querySelector('[data-approve="0"]').addEventListener('click', () => decide(false));
  container.insertBefore(card, botEl);
  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage(message, container, opts = {}) {
  if (!message || !message.trim()) return;
  const userMeta = {
    attachments: composerState.attachments.map((a) => ({
      name: a.name || a.path || '附件',
      folder: !!a.folder,
      extension: a.extension || '',
      converted: !!a.converted,
      vendor: a.vendor || '',
      characters: a.characters || 0,
    })),
    images: composerState.images.map((img) => ({ name: img.name || '图片' })),
    goal: composerState.goal || '',
    outcomes: composerState.outcomes || '',
    plan: !!opts.planModeOverride,
    approvalMode: approvalMode(),
  };
  appendChat(container, 'user', message, null, userMeta);
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
        body: JSON.stringify({ role: 'user', content: message, meta: userMeta }),
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
  const withThink = deepThinkEnabled();
  if (withThink) {
    cotBegin();
    setChatStatus('🧠 深入思考中…');
  }
  try {
    const res = await fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
      body: JSON.stringify({
        message,
        enableSearch: webSearchEnabled(),
        deepThink: withThink,
        approvalMode: approvalMode(),
        planMode: opts.planModeOverride === true,
        goal: composerState.goal,
        outcomes: composerState.outcomes,
        attachments: composerState.attachments,
        images: composerState.images,
        model: selectedModel() || undefined,
      }),
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
          messageTraceAdd(botEl, { ...payload, kind: 'tool' });
          if (withThink) cotAdd({ icon: payload.icon || '🔧', label: payload.text || '执行工具', detail: '' });
          setChatStatus('🔧 ' + (payload.text || '执行操作…'));
        } else if (event === 'approval') {
          messageTraceAdd(botEl, {
            icon: '⏸',
            kind: 'approval',
            label: '等待批准：' + (payload.tool || '操作'),
            detail: payload.reason || '',
          });
          insertApprovalCard(container, botEl, payload);
          if (withThink) cotAdd({ icon: '⏸', label: '等待批准：' + (payload.tool || '操作'), detail: payload.reason || '' });
          setChatStatus('⏸ 等待你批准：' + (payload.tool || '操作'));
        } else if (event === 'thought') {
          messageTraceAdd(botEl, { ...payload, kind: 'thought' });
          if (withThink) {
            cotAdd(payload);
            setChatStatus('🧠 ' + (payload.label || '思考中…'));
          }
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
            messageTraceFinish(botEl, 'done');
            saveBotMessage(sessionId, fullText.trim(), {
              trace: messageTraceData(botEl),
              model: selectedModel() || '',
              think: withThink,
              plan: !!opts.planModeOverride,
            }, () => maybeSummarize(sessionId));
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
          messageTraceAdd(botEl, { icon: '❌', kind: 'error', label: '执行失败', detail: raw });
          messageTraceFinish(botEl, 'failed');
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
      messageTraceFinish(botEl, 'failed');
    } else {
      bubble.classList.remove('typing', 'streaming');
      bubble.classList.add('md-body', 'is-error');
      bubble.innerHTML = renderMarkdown('❌ ' + e.message);
      messageTraceAdd(botEl, { icon: '❌', kind: 'error', label: '请求失败', detail: e.message });
      messageTraceFinish(botEl, 'failed');
      setChatStatus('网络错误');
    }
  } finally {
    if (withThink) cotEnd();
    refreshContextMeter();
    if (opts.onStop) opts.onStop.classList.add('hidden');
    if (typeof opts.onSettled === 'function') opts.onSettled();
    // PPT 预览：对话结束后刷新草稿（ppt_* 工具可能已修改）
    if (typeof refreshPptPreview === 'function') setTimeout(refreshPptPreview, 300);
  }
}

// 主对话 Tab 事件
$('#chatInput').addEventListener('input', () => {
  autoResizeInput();
  renderSlashMenu($('#chatInput').value);
  renderMentionMenu($('#chatInput').value);
});
$('#chatInput').addEventListener('keydown', (e) => {
  const mentionMenu = document.getElementById('mentionMenu');
  if (mentionMenu && !mentionMenu.classList.contains('hidden')) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveMention(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      renderMentionMenu('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chooseMentionActive();
      return;
    }
  }
  const slashMenu = document.getElementById('slashMenu');
  if (slashMenu && !slashMenu.classList.contains('hidden')) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSlash(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      renderSlashMenu('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chooseSlashActive();
      return;
    }
  }
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
  btn.setAttribute('aria-pressed', String(webSearchEnabled()));
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
function saveBotMessage(sessionId, content, meta, onSaved) {
  if (!sessionId || !content) { if (onSaved) onSaved(); return; }
  fetch('/api/chathistory/sessions/' + sessionId + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: JSON.stringify({ role: 'bot', content, meta: meta || null }),
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
      box.innerHTML = '<div class="muted session-empty small">还没有历史对话</div>';
      return;
    }
    box.innerHTML = '';
    const groups = new Map();
    for (const s of r.items) {
      const project = s.project || 'WorkBuddy';
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project).push(s);
    }
    for (const [project, list] of groups) {
      const header = document.createElement('div');
      header.className = 'session-group';
      header.textContent = project;
      box.appendChild(header);
      for (const s of list) {
      const el = document.createElement('div');
      el.className = 'session-item' + (Number(s.id) === getCurrentSessionId() ? ' active' : '');
      el.dataset.id = s.id;
      el.innerHTML = `
        <span class="si-icon">💬</span>
        <span class="si-title">${escapeHtml(s.title || '新对话')}</span>
        <button class="si-proj" title="修改项目">📁</button>
        <button class="si-fork" title="Fork 会话">⑂</button>
        <button class="si-del" title="删除会话">✕</button>`;
      // 点击主体 → 回放
      el.querySelector('.si-title').parentElement.addEventListener('click', async (e) => {
        if (e.target.classList.contains('si-del') || e.target.classList.contains('si-fork') || e.target.classList.contains('si-proj')) return;
        await openSession(s.id, s.title);
      });
      el.querySelector('.si-proj').addEventListener('click', async () => {
        const project = prompt('项目名称', s.project || 'WorkBuddy');
        if (project === null) return;
        await api('/api/chathistory/sessions/' + s.id + '/project', { method: 'PATCH', body: { project } });
        loadSessionList();
      });
      el.querySelector('.si-fork').addEventListener('click', async () => {
        const fork = await api('/api/chathistory/sessions/' + s.id + '/fork', { method: 'POST', body: {} });
        setCurrentSessionId(fork.id);
        await loadSessionList();
        await openSession(fork.id, fork.title);
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
    }
  } catch (_) {
    box.innerHTML = '<div class="muted session-empty">加载失败</div>';
  }
}
/** 打开某个历史会话：回放消息到中间区 */
let sessionSearchTimer = null;
$('#sessionSearch').addEventListener('input', () => {
  clearTimeout(sessionSearchTimer);
  const q = $('#sessionSearch').value.trim();
  if (!q) { loadSessionList(); return; }
  sessionSearchTimer = setTimeout(async () => {
    try {
      const r = await api('/api/chathistory/search?q=' + encodeURIComponent(q));
      renderSessionSearch(r.items || []);
    } catch (_) {}
  }, 200);
});
function renderSessionSearch(items) {
  const box = $('#sessionList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="muted session-empty small">没有匹配的会话</div>';
    return;
  }
  box.innerHTML = '';
  items.forEach((it) => {
    const el = document.createElement('div');
    el.className = 'session-item';
    el.innerHTML = `<span class="si-icon">🔎</span><span class="si-title">${escapeHtml(it.title || '会话')}<br><small>${escapeHtml(String(it.content || '').slice(0, 40))}</small></span>`;
    el.addEventListener('click', () => openSession(it.session_id, it.title));
    box.appendChild(el);
  });
}

async function openSession(sessionId, title) {
  closeHistoryDrawer();
  setCurrentSessionId(sessionId);
  const win = $('#chatWindow');
  win.innerHTML = '';
  try {
    const r = await api('/api/chathistory/sessions/' + sessionId + '/messages');
    for (const m of r.items) {
      if (m.role === 'user') {
        appendChat(win, 'user', m.content, null, m.meta);
      } else {
        const span = appendChat(win, 'bot', '', null, m.meta);
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
  refreshContextMeter();
}
function closeHistoryDrawer() {
  const history = $('#chatHistory');
  const backdrop = $('#historyBackdrop');
  if (history) history.classList.remove('mobile-open');
  if (backdrop) backdrop.classList.add('hidden');
  $('#btnHistoryToggle')?.setAttribute('aria-expanded', 'false');
}
$('#btnHistoryToggle')?.addEventListener('click', () => {
  const history = $('#chatHistory');
  const backdrop = $('#historyBackdrop');
  if (!history || !backdrop) return;
  history.classList.add('mobile-open');
  backdrop.classList.remove('hidden');
  $('#btnHistoryToggle').setAttribute('aria-expanded', 'true');
});
$('#btnHistoryClose')?.addEventListener('click', closeHistoryDrawer);
$('#historyBackdrop')?.addEventListener('click', closeHistoryDrawer);
window.addEventListener('resize', () => {
  if (window.innerWidth > 860) closeHistoryDrawer();
});
$('#btnNewChat').addEventListener('click', () => {
  closeHistoryDrawer();
  setCurrentSessionId(null); // 下次发消息自动建新会话
  clearChat();
  setChatStatus('新对话');
  $('#chatInput').focus();
});

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

// ===== 对话工具台：Think + 电脑 / 浏览器 / 记忆 / 技能 =====
const TK_KEY = 'workbuddy_toolkit';
const THINK_KEY = 'workbuddy_deep_think';
let currentTkMode = 'think';
const cotState = { items: [], running: false };

function deepThinkEnabled() {
  return localStorage.getItem(THINK_KEY) === '1';
}
function renderDeepThinkToggle() {
  const btn = $('#btnDeepThink');
  if (!btn) return;
  btn.classList.toggle('on', deepThinkEnabled());
  btn.setAttribute('aria-pressed', String(deepThinkEnabled()));
  btn.title = deepThinkEnabled() ? '深度思考已开启，回复将展示思考链路' : '深度思考已关闭';
}
$('#btnDeepThink').addEventListener('click', () => {
  const on = !deepThinkEnabled();
  localStorage.setItem(THINK_KEY, on ? '1' : '0');
  renderDeepThinkToggle();
  setChatStatus(on ? '🧠 Think 已开启，本次回复会展示思考链路' : 'Think 已关闭');
  if (on) {
    localStorage.setItem(TK_KEY, '1');
    renderToolkit();
    activateTkMode('think');
  } else {
    cotClear();
  }
});

// ===== 三档审批模式 =====
const APPROVAL_KEY = 'workbuddy_approval_mode';
const GOAL_KEY = 'workbuddy_goal';
const OUTCOMES_KEY = 'workbuddy_outcomes';
const PLAN_KEY = 'workbuddy_plan_mode';
const APPROVAL_LABEL = { ask: '请求批准', auto: '帮我批准', full: '完全访问' };
function approvalMode() {
  const v = localStorage.getItem(APPROVAL_KEY);
  return ['ask', 'auto', 'full'].includes(v) ? v : 'ask';
}
function renderApprovalMode() {
  const mode = approvalMode();
  const btn = $('#btnPermission');
  if (!btn) return;
  btn.textContent = '权限：' + (APPROVAL_LABEL[mode] || mode);
  btn.classList.toggle('danger', mode === 'full');
}

// ===== 模型选择器 =====
const MODEL_KEY = 'workbuddy_model';
function selectedModel() {
  return localStorage.getItem(MODEL_KEY) || '';
}
async function initModelPicker() {
  const sel = $('#chatModel');
  if (!sel) return;
  let current = '';
  try {
    const s = await api('/api/ai/status');
    current = s.model || '';
  } catch (_) {}
  const models = [...new Set(['deepseek-chat', 'gpt-4o-mini', 'moonshot-v1-8k', 'qwen-turbo', current].filter(Boolean))];
  sel.innerHTML = '<option value="">默认模型</option>' + models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
  sel.value = selectedModel();
}
$('#chatModel').addEventListener('change', (e) => {
  if (e.target.value) localStorage.setItem(MODEL_KEY, e.target.value);
  else localStorage.removeItem(MODEL_KEY);
  setChatStatus(e.target.value ? '模型：' + e.target.value : '使用默认模型');
});

// ===== Composer：文件和文件夹 / 目标 / 计划模式 =====
const composerState = {
  attachments: [],
  images: [],
  goal: localStorage.getItem(GOAL_KEY) || '',
  outcomes: localStorage.getItem(OUTCOMES_KEY) || '',
  plan: localStorage.getItem(PLAN_KEY) === '1',
};

function openComposerPanel(title, render) {
  const body = $('#panelBody');
  const panel = document.getElementById('composerPanel');
  if (!panel || !body) return;
  const t = document.getElementById('panelTitle');
  if (t) t.textContent = title;
  body.innerHTML = '';
  render(body);
  panel.classList.remove('hidden');
}
function closeComposerPanel() {
  const panel = document.getElementById('composerPanel');
  if (panel) panel.classList.add('hidden');
}
$('#panelClose').addEventListener('click', closeComposerPanel);

function renderContextChips() {
  const box = $('#contextChips');
  if (!box) return;
  box.innerHTML = '';
  if (composerState.goal) {
    const chip = document.createElement('span');
    chip.className = 'context-chip goal';
    chip.innerHTML = `🎯 <b>持续目标</b> ${escapeHtml(composerState.goal.slice(0, 48))} <button title="清除目标">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      composerState.goal = '';
      localStorage.removeItem(GOAL_KEY);
      renderContextChips();
    });
    box.appendChild(chip);
  }
  if (composerState.outcomes) {
    const chip = document.createElement('span');
    chip.className = 'context-chip outcome';
    chip.innerHTML = `📈 <b>成果</b> ${escapeHtml(composerState.outcomes.slice(0, 48))} <button title="清除成果">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      composerState.outcomes = '';
      localStorage.removeItem(OUTCOMES_KEY);
      renderContextChips();
    });
    box.appendChild(chip);
  }
  composerState.attachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'context-chip file';
    const label = a.folder ? `📁 ${a.path}` : `📄 ${a.name || '附件'}`;
    const engine = a.converted ? ` <em>${escapeHtml(a.vendor || 'MarkItDown')}</em>` : '';
    chip.innerHTML = `${escapeHtml(label)}${engine} <button title="移除">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      composerState.attachments.splice(i, 1);
      renderContextChips();
    });
    box.appendChild(chip);
  });
  composerState.images.forEach((img, i) => {
    const chip = document.createElement('span');
    chip.className = 'context-chip image';
    chip.innerHTML = `🖼 ${escapeHtml(img.name || '图片')} <button title="移除">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      composerState.images.splice(i, 1);
      renderContextChips();
    });
    box.appendChild(chip);
  });
  renderComposerTrigger();
}

function renderComposerTrigger() {
  const addBtn = $('#btnComposerAdd');
  if (!addBtn) return;
  const extra = [];
  if (composerState.attachments.length) extra.push(composerState.attachments.length + ' 附件');
  if (composerState.images.length) extra.push(composerState.images.length + ' 图片');
  addBtn.textContent = '＋ 添加' + (extra.length ? ' · ' + extra.join(' / ') : '');
  addBtn.classList.toggle('on', extra.length > 0);

  const hasGoal = Boolean(composerState.goal || composerState.outcomes);
  const goalBtn = $('#btnGoalMode');
  if (goalBtn) {
    goalBtn.classList.toggle('on', hasGoal);
    goalBtn.setAttribute('aria-pressed', String(hasGoal));
    goalBtn.title = hasGoal ? '编辑持续目标和成果' : '设置持续目标';
  }

  const planBtn = $('#btnPlanMode');
  if (planBtn) {
    planBtn.classList.toggle('on', composerState.plan);
    planBtn.setAttribute('aria-pressed', String(composerState.plan));
    planBtn.title = composerState.plan ? '关闭计划模式' : '开启后，下一条及后续消息会先生成计划';
  }

  const input = $('#chatInput');
  if (input) {
    input.placeholder = composerState.plan
      ? '描述任务，先生成一份可执行计划…'
      : '输入消息，Enter 发送，Shift+Enter 换行';
  }
}

function openGoalPanel() {
  openComposerPanel('持续目标', (body) => {
    const goalInput = document.createElement('textarea');
    goalInput.rows = 2;
    goalInput.placeholder = '要持续输出的目标，例如：把 WorkBuddy 做成 Codex 式本地助手';
    goalInput.value = composerState.goal;

    const outcomeInput = document.createElement('textarea');
    outcomeInput.rows = 2;
    outcomeInput.placeholder = '可衡量的成果，例如：对话中自动调用工具并展示 COT 链路';
    outcomeInput.value = composerState.outcomes;

    body.appendChild(goalInput);
    body.appendChild(outcomeInput);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    actions.innerHTML = '<button class="primary small">保存目标</button><button class="small">清除</button>';
    actions.children[0].addEventListener('click', () => {
      composerState.goal = goalInput.value.trim();
      composerState.outcomes = outcomeInput.value.trim();
      if (composerState.goal) localStorage.setItem(GOAL_KEY, composerState.goal);
      else localStorage.removeItem(GOAL_KEY);
      if (composerState.outcomes) localStorage.setItem(OUTCOMES_KEY, composerState.outcomes);
      else localStorage.removeItem(OUTCOMES_KEY);
      renderContextChips();
      closeComposerPanel();
      setChatStatus(composerState.goal ? '目标状态已更新' : '目标状态已清除');
    });
    actions.children[1].addEventListener('click', () => {
      composerState.goal = '';
      composerState.outcomes = '';
      localStorage.removeItem(GOAL_KEY);
      localStorage.removeItem(OUTCOMES_KEY);
      renderContextChips();
      closeComposerPanel();
      setChatStatus('目标状态已清除');
    });
    body.appendChild(actions);
  });
}

$('#btnGoalMode').addEventListener('click', openGoalPanel);
$('#btnPlanMode').addEventListener('click', () => {
  composerState.plan = !composerState.plan;
  if (composerState.plan) localStorage.setItem(PLAN_KEY, '1');
  else localStorage.removeItem(PLAN_KEY);
  renderComposerTrigger();
  setChatStatus(composerState.plan ? '计划模式已开启' : '计划模式已关闭');
  if (composerState.plan) $('#chatInput').focus();
});

$('#btnPermission').addEventListener('click', () => {
  const options = [
    { value: 'ask', title: '请求批准', desc: '敏感操作先弹批准卡片，等你点批准后才执行' },
    { value: 'auto', title: '帮我批准', desc: '沙箱内文件读写自动放行；命令和 GUI 控制仍会询问' },
    { value: 'full', title: '完全访问', desc: '不再请求批准，沙箱放开为 danger-full-access' },
  ];
  openComposerPanel('权限模式', (body) => {
    options.forEach((o) => {
      const el = document.createElement('button');
      el.className = 'permission-option' + (approvalMode() === o.value ? ' active' : '');
      el.innerHTML = `<b>${o.title}</b><span>${o.desc}</span>`;
      el.addEventListener('click', () => {
        localStorage.setItem(APPROVAL_KEY, o.value);
        renderApprovalMode();
        setChatStatus('权限模式：' + o.title);
        closeComposerPanel();
      });
      body.appendChild(el);
    });
  });
});

const DOCUMENT_ACCEPT = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.tsv,.html,.htm,.xml,.json,.txt,.md,.markdown,.rst,.epub,.msg,.ipynb,.rtf,.log,.js,.jsx,.ts,.tsx,.py,.java,.go,.rs,.c,.cpp,.h,.hpp,.cs,.php,.rb,.sh,.ps1,.sql,.yml,.yaml';

async function convertPickedDocument(file) {
  const r = await fetch('/api/ai/documents/convert?name=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      Authorization: 'Bearer ' + getToken(),
    },
    body: file,
  });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
  return payload;
}

function openNativePicker(asFolder, asImage, statusEl) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (asImage) {
    input.accept = 'image/*';
  } else if (asFolder) {
    input.webkitdirectory = true;
    input.setAttribute('webkitdirectory', '');
  } else {
    input.accept = DOCUMENT_ACCEPT;
  }
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []).slice(0, 30);
    let failed = 0;
    for (const f of files) {
      if (asImage) {
        if (f.size > 3_000_000) continue;
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = reject;
            fr.readAsDataURL(f);
          });
          composerState.images.push({ name: f.name, dataUrl });
        } catch (_) {}
        continue;
      }
      const name = asFolder ? (f.webkitRelativePath || f.name) : f.name;
      const extension = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (asFolder) {
        if (f.size > 120_000) continue;
        try {
          const content = (await f.text()).slice(0, 120_000);
          composerState.attachments.push({ name, content, extension });
        } catch (_) {
          failed++;
        }
        continue;
      }
      if (f.size > 25 * 1024 * 1024) {
        failed++;
        if (statusEl) statusEl.textContent = `${f.name} 超过 25 MB，已跳过`;
        continue;
      }
      try {
        if (statusEl) statusEl.textContent = `正在解析 ${f.name}…`;
        setChatStatus(`📄 MarkItDown 解析：${f.name}`);
        const result = await convertPickedDocument(f);
        composerState.attachments.push({
          name,
          extension: result.extension || extension,
          content: result.markdown,
          converted: result.engine === 'markitdown',
          vendor: result.vendor || '',
          characters: result.characters || 0,
          truncated: !!result.truncated,
        });
      } catch (e) {
        failed++;
        if (statusEl) statusEl.textContent = `${f.name} 解析失败：${e.message || e}`;
      }
    }
    renderContextChips();
    if (statusEl && files.length && !failed) {
      statusEl.textContent = `已添加 ${files.length} 个文件，文本将作为本次对话上下文。`;
      setChatStatus('文档上下文已就绪');
    }
  });
  input.click();
}

$('#btnComposerAdd').addEventListener('click', () => {
  openComposerPanel('添加上下文', (body) => {
    const pickRow = document.createElement('div');
    pickRow.className = 'modal-actions';
    pickRow.innerHTML = '<button class="primary small">选择文件</button><button class="small">选择文件夹</button><button class="small">选择图片</button>';
    body.appendChild(pickRow);
    const status = document.createElement('p');
    status.className = 'modal-tip';
    status.textContent = 'PDF · Word · PPT · Excel · EPUB · 代码与文本';
    body.appendChild(status);
    pickRow.children[0].addEventListener('click', () => openNativePicker(false, false, status));
    pickRow.children[1].addEventListener('click', () => openNativePicker(true, false, status));
    pickRow.children[2].addEventListener('click', () => openNativePicker(false, true, status));
  });
});

function toolkitOpen() {
  return localStorage.getItem(TK_KEY) === '1';
}
function renderToolkit() {
  const tk = $('#chatToolkit');
  if (!tk) return;
  const open = toolkitOpen();
  tk.classList.toggle('hidden', !open);
  document.body.classList.toggle('toolkit-open', open);
  const btn = $('#btnToolkitToggle');
  if (btn) {
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', String(open));
  }
}
$('#btnToolkitToggle').addEventListener('click', () => {
  localStorage.setItem(TK_KEY, toolkitOpen() ? '0' : '1');
  renderToolkit();
  if (toolkitOpen()) activateTkMode(currentTkMode);
});
$('#btnTkClose').addEventListener('click', () => {
  localStorage.setItem(TK_KEY, '0');
  renderToolkit();
});

function activateTkMode(mode) {
  currentTkMode = mode;
  $$('.tk-mode').forEach((b) => b.classList.toggle('active', b.dataset.tkMode === mode));
  $$('.tk-pane').forEach((v) => v.classList.toggle('active', v.id === 'tk-pane-' + mode));
  if (mode === 'computer') refreshComputer();
  if (mode === 'browser') refreshBrowser();
  if (mode === 'memory') loadMemories();
  if (mode === 'review') loadReview();
  if (mode === 'workspace') { loadWorkspace(); loadWorkspaceFiles(wsCurrentPath || '.'); }
  if (mode === 'tasks') loadTasks();
  if (mode === 'remote') loadRemote();
  if (mode === 'skills') loadSkills();
  refreshCapabilityStatus();
}
$$('.tk-mode').forEach((btn) => btn.addEventListener('click', () => activateTkMode(btn.dataset.tkMode)));

// ===== Review 面板（仿 Codex /review） =====
async function loadReview() {
  const base = $('#reviewBase').value.trim();
  const url = '/api/review/status' + (base ? '?base=' + encodeURIComponent(base) : '');
  try {
    const [r, filesRes] = await Promise.all([api(url), api('/api/review/files')]);
    setOut('#reviewStatus', r.has_changes ? '有未提交变更' : '工作区干净，无未提交变更');
    setOut('#reviewDiff', (r.diff || '').slice(0, 20_000) || '(no diff)');
    renderReviewFiles(filesRes.items || []);
  } catch (e) {
    setOut('#reviewStatus', '读取失败：' + (e.message || e));
  }
}
function renderReviewFiles(items) {
  const box = $('#reviewFiles');
  if (!box) return;
  if (!items.length) { box.innerHTML = '<div class="muted">没有变更文件</div>'; return; }
  box.innerHTML = '';
  items.forEach((f, idx) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<div class="body"><div class="title"><span class="badge">${escapeHtml(f.status || 'M')}</span> ${escapeHtml(f.path)}</div><pre class="computer-output hidden" data-hunks-out="${idx}"></pre></div><div class="ops"><button class="ghost small" data-hunks="${idx}" data-file="${encodeURIComponent(f.path)}">Hunks</button><button class="ghost small" data-stage="${encodeURIComponent(f.path)}">暂存</button><button class="ghost small" data-unstage="${encodeURIComponent(f.path)}">取消暂存</button><button class="ghost small danger" data-discard="${encodeURIComponent(f.path)}">丢弃</button></div>`;
    box.appendChild(el);
  });
  $$('#reviewFiles [data-hunks]').forEach((b) => b.addEventListener('click', async () => {
    const out = document.querySelector('[data-hunks-out="' + b.dataset.hunks + '"]');
    const file = decodeURIComponent(b.dataset.file);
    if (!out) return;
    if (!out.classList.contains('hidden')) { out.classList.add('hidden'); return; }
    try {
      const r = await api('/api/review/hunks?path=' + encodeURIComponent(file));
      const hunks = r.hunks || [];
      out.innerHTML = hunks.map((h) => `<div class="hunk-block"><div class="hunk-head"><span>hunk ${h.index + 1}</span><span><button class="small" data-stage-hunk="${h.index}">暂存</button><button class="small" data-unstage-hunk="${h.index}">取消暂存</button><button class="small danger" data-discard-hunk="${h.index}">丢弃</button></span></div><pre>${escapeHtml(h.text)}</pre></div>`).join('') || '没有 hunk';
      out.classList.remove('hidden');
      $$('[data-hunks-out="' + b.dataset.hunks + '"] [data-stage-hunk]').forEach((sb) => sb.addEventListener('click', async () => {
        await api('/api/review/stage-hunks', { method: 'POST', body: { path: file, indexes: [Number(sb.dataset.stageHunk)] } });
        loadReview();
      }));
      $$('[data-hunks-out="' + b.dataset.hunks + '"] [data-unstage-hunk]').forEach((sb) => sb.addEventListener('click', async () => {
        await api('/api/review/unstage-hunks', { method: 'POST', body: { path: file, indexes: [Number(sb.dataset.unstageHunk)] } });
        loadReview();
      }));
      $$('[data-hunks-out="' + b.dataset.hunks + '"] [data-discard-hunk]').forEach((sb) => sb.addEventListener('click', async () => {
        if (!confirm('丢弃这个 hunk？此操作不可撤销。')) return;
        await api('/api/review/discard-hunks', {
          method: 'POST',
          body: { path: file, indexes: [Number(sb.dataset.discardHunk)], fullAccess: approvalMode() === 'full' },
        });
        loadReview();
      }));
    } catch (e) {
      out.textContent = '读取 hunks 失败：' + e.message;
      out.classList.remove('hidden');
    }
  }));
  $$('#reviewFiles [data-stage]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/review/stage', { method: 'POST', body: { path: decodeURIComponent(b.dataset.stage) } });
    loadReview();
  }));
  $$('#reviewFiles [data-unstage]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/review/unstage', { method: 'POST', body: { path: decodeURIComponent(b.dataset.unstage) } });
    loadReview();
  }));
  $$('#reviewFiles [data-discard]').forEach((b) => b.addEventListener('click', async () => {
    const p = decodeURIComponent(b.dataset.discard);
    if (!confirm('丢弃 ' + p + ' 的未提交变更？此操作不可撤销。')) return;
    try {
      await api('/api/review/discard', { method: 'POST', body: { path: p, fullAccess: approvalMode() === 'full' } });
      loadReview();
    } catch (e) {
      setOut('#reviewStatus', '丢弃失败：' + (e.message || e));
    }
  }));
}
$('#btnReviewRefresh').addEventListener('click', loadReview);
$('#btnReviewRun').addEventListener('click', async () => {
  const btn = $('#btnReviewRun');
  btn.disabled = true;
  setOut('#reviewResult', '审阅中…');
  try {
    const base = $('#reviewBase').value.trim();
    const r = await api('/api/review/run', { method: 'POST', body: { base } });
    setOut('#reviewResult', r.text || r.error || '完成');
    loadReview();
  } catch (e) {
    setOut('#reviewResult', '审阅失败：' + (e.message || e));
  } finally {
    btn.disabled = false;
  }
});

// ===== 工作区 / Worktree handoff =====
function parseWorktrees(output) {
  const list = [];
  for (const block of String(output || '').split(/\n\s*\n/)) {
    if (!block.trim()) continue;
    const item = {};
    for (const line of block.split(/\r?\n/)) {
      const idx = line.indexOf(' ');
      if (idx < 0) continue;
      const k = line.slice(0, idx);
      const v = line.slice(idx + 1).trim();
      if (k === 'worktree') item.path = v;
      if (k === 'branch') item.branch = v.replace(/^refs\/heads\//, '');
      if (k === 'HEAD') item.head = v;
    }
    if (item.path) list.push(item);
  }
  return list;
}

async function loadWorkspace() {
  const sid = getCurrentSessionId();
  if (!sid) {
    setOut('#workspaceEnv', '当前没有会话，先发一条消息再绑定工作区');
    const box = $('#worktreeList');
    if (box) box.innerHTML = '';
    return;
  }
  try {
    const env = await api('/api/chathistory/sessions/' + sid + '/environment');
    setOut('#workspaceEnv', env.workspace_mode === 'worktree'
      ? `Worktree：${env.worktree_path || ''}${env.worktree_branch ? '（' + env.worktree_branch + '）' : ''}`
      : 'Local：直接在当前项目目录工作');
    const r = await api('/api/worktrees');
    renderWorktreeList(parseWorktrees(r.output));
  } catch (e) {
    setOut('#workspaceEnv', '读取失败：' + (e.message || e));
  }
}

function renderWorktreeList(items) {
  const box = $('#worktreeList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="muted">没有 worktree</div>';
    return;
  }
  box.innerHTML = '';
  items.forEach((w) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<div class="body"><div class="title">${escapeHtml(w.path)}</div><div class="meta">${escapeHtml(w.branch || 'detached')} · ${escapeHtml(w.head || '')}</div></div><div class="ops"><button class="ghost small" data-bind="${encodeURIComponent(w.path)}">绑定到当前会话</button></div>`;
    box.appendChild(el);
  });
  $$('#worktreeList [data-bind]').forEach((b) => b.addEventListener('click', async () => {
    const sid = getCurrentSessionId();
    if (!sid) return;
    const path = decodeURIComponent(b.dataset.bind);
    await api('/api/chathistory/sessions/' + sid + '/environment', {
      method: 'PATCH',
      body: { workspace_mode: 'worktree', worktree_path: path },
    });
    loadWorkspace();
  }));
}

$('#btnWorktreeRefresh').addEventListener('click', loadWorkspace);
$('#btnWorkspaceLocal').addEventListener('click', async () => {
  const sid = getCurrentSessionId();
  if (!sid) return;
  await api('/api/chathistory/sessions/' + sid + '/environment', {
    method: 'PATCH',
    body: { workspace_mode: 'local' },
  });
  loadWorkspace();
});
$('#btnWorktreeCreate').addEventListener('click', async () => {
  const sid = getCurrentSessionId();
  if (!sid) { setOut('#workspaceEnv', '当前没有会话'); return; }
  const path = $('#wtPath').value.trim();
  const branch = $('#wtBranch').value.trim();
  if (!path) { $('#wtPath').focus(); return; }
  try {
    await api('/api/chathistory/sessions/' + sid + '/worktree', {
      method: 'POST',
      body: { path, branch, fullAccess: approvalMode() === 'full' },
    });
    setOut('#workspaceEnv', '已创建并绑定 worktree');
    loadWorkspace();
  } catch (e) {
    setOut('#workspaceEnv', '创建失败：' + (e.message || e));
  }
});

// ===== 工作区文件浏览 =====
let wsCurrentPath = '.';
let wsCurrentFile = null;
async function loadWorkspaceFiles(p) {
  wsCurrentPath = p || '.';
  setOut('#wsPath', wsCurrentPath);
  const box = $('#wsList');
  if (!box) return;
  try {
    const r = await api('/api/files/list?path=' + encodeURIComponent(wsCurrentPath));
    const items = (r.items || []).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    box.innerHTML = '';
    if (wsCurrentPath !== '.') {
      const up = document.createElement('div');
      up.className = 'session-item';
      up.innerHTML = '<span class="si-icon">⬆️</span><span class="si-title">..</span>';
      up.addEventListener('click', () => loadWorkspaceFiles(wsCurrentPath.split('/').slice(0, -1).join('/') || '.'));
      box.appendChild(up);
    }
    items.forEach((it) => {
      const el = document.createElement('div');
      el.className = 'session-item';
      const rel = wsCurrentPath === '.' ? it.name : wsCurrentPath + '/' + it.name;
      el.innerHTML = `<span class="si-icon">${it.type === 'dir' ? '📁' : '📄'}</span><span class="si-title">${escapeHtml(it.name)}</span>${it.type === 'file' ? `<button class="ghost small" data-add-ctx="${encodeURIComponent(rel)}">＋上下文</button>` : ''}`;
      el.addEventListener('click', async (e) => {
        if (e.target.closest('[data-add-ctx]')) return;
        if (it.type === 'dir') loadWorkspaceFiles(rel);
        else {
          try {
            const f = await api('/api/files/read?path=' + encodeURIComponent(rel) + '&limit=20000');
            setOut('#wsPreview', f.content || '(空文件)');
            wsCurrentFile = rel;
            const editBtn = $('#btnWsEdit');
            if (editBtn) editBtn.disabled = false;
          } catch (err) {
            setOut('#wsPreview', '读取失败：' + err.message);
          }
        }
      });
      el.querySelector('[data-add-ctx]')?.addEventListener('click', () => {
        composerState.attachments.push({ path: rel });
        renderContextChips();
        setOut('#wsPreview', '已加入上下文：' + rel);
      });
      box.appendChild(el);
    });
  } catch (e) {
    box.innerHTML = '<div class="muted">读取失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}
$('#btnWsRoot').addEventListener('click', () => loadWorkspaceFiles('.'));
$('#btnWsEdit').addEventListener('click', () => {
  if (!wsCurrentFile) return;
  const editor = $('#wsEditor');
  editor.value = $('#wsPreview').textContent || '';
  editor.classList.remove('hidden');
  $('#wsPreview').classList.add('hidden');
  $('#btnWsSave').classList.remove('hidden');
});
$('#btnWsSave').addEventListener('click', async () => {
  if (!wsCurrentFile) return;
  try {
    await api('/api/files/write', { method: 'POST', body: { path: wsCurrentFile, content: $('#wsEditor').value } });
    setOut('#wsPreview', $('#wsEditor').value);
    $('#wsEditor').classList.add('hidden');
    $('#wsPreview').classList.remove('hidden');
    $('#btnWsSave').classList.add('hidden');
    setOut('#wsPath', wsCurrentPath + ' · 已保存 ' + wsCurrentFile);
  } catch (e) {
    setOut('#wsPath', '保存失败：' + e.message);
  }
});

// ===== 后台任务（本地 cloud task 等价） =====
let taskFilter = 'all';
async function loadTasks() {
  const box = $('#taskList');
  if (!box) return;
  try {
    const r = await api('/api/tasks' + (taskFilter !== 'all' ? '?type=' + encodeURIComponent(taskFilter) : ''));
    renderTasks(r.items || []);
    $$('.task-filter').forEach((b) => b.classList.toggle('active', b.dataset.taskFilter === taskFilter));
  } catch (e) {
    box.innerHTML = '<div class="muted">加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}
function renderTasks(items) {
  const box = $('#taskList');
  if (!box) return;
  if (!items.length) { box.innerHTML = '<div class="muted">暂无后台任务</div>'; return; }
  box.innerHTML = '';
  items.forEach((t) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<div class="body"><div class="title">#${t.id} ${escapeHtml(t.title)} <span class="badge">${escapeHtml(t.type || 'task')}</span> <span class="badge">${escapeHtml(t.status)}</span></div><div class="meta">${escapeHtml((t.prompt || '').slice(0, 100))}</div><pre class="computer-output hidden" data-task-out="${t.id}">${escapeHtml(t.result || t.error || '')}</pre></div><div class="ops"><button class="ghost small" data-task-view="${t.id}">结果</button><button class="ghost small" data-task-cancel="${t.id}">取消</button><button class="ghost small danger" data-task-del="${t.id}">删除</button></div>`;
    box.appendChild(el);
  });
  $$('#taskList [data-task-view]').forEach((b) => b.addEventListener('click', () => {
    const out = document.querySelector('[data-task-out="' + b.dataset.taskView + '"]');
    if (out) out.classList.toggle('hidden');
  }));
  $$('#taskList [data-task-cancel]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/tasks/' + b.dataset.taskCancel + '/cancel', { method: 'POST' });
    loadTasks();
  }));
  $$('#taskList [data-task-del]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/tasks/' + b.dataset.taskDel, { method: 'DELETE' });
    loadTasks();
  }));
}
$('#btnTasksRefresh').addEventListener('click', loadTasks);
$$('.task-filter').forEach((b) => b.addEventListener('click', () => {
  taskFilter = b.dataset.taskFilter || 'all';
  loadTasks();
}));
$('#btnTaskCreate').addEventListener('click', async () => {
  const prompt = $('#taskPrompt').value.trim();
  if (!prompt) { $('#taskPrompt').focus(); return; }
  try {
    await api('/api/tasks', { method: 'POST', body: { prompt, model: selectedModel() || undefined } });
    $('#taskPrompt').value = '';
    loadTasks();
  } catch (e) {
    setOut('#workspaceEnv', '创建任务失败：' + e.message);
  }
});

// ===== 远程主机 / Handoff =====
async function loadRemote() {
  const box = $('#remoteList');
  if (!box) return;
  try {
    const r = await api('/api/remote/hosts');
    const items = r.items || [];
    const sel = $('#remoteHostSelect');
    if (sel) sel.innerHTML = items.map((h) => `<option value="${escapeHtml(h.name)}">${escapeHtml(h.name)}</option>`).join('');
    renderRemoteList(items);
  } catch (e) {
    box.innerHTML = '<div class="muted">加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}
function renderRemoteList(items) {
  const box = $('#remoteList');
  if (!box) return;
  if (!items.length) { box.innerHTML = '<div class="muted">还没有远程主机</div>'; return; }
  box.innerHTML = '';
  items.forEach((h) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<div class="body"><div class="title">${escapeHtml(h.name)}</div><div class="meta">${escapeHtml(h.baseUrl)} · token ${h.has_token ? '已配置' : '未配置'}</div></div><div class="ops"><button class="ghost small" data-rtest="${h.name}">测试</button><button class="ghost small danger" data-rdel="${h.name}">删除</button></div>`;
    box.appendChild(el);
  });
  $$('#remoteList [data-rtest]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api('/api/remote/hosts/' + encodeURIComponent(b.dataset.rtest) + '/test', { method: 'POST' });
      setOut('#remoteOutput', `✅ ${b.dataset.rtest} 可用\n` + JSON.stringify(r.health, null, 2));
    } catch (e) {
      setOut('#remoteOutput', '测试失败：' + e.message);
    }
  }));
  $$('#remoteList [data-rdel]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/remote/hosts/' + encodeURIComponent(b.dataset.rdel), { method: 'DELETE' });
    loadRemote();
  }));
}
$('#btnRemoteRefresh').addEventListener('click', loadRemote);
$('#btnRemoteSave').addEventListener('click', async () => {
  try {
    await api('/api/remote/hosts', {
      method: 'POST',
      body: { name: $('#remoteName').value.trim(), baseUrl: $('#remoteUrl').value.trim(), token: $('#remoteToken').value },
    });
    $('#remoteName').value = '';
    $('#remoteUrl').value = '';
    $('#remoteToken').value = '';
    loadRemote();
  } catch (e) {
    setOut('#remoteOutput', '保存失败：' + e.message);
  }
});
$('#btnRemoteRun').addEventListener('click', async () => {
  const host = $('#remoteHostSelect').value;
  const prompt = $('#remotePrompt').value.trim();
  if (!host || !prompt) { setOut('#remoteOutput', '请选择主机并填写任务'); return; }
  try {
    const r = await api('/api/remote/hosts/' + encodeURIComponent(host) + '/run', {
      method: 'POST',
      body: { prompt, model: selectedModel() || undefined },
    });
    setOut('#remoteOutput', (r.result && r.result.reply) || JSON.stringify(r, null, 2));
  } catch (e) {
    setOut('#remoteOutput', '远程运行失败：' + e.message);
  }
});
$('#btnRemoteHandoff').addEventListener('click', async () => {
  const host = $('#remoteHostSelect').value;
  const sid = getCurrentSessionId();
  if (!host) { setOut('#remoteOutput', '请选择主机'); return; }
  if (!sid) { setOut('#remoteOutput', '当前没有会话可 handoff'); return; }
  try {
    const r = await api('/api/remote/hosts/' + encodeURIComponent(host) + '/handoff', { method: 'POST', body: { sessionId: sid } });
    setOut('#remoteOutput', `✅ 已 handoff 到 ${host}\n远程会话 #${r.remoteSessionId}（${r.messages} 条消息）`);
  } catch (e) {
    setOut('#remoteOutput', 'Handoff 失败：' + e.message);
  }
});

// ===== COT 思考链路 =====
function cotAdd(item) {
  cotState.items.push({
    id: 'cot-' + (cotState.items.length + 1),
    time: new Date(),
    icon: item.icon || '🧠',
    label: item.label || '思考',
    detail: item.detail || '',
  });
  renderCOT();
}
function renderCOT() {
  const box = $('#cotTrace');
  if (!box) return;
  if (!cotState.items.length) {
    box.innerHTML = '<div class="cot-empty">开启「Think」后，助手会在这里展示每一步推理</div>';
    return;
  }
  box.innerHTML = cotState.items.map((it) => `
    <div class="cot-item${cotState.running ? ' is-running' : ''}">
      <div class="cot-marker">${it.icon}</div>
      <div class="cot-line">
        <div class="cot-head">
          <span class="cot-label">${escapeHtml(it.label)}</span>
          <span class="cot-time">${nowTime(it.time)}</span>
        </div>
        ${it.detail ? `<div class="cot-detail">${escapeHtml(it.detail)}</div>` : ''}
      </div>
    </div>`).join('');
  box.scrollTop = box.scrollHeight;
}
function cotBegin() {
  cotState.items = [];
  cotState.running = true;
  renderCOT();
}
function cotEnd() {
  cotState.running = false;
  renderCOT();
}
function cotClear() {
  cotBegin();
}
$('#btnCOTClear').addEventListener('click', cotClear);

async function refreshCapabilityStatus() {
  try {
    const [c, b, a] = await Promise.all([
      api('/api/computer/status'),
      api('/api/browser/status'),
      api('/api/ai/status'),
    ]);
    const llm = a.enabled ? 'LLM 就绪' : 'LLM 未配置';
    const comp = c.windows ? '电脑可用' : '电脑不支持';
    const br = b.executable ? (b.executable.name || '浏览器') + (b.running ? ' 运行中' : ' 可用') : '浏览器未找到';
    setOut('#capStatusLine', `${llm} · ${comp} · ${br}`);
  } catch (e) {
    setOut('#capStatusLine', '状态读取失败：' + (e.message || e));
  }
}

function setOut(id, text) {
  const el = $(id);
  if (el && el.textContent !== undefined) el.textContent = text;
}

function shotUrl(r) {
  const sep = r.url.includes('?') ? '&' : '?';
  return r.url + sep + 'token=' + encodeURIComponent(getToken());
}

function showShotInto(stage, r) {
  stage.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.style.display = 'inline-block';
  const img = document.createElement('img');
  img.src = shotUrl(r);
  img.alt = '截图';
  const meta = { width: r.width || 1, height: r.height || 1 };
  img.addEventListener('load', () => {
    meta.width = img.naturalWidth || meta.width;
    meta.height = img.naturalHeight || meta.height;
  });
  img.addEventListener('click', (e) => {
    const rect = img.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * (meta.width / rect.width));
    const y = Math.round((e.clientY - rect.top) * (meta.height / rect.height));
    const cx = $('#compX'), cy = $('#compY');
    if (cx && cy) { cx.value = x; cy.value = y; }
    setOut('#compXY', x + ', ' + y);
    wrap.querySelectorAll('.shot-marker').forEach((m) => m.remove());
    const dot = document.createElement('div');
    dot.className = 'shot-marker';
    dot.style.left = (e.clientX - rect.left) + 'px';
    dot.style.top = (e.clientY - rect.top) + 'px';
    wrap.appendChild(dot);
  });
  wrap.appendChild(img);
  stage.appendChild(wrap);
}

// ===== Computer Use =====
let compWindows = [];
let compWindowId = null;

async function refreshComputer() {
  try {
    const s = await api('/api/computer/status');
    setOut('#compStatus', (s.windows ? 'Windows ' + s.os_version : '不支持') + ' · 允许命令 ' + (s.allow_shell ? '开' : '关'));
    const cb = $('#compAllowShell');
    if (cb) cb.checked = !!s.allow_shell;
    await loadComputerWindows();
  } catch (e) {
    setOut('#compStatus', '❌ ' + (e.message || e));
  }
}

async function loadComputerWindows() {
  try {
    const r = await api('/api/computer/windows');
    compWindows = r.windows || [];
    const sel = $('#compWinSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">全屏</option>';
    compWindows.slice(0, 60).forEach((w) => {
      const o = document.createElement('option');
      o.value = w.handle;
      o.textContent = `${w.title.slice(0, 42)}（${w.process}）`;
      sel.appendChild(o);
    });
    if (compWindowId && compWindows.some((w) => Number(w.handle) === Number(compWindowId))) sel.value = compWindowId;
  } catch (e) {
    setOut('#compOutput', '窗口加载失败：' + (e.message || e));
  }
}

$('#compWinSelect').addEventListener('change', (e) => {
  compWindowId = e.target.value ? Number(e.target.value) : null;
});

async function computerAction(path, body) {
  try {
    const r = await api(path, { method: 'POST', body });
    setOut('#compOutput', JSON.stringify(r, null, 2));
    return r;
  } catch (e) {
    setOut('#compOutput', '❌ ' + (e.message || e));
    return null;
  }
}

$('#compRefresh').addEventListener('click', loadComputerWindows);
$('#compShotFull').addEventListener('click', async () => {
  const r = await computerAction('/api/computer/screenshot', { windowId: null });
  if (r && r.url) {
    showShotInto($('#compShotStage'), r);
    setOut('#compShotName', r.name + ' · ' + r.width + '×' + r.height);
  }
});
$('#compShotWin').addEventListener('click', async () => {
  const r = await computerAction('/api/computer/screenshot', { windowId: compWindowId || null });
  if (r && r.url) {
    showShotInto($('#compShotStage'), r);
    setOut('#compShotName', r.name + ' · ' + r.width + '×' + r.height);
  }
});

function compXY() {
  return { x: parseInt($('#compX').value, 10) || 0, y: parseInt($('#compY').value, 10) || 0 };
}
$('#compMove').addEventListener('click', () => computerAction('/api/computer/mouse', { ...compXY(), action: 'move' }));
$('#compClick').addEventListener('click', () => computerAction('/api/computer/mouse', { ...compXY(), action: 'click' }));
$('#compDblClick').addEventListener('click', () => computerAction('/api/computer/mouse', { ...compXY(), action: 'dblclick' }));
$('#compRightClick').addEventListener('click', () => computerAction('/api/computer/mouse', { ...compXY(), action: 'rightclick' }));
$('#compScrollUp').addEventListener('click', () => computerAction('/api/computer/scroll', { dx: 0, dy: -1 }));
$('#compScrollDown').addEventListener('click', () => computerAction('/api/computer/scroll', { dx: 0, dy: 1 }));
$('#compTypeBtn').addEventListener('click', () => computerAction('/api/computer/type', { text: $('#compType').value }));
$('#compKeyBtn').addEventListener('click', () => {
  const key = $('#compKey').value;
  if (!key) { setOut('#compOutput', '请选择按键'); return; }
  computerAction('/api/computer/key', { key });
});
$('#compRun').addEventListener('click', () => computerAction('/api/computer/run', { command: $('#compCmd').value }));
$('#compAllowShell').addEventListener('change', async (e) => {
  try {
    const r = await api('/api/computer/allow-shell', { method: 'PATCH', body: { enabled: e.target.checked } });
    setOut('#compOutput', '允许执行系统命令：' + (r.allow_shell ? '开' : '关'));
    refreshComputer();
  } catch (err) {
    setOut('#compOutput', '切换失败：' + (err.message || err));
    e.target.checked = !e.target.checked;
  }
});

// ===== Browser Use =====
let brActiveTab = null;

async function refreshBrowser() {
  try {
    const s = await api('/api/browser/status');
    const exe = s.executable ? (s.executable.name || pathName(s.executable.path)) : '未找到';
    setOut('#brStatus', (s.running ? '运行中 · port ' + s.port : '未运行') + ' · ' + exe + (s.headless ? ' · 无头' : ''));
    renderBrowserTabs(s.tabs || []);
  } catch (e) {
    setOut('#brStatus', '❌ ' + (e.message || e));
  }
}
function pathName(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1];
}
function renderBrowserTabs(tabs) {
  const sel = $('#brTabSelect');
  if (!sel) return;
  sel.innerHTML = '';
  if (!tabs.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '没有标签页';
    sel.appendChild(o);
    brActiveTab = null;
    return;
  }
  if (!tabs.some((t) => t.id === brActiveTab)) brActiveTab = tabs[0].id;
  tabs.forEach((t) => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = (t.title || t.url || '新标签').slice(0, 42);
    sel.appendChild(o);
  });
  sel.value = brActiveTab;
}

$('#brTabSelect').addEventListener('change', (e) => { brActiveTab = e.target.value || null; });

async function brAction(path, body = {}) {
  if (body.tabId === undefined) body.tabId = brActiveTab;
  return computerAction(path, body);
}

$('#brStart').addEventListener('click', async () => {
  const r = await computerAction('/api/browser/start', { url: $('#brOpenUrl').value.trim() || undefined });
  if (r && r.tabs) renderBrowserTabs(r.tabs);
  refreshBrowser();
});
$('#brStop').addEventListener('click', async () => {
  await computerAction('/api/browser/stop', {});
  refreshBrowser();
});
$('#brNav').addEventListener('click', async () => {
  const url = $('#brUrl').value.trim();
  if (!url) { setOut('#brSnapshotOut', '请填写网址'); return; }
  const r = await brAction('/api/browser/navigate', { url: /^https?:\/\//i.test(url) ? url : 'https://' + url });
  if (r && r.render) setOut('#brSnapshotOut', r.render);
  refreshBrowser();
});
$('#brSnapshot').addEventListener('click', async () => {
  const r = await brAction('/api/browser/snapshot');
  if (r && r.render) setOut('#brSnapshotOut', r.render);
});
$('#brScreenshot').addEventListener('click', async () => {
  const r = await brAction('/api/browser/screenshot');
  if (r && r.url) showShotInto($('#brShotStage'), r);
});
$('#brCloseTab').addEventListener('click', async () => {
  const r = await computerAction('/api/browser/close', { tabId: brActiveTab });
  if (r && r.tabs) renderBrowserTabs(r.tabs);
  refreshBrowser();
});
$('#brClick').addEventListener('click', () => brAction('/api/browser/click', { selector: $('#brSelector').value, text: $('#brText').value }));
$('#brTypeBtn').addEventListener('click', async () => {
  const r = await brAction('/api/browser/type', { selector: $('#brSelector').value, text: $('#brText').value });
  if (r && r.ok) setOut('#brSnapshotOut', '✅ 已输入 ' + r.chars + ' 字符');
  refreshBrowser();
});
$('#brKeyEnter').addEventListener('click', () => brAction('/api/browser/key', { key: 'Enter' }));
$('#brScrollUp').addEventListener('click', () => brAction('/api/browser/scroll', { dx: 0, dy: -500 }));
$('#brScrollDown').addEventListener('click', () => brAction('/api/browser/scroll', { dx: 0, dy: 500 }));

// ===== 长期记忆 =====
async function loadMemories() {
  try {
    const q = $('#memSearch').value.trim();
    const list = await api('/api/memory?limit=100' + (q ? '&q=' + encodeURIComponent(q) : ''));
    const st = await api('/api/memory/stats');
    renderMemStats(st);
    renderMemList(list.items || []);
  } catch (e) {
    setOut('#memList', '加载失败：' + (e.message || e));
  }
}

function renderMemStats(st) {
  const box = $('#memStats');
  if (!box) return;
  const kinds = { fact: '事实', preference: '偏好', habit: '习惯', event: '事件', context: '上下文' };
  const parts = Object.entries(st.by_kind || {}).map(([k, v]) => `<span class="mem-stat"><b>${v}</b>${kinds[k] || k}</span>`);
  parts.unshift(`<span class="mem-stat"><b>${st.total || 0}</b>总记忆</span>`);
  parts.push(`<span class="mem-stat"><b>${st.pinned || 0}</b>置顶</span>`);
  box.innerHTML = parts.join('');
}

function renderMemList(items) {
  const box = $('#memList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="muted">还没有记忆，说「记住我每天 9 点开始工作」试试</div>';
    return;
  }
  const kindMap = { fact: '事实', preference: '偏好', habit: '习惯', event: '事件', context: '上下文' };
  box.innerHTML = '';
  items.forEach((it) => {
    const el = document.createElement('div');
    el.className = 'mem-item' + (it.pinned ? ' pinned' : '');
    el.innerHTML = `
      <span class="mi-kind">${kindMap[it.kind] || it.kind}${it.importance >= 3 ? ' ★' : ''}</span>
      <div class="mi-content">
        <div>${escapeHtml(it.content)}</div>
        ${it.tags && it.tags.length ? '<div class="mi-tags">' + it.tags.map((t) => '#' + escapeHtml(t)).join(' ') + '</div>' : ''}
        <div class="mi-tags">${escapeHtml(it.source || '')} · 更新 ${fmtDate(it.updated_at)}</div>
      </div>
      <div class="mi-ops">
        <button data-pin="${it.id}" title="置顶">${it.pinned ? '取消置顶' : '置顶'}</button>
        <button data-del="${it.id}" class="danger">删除</button>
      </div>`;
    el.querySelector('[data-pin]').addEventListener('click', async () => {
      await api('/api/memory/' + it.id + '/pin', { method: 'POST', body: { pinned: !it.pinned } });
      loadMemories();
    });
    el.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm('删除这条记忆？')) return;
      await api('/api/memory/' + it.id, { method: 'DELETE' });
      loadMemories();
    });
    box.appendChild(el);
  });
}

$('#btnMemAdd').addEventListener('click', async () => {
  const content = $('#memContent').value.trim();
  if (!content) { setOut('#memStatus', '内容不能为空'); return; }
  try {
    await api('/api/memory', {
      method: 'POST',
      body: {
        kind: $('#memKind').value,
        content,
        importance: parseInt($('#memImportance').value, 10) || 1,
        tags: $('#memTags').value,
      },
    });
    $('#memContent').value = '';
    $('#memTags').value = '';
    setOut('#memStatus', '✅ 已保存');
    loadMemories();
  } catch (e) {
    setOut('#memStatus', '❌ ' + (e.message || e));
  }
});
$('#memRecall').addEventListener('click', loadMemories);
$('#memSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadMemories(); } });
$('#memExtract').addEventListener('click', async () => {
  try {
    let sid = getCurrentSessionId();
    if (!sid) {
      const s = await api('/api/chathistory/sessions');
      sid = s.items && s.items[0] ? s.items[0].id : null;
    }
    if (!sid) { setOut('#memList', '没有可提取的对话'); return; }
    const msgs = await api('/api/chathistory/sessions/' + sid + '/messages');
    const r = await api('/api/memory/extract', { method: 'POST', body: { messages: msgs.items || [] } });
    setOut('#memList', '🧠 提取完成：' + r.extracted + ' 条新记忆');
    loadMemories();
  } catch (e) {
    setOut('#memList', '提取失败：' + (e.message || e));
  }
});
$('#memRefresh').addEventListener('click', loadMemories);

// ===== 技能区 =====
let skillEditing = null;

async function loadSkills() {
  try {
    const r = await api('/api/skills');
    const box = $('#skillList');
    if (!box) return;
    box.innerHTML = '';
    if (!r.items.length) {
      box.innerHTML = '<div class="muted">技能区是空的，创建第一个技能（左下角编辑器）</div>';
      return;
    }
    for (const s of r.items) {
      const el = document.createElement('div');
      el.className = 'skill-item' + (s.name === skillEditing ? ' active' : '');
      el.innerHTML = `
        <div class="sk-name">⚡ ${escapeHtml(s.name)}</div>
        <div class="sk-desc">${escapeHtml((s.description || '').slice(0, 120))}</div>
        <div class="sk-meta">v${escapeHtml(s.version || '1.0')} · ${s.assets ? (s.assets.length + ' 个资源') : '无资源'}</div>`;
      el.addEventListener('click', () => selectSkill(s.name));
      box.appendChild(el);
    }
  } catch (e) {
    setOut('#skillList', '加载失败：' + (e.message || e));
  }
}

async function selectSkill(name) {
  skillEditing = name;
  try {
    const s = await api('/api/skills/' + encodeURIComponent(name));
    $('#skillName').value = s.folder || s.name;
    $('#skillDesc').value = s.description || '';
    $('#skillWhen').value = s.when_to_use || '';
    $('#skillContent').value = s.body || s.content || '';
    $('#skillEditorTitle').textContent = '编辑技能：' + s.name;
    setOut('#skillStatus', '已加载 ' + s.name);
    loadSkills();
  } catch (e) {
    setOut('#skillStatus', '加载失败：' + (e.message || e));
  }
}

$('#btnSkillNew').addEventListener('click', () => {
  skillEditing = null;
  $('#skillName').value = '';
  $('#skillDesc').value = '';
  $('#skillWhen').value = '';
  $('#skillContent').value = '# 技能\n\n1. 第一步\n2. 第二步';
  $('#skillEditorTitle').textContent = '新建技能';
  $('#skillName').focus();
});

$('#btnSkillInstall').addEventListener('click', async () => {
  const url = $('#skillInstallUrl').value.trim();
  if (!url) { setOut('#skillStatus', '请填写 GitHub 仓库地址'); return; }
  setOut('#skillStatus', '安装中…');
  try {
    const s = await api('/api/skills/install', { method: 'POST', body: { url } });
    setOut('#skillStatus', '✅ 已安装 ' + s.name);
    $('#skillInstallUrl').value = '';
    await loadSkills();
    selectSkill(s.folder || s.name);
  } catch (e) {
    setOut('#skillStatus', '❌ ' + e.message);
  }
});

$('#btnSkillSave').addEventListener('click', async () => {
  const name = $('#skillName').value.trim();
  if (!name) { setOut('#skillStatus', '技能名必填'); return; }
  try {
    const body = {
      description: $('#skillDesc').value.trim(),
      when_to_use: $('#skillWhen').value.trim(),
      content: $('#skillContent').value,
    };
    if (skillEditing && name !== skillEditing) {
      // 改名：先建新技能，再删旧目录
      await api('/api/skills', { method: 'POST', body: { name, ...body } });
      await api('/api/skills/' + encodeURIComponent(skillEditing), { method: 'DELETE' });
    } else {
      const method = skillEditing ? 'PATCH' : 'POST';
      const path = skillEditing ? '/api/skills/' + encodeURIComponent(skillEditing) : '/api/skills';
      await api(path, { method, body });
    }
    setOut('#skillStatus', '✅ 已保存');
    skillEditing = name;
    loadSkills();
  } catch (e) {
    setOut('#skillStatus', '❌ ' + (e.message || e));
  }
});

$('#btnSkillDelete').addEventListener('click', async () => {
  const name = skillEditing || $('#skillName').value.trim();
  if (!name || !confirm('删除技能「' + name + '」？')) return;
  await api('/api/skills/' + encodeURIComponent(name), { method: 'DELETE' });
  skillEditing = null;
  setOut('#skillStatus', '已删除');
  loadSkills();
});

$('#btnSkillUse').addEventListener('click', () => {
  const name = skillEditing || $('#skillName').value.trim();
  if (!name) { setOut('#skillStatus', '先选择或创建技能'); return; }
  $('#chatInput').value = '使用技能 ' + name + '：';
  $$('.tab').forEach((b) => { if (b.dataset.tab === 'chat') b.click(); });
  setTimeout(() => $('#chatInput').focus(), 80);
});
renderDeepThinkToggle();
renderApprovalMode();
initModelPicker();
renderContextChips();
renderComposerTrigger();
renderToolkit();
activateTkMode(currentTkMode);

// ===== 命令面板 + 主题 =====
const THEME_KEY = 'workbuddy_theme';
function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.body.classList.toggle('dark', t === 'dark');
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute('content', t === 'dark' ? '#0a1115' : '#101a24');
  localStorage.setItem(THEME_KEY, t);
}
function toggleTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) === 'dark' ? 'light' : 'dark');
  setChatStatus('主题：' + (localStorage.getItem(THEME_KEY) === 'dark' ? '深色' : '浅色'));
}

const PALETTE_ACTIONS = [
  { id: 'new_chat', label: '新对话', desc: '开始一个新的会话', run: () => $('#btnNewChat').click() },
  { id: 'search', label: '搜索会话', desc: '聚焦会话搜索框', run: () => { switchTab('chat'); setTimeout(() => $('#sessionSearch').focus(), 50); } },
  { id: 'goal', label: '目标状态', desc: '设置持续目标与可衡量成果', run: () => { switchTab('chat'); $('#btnGoalMode').click(); } },
  { id: 'plan', label: '计划模式', desc: '切换持续计划状态', run: () => { switchTab('chat'); $('#btnPlanMode').click(); } },
  { id: 'review', label: '审阅变更', desc: '打开 Review 面板并审阅', run: () => { handleSlashCommand('/review'); } },
  { id: 'worktree', label: '工作区 / Worktree', desc: 'Local / Worktree handoff', run: () => { localStorage.setItem(TK_KEY, '1'); renderToolkit(); activateTkMode('workspace'); } },
  { id: 'tasks', label: '后台任务', desc: '创建/查看后台 Agent 任务', run: () => { localStorage.setItem(TK_KEY, '1'); renderToolkit(); activateTkMode('tasks'); } },
  { id: 'remote', label: '远程主机', desc: 'Remote / Handoff', run: () => { localStorage.setItem(TK_KEY, '1'); renderToolkit(); activateTkMode('remote'); } },
  { id: 'memory', label: '长期记忆', desc: '管理 Memory', run: () => { localStorage.setItem(TK_KEY, '1'); renderToolkit(); activateTkMode('memory'); } },
  { id: 'skills', label: '技能', desc: '管理 Skills', run: () => { localStorage.setItem(TK_KEY, '1'); renderToolkit(); activateTkMode('skills'); } },
  { id: 'mcp', label: 'MCP', desc: 'MCP servers 管理', run: () => { switchTab('ai'); setTimeout(loadMcp, 50); } },
  { id: 'automations', label: '自动化任务', desc: '管理 Agent 定时任务', run: () => { switchTab('reminders'); setTimeout(() => switchReminderView('automations'), 50); } },
  { id: 'fork', label: 'Fork 当前会话', desc: '复制当前会话', run: () => handleSlashCommand('/fork') },
  { id: 'theme', label: '切换主题', desc: '浅色 / 深色', run: () => toggleTheme() },
  { id: 'clear', label: '清空对话', desc: '清空当前聊天窗口', run: () => clearChat() },
  { id: 'stop', label: '停止生成', desc: '停止当前回复', run: () => $('#btnChatStop').click() },
];
let paletteIndex = 0;
function openCommandPalette() {
  const p = document.getElementById('commandPalette');
  if (!p) return;
  p.classList.remove('hidden');
  const input = $('#cpInput');
  input.value = '';
  paletteIndex = 0;
  renderCommandPalette('');
  setTimeout(() => input.focus(), 20);
}
function closeCommandPalette() {
  document.getElementById('commandPalette').classList.add('hidden');
}
function renderCommandPalette(filter) {
  const box = $('#cpList');
  const q = String(filter || '').toLowerCase();
  const items = PALETTE_ACTIONS.filter((a) => !q || a.label.toLowerCase().includes(q) || a.id.includes(q));
  paletteIndex = Math.min(paletteIndex, Math.max(0, items.length - 1));
  box.innerHTML = items.map((a, i) => `<div class="cp-item${i === paletteIndex ? ' active' : ''}" data-id="${a.id}"><b>${escapeHtml(a.label)}</b><span>${escapeHtml(a.desc)}</span></div>`).join('') || '<div class="cp-item">没有匹配命令</div>';
  $$('#cpList .cp-item[data-id]').forEach((el) => el.addEventListener('click', () => {
    closeCommandPalette();
    const a = PALETTE_ACTIONS.find((x) => x.id === el.dataset.id);
    if (a) a.run();
  }));
}
$('#btnCommandPalette').addEventListener('click', openCommandPalette);
$('#cpInput').addEventListener('input', (e) => { paletteIndex = 0; renderCommandPalette(e.target.value); });
$('#commandPalette').addEventListener('click', (e) => { if (e.target.id === 'commandPalette') closeCommandPalette(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCommandPalette();
    return;
  }
  const p = document.getElementById('commandPalette');
  if (!p || p.classList.contains('hidden')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); return; }
  const items = PALETTE_ACTIONS.filter((a) => {
    const q = $('#cpInput').value.toLowerCase();
    return !q || a.label.toLowerCase().includes(q) || a.id.includes(q);
  });
  if (!items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    paletteIndex = (paletteIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    $$('#cpList .cp-item[data-id]').forEach((el, i) => el.classList.toggle('active', i === paletteIndex));
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const a = items[paletteIndex];
    closeCommandPalette();
    if (a) a.run();
  }
});
applyTheme(localStorage.getItem(THEME_KEY) || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
refreshContextMeter();

async function refreshContextMeter() {
  const btn = $('#btnContextMeter');
  const sid = getCurrentSessionId();
  if (!sid) { if (btn) btn.textContent = '上下文 —'; return; }
  try {
    const s = await api('/api/chathistory/sessions/' + sid + '/context-stats');
    if (btn) {
      btn.textContent = `上下文 ${s.estimated_tokens}tok · ${s.messages}条`;
      btn.classList.toggle('danger', s.messages >= s.threshold);
    }
  } catch (_) {}
}
$('#btnContextMeter').addEventListener('click', async () => {
  const sid = getCurrentSessionId();
  if (!sid) return;
  setChatStatus('🧹 正在压缩上下文…');
  try {
    await api('/api/chathistory/sessions/' + sid + '/summarize', { method: 'POST', body: {} });
    await refreshContextMeter();
    setChatStatus('上下文已压缩');
  } catch (e) {
    setChatStatus('压缩失败：' + e.message);
  }
});

// ===== 项目规则 AGENTS.md =====
async function loadDiagnostics() {
  const out = $('#diagnosticsOut');
  if (!out) return;
  try {
    const r = await api('/api/diagnostics');
    out.textContent = JSON.stringify(r, null, 2);
  } catch (e) {
    out.textContent = '诊断失败：' + (e.message || e);
  }
}
$('#btnDiagnostics').addEventListener('click', loadDiagnostics);

// ===== 项目规则 AGENTS.md =====
async function loadRules() {
  try {
    const r = await api('/api/rules');
    const files = r.files || [];
    const sel = $('#rulesFile');
    if (sel) {
      const current = sel.value;
      sel.innerHTML = files.map((f) => `<option value="${escapeHtml(f.path)}">${escapeHtml(f.path)}${f.exists ? '' : '（新）'}</option>`).join('');
      if (current && files.some((f) => f.path === current)) sel.value = current;
    }
    const p = $('#rulesFile') && $('#rulesFile').value;
    if (p) await selectRulesFile(p);
    else setOut('#rulesStatus', '尚未创建 AGENTS.md');
  } catch (e) {
    setOut('#rulesStatus', '读取失败：' + e.message);
  }
}
async function selectRulesFile(p) {
  const r = await api('/api/rules/file?path=' + encodeURIComponent(p));
  const ta = $('#rulesContent');
  if (ta) ta.value = r.content || '';
  setOut('#rulesStatus', r.exists ? '已加载 ' + p : '新文件 ' + p);
}
$('#rulesFile').addEventListener('change', () => selectRulesFile($('#rulesFile').value));
$('#btnRulesNew').addEventListener('click', async () => {
  const p = $('#rulesPath').value.trim();
  if (!/AGENTS\.md$/i.test(p)) { setOut('#rulesStatus', '路径必须以 AGENTS.md 结尾'); return; }
  const sel = $('#rulesFile');
  if (sel && !Array.from(sel.options).some((o) => o.value === p)) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p + '（新）';
    sel.appendChild(opt);
  }
  if (sel) sel.value = p;
  await selectRulesFile(p);
});
$('#btnRulesSave').addEventListener('click', async () => {
  try {
    const p = $('#rulesFile').value || $('#rulesPath').value.trim() || 'AGENTS.md';
    const r = await api('/api/rules', { method: 'PUT', body: { path: p, content: $('#rulesContent').value } });
    setOut('#rulesStatus', r.exists ? '✅ 已保存 ' + r.path : '已清空');
    loadRules();
  } catch (e) {
    setOut('#rulesStatus', '❌ ' + e.message);
  }
});

// ===== MCP Servers 管理 =====
async function loadMcp() {
  const box = $('#mcpList');
  if (!box) return;
  try {
    const r = await api('/api/mcp/servers');
    renderMcpList(r.items || []);
  } catch (e) {
    box.innerHTML = '<div class="muted">加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}
function renderMcpList(items) {
  const box = $('#mcpList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="muted">还没有 MCP server。用下面表单添加一个。</div>';
    return;
  }
  box.innerHTML = '';
  items.forEach((s) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `
      <div class="body">
        <div class="title">${escapeHtml(s.name)} <span class="badge">${escapeHtml(s.transport)}</span> ${s.connected ? '<span class="badge p3">已连接</span>' : '<span class="badge p2">未连接</span>'}</div>
        <div class="meta">${s.transport === 'http' ? escapeHtml(s.url || '') : escapeHtml((s.command || '') + ' ' + (s.args || []).join(' '))}${s.toolCount != null ? ' · ' + s.toolCount + ' tools' : ''}</div>
      </div>
      <div class="ops">
        <button class="ghost small" data-connect="${s.name}">连接</button>
        ${s.transport === 'http' ? `<button class="ghost small" data-discover="${s.name}">发现 OAuth</button>` : ''}
        ${s.auth === 'oauth' ? `<button class="ghost small" data-oauth="${s.name}">授权</button>` : ''}
        <button class="ghost small" data-tools="${s.name}">工具</button>
        <button class="ghost small" data-disconnect="${s.name}">断开</button>
        <button class="ghost small danger" data-del="${s.name}">删除</button>
      </div>`;
    box.appendChild(el);
  });
  $$('#mcpList [data-connect]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/mcp/servers/' + encodeURIComponent(b.dataset.connect) + '/connect', { method: 'POST' }); await loadMcp(); }
    catch (e) { setOut('#mcpStatus', '连接失败：' + e.message); }
  }));
  $$('#mcpList [data-oauth]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api('/api/mcp/servers/' + encodeURIComponent(b.dataset.oauth) + '/oauth/start', { method: 'POST' });
      window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      setOut('#mcpStatus', 'OAuth 启动失败：' + e.message);
    }
  }));
  $$('#mcpList [data-discover]').forEach((b) => b.addEventListener('click', async () => {
    try {
      setOut('#mcpStatus', '发现 OAuth 配置中…');
      const r = await api('/api/mcp/servers/' + encodeURIComponent(b.dataset.discover) + '/discover', { method: 'POST' });
      setOut('#mcpStatus', r.client_id ? '✅ 已发现并注册客户端' : '✅ 已发现 OAuth 配置');
      await loadMcp();
    } catch (e) {
      setOut('#mcpStatus', '发现失败：' + e.message);
    }
  }));
  $$('#mcpList [data-disconnect]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/mcp/servers/' + encodeURIComponent(b.dataset.disconnect) + '/disconnect', { method: 'POST' });
    loadMcp();
  }));
  $$('#mcpList [data-tools]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api('/api/mcp/servers/' + encodeURIComponent(b.dataset.tools) + '/tools');
      alert((r.items || []).map((t) => t.name + ': ' + (t.description || '')).join('\n') || '没有工具');
    } catch (e) { alert('读取工具失败：' + e.message); }
  }));
  $$('#mcpList [data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('删除 MCP server「' + b.dataset.del + '」？')) return;
    await api('/api/mcp/servers/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
    loadMcp();
  }));
}
$('#btnMcpSave').addEventListener('click', async () => {
  const name = $('#mcpName').value.trim();
  const transport = $('#mcpTransport').value;
  if (!name) { setOut('#mcpFormStatus', '请填写名称'); return; }
  let headers = {};
  const headersRaw = $('#mcpHeaders').value.trim();
  if (headersRaw) {
    try { headers = JSON.parse(headersRaw); } catch (_) { setOut('#mcpFormStatus', 'Headers 不是合法 JSON'); return; }
  }
  const body = transport === 'http'
    ? {
        name, transport,
        url: $('#mcpUrl').value.trim(),
        headers,
        auth: $('#mcpAuth').value,
        authorizationUrl: $('#mcpAuthUrl').value.trim(),
        tokenUrl: $('#mcpTokenUrl').value.trim(),
        clientId: $('#mcpClientId').value.trim(),
        clientSecret: $('#mcpClientSecret').value,
        scopes: $('#mcpScopes').value.trim(),
      }
    : { name, transport, command: $('#mcpCommand').value.trim(), args: $('#mcpArgs').value.trim().split(/\s+/).filter(Boolean) };
  try {
    await api('/api/mcp/servers', { method: 'POST', body });
    setOut('#mcpFormStatus', '✅ 已保存');
    loadMcp();
  } catch (e) {
    setOut('#mcpFormStatus', '❌ ' + e.message);
  }
});

// ===== Scheduled tasks（automations） =====
let autoFilter = 'all';
async function loadAutomations() {
  const box = $('#autoList');
  if (!box) return;
  try {
    const [r, st] = await Promise.all([
      api('/api/automations' + (autoFilter !== 'all' ? '?status=' + encodeURIComponent(autoFilter) : '')),
      api('/api/automations/stats'),
    ]);
    renderAutomations(r.items || []);
    setOut('#autoStats', `共 ${st.total} · 启用 ${st.enabled} · 停用 ${st.paused} · 异常 ${st.errors}`);
    $$('.auto-filter').forEach((b) => b.classList.toggle('active', b.dataset.autoFilter === autoFilter));
  } catch (e) {
    box.innerHTML = '<div class="muted">加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}
function renderAutomations(items) {
  const box = $('#autoList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="muted">还没有 automation。</div>';
    return;
  }
  box.innerHTML = '';
  items.forEach((a) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `
      <div class="body">
        <div class="title">${escapeHtml(a.name)} <span class="badge">${escapeHtml(a.cron)}</span></div>
        <div class="meta">${escapeHtml((a.prompt || '').slice(0, 120))}</div>
        <div class="meta">最近运行：${a.last_run_at ? escapeHtml(a.last_run_at) + ' · ' + escapeHtml(a.last_status || '') : '从未运行'}</div>
      </div>
      <div class="ops">
        <button class="ghost small" data-run="${a.id}">立即运行</button>
        <button class="ghost small" data-runs="${a.id}">历史</button>
        <button class="ghost small" data-dup="${a.id}">复制</button>
        <button class="ghost small" data-toggle="${a.id}">${a.enabled ? '停用' : '启用'}</button>
        <button class="ghost small danger" data-del="${a.id}">删除</button>
      </div>
      <pre class="computer-output hidden" data-runs-out="${a.id}"></pre>`;
    box.appendChild(el);
  });
  $$('#autoList [data-run]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    setOut('#autoStatus', '运行中…');
    try {
      await api('/api/automations/' + b.dataset.run + '/run', { method: 'POST' });
      setOut('#autoStatus', '已运行');
      loadAutomations();
    } catch (e) {
      setOut('#autoStatus', '运行失败：' + e.message);
    } finally {
      b.disabled = false;
    }
  }));
  $$('#autoList [data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const item = items.find((a) => Number(a.id) === Number(b.dataset.toggle));
    await api('/api/automations/' + b.dataset.toggle, { method: 'PATCH', body: { enabled: !item.enabled } });
    loadAutomations();
  }));
  $$('#autoList [data-runs]').forEach((b) => b.addEventListener('click', async () => {
    const out = document.querySelector('[data-runs-out="' + b.dataset.runs + '"]');
    if (!out) return;
    if (!out.classList.contains('hidden')) { out.classList.add('hidden'); return; }
    try {
      const r = await api('/api/automations/' + b.dataset.runs + '/runs?limit=20');
      out.textContent = (r.items || []).map((x) => `[${x.status}] ${x.started_at || ''}\n${x.result || ''}`).join('\n\n') || '暂无运行记录';
      out.classList.remove('hidden');
    } catch (e) {
      out.textContent = '读取失败：' + e.message;
      out.classList.remove('hidden');
    }
  }));
  $$('#autoList [data-dup]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/automations/' + b.dataset.dup + '/duplicate', { method: 'POST' });
    loadAutomations();
  }));
  $$('#autoList [data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('删除这个 automation？')) return;
    await api('/api/automations/' + b.dataset.del, { method: 'DELETE' });
    loadAutomations();
  }));
}
$('#btnAutoSave').addEventListener('click', async () => {
  const body = {
    name: $('#autoName').value.trim(),
    cron: $('#autoCron').value.trim(),
    prompt: $('#autoPrompt').value.trim(),
  };
  if (!body.name || !body.cron || !body.prompt) { setOut('#autoFormStatus', '名称 / cron / prompt 都必填'); return; }
  try {
    await api('/api/automations', { method: 'POST', body });
    setOut('#autoFormStatus', '✅ 已创建');
    $('#autoName').value = '';
    $('#autoCron').value = '';
    $('#autoPrompt').value = '';
    loadAutomations();
  } catch (e) {
    setOut('#autoFormStatus', '❌ ' + e.message);
  }
});
$$('.auto-filter').forEach((b) => b.addEventListener('click', () => {
  autoFilter = b.dataset.autoFilter || 'all';
  loadAutomations();
}));
$('#btnAutoPauseAll').addEventListener('click', async () => {
  await api('/api/automations/pause-all', { method: 'POST' });
  loadAutomations();
});
$('#btnAutoResumeAll').addEventListener('click', async () => {
  await api('/api/automations/resume-all', { method: 'POST' });
  loadAutomations();
});
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'ai') { loadRules(); loadMcp(); loadDiagnostics(); }
    if (btn.dataset.tab === 'reminders') loadAutomations();
  });
});
