// E2E：PPT Agent 门控全流程（真实 LLM）
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
  try { return JSON.parse(doneB.match(/data: (.*)/s)[1]).reply; } catch { return '(no reply)'; }
}

(async () => {
  const L = await req('POST', '/api/auth/login', { username: 'admin', password: process.env.WBD_ADMIN_PASSWORD || 'password123' });
  const T = JSON.parse(L.body).token;

  console.log('=== 第1步：发起 PPT 请求（应生成大纲并停下等确认）===');
  let r = await req('POST', '/api/ai/chat/stream', { message: '帮我做一份"2026年新产品发布计划"的PPT' }, T);
  console.log(replyOf(r.body).slice(0, 300));
  console.log('\n=== 第2步：回复「确认」（应进入主题选择）===');
  r = await req('POST', '/api/ai/chat/stream', { message: '确认' }, T);
  console.log(replyOf(r.body).slice(0, 200));
  console.log('\n=== 第3步：选商务蓝（应直接生成 pptx + 下载卡片）===');
  r = await req('POST', '/api/ai/chat/stream', { message: '商务蓝' }, T);
  const reply = replyOf(r.body);
  console.log(reply.slice(0, 250));
  const hasCard = /\/api\/ppt\/download\/[0-9a-f]+/.test(reply);
  console.log(hasCard ? '\n✅ 全流程通过：含下载链接' : '\n❌ 未拿到下载链接');

  // 验证下载端点
  const m = reply.match(/\/api\/ppt\/download\/([0-9a-f]+)/);
  if (m) {
    const dl = await req('GET', '/api/ppt/download/' + m[1], null, T);
    console.log('下载校验:', dl.s === 200 ? '✅ HTTP 200' : '❌ ' + dl.s, '| 大小:', Math.round(dl.body.length / 1024), 'KB | ZIP头:', dl.body.slice(0, 2).toString());
  }
})().catch((e) => console.error('ERR', e.message));
