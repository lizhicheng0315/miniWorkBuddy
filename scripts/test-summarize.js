// P0-1 上下文压缩端到端：灌入 >12 条消息 → 验证摘要生成 + getContext 分段
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

  // 建测试会话
  const s = await req('POST', '/api/chathistory/sessions', { title: '压缩测试会话' }, T);
  const sid = JSON.parse(s.body).id;
  console.log('会话 id:', sid);

  // 灌 14 条消息
  for (let i = 1; i <= 14; i++) {
    await req('POST', `/api/chathistory/sessions/${sid}/messages`, {
      role: i % 2 ? 'user' : 'bot',
      content: `第${i}条测试消息，内容关于${['项目管理', '代码评审', '部署流程', '性能优化'][i % 4]}的第${i}轮讨论`,
    }, T);
  }
  console.log('已灌入 14 条消息');

  // 触发压缩（压缩到第 10 条）
  const sum = await req('POST', `/api/chathistory/sessions/${sid}/summarize`, { untilId: 10 + sid * 1000 }, T);
  console.log('压缩响应:', sum.s, sum.body.slice(0, 120));

  // 验证 context：summary 有值、messages 变少
  const ctx = await req('GET', `/api/chathistory/sessions/${sid}/context`, null, T);
  const c = JSON.parse(ctx.body);
  console.log('\n=== 压缩后上下文 ===');
  console.log('摘要存在:', c.summary ? `✅ (${c.summary.length} 字)` : '❌ 无摘要');
  if (c.summary) console.log('摘要预览:', c.summary.slice(0, 150));
  console.log('未压缩剩余消息:', (c.messages || []).length, '条');

  // 清理
  await req('DELETE', `/api/chathistory/sessions/${sid}`, null, T);
  console.log('\n(测试会话已清理)');
})().catch((e) => console.error('ERR', e.message));
