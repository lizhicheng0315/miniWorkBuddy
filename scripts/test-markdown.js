// 测试 renderMarkdown：XSS 安全 + Markdown 正确性（在 Node 中模拟 DOM 无关部分）
// 提取 app.js 中的纯函数
const fs = require('fs');
const src = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

// 截取 escapeMd / renderMarkdown / highlightCode / renderCodeBlock 函数定义
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('not found: ' + name);
  let depth = 0, i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
const code = [extract('escapeMd'), extract('highlightCode'), extract('renderCodeBlock'), extract('renderMarkdown')].join('\n');
// renderMarkdown 依赖 renderCodeBlock；renderCodeBlock 依赖 escapeMd/highlightCode
const fn = new Function(code + '; return renderMarkdown;')();

let pass = 0, fail = 0;
function check(desc, input, mustInclude, mustNotInclude) {
  const out = fn(input);
  const okInc = !mustInclude || mustInclude.every((s) => out.includes(s));
  const okExc = !mustNotInclude || mustNotInclude.every((s) => !out.includes(s));
  if (okInc && okExc) { pass++; console.log('✅', desc); }
  else { fail++; console.log('❌', desc, '\n   output:', out.slice(0, 150)); }
}

check('粗体', '**加粗文字**', ['<strong>加粗文字</strong>'], []);
check('斜体', '*斜体*', ['<em>斜体</em>'], []);
check('行内码', '用 `npm install` 安装', ['<code class="md-code">npm install</code>'], []);
check('代码块+语言标注', '```js\nconst a = 1;\n```', ['code-block', 'tok-kw', '<span class="cb-lang">js</span>', '复制'], []);
check('无序列表', '- 苹果\n- 香蕉', ['<ul class="md-list">', '<li>苹果</li>', '<li>香蕉</li>'], []);
check('有序列表', '1. 第一\n2. 第二', ['<ol class="md-list">', '<li>第一</li>'], []);
check('标题', '## 小节', ['md-h'], []);
check('链接', '[百度](https://baidu.com)', ['<a href="https://baidu.com"'], []);
check('XSS script 注入被转义', '<script>alert(1)</script>', ['&lt;script&gt;'], ['<script>']);
check('XSS img onerror 被转义', '<img src=x onerror=alert(1)>', ['&lt;img'], ['<img']);
check('XSS 通过链接 href', '[x](javascript:alert(1))', [], ['href="javascript:']);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
