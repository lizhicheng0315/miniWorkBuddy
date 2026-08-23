// 全功能演示：按场景顺序跑一遍，输出真实交互内容
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
  try { return JSON.parse(doneB.match(/data: (.*)/s)[1]).reply; } catch { return '(无回复)'; }
}
function toolsOf(sseBody) {
  return sseBody.split('\n\n').filter((x) => x.includes('event: tool')).map((x) => {
    try { return '🔧 ' + JSON.parse(x.match(/data: (.*)/s)[1]).text; } catch { return ''; }
  });
}

(async () => {
  const L = await req('POST', '/api/auth/login', { username: 'admin', password: process.env.WBD_ADMIN_PASSWORD || 'password123' });
  const T = JSON.parse(L.body).token;

  // ===== 场景1：澄清工具 =====
  console.log('━━━━━━━━━━ 场景 1：模糊请求 → 主动追问（ask_clarification）━━━━━━━━━━');
  let r = await req('POST', '/api/ai/chat/stream', { message: '帮我做一份PPT' }, T);
  console.log('你: 帮我做一份PPT');
  console.log('🤖', replyOf(r.body).slice(0, 80));

  // ===== 场景2：PPT 完整门控流程 =====
  console.log('\n━━━━━━━━━━ 场景 2：PPT 门控流程（大纲⛔ → 确认 → 主题 → 导出）━━━━━━━━━━');
  r = await req('POST', '/api/ai/chat/stream', { message: '帮我做一份"WorkBuddy 项目季度总结"的PPT，只要5页' }, T);
  console.log('你: 帮我做一份"WorkBuddy 项目季度总结"的PPT，只要5页');
  for (const t of toolsOf(r.body)) console.log('  ' + t);
  console.log('🤖', replyOf(r.body).slice(0, 400));
  console.log('   …');

  r = await req('POST', '/api/ai/chat/stream', { message: '确认' }, T);
  console.log('\n你: 确认');
  console.log('🤖', replyOf(r.body).slice(0, 120));

  r = await req('POST', '/api/ai/chat/stream', { message: '科技黑' }, T);
  console.log('\n你: 科技黑');
  for (const t of toolsOf(r.body)) console.log('  ' + t);
  const finalReply = replyOf(r.body);
  console.log('🤖', finalReply.slice(0, 220));

  // 验证票据下载
  const m = finalReply.match(/\/api\/ppt\/download\/t\/([0-9a-f]+)/);
  if (m) {
    const dl = await req('GET', '/api/ppt/download/t/' + m[1], null, null); // 故意不带登录态
    console.log(`\n⬇️ 免登录下载验证: HTTP ${dl.s} | ${Math.round(dl.body.length / 1024)}KB | ZIP头: ${dl.body.slice(0, 2).toString('binary')}`);
  }

  // ===== 场景3：Agent 复合任务 + 工具转录 =====
  console.log('\n━━━━━━━━━━ 场景 3：复合任务一句话（Agent 自动拆步）━━━━━━━━━━');
  r = await req('POST', '/api/ai/chat/stream', { message: '创建一个待办"整理会议纪要"标记为高优先级，然后马上把它删除' }, T);
  console.log('你: 创建一个待办"整理会议纪要"标记为高优先级，然后马上把它删除');
  for (const t of toolsOf(r.body)) console.log('  ' + t);
  console.log('🤖', replyOf(r.body).slice(0, 150));

  // ===== 场景4：中文数字页码 =====
  console.log('\n━━━━━━━━━━ 场景 4：中文数字识别 ━━━━━━━━━━');
  r = await req('POST', '/api/ai/chat/stream', { message: '帮我做一份"测试中文页码"的PPT，只要3页' }, T);
  r = await req('POST', '/api/ai/chat/stream', { message: '第二页改成中文数字测试成功' }, T);
  console.log('你: 第二页改成中文数字测试成功');
  for (const t of toolsOf(r.body)) console.log('  ' + t);
  console.log('🤖', replyOf(r.body).slice(0, 100));

  // ===== 场景5：压缩状态查询 =====
  console.log('\n━━━━━━━━━━ 场景 5：会话记忆压缩（后台自动）━━━━━━━━━━');
  console.log('机制：未压缩消息 ≥12 条时，bot 回复落库后自动触发摘要压缩');
  console.log('当前阈值 SUMMARIZE_THRESHOLD = 12（可在 app.js 调整）');
})().catch((e) => console.error('ERR', e.message));
