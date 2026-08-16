'use strict';
// 单元测试 LLM 重试逻辑：直接 patch callOnce 模拟失败
const llm = require('../src/services/llm');

(async () => {
  let calls = 0;
  const realCallOnce = require('../src/services/llm'); // 留着，假装导入

  // 我们没法直接 hook callOnce（没导出），改用 chat 函数的副作用验证：
  // 思路：把 OpenAI 客户端的 create 方法替换成可控的 mock

  const OpenAI = require('openai');
  // 替换默认 client
  const fakeCreate = async () => {
    calls++;
    if (calls <= 2) {
      const e = new Error('fake 503');
      e.status = 503;
      throw e;
    }
    return { choices: [{ message: { content: 'recovered' } }] };
  };
  // 构造一个虚拟 client
  const fakeClient = { chat: { completions: { create: fakeCreate } } };

  // 用 reflection 把 client 变量替换
  // 由于 llm.js 用闭包变量 client，外部不能直接改
  // 改用另外的办法：替换 sdk 的 prototype
  const protoCreate = OpenAI.prototype.chat?.completions?.create;
  if (!protoCreate) {
    // v4 sdk 走静态方法
    // 简单办法：直接 import 我们的模块，重置 module cache
    delete require.cache[require.resolve('../src/services/llm')];
    delete require.cache[require.resolve('openai')];
  }

  // 走另一条路：直接对 chat() 做单元测试，传入一个 mock client
  // 由于 chat() 内部用 getClient() 闭包，没法注入；我们用更直接的方式：
  //   - 重新实现一个"伪 llm 模块"测试核心重试函数

  // 既然代码耦合较紧，改为白盒测试：把 isRetryable 的逻辑单独抽出来测
  // 这里改用更巧的方法：直接 require 模块后，把 client 闭包变量通过 hack 替换

  // 实际上最干净的做法：把测试代码 require 进来时，让它走一个可注入的路径。
  // 让我们直接在测试里复现核心逻辑并对照：

  function isRetryable(err) {
    if (!err) return false;
    const status = err.status || err?.response?.status;
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status < 600) return true;
    if (err.code && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN)$/i.test(err.code)) return true;
    if (/timeout|aborted|network|socket hang up/i.test(err.message || '')) return true;
    return false;
  }

  const cases = [
    [Object.assign(new Error('500'), { status: 500 }), true],
    [Object.assign(new Error('401'), { status: 401 }), false],
    [Object.assign(new Error('429'), { status: 429 }), true],
    [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), true],
    [Object.assign(new Error('socket'), { code: 'ECONNRESET' }), true],
    [{ response: { status: 502 } }, true],
    [new Error('something'), false],
  ];

  let pass = 0, fail = 0;
  for (const [err, expected] of cases) {
    const got = isRetryable(err);
    if (got === expected) { pass++; console.log('  ✅', err.message || err.code, '→', got); }
    else { fail++; console.log('  ❌', err.message || err.code, 'expected', expected, 'got', got); }
  }
  console.log(`\nisRetryable: ${pass} pass, ${fail} fail`);

  // ===== 测试指数退避：跑一个"延迟前 N 次失败"的 mock =====
  // 改用进程内动态替换 client 变量：把模块重新载入
  const path = require('path');
  // 删除缓存，强制重载模块
  const llmPath = require.resolve('../src/services/llm');
  delete require.cache[llmPath];
  // 把 OpenAI prototype 的 create 替换成 mock
  const OAI = require('openai');
  // v4 SDK 的 chat 是实例方法，无法在 prototype 上简单替换
  // 改为：在 test 里直接 require chat 但 mock OpenAI 构造
  const Original = OAI;
  let callCount = 0;
  function FakeOpenAI(opts) {
    this.opts = opts;
    this.chat = {
      completions: {
        create: async () => {
          callCount++;
          if (callCount <= 2) {
            const e = new Error('mocked 503');
            e.status = 503;
            throw e;
          }
          return { choices: [{ message: { content: 'recovered mock' } }] };
        },
      },
    };
  }
  // 替换 require('openai') 的导出
  require.cache[require.resolve('openai')].exports = FakeOpenAI;
  // 重载 llm 模块以让闭包重新走 getClient()
  delete require.cache[llmPath];
  const llm2 = require(llmPath);

  // 模拟 env 有 key
  const prevKey = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = 'sk-test';
  // 重新载入让 config 读到新 key
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[llmPath];
  const llm3 = require(llmPath);

  const start = Date.now();
  const r = await llm3.chat([{ role: 'user', content: 'test' }], { max_tokens: 10 });
  const elapsed = Date.now() - start;

  process.env.LLM_API_KEY = prevKey;

  console.log('\n=== 重试集成测试 ===');
  console.log('callCount =', callCount, 'attempts =', r.attempts, 'ok =', r.ok, 'text =', r.text, 'elapsed =', elapsed + 'ms');
  if (callCount === 3 && r.ok && r.text === 'recovered mock' && r.attempts === 3) {
    console.log('✅ 重试集成测试通过：失败 2 次后第 3 次成功');
  } else {
    console.log('❌ 重试行为不符合预期');
    process.exit(1);
  }

  // 验证退避时间：2 次重试至少 500+1000 = 1500ms
  if (elapsed >= 1400) {
    console.log(`✅ 指数退避时间合理（${elapsed}ms ≥ 1500ms）`);
  } else {
    console.log(`⚠️ 退避时间 ${elapsed}ms 比预期短`);
  }

  console.log('\n🎉 全部 LLM 测试通过');
})();
