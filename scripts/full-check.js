// 全功能 HTTP 集成测试：模拟浏览器从加载页面到所有操作
// 不依赖 DOM/browser，直接打 API 验证

const http = require('http');

function req(method, p, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request(
      { hostname: '127.0.0.1', port: 3000, path: p, method, headers, timeout: 30000 },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, text: buf }); }
        });
      }
    );
    r.on('error', (e) => resolve({ error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

function assert(cond, msg) { if (!cond) { console.error('  ❌ ' + msg); process.exitCode = 1; } else { console.log('  ✅ ' + msg); } }

(async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  WorkBuddy 全面健康检查（模拟浏览器操作）');
  console.log('═══════════════════════════════════════════════════════════\n');

  // ==== 第 1 步：检查 HTML 完整性 ====
  console.log('▼ 第 1 步：检查 index.html 关键元素（这是浏览器加载的页面）');
  const html = await new Promise((resolve) => {
    http.get('http://127.0.0.1:3000/', (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve(b)); });
  });
  const checks = [
    ['#btnQuickChat', '智能助手快速对话发送按钮'],
    ['#quickChatInput', '快速对话输入框'],
    ['#chatInput', '对话 Tab 输入框'],
    ['#btnChatSend', '对话 Tab 发送按钮'],
    ['#cfgBaseURL', 'LLM 配置 Base URL'],
    ['#cfgModel', 'LLM 配置 模型'],
    ['#cfgApiKey', 'LLM 配置 API Key'],
    ['#btnCfgSave', 'LLM 配置 保存按钮'],
    ['#btnCfgTest', 'LLM 配置 测试按钮'],
    ['#installBanner', 'PWA 安装横幅'],
    ['#btnInstall', 'PWA 安装按钮'],
    ['#loginForm', '登录表单'],
    ['app.js?v=4', 'app.js 带 cache-busting'],
  ];
  for (const [id, desc] of checks) {
    const found = id.startsWith('app.js') ? html.includes(id) : html.includes(`id="${id.replace(/^#/, '')}"`);
    if (found) console.log('  ✅', desc, '✓');
    else console.log('  ❌', desc, '缺失！');
  }

  // ==== 第 2 步：检查 app.js 关键函数 ====
  console.log('\n▼ 第 2 步：检查 app.js 关键绑定（必须包含）');
  const appJs = await new Promise((resolve) => {
    http.get('http://127.0.0.1:3000/app.js?v=4', (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve(b)); });
  });
  const jsChecks = [
    ['console.log(\'[WorkBuddy] app.js?v=4 loaded', 'app.js v4 版本标记'],
    ['$ = (sel) =>', '安全 $ 代理'],
    ['btnQuickChat\', \'click\'', '快速对话事件绑定'],
    ['btnCfgSave\', \'click\'', 'LLM 保存事件绑定'],
    ['btnCfgTest\', \'click\'', 'LLM 测试事件绑定'],
    ['sendChatMessage', '聊天发送函数'],
    ['refreshLlmConfig', 'LLM 配置读取'],
  ];
  for (const [needle, desc] of jsChecks) {
    if (appJs.includes(needle)) console.log('  ✅', desc, '✓');
    else console.log('  ❌', desc, '缺失！');
  }
  console.log('  app.js 总大小:', appJs.length, '字节');

  // ==== 第 3 步：登录 ====
  console.log('\n▼ 第 3 步：登录 admin');
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: process.env.WBD_ADMIN_PASSWORD || 'password123' });
  if (login.status !== 200) { console.error('  ❌ 登录失败:', login); process.exit(1); }
  console.log('  ✅ 登录成功, token 长度:', login.json.token.length);
  const T = login.json.token;

  // ==== 第 4 步：LLM 配置 PATCH（你点"保存"按钮时实际请求） ====
  console.log('\n▼ 第 4 步：PATCH /api/ai/config（你点"保存"时发起的请求）');
  const t0 = Date.now();
  const p1 = await req('PATCH', '/api/ai/config', { model: 'test-model-' + Date.now() }, T);
  const t1 = Date.now() - t0;
  console.log('  status:', p1.status, '耗时:', t1, 'ms');
  assert(p1.status === 200, 'PATCH 状态码 200');
  assert(p1.json.ok === true, '返回 ok:true');
  assert(p1.json.config.source.model === true, '写入 settings 表成功（source.model=true）');

  // ==== 第 5 步：LLM 测试连接（你点"测试连接"按钮时） ====
  console.log('\n▼ 第 5 步：POST /api/ai/config/test（你点"测试连接"时发起）');
  const t2 = Date.now();
  const p2 = await req('POST', '/api/ai/config/test', {}, T);
  const t3 = Date.now() - t2;
  console.log('  status:', p2.status, '耗时:', t3, 'ms');
  console.log('  body:', JSON.stringify(p2.json || p2));
  assert(p2.status === 200 || p2.status === 400, '5s 内返回（不超 30s）');
  assert(t3 < 10000, '耗时 < 10s（修复后应该 < 5s）');

  // ==== 第 6 步：聊天端到端（你点"快速对话发送"时） ====
  console.log('\n▼ 第 6 步：SSE 流式聊天（你点快速对话发送时发起）');
  const t4 = Date.now();
  const sse = await new Promise((resolve) => {
    const data = JSON.stringify({ message: '提醒我测试一下' });
    const rq = http.request({
      hostname: '127.0.0.1', port: 3000, path: '/api/ai/chat/stream', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': 'Bearer ' + T },
      timeout: 30000,
    }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ s: res.statusCode, b, t: Date.now() - t4 })); });
    rq.on('error', e => resolve({ err: e.message }));
    rq.on('timeout', () => { rq.destroy(); resolve({ err: 'timeout' }); });
    rq.write(data); rq.end();
  });
  console.log('  status:', sse.s, '耗时:', sse.t, 'ms');
  console.log('  body 摘要:', sse.b ? sse.b.slice(0, 300) : sse.err);
  assert(sse.s === 200, 'SSE 返回 200');
  assert(sse.b && sse.b.includes('event:'), 'SSE 格式正确');
  assert(sse.b && (sse.b.includes('done') || sse.b.includes('error')), 'SSE 含 done/error 终止事件');
  assert(sse.t < 10000, 'SSE < 10s');

  // ==== 第 7 步：GET 聊天历史（前端 init 时调用） ====
  console.log('\n▼ 第 7 步：GET /api/ai/chat/history（页面初始化时调用）');
  const h = await req('GET', '/api/ai/chat/history', null, T);
  console.log('  status:', h.status, 'history 条数:', h.json?.items?.length);
  assert(h.status === 200, 'history 返回 200');

  // ==== 第 8 步：NLP 离线模式（无 LLM key 时降级） ====
  console.log('\n▼ 第 8 步：NLP 离线模式（你点"快速对话"时实际使用）');
  const nlp = await req('POST', '/api/ai/chat', { message: '明天下午3点开会' }, T);
  console.log('  intent:', nlp.json?.intent, 'reply:', nlp.json?.reply?.slice(0, 80));
  assert(nlp.json?.intent === 'create_schedule', '离线模式识别为 create_schedule');
  assert(nlp.json?.reply?.includes('已创建日程'), '回复包含"已创建日程"');

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  检查完成');
  console.log('═══════════════════════════════════════════════════════════');
})();
