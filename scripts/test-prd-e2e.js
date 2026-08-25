// PRD 全流程 E2E 验证
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
function replyOf(sseBody) {
  const doneB = sseBody.split('\n\n').filter((x) => x.includes('event: done'))[0];
  try { return JSON.parse(doneB.match(/data: (.*)/s)[1]).reply; } catch { return ''; }
}

(async () => {
  const L = await req('POST', '/api/auth/login', { username: 'admin', password: process.env.WBD_ADMIN_PASSWORD || 'password123' });
  const T = JSON.parse(L.body).token;

  // 1. 生成
  let r = await req('POST', '/api/ai/chat/stream', { message: '帮我写一份"智能会议室预约系统"的需求文档' }, T);
  let reply = replyOf(r.body);
  console.log('1.生成:', reply.includes('确认') ? '✅有确认提示' : '⚠️无确认提示',
    '| 不含[object Object]:', reply.includes('[object Object]') ? '❌' : '✅');
  console.log('   前100字:', reply.slice(0, 100));

  // 2. 确认导出
  r = await req('POST', '/api/ai/chat/stream', { message: '确认' }, T);
  reply = replyOf(r.body);
  console.log('2.确认导出:', reply.includes('/api/prd/download/') ? '✅有下载链接' : '❌');
  const m = reply.match(/\/api\/prd\/download\/t\/([0-9a-f]+)/);
  if (m) {
    const dl = await req('GET', '/api/prd/download/t/' + m[1], null, null);
    console.log('3.下载:', dl.s === 200 ? '✅' : '❌', dl.s, '|', dl.body.length, 'B |', dl.body.startsWith('#') ? '有效MD' : '❌');
  }

  // 4. 审查
  r = await req('POST', '/api/ai/chat/stream', { message: '帮我写一份"企业HR管理系统"的PRD' }, T);
  r = await req('POST', '/api/ai/chat/stream', { message: '帮我审查一下这份PRD' }, T);
  reply = replyOf(r.body);
  console.log('4.审查:', reply.length > 50 ? '✅返回' + reply.length + '字' : '⚠️', reply.slice(0, 80));
})().catch((e) => console.error('ERR', e.message));
