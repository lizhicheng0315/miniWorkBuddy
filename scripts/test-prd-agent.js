// PRD 全流程 E2E 测试：生成 → 审查 → 导出
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
function toolsOf(sseBody) {
  return sseBody.split('\n\n').filter((x) => x.includes('event: tool')).map((x) => {
    try { return '🔧 ' + JSON.parse(x.match(/data: (.*)/s)[1]).text; } catch { return ''; }
  });
}

(async () => {
  const L = await req('POST', '/api/auth/login', { username: 'admin', password: process.env.WBD_ADMIN_PASSWORD || 'password123' });
  const T = JSON.parse(L.body).token;

  // ===== 场景1：PRD 生成 =====
  console.log('━━━━━━━━━━ 场景 1：PRD 生成━━━━━━━━━━');
  let r = await req('POST', '/api/ai/chat/stream', { message: '帮我写一份"在线教育平台"的需求文档' }, T);
  for (const t of toolsOf(r.body)) console.log('  ' + t);
  const reply1 = replyOf(r.body);
  console.log('🤖 回复前200字:\n', reply1.slice(0, 250));
  const hasConfirm = reply1.includes('确认');
  console.log(hasConfirm ? '\n✅ 门控正确：等待用户确认' : '\n⚠️ 未检测到确认提示');

  // ===== 场景2：直接确认 → 导出 =====
  console.log('\n━━━━━━━━━━ 场景 2：确认导出 Markdown ━━━━━━━━━━');
  r = await req('POST', '/api/ai/chat/stream', { message: '确认' }, T);
  for (const t of toolsOf(r.body)) console.log('  ' + t);
  const reply2 = replyOf(r.body);
  console.log('🤖 回复前200字:\n', reply2.slice(0, 200));
  const ticketM = reply2.match(/\/api\/prd\/download\/t\/([0-9a-f]+)/);
  if (ticketM) {
    console.log('\n✅ 导出链接存在');
    // 验证下载
    const dl = await req('GET', '/api/prd/download/t/' + ticketM[1], null, null);
    console.log('⬇️ 免登录下载:', dl.s === 200 ? '✅ HTTP 200' : '❌ ' + dl.s,
      '|', Math.round(dl.body.length / 1024), 'KB',
      '| 前20字:', dl.body.slice(0, 20));
    // 验证是有效 Markdown
    const isMd = dl.body.startsWith('# ');
    console.log(isMd ? '✅ 是有效 Markdown 文件' : '❌ 不是 Markdown');
  } else {
    console.log('\n⚠️ 未检测到下载链接');
  }

  // ===== 场景3：审查 =====
  console.log('\n━━━━━━━━━━ 场景 3：PRD 审查 ━━━━━━━━━━');
  r = await req('POST', '/api/ai/chat/stream', { message: '帮我做一份新的"智能家居控制系统"的PRD' }, T);
  r = await req('POST', '/api/ai/chat/stream', { message: '帮我审查一下这份PRD' }, T);
  const reply3 = replyOf(r.body);
  console.log('🤖 审查意见:\n', reply3.slice(0, 300));
  console.log(reply3.includes('建议') || reply3.includes('审查') ? '\n✅ 审查通过' : '\n⚠️ 可能不是审查内容');
})().catch((e) => console.error('ERR', e.message));
