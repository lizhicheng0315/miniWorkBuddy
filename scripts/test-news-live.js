'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-news-live-'));
  process.env.NEWS_CONCURRENCY = '6';
  process.env.NOTIFY_TASKS = 'false';
  const db = require('../src/db');
  await db.init();
  const news = require('../src/services/news');
  news.ensureTables();

  const sourceIds = news.publicCatalog().sources.map((source) => source.id);
  const result = await news.articlesFor(1, {
    sourceIds,
    limit: 12,
    sourceLimit: 3,
    force: true,
  });
  console.log(JSON.stringify({
    total: result.items.length,
    sources: result.sources,
    sample: result.items.slice(0, 3).map((item) => ({
      title: item.title,
      source: item.sourceName,
      publishedAt: item.publishedAt,
    })),
  }, null, 2));
  if (!result.items.length) throw new Error('live news fetch returned no items');

  const board = news.createBoard(1, {
    name: '联网新闻验收',
    sourceIds: ['people-politics', 'sspai', 'github-blog'],
    limit: 6,
    cron: '0 8 * * *',
  });
  const automation = require('../src/services/automations').get(1, board.automation_id);
  const scheduled = await require('../src/services/automations').execute(1, automation);
  if (!scheduled.ok || !String(scheduled.result).includes('## 联网新闻验收')) {
    throw new Error('scheduled news push failed');
  }
  const tool = await require('../src/services/nlp').executeIntent(
    { intent: 'news_digest', board: board.name },
    1,
    '看看联网新闻验收'
  );
  if (!String(tool.summary || '').includes('## 联网新闻验收')) {
    throw new Error('chat news tool linkage failed');
  }
  require('../src/services/automations').shutdown();
  console.log('✅ 新闻板块、对话工具与定时推送链路通过');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
