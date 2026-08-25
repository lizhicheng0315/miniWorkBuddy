// 待办 P1 测试：批量操作 + 分类列表
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

  // 创建测试数据
  const ids = [];
  for (const [title, cat, p] of [['项目周报', '工作', 1], ['订餐', '生活', 2], ['代码审查', '工作', 1], ['健身', '生活', 3], ['季度总结', '工作', 2]]) {
    const r = await req('POST', '/api/todos', { title, category: cat, priority: p }, T);
    ids.push(JSON.parse(r.body).id);
  }
  console.log('创建了', ids.length, '条测试待办');

  // 测试分类列表
  const cats = await req('GET', '/api/todos/categories', null, T);
  console.log('分类列表:', JSON.parse(cats.body));

  // 测试批量完成
  const batch = await req('POST', '/api/todos/batch', { ids: ids.slice(0, 2), action: 'complete' }, T);
  console.log('批量完成:', JSON.parse(batch.body));

  // 测试批量高优
  const batch2 = await req('POST', '/api/todos/batch', { ids: ids.slice(2, 4), action: 'priority', priority: 1 }, T);
  console.log('批量高优:', JSON.parse(batch2.body));

  // 验证结果
  const list = JSON.parse((await req('GET', '/api/todos', null, T)).body);
  console.log('当前待办:', list.map((t) => `[${t.priority === 1 ? '🔴' : t.priority === 3 ? '🔵' : '🟡'}] ${t.title} ${t.status === 'done' ? '✅' : ''}`).join(' | '));

  // 清理
  for (const id of ids) await req('DELETE', '/api/todos/' + id, null, T);
  console.log('已清理测试数据');
})().catch((e) => console.error('ERR', e.message));
