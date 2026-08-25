// 最终 PRD 验证：确认"确认提示"确实在回复里
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

  // 直接调 API 拿完整 summary
  const r = await req('POST', '/api/ai/chat', { message: '帮我写一份"社区团购平台"的PRD' }, T);
  const j = JSON.parse(r.body);
  const reply = j.reply || '';
  console.log('完整回复长度:', reply.length);
  console.log('含"确认":', reply.includes('确认') ? '✅' : '❌');
  console.log('含"导出":', reply.includes('导出') ? '✅' : '❌');
  console.log('含"审查":', reply.includes('审查') ? '✅' : '❌');
  console.log('含"📝 概述":', reply.includes('📝 概述') ? '✅' : '❌');
  console.log('含"功能清单":', reply.includes('功能清单') ? '✅' : '❌');
  console.log('含目标用户:', reply.includes('[object Object]') ? '❌含错误' : '✅格式正确');
})().catch((e) => console.error('ERR', e.message));
