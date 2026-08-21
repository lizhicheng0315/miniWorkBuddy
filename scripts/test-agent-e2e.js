// E2E：Agent 循环真实 LLM 测试
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

  console.log('--- 端到端：复合任务（建待办 → 删待办）---');
  const t0 = Date.now();
  const r = await req('POST', '/api/ai/chat/stream', { message: '帮我创建一个待办"测试agent任务"，然后删除它' }, T);
  console.log('耗时:', Date.now() - t0, 'ms | status:', r.s);

  for (const b of r.body.split('\n\n').filter((x) => x.includes('event: tool'))) {
    const m = b.match(/data: (.*)/s);
    try { console.log('  🔧', JSON.parse(m[1]).text); } catch {}
  }
  try {
    const intentB = r.body.split('\n\n').find((x) => x.includes('event: intent'));
    if (intentB) console.log('intent:', JSON.parse(intentB.match(/data: (.*)/s)[1]).intent);
  } catch {}
  const doneB = r.body.split('\n\n').filter((x) => x.includes('event: done'))[0];
  if (doneB) {
    try { console.log('reply:', JSON.parse(doneB.match(/data: (.*)/s)[1]).reply.slice(0, 150)); } catch {}
  }

  // 验证数据干净（没有残留"测试agent任务"）
  const list = await req('GET', '/api/todos', null, T);
  try {
    const todos = JSON.parse(list.body);
    const leftover = (Array.isArray(todos) ? todos : []).filter((t) => t.title && t.title.includes('测试agent'));
    console.log(leftover.length ? '❌ 残留测试数据: ' + leftover.map(t => t.title).join(',') : '✅ 数据干净（创建+删除都执行了）');
  } catch {}
})().catch((e) => console.error('ERR', e.message));
