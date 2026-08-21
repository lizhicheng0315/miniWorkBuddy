// 模拟双击发送：同时发两个请求（防重入锁修复前的行为）
const http = require('http');
function req(m, p, b, t) {
  return new Promise((r) => {
    const d = b ? JSON.stringify(b) : '';
    const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) };
    if (t) h.Authorization = 'Bearer ' + t;
    const rq = http.request({ hostname: '127.0.0.1', port: 3000, path: p, method: m, headers: h }, (rs) => {
      let buf = '';
      rs.on('data', (c) => buf += c);
      rs.on('end', () => r({ s: rs.statusCode, body: buf }));
    });
    rq.on('error', (e) => r({ err: e.message }));
    if (d) rq.write(d);
    rq.end();
  });
}

(async () => {
  const L = await req('POST', '/api/auth/login', { username: 'admin', password: process.env.WBD_ADMIN_PASSWORD || 'password123' });
  const T = JSON.parse(L.body).token;

  console.log('=== 同时发出两个相同请求（模拟双击）===');
  const [r1, r2] = await Promise.all([
    req('POST', '/api/ai/chat/stream', { message: '你好' }, T),
    req('POST', '/api/ai/chat/stream', { message: '你好' }, T),
  ]);
  for (const [i, r] of [r1, r2].entries()) {
    const deltas = (r.body.match(/event: delta/g) || []).length;
    const doneB = r.body.split('\n\n').filter((x) => x.includes('event: done'))[0];
    let reply = '';
    try { reply = JSON.parse(doneB.match(/data: (.*)/s)[1]).reply.slice(0, 60); } catch {}
    console.log(`请求${i + 1}: delta=${deltas} | reply=${reply}`);
  }
  console.log('\n→ 服务端会老实回答两次（每个请求一次）。');
  console.log('→ 前端 v18 的 chatSending 锁会让第二次点击直接被忽略，不再发第二个请求。');
})().catch((e) => console.error('ERR', e.message));
