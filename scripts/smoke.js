'use strict';
// 综合端到端：多用户隔离 / 流式 LLM mock / 限流 / 可观测性 / 登录失败计数
const http = require('http');
const fs = require('fs');
const path = require('path');

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request(
      { hostname: '127.0.0.1', port: 3000, path: p, method, headers },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, text: buf }); }
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function reqRaw(p, token) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    http.get({ hostname: '127.0.0.1', port: 3000, path: p, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    }).on('error', reject);
  });
}
function logSection(t) { console.log('\n=== ' + t + ' ==='); }
function assert(cond, msg) { if (!cond) throw new Error('assert failed: ' + msg); }
const ADMIN_PW = () => process.env.WBD_ADMIN_PASSWORD || 'password123'; // 默认仅本地开发；生产请用环境变量覆盖

(async () => {
  // 0. 清理 admin 旧数据（保证测试可重复）
  const adminLogin0 = await req('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW() });
  if (adminLogin0.status === 200) {
    const t = adminLogin0.json.token;
    for (const todo of (await req('GET', '/api/todos', null, t)).json) await req('DELETE', '/api/todos/' + todo.id, null, t);
    for (const ev of (await req('GET', '/api/schedule', null, t)).json) await req('DELETE', '/api/schedule/' + ev.id, null, t);
    for (const r of (await req('GET', '/api/reminders', null, t)).json) await req('DELETE', '/api/reminders/' + r.id, null, t);
  }

  // ===== 1. /api/stats 公开端点（丰富字段） =====
  logSection('1. /api/stats 公开端点');
  const stats = await req('GET', '/api/stats');
  console.log(JSON.stringify(stats.json, null, 2));
  assert(stats.json.db && stats.json.db.size_bytes > 0, 'db size should be > 0');
  assert(stats.json.users.total >= 1, 'should have at least 1 user (admin)');
  assert(typeof stats.json.uptime_sec === 'number', 'uptime should be number');

  // ===== 2. /api/health 简单端点 =====
  logSection('2. /api/health');
  const h = await req('GET', '/api/health');
  console.log(JSON.stringify(h.json));
  assert(h.json.ok === true, 'health ok');

  // ===== 3. admin 登录 =====
  logSection('3. admin 登录');
  const a1 = await req('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW() });
  console.log('admin login:', a1.status, 'user:', a1.json.user);
  assert(a1.status === 200, 'admin login should succeed');
  const adminToken = a1.json.token;

  // ===== 4. 注册第二个普通用户 =====
  logSection('4. 注册 alice（普通用户）');
  const aliceUser = 'alice_' + Date.now().toString(36);
  const reg = await req('POST', '/api/auth/register', { username: aliceUser, password: 'alice123' }, adminToken);
  console.log('register', aliceUser, ':', reg.status, reg.json);
  assert(reg.status === 201, 'register should succeed');
  assert(reg.json.username === aliceUser, 'username match');

  // 非 admin 注册应被拒
  const aliceLogin = await req('POST', '/api/auth/login', { username: aliceUser, password: 'alice123' });
  const aliceToken = aliceLogin.json.token;
  const regFail = await req('POST', '/api/auth/register', { username: 'bob', password: 'bob123' }, aliceToken);
  console.log('alice 试图注册 bob →', regFail.status, regFail.json.error);
  assert(regFail.status === 403, 'non-admin register should be 403');

  // ===== 5. 多用户隔离 =====
  logSection('5. 多用户数据隔离');
  // admin 创建 todo
  const aTodo = await req('POST', '/api/todos', { title: 'admin 的工作', priority: 1 }, adminToken);
  const aEvent = await req('POST', '/api/schedule', { title: 'admin 的会议', start_at: '2026-08-20T10:00:00.000Z' }, adminToken);
  const aRem = await req('POST', '/api/reminders', { title: 'admin 提醒', cron: '0 9 * * *' }, adminToken);
  console.log('admin created todo', aTodo.json.id, 'event', aEvent.json.id, 'reminder', aRem.json.id);

  // alice 创建 todo
  const aliceTodo = await req('POST', '/api/todos', { title: aliceUser + ' 的购物', priority: 3 }, aliceToken);
  const aliceEvent = await req('POST', '/api/schedule', { title: aliceUser + ' 健身', start_at: '2026-08-20T18:00:00.000Z' }, aliceToken);
  console.log(aliceUser, 'created todo', aliceTodo.json.id, 'event', aliceEvent.json.id);

  // 各自列表
  const aList = await req('GET', '/api/todos', null, adminToken);
  const bList = await req('GET', '/api/todos', null, aliceToken);
  console.log('admin todos:', aList.json.length, '| alice todos:', bList.json.length);
  assert(aList.json.length === 1, 'admin should see only 1 todo');
  assert(bList.json.length === 1, 'alice should see only 1 todo');
  assert(aList.json[0].title === 'admin 的工作', 'admin sees own todo');
  assert(bList.json[0].title === aliceUser + ' 的购物', 'alice sees own todo');

  // alice 试图修改 admin 的 todo（应 404）
  const crossPatch = await req('PATCH', '/api/todos/' + aTodo.json.id, { status: 'done' }, aliceToken);
  console.log('alice PATCH admin todo →', crossPatch.status, crossPatch.json);
  assert(crossPatch.status === 404, 'cross-user patch should 404');

  // alice 试图删 admin 的 reminder（应 404）
  const crossDel = await req('DELETE', '/api/reminders/' + aRem.json.id, null, aliceToken);
  console.log('alice DELETE admin reminder →', crossDel.status);
  assert(crossDel.status === 404, 'cross-user delete should 404');

  // ===== 6. 备份按用户隔离 =====
  logSection('6. 备份按用户隔离');
  const aExp = await reqRaw('/api/backup/export', adminToken);
  const bExp = await reqRaw('/api/backup/export', aliceToken);
  const aSnap = JSON.parse(aExp.body);
  const bSnap = JSON.parse(bExp.body);
  console.log('admin backup user_id:', aSnap.user_id, 'todos:', aSnap.tables.todos.length);
  console.log('alice backup user_id:', bSnap.user_id, 'todos:', bSnap.tables.todos.length);
  assert(aSnap.user_id !== bSnap.user_id, 'export user_id should differ');
  assert(aSnap.tables.todos[0].title === 'admin 的工作', 'admin backup contains own todo');
  assert(bSnap.tables.todos[0].title === aliceUser + ' 的购物', 'alice backup contains own todo');

  // ===== 7. 用户列表（仅 admin） =====
  logSection('7. /api/auth/users');
  const usersAsAdmin = await req('GET', '/api/auth/users', null, adminToken);
  const usersAsAlice = await req('GET', '/api/auth/users', null, aliceToken);
  console.log('admin sees users:', usersAsAdmin.json.length, 'alice 试图访问 →', usersAsAlice.status);
  assert(usersAsAdmin.json.length >= 2, 'should have at least 2 users (admin + alice)');
  assert(usersAsAlice.status === 403, 'non-admin should be 403');
  const adminEntry = usersAsAdmin.json.find((u) => u.username === 'admin');
  assert(adminEntry && adminEntry.is_admin, 'admin user should be flagged is_admin');

  // ===== 8. /api/stats/metrics（admin only） =====
  logSection('8. /api/stats/metrics');
  const mAsAdmin = await reqRaw('/api/stats/metrics', adminToken);
  console.log(mAsAdmin.body.split('\n').slice(0, 12).join('\n'));
  assert(mAsAdmin.body.includes('workbuddy_users_total'), 'metric should include users_total');
  assert(mAsAdmin.body.includes('workbuddy_todos_open'), 'metric should include todos_open');
  const mAsAlice = await reqRaw('/api/stats/metrics', aliceToken);
  assert(mAsAlice.status === 403, 'non-admin metrics should 403');

  // ===== 9. SSE 流式（用占位 key 看完整事件序列） =====
  logSection('9. SSE 流式（鉴权失败时也应输出 error 事件）');
  const sseRes = await new Promise((resolve) => {
    const data = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 });
    const r = http.request({
      hostname: '127.0.0.1', port: 3000, path: '/api/ai/stream', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': 'Bearer ' + adminToken },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    r.on('error', (e) => resolve({ error: e.message }));
    r.write(data); r.end();
  });
  console.log('SSE status:', sseRes.status, 'CT:', sseRes.headers['content-type']);
  console.log('SSE body:', sseRes.body);
  assert(sseRes.headers['content-type'].includes('text/event-stream'), 'should be event-stream');
  assert(sseRes.body.includes('event:'), 'should contain event: prefix');

  // ===== 10. 登录失败限频 =====
  logSection('10. 登录失败限频（5 次后 429）');
  for (let i = 1; i <= 6; i++) {
    const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
    console.log(`attempt ${i}: ${r.status} ${r.json.error || ''}`);
  }
  const locked = await req('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW() });
  console.log('correct password after 5 failures →', locked.status, locked.json.error);
  assert(locked.status === 429, 'should be locked out');

  // ===== 11. 日志文件 =====
  logSection('11. 请求日志文件');
  await new Promise((r) => setTimeout(r, 200));
  const logDir = path.join(__dirname, '..', 'data', 'logs');
  if (fs.existsSync(logDir)) {
    const files = fs.readdirSync(logDir);
    console.log('log files:', files);
    if (files.length) {
      const sample = fs.readFileSync(path.join(logDir, files[0]), 'utf8').split('\n').slice(0, 3).join('\n');
      console.log('sample:\n' + sample);
      assert(sample.includes('"method"'), 'log line should be JSON');
    }
  }

  // ===== 12. 限流 =====
  logSection('12. API 限流');
  // 改用临时小窗口测：动态计算，遍历到 429 为止
  let got429 = 0;
  for (let i = 0; i < 400; i++) {
    const r = await req('GET', '/api/todos', null, adminToken);
    if (r.status === 429) { got429++; break; }
  }
  console.log('拿到第一个 429 时已发送请求数: ' + (got429 ? '达到限流' : '未限流'));
  // 同时再发一些确认 429
  for (let i = 0; i < 5; i++) {
    const r = await req('GET', '/api/todos', null, adminToken);
    if (r.status === 429) got429++;
  }
  console.log('总共拿到', got429, '个 429');
  assert(got429 > 0, 'should have some 429s');

  console.log('\n✅ 全部 12 个测试场景通过');
})().catch((e) => { console.error('\n❌ FAILED:', e.message); process.exit(1); });
