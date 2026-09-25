'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-news-'));
  const db = require('../src/db');
  await db.init();
  const news = require('../src/services/news');
  const automations = require('../src/services/automations');
  news.ensureTables();

  const sample = `<?xml version="1.0"?>
    <rss><channel><item>
      <title><![CDATA[AI 芯片进入新阶段]]></title>
      <link>https://example.com/news/1</link>
      <description><![CDATA[<p>新的推理芯片与开源模型进展。</p>]]></description>
      <pubDate>Fri, 18 Sep 2026 08:00:00 GMT</pubDate>
    </item></channel></rss>`;
  const source = news.sourceById('leiphone');
  const parsed = news._test.parseFeed(sample, source);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].title, 'AI 芯片进入新阶段');
  assert.strictEqual(parsed[0].url, 'https://example.com/news/1');
  assert.strictEqual(parsed[0].summary, '新的推理芯片与开源模型进展。');
  assert.ok(parsed[0].publishedAt);

  assert.ok(news.publicCatalog().sources.length >= 20);
  const board = news.createBoard(1, { templateId: 'tech-cn', name: '测试科技' });
  assert.strictEqual(board.name, '测试科技');
  assert.ok(board.source_ids.includes('leiphone'));

  const updated = news.updateBoard(1, board.id, {
    includeKeywords: 'AI, 芯片',
    limit: 8,
    cron: '0 8 * * *',
  });
  assert.deepStrictEqual(updated.include_keywords, ['AI', '芯片']);
  assert.strictEqual(updated.limit_count, 8);
  assert.ok(updated.automation_id);

  const automation = automations.get(1, updated.automation_id);
  assert.strictEqual(automation.kind, 'news_digest');
  assert.strictEqual(automation.payload.boardId, board.id);

  assert.strictEqual(news.removeBoard(1, board.id), true);
  assert.strictEqual(news.getBoard(1, board.id), null);
  assert.strictEqual(automations.get(1, updated.automation_id), null);

  console.log('✅ 新闻解析、板块 CRUD、定时推送注册测试通过');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
