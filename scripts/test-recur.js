// 重复任务端到端测试
const http = require('http');
function req(m, p, b, t) {
  return new Promise((r) => {
    const d = b ? JSON.stringify(b) : '';
    const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) };
    if (t) h.Authorization = 'Bearer ' + t;
    const rq = http.request({ hostname: '127.0.0.1', port: 3000, path: p, method: m, headers: h }, (rs) => {
      let buf = ''; rs.on('data', (c) => buf += c); rs.on('end', () => r({ s: rs.statusCode, body: buf }));
    }); rq.on('error', (e) => r({ err: e.message })); if (d) rq.write(d); rq.end();
  });
}

(async () => {
  const L = await req('POST', '/api/auth/login', { username: 'admin', password: process.env.WBD_ADMIN_PASSWORD || 'password123' });
  const T = JSON.parse(L.body).token;

  // 1. 创建重复待办
  const r = await req('POST', '/api/todos', { title: '每天写日报', priority: 1, recur_rule: 'daily', category: '工作' }, T);
  const id = JSON.parse(r.body).id;
  console.log('1. 创建重复待办:', id, '| recur_rule:', JSON.parse(r.body).recur_rule);

  // 2. 标记完成
  await req('PATCH', '/api/todos/' + id, { status: 'done' }, T);
  console.log('2. 标记完成');

  // 3. 手动触发 checkRecurring
  const sched = require('../src/services/scheduler');
  sched.checkRecurring();
  console.log('3. checkRecurring 触发');

  // 4. 验证新实例
  const list = await req('GET', '/api/todos', null, T);
  const todos = JSON.parse(list.body);
  const newOnes = todos.filter((t) => t.title === '每天写日报');
  console.log('4. 匹配数量:', newOnes.length);
  const open = newOnes.find((t) => t.status === 'open');
  if (open) {
    console.log('   新实例 due_at:', open.due_at);
    console.log('   ✅ 重复任务自动创建成功');
  } else {
    console.log('   ❌ 未创建新实例');
  }

  // 5. 清理
  for (const t of newOnes) await req('DELETE', '/api/todos/' + t.id, null, T);
  console.log('5. 已清理');
})().catch((e) => console.error('ERR', e.message));
