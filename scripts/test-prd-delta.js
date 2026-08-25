// 验证 PRD 完整内容在 delta 里
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
  const r = await req('POST', '/api/ai/chat/stream', { message: '帮我写一份"社区团购平台"的PRD' }, T);
  // 收集所有 delta
  let full = '';
  for (const b of r.body.split('\n\n').filter((x) => x.includes('event: delta'))) {
    const m = b.match(/data: (.*)/s);
    if (m) { try { full += JSON.parse(m[1]).text; } catch {} }
  }
  console.log('delta 总长:', full.length);
  console.log('含"确认":', full.includes('确认') ? '✅' : '❌');
  console.log('含"📝 概述":', full.includes('📝 概述') ? '✅' : '❌');
  console.log('含"功能清单":', full.includes('功能清单') ? '✅' : '❌');
  console.log('含目标用户[object]:', full.includes('[object') ? '❌' : '✅');
  console.log('前150字:\n', full.slice(0, 150));
})().catch((e) => console.error('ERR', e.message));
