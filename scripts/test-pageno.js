// extractPageNo 中文/阿拉伯数字页码测试
const nlp = require('../src/services/nlp');
const cases = [
  ['第3页改成XX', 3],
  ['第三页改成XX', 3],
  ['第四页改为可持续的AI生态', 4],
  ['第 12 页', 12],
  ['第十二页', 12],
  ['第二十页', 20],
  ['第二十五页', 25],
  ['第十页', 10],
  ['第一百零一页', 101],
  ['把买牛奶标记完成', 0],       // 无页码
  ['帮我做一份PPT', 0],
];
let pass = 0;
for (const [input, want] of cases) {
  const got = nlp.extractPageNo(input);
  const ok = got === want;
  if (ok) pass++;
  console.log(`${ok ? '✅' : '❌'} "${input}" → ${got}${ok ? '' : '（期望 ' + want + '）'}`);
}
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);
