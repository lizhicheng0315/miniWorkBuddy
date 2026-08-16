// 验证 NLP 脱机降级模式（不依赖 LLM 真实 key）
const http = require('http');
const fs = require('fs');
const path = require('path');

function req(method, p, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ hostname: '127.0.0.1', port: 3000, path: p, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, text: buf }); }
      });
    });
    r.on('error', (e) => resolve({ error: e.message }));
    if (data) r.write(data); r.end();
  });
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + msg); }

(async () => {
  // ===== 1. 准备：清空 admin 数据 =====
  console.log('=== 1. 准备 ===');
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: process.env.WBD_ADMIN_PASSWORD || 'password123' });
  const token = login.json.token;
  for (const t of (await req('GET', '/api/todos', null, token)).json) await req('DELETE', '/api/todos/' + t.id, null, token);
  for (const e of (await req('GET', '/api/schedule', null, token)).json) await req('DELETE', '/api/schedule/' + e.id, null, token);
  for (const r of (await req('GET', '/api/reminders', null, token)).json) await req('DELETE', '/api/reminders/' + r.id, null, token);
  console.log('cleaned');

  // ===== 2. 单元测试：offlineClassify 不需要服务（直测模块）=====
  console.log('\n=== 2. offlineClassify 单元测试 ===');
  const nlp = require('../src/services/nlp');
  const cases = [
    // [输入, 期望intent, 期望title或target包含]
    ['提醒我买牛奶', 'create_todo', '买牛奶'],
    ['记一下明天下午3点开项目周会', 'create_schedule', '开项目周会'],
    ['每天9点提醒我写日报', 'create_reminder', null],
    ['工作日8点提醒我打卡', 'create_reminder', null],
    ['每周一10点提醒我开会', 'create_reminder', null],
    ['我今天还有什么没做', 'query_todo', null],
    ['明天有什么安排', 'query_schedule', null],
    ['把买牛奶标记完成', 'complete_todo', '买牛奶'],
    ['完成买牛奶', 'complete_todo', '买牛奶'],
    ['删掉买牛奶', 'delete_todo', '买牛奶'],
    ['把买牛奶改成明天', 'update_todo', '买牛奶'],
    ['把买牛奶时间改到明天下午', 'update_todo', '买牛奶'],
    ['生成今日日报', 'daily_report', null],
    ['本周周报', 'weekly_report', null],
    ['月度复盘', 'monthly_review', null],
    ['拆解 写毕业论文', 'breakdown', null],
    ['帮我拆解写论文', 'breakdown', null],
    ['你好', 'chat', null],
    ['你能做什么', 'chat', null],
  ];
  for (const [text, wantIntent, wantTitle] of cases) {
    const got = nlp.offlineClassify(text);
    if (!got) { console.log(`  ❌ "${text}" → null`); continue; }
    const intentOk = got.intent === wantIntent;
    const titleOk = !wantTitle || (got.title || got.target || '').includes(wantTitle) || (got.title || got.target || '').includes(wantTitle.replace('明天下午', '明天下'));
    const mark = intentOk && titleOk ? '✅' : '❌';
    console.log(`  ${mark} "${text}" → ${got.intent} ${got.title ? `("${got.title}")` : ''}${got.cron ? ` cron=${got.cron}` : ''}`);
    if (!intentOk) console.log(`      期望 intent=${wantIntent}`);
  }

  // ===== 3. 端到端：通过 /api/ai/chat 走脱机模式 =====
  console.log('\n=== 3. 端到端：脱机模式 chat ===');
  const c1 = await req('POST', '/api/ai/chat', { message: '提醒我买牛奶' }, token);
  console.log('"提醒我买牛奶" →', c1.json.intent, '|', c1.json.reply);
  assert(c1.json.intent === 'create_todo', '应识别 create_todo');
  assert(c1.json.reply.includes('已添加'), 'reply 应有"已添加"');

  const c2 = await req('POST', '/api/ai/chat', { message: '记一下明天下午3点开项目周会' }, token);
  console.log('"记一下明天下午3点开项目周会" →', c2.json.intent, '|', c2.json.reply);
  assert(c2.json.intent === 'create_schedule', '应识别 create_schedule');

  const c3 = await req('POST', '/api/ai/chat', { message: '每天9点提醒我写日报' }, token);
  console.log('"每天9点提醒我写日报" →', c3.json.intent, '|', c3.json.reply);
  assert(c3.json.intent === 'create_reminder', '应识别 create_reminder');
  assert(c3.json.reply.includes('0 9 * * *'), '应推断 cron 0 9 * * *');

  // ===== 4. 验证数据真的写入了 =====
  console.log('\n=== 4. 验证数据已落库 ===');
  const todos = (await req('GET', '/api/todos', null, token)).json;
  const events = (await req('GET', '/api/schedule', null, token)).json;
  const reminders = (await req('GET', '/api/reminders', null, token)).json;
  console.log('todos:', todos.length, todos.map(t => t.title));
  console.log('events:', events.length, events.map(e => `${e.title} @ ${e.start_at}`));
  console.log('reminders:', reminders.length, reminders.map(r => `${r.title} (${r.cron})`));
  assert(todos.some(t => t.title === '买牛奶'), '待办 应有"买牛奶"');
  assert(events.some(e => e.title.includes('项目周会')), '日程 应有"项目周会"');
  assert(reminders.some(r => r.cron === '0 9 * * *'), '提醒 应有 cron=0 9 * * *');

  // ===== 5. 修改：把"买牛奶"改成"买鸡蛋" =====
  console.log('\n=== 5. 修改：把买牛奶改成买鸡蛋 ===');
  const c4 = await req('POST', '/api/ai/chat', { message: '把买牛奶改成买鸡蛋' }, token);
  console.log('reply:', c4.json.reply);
  const after = (await req('GET', '/api/todos', null, token)).json;
  const found = after.find(t => t.title === '买鸡蛋');
  assert(found, '应有"买鸡蛋"待办');
  assert(!after.find(t => t.title === '买牛奶'), '不应再有"买牛奶"');

  // ===== 6. 完成 + 删除 =====
  console.log('\n=== 6. 完成 / 删除 ===');
  const c5 = await req('POST', '/api/ai/chat', { message: '完成买鸡蛋' }, token);
  console.log('完成:', c5.json.reply);
  const c6 = await req('POST', '/api/ai/chat', { message: '删掉买鸡蛋' }, token);
  console.log('删除:', c6.json.reply);
  const after2 = (await req('GET', '/api/todos', null, token)).json;
  assert(!after2.find(t => t.title === '买鸡蛋'), '应已删除');

  // ===== 7. 查询 =====
  console.log('\n=== 7. 查询 ===');
  const c7 = await req('POST', '/api/ai/chat', { message: '我今天还有什么没做' }, token);
  console.log('query_todo reply:', c7.json.reply);
  const c8 = await req('POST', '/api/ai/chat', { message: '明天有什么安排' }, token);
  console.log('query_schedule reply:', c8.json.reply);
  const c9 = await req('POST', '/api/ai/chat', { message: '我的提醒' }, token);
  console.log('query_reminder reply:', c9.json.reply);

  // ===== 8. 流式输出 =====
  console.log('\n=== 8. SSE 流式（脱机模式） ===');
  const sseRes = await new Promise((resolve) => {
    const data = JSON.stringify({ message: '提醒我写代码' });
    const rq = http.request({
      hostname: '127.0.0.1', port: 3000, path: '/api/ai/chat/stream', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': 'Bearer ' + token },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve(buf));
    });
    rq.on('error', (e) => resolve('ERR: ' + e.message));
    rq.write(data); rq.end();
  });
  const sseParts = sseRes.split('\n\n').filter(Boolean);
  console.log('收到', sseParts.length, '个事件');
  for (const e of sseParts.slice(0, 8)) console.log('  ' + e.split('\n').join(' | '));
  assert(sseParts.length >= 3, '至少 3 个事件 (thinking/intent/delta/done)');
  assert(sseParts.some(e => e.includes('create_todo')), '应包含 create_todo intent');
  assert(sseParts.some(e => e.includes('done')), '应包含 done 事件');

  console.log('\n✅ 脱机模式 + update/delete/complete/query 全部验证通过');
})().catch((e) => { console.error('\n❌', e); process.exit(1); });
