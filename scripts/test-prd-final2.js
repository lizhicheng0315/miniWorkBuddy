// PRD 终验：验证完整内容
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
  const r = await req('POST', '/api/ai/chat/stream', { message: '帮我写一份"智能家居控制系统"的PRD' }, T);
  let full = '';
  for (const b of r.body.split('\n\n').filter((x) => x.includes('event: delta'))) {
    const m = b.match(/data: (.*)/s);
    if (m) { try { full += JSON.parse(m[1]).text; } catch {} }
  }
  console.log('delta 总长:', full.length, full.length > 500 ? '✅ 完整' : '⚠️ 可能截断');
  console.log('含确认提示:', full.includes('确认') ? '✅' : '❌');
  console.log('含[object:', full.includes('[object') ? '❌' : '✅');
  console.log('\n--- 完整内容（前400字）---');
  console.log(full.slice(0, 400));
  console.log('\n--- 结尾 ---');
  console.log(full.slice(-150));
})().catch((e) => console.error('ERR', e.message));
