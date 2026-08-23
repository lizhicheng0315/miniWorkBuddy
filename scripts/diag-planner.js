// 诊断：规划器对闲聊消息的原始输出
process.env.AUTH_ENABLED = 'false';
const db = require('../src/db');
const llm = require('../src/services/llm');

(async () => {
  await db.init();
  const nlp = require('../src/services/nlp');

  // 拦截 parseAgentDecision 输入：直接复刻 runAgentLoop 的规划调用
  const c = llm.getClient();
  const sys = `你是 WorkBuddy 本地智能助手的规划器。分析用户消息，只输出一个 JSON 对象（不要 Markdown 包裹、不要解释）。

可用工具：
- web_search: 联网搜索

两种输出格式：

A. 问答/闲聊/建议，不需要工具操作数据：
{"action":"final","reply":"用一句话说明回答方向（如：介绍上海的城市概况）"}
注意：reply 只是方向提示，系统会据此生成完整流式回答；写简短即可

B. 用户要执行操作（可多个）：
{"action":"plan","steps":[{"tool":"工具名","args":{"参数":"值"}}]}

只输出 JSON`;

  for (const msg of ['用三句话介绍上海', '讲个笑话']) {
    const resp = await c.chat.completions.create({
      model: llm.resolveConfig().model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: msg },
      ],
      temperature: 0.2,
      max_tokens: 500,
    });
    const raw = resp.choices?.[0]?.message?.content || '';
    console.log(`[${msg}] 规划器输出:`);
    console.log(' ', raw.slice(0, 200));
    const parsed = require('../src/services/nlp').safeParseJson(raw);
    if (parsed && parsed.action === 'final') {
      console.log(`  → final.reply 长度: ${String(parsed.reply || '').length} 字 ${String(parsed.reply || '').length < 40 ? '(<40 走直给,不流式!)' : '(≥40 走chatStream)'}`);
    }
    console.log('');
  }
})();
