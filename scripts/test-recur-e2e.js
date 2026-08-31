// 服务端验证：创建→完成→等1分钟cron执行
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

  // 创建3个不同的重复待办并全部标记完成
  const titles = ['每天喝8杯水', '每天运动30分钟', '每天读书1小时'];
  for (const title of titles) {
    const r = await req('POST', '/api/todos', { title, recur_rule: 'daily' }, T);
    await req('PATCH', '/api/todos/' + JSON.parse(r.body).id, { status: 'done' }, T);
  }
  console.log('已创建并完成3个 daily 待办');

  // 等1分钟让 cron 执行
  console.log('等待 65 秒让 cron 执行...');
  await new Promise((r) => setTimeout(r, 65000));

  // 检查新实例
  const list = await req('GET', '/api/todos', null, T);
  const todos = JSON.parse(list.body);
  const newOnes = todos.filter((t) => titles.includes(t.title) && t.status === 'open');
  console.log('新实例数量:', newOnes.length, '/ 期望 3');
  for (const t of newOnes) {
    console.log('  ', t.title, '| due:', t.due_at);
  }
  console.log(newOnes.length === 3 ? '✅ 全部通过' : '⚠️ 部分未创建');
})().catch((e) => console.error('ERR', e.message));
