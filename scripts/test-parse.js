// 测试 safeParseJson 容错解析
const nlp = require('../src/services/nlp');

const cases = [
  ['{"intent":"chat","confidence":0.9}', '标准 JSON'],
  ['```json\n{"intent":"web_search","confidence":0.95}\n```', 'markdown 包裹'],
  ['好的，我来分析。{"intent":"web_search","query":"xxx"}', '前后有文本'],
  ['{"intent":"chat"}', '缺 confidence'],
  ['纯文本没有JSON', '完全无 JSON'],
  ['{intent: "chat", confidence: 0.8}', '非标准 JSON'],
];

for (const [input, desc] of cases) {
  const r = nlp.safeParseJson(input);
  console.log(`[${desc}]`, JSON.stringify(r));
}

console.log('\n--- 分类测试（离线规则优先） ---');
const offlineCases = ['提醒我买牛奶', '明天下午3点开会', '你好', '查一下 世界杯'];
for (const c of offlineCases) {
  console.log(c, '→', JSON.stringify(nlp.offlineClassify(c)).slice(0, 100));
}
