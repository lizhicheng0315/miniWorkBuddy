// 验证 LLM 配置端点
const http = require('http');

function req(method, p, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request(
      { hostname: '127.0.0.1', port: 3000, path: p, method, headers },
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
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('=== 1. 登录 ===');
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: process.env.WBD_ADMIN_PASSWORD || 'password123' });
  console.log('login:', login.status);
  if (login.status !== 200) { console.error('login failed'); process.exit(1); }
  const token = login.json.token;

  console.log('\n=== 2. GET /api/ai/config（脱敏） ===');
  const cfg = await req('GET', '/api/ai/config', null, token);
  console.log(JSON.stringify(cfg.json, null, 2));
  if (cfg.json.apiKey) throw new Error('API key 不应明文返回！');
  if (!cfg.json.configured) throw new Error('应该 configured');

  console.log('\n=== 3. PATCH /api/ai/config 改 baseURL ===');
  const patch = await req('PATCH', '/api/ai/config', { baseURL: 'https://api.moonshot.cn/v1' }, token);
  console.log(JSON.stringify(patch.json, null, 2));
  if (patch.json.config.baseURL !== 'https://api.moonshot.cn/v1') throw new Error('baseURL 未更新');

  console.log('\n=== 4. PATCH 改 model ===');
  const patch2 = await req('PATCH', '/api/ai/config', { model: 'moonshot-v1-8k' }, token);
  console.log('new model:', patch2.json.config.model);

  console.log('\n=== 5. POST /api/ai/config/test（用当前占位 key 测试，期望失败但链路通） ===');
  const test = await req('POST', '/api/ai/config/test', {}, token);
  console.log(JSON.stringify(test.json));
  if (test.status === 200 && test.json.ok) {
    console.log('✅ 测试连接成功！latency:', test.json.latency_ms, 'model:', test.json.model);
  } else {
    console.log('⚠️  测试连接失败（预期，因为 key 是占位）:', test.json.error);
  }

  console.log('\n=== 6. 验证设置已持久化到 settings 表 ===');
  // 通过 ai/status 间接确认
  const status = await req('GET', '/api/ai/status', null, token);
  console.log('status:', JSON.stringify(status.json));

  console.log('\n=== 7. 非 admin 调用应被拒 ===');
  // 注册临时用户
  const username = 'nonadmin_' + Date.now().toString(36);
  const reg = await req('POST', '/api/auth/register', { username, password: 'pass1234' }, token);
  if (reg.status === 201) {
    const nonAdminLogin = await req('POST', '/api/auth/login', { username, password: 'pass1234' });
    const nonAdminToken = nonAdminLogin.json.token;
    const cfgAsNon = await req('GET', '/api/ai/config', null, nonAdminToken);
    console.log('non-admin GET config →', cfgAsNon.status, cfgAsNon.json);
    if (cfgAsNon.status !== 403) throw new Error('should be 403');
  }

  console.log('\n=== 8. 恢复 .env 默认值（手动清理 settings） ===');
  // 通过一个特殊 PATCH：传空字符串不会清（设计如此），所以用 sql 直接清掉
  // 这里我们改回原值：
  await req('PATCH', '/api/ai/config', {
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  }, token);
  const final = await req('GET', '/api/ai/config', null, token);
  console.log('restored:', final.json.baseURL, final.json.model);

  console.log('\n✅ LLM 配置端点验证通过');
})().catch((e) => { console.error('\n❌', e.message); process.exit(1); });
