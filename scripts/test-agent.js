// 结构测试：Agent 工具循环（mock LLM 决策）
process.env.AUTH_ENABLED = 'false';
const path = require('path');
const Svc = (f) => path.resolve(__dirname, '../src/services', f);
const Util = (f) => path.resolve(__dirname, '../src/utils', f);

// Mock llm.getClient 返回受控计划（plan-then-execute 格式）
const planJson = JSON.stringify({
  action: 'plan',
  steps: [
    { tool: 'create_todo', args: { title: '写论文', priority: 'high' } },
    { tool: 'create_reminder', args: { title: '每天提醒写论文', cron: '0 9 * * *' } },
  ],
});
let callIdx = 0;

require.cache[require.resolve(Svc('llm.js'))] = {
  id: 0, filename: Svc('llm.js'), loaded: true,
  exports: {
    resolveConfig: () => ({ apiKey: 'mock', model: 'mock-model', baseURL: 'http://mock' }),
    getClient: () => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: planJson } }],
            usage: null,
          }),
        },
      },
    }),
    recordUsage: () => {},
    chat: async () => ({ ok: true, text: 'mock' }),
    chatStream: async (m, o, cb) => { if (cb) cb('mock', 'mock'); return { ok: true, text: 'mock' }; },
  },
};

// mock db（避免 sql.js WASM 初始化）—— db.js 在 src/ 根目录
const created = [];
const DbPath = () => path.resolve(__dirname, '../src/db.js');
require.cache[require.resolve(DbPath())] = {
  id: 1, filename: DbPath(), loaded: true,
  exports: {
    list: () => [],
    find: () => null,
    insert: (table, row) => { created.push({ table, row }); return { id: created.length, ...row }; },
    update: () => ({}),
    remove: () => true,
    nowIso: () => new Date().toISOString(),
    rawDb: () => ({ run: () => {}, exec: () => [] }),
  },
};

// mock scheduler / ai / logger
require.cache[require.resolve(Svc('scheduler.js'))] = {
  id: 2, filename: Svc('scheduler.js'), loaded: true,
  exports: { isValidCron: (c) => /^[\d*/-]+ [\d*/-]+/.test(c || ''), register: () => {}, unregister: () => {}, loadAll: () => {} },
};
require.cache[require.resolve(Svc('ai.js'))] = {
  id: 3, filename: Svc('ai.js'), loaded: true,
  exports: { breakdown: async () => ({ ok: false }), dailyReport: async () => ({ ok: false }), weeklyReport: async () => ({ ok: false }), monthlyReview: async () => ({ ok: false }), summarize: async () => ({ ok: false }) },
};
require.cache[require.resolve(Svc('websearch.js'))] = {
  id: 4, filename: Svc('websearch.js'), loaded: true,
  exports: { search: async () => ({ ok: true, results: [{ title: 't', url: 'u', snippet: 's' }] }) },
};
try {
  const loggerPath = require.resolve(path.resolve(__dirname, '../src/logger.js'));
  require.cache[loggerPath] = { id: 5, filename: loggerPath, loaded: true, exports: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } };
} catch (_) { /* logger 路径不同则跳过 mock */ }

const nlp = require('../src/services/nlp');

(async () => {
  const steps = [];
  const result = await nlp.chat(1, '帮我建个高优先级待办"写论文"，并每天9点提醒我', {
    enableSearch: true,
    onStep: (s) => steps.push(s),
    onDelta: () => {},
  });
  console.log('intent:', result.intent);
  console.log('reply:', String(result.reply).slice(0, 80));
  console.log('steps:', JSON.stringify(result.steps.map(s => s.text)));
  console.log('created rows:', created.length);
  const ok = created.length === 2 && String(result.reply).includes('已创建') && steps.length >= 2;
  console.log(ok ? '\n✅ Agent 循环测试通过（多步工具 + final）' : '\n❌ 测试失败');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
