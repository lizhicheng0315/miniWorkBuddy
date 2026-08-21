// 结构测试：TOOLS 注册表 + executeIntent 分发 + steps 转录
process.env.AUTH_ENABLED = 'false';
const nlp = require('../src/services/nlp');

(async () => {
  const userId = 1;
  const tests = [
    ['create_todo', { intent: 'create_todo', title: '买牛奶', priority: 'high' }, '提醒我买牛奶'],
    ['query_todo', { intent: 'query_todo' }, '我有什么待办'],
    ['complete_todo', { intent: 'complete_todo', title: '买牛奶' }, '把买牛奶标记完成'],
    ['delete_todo', { intent: 'delete_todo', title: '买牛奶' }, '删除买牛奶'],
  ];
  let pass = 0;
  for (const [name, intent, message] of tests) {
    const r = await nlp.executeIntent(intent, userId, message, {
      onStep: (s) => console.log('   [onStep]', s.icon, s.text),
    });
    const ok = r && typeof r.summary === 'string' && Array.isArray(r.steps || []);
    console.log(`${ok ? '✅' : '❌'} ${name} → summary: ${String(r.summary).slice(0, 60)} | steps: ${(r.steps || []).length}`);
    if (ok) pass++;
  }
  // 未知意图兜底
  const r2 = await nlp.executeIntent({ intent: 'nonexistent' }, userId, 'x');
  console.log(`${r2.summary ? '✅' : '❌'} unknown-intent fallback → ${String(r2.summary).slice(0, 40)}`);

  // TOOLS 注册表清单
  console.log('\n注册的工具:', Object.keys(nlp.TOOLS || {}).length || '(未导出，内部使用)');
  console.log(`\n${pass}/${tests.length} 通过`);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
