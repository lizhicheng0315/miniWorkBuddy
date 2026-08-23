// 诊断 llm.chatStream 是否真流式（记录 onDelta 回调时序）
process.env.AUTH_ENABLED = 'false';
const db = require('../src/db');
const llm = require('../src/services/llm');

(async () => {
  await db.init(); // async 初始化 sql.js
  const cfg = llm.resolveConfig();
  console.log('LLM:', cfg.baseURL, '| model:', cfg.model, '| key:', cfg.apiKey ? cfg.apiKey.slice(0, 8) + '…' : '(无)');
  const t0 = Date.now();
  let count = 0;
  let firstAt = null;
  const r = await llm.chatStream(
    [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '用三句话介绍上海' },
    ],
    { temperature: 0.7, max_tokens: 200 },
    (delta) => {
      count++;
      if (!firstAt) firstAt = Date.now() - t0;
    }
  );
  console.log('ok:', r.ok);
  console.log('onDelta 调用次数:', count);
  console.log('首个回调延迟:', firstAt, 'ms');
  console.log('总耗时:', Date.now() - t0, 'ms');
  console.log(count > 3 ? '✅ chatStream 真流式' : '❌ chatStream 也是一次性到达（接口不支持 stream 或被聚合）');
})();
