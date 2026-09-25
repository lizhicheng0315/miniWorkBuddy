'use strict';

process.env.TZ = process.env.TZ || 'Asia/Shanghai';

const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const express = require('express');
const config = require('./src/config');
const logger = require('./src/logger');
const scheduler = require('./src/services/scheduler');
const cron = require('node-cron');
const llm = require('./src/services/llm');
const auth = require('./src/auth');
const db = require('./src/db');
const desktop = require('./src/desktop');
const { attachUser } = require('./src/middleware/auth');
const { requestLogger } = require('./src/middleware/requestLog');
const { makeLimiter } = require('./src/middleware/ratelimit');

// 解析 CLI 参数
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const customDataDir = getArg('--userdata');
if (customDataDir) {
  config.dataDir = path.resolve(customDataDir);
  fs.mkdirSync(config.dataDir, { recursive: true });
  logger.info(`custom data dir: ${config.dataDir}`);
}

// 全局异常捕获（防服务被未处理错误拖死）
process.on('uncaughtException', (e) => {
  logger.error('uncaughtException:', e.stack || e.message);
});
process.on('unhandledRejection', (reason) => {
  // node-notifier 内部 spawn 失败（沙箱 / 无 GUI / 信道服务）会冒泡到 unhandledRejection
  // 不让它影响服务主流程
  const msg = reason && reason.message ? reason.message : String(reason);
  if (msg.includes('spawn') || msg.includes('EPERM') || msg.includes('notifu') || msg.includes('snore')) {
    logger.warn('notification subsystem unavailable:', msg);
    return;
  }
  logger.error('unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});

async function main() {
  await db.init();
  auth.bootstrapAdmin();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(requestLogger);
  app.use(attachUser);

  // 全局 API 限流（按 IP）
  const apiLimiter = makeLimiter({
    name: 'api',
    keyFn: (req) => req.ip,
    limit: config.rateLimit.apiPerMin,
    windowMs: 60_000,
  });
  app.use('/api', apiLimiter);

  // 公开端点
  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // 认证路由（登录端点单独限流）
  const loginLimiter = makeLimiter({
    name: 'login',
    keyFn: (req) => req.ip,
    limit: config.rateLimit.loginPer15min,
    windowMs: 15 * 60_000,
  });
  app.use('/api/auth/login', loginLimiter);
  app.use('/api/auth', require('./src/routes/auth'));

  // 受保护路由
  app.use('/api/todos', require('./src/routes/todos'));
  app.use('/api/schedule', require('./src/routes/schedule'));
  app.use('/api/reminders', require('./src/routes/reminders'));
  app.use('/api/plan', require('./src/routes/plan'));
  app.use('/api/news', require('./src/routes/news'));
  app.use('/api/ai', require('./src/routes/ai'));
  app.use('/api/integrations', require('./src/routes/integrations'));
  app.use('/api/ppt', require('./src/routes/ppt'));
  app.use('/api/chathistory', require('./src/routes/chathistory'));
  app.use('/api/memory', require('./src/routes/memory'));
  app.use('/api/skills', require('./src/routes/skills'));
  app.use('/api/computer', require('./src/routes/computer'));
  app.use('/api/browser', require('./src/routes/browser'));
  app.use('/api/media', require('./src/routes/media'));
  app.use('/api/mcp', require('./src/routes/mcp'));
  app.use('/api/automations', require('./src/routes/automations'));
  app.use('/api/review', require('./src/routes/review'));
  app.use('/api/worktrees', require('./src/routes/worktrees'));
  app.use('/api/rules', require('./src/routes/rules'));
  app.use('/api/files', require('./src/routes/files'));
  app.use('/api/agent', require('./src/routes/agent'));
  app.use('/api/tasks', require('./src/routes/tasks'));
  app.use('/api/remote', require('./src/routes/remote'));
  app.use('/api/diagnostics', require('./src/routes/diagnostics'));
  app.use('/api/prd', require('./src/routes/prd'));
  app.use('/api/backup', require('./src/routes/backup'));

  // 可观测性端点（公开 + admin 专属混合在 stats 路由里）
  app.use('/api/stats', require('./src/routes/stats'));

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  scheduler.loadAll();
  require('./src/services/automations').loadAll();
  const plan = require('./src/services/plan');
  plan.rolloverAll();
  cron.schedule('0 0 * * *', () => {
    try {
      const result = plan.rolloverAll();
      logger.info(`plan rollover completed: ${JSON.stringify(result)}`);
    } catch (e) {
      logger.warn('plan rollover failed:', e.message);
    }
  });
  // 重复任务：每小时检查一次（完成的重复待办自动生成新实例）
  cron.schedule('0 * * * *', () => scheduler.checkRecurring());

  // 启动 HTTP 或 HTTPS
  let server;
  const protocol = config.tls.enabled && fs.existsSync(config.tls.key) && fs.existsSync(config.tls.cert) ? 'https' : 'http';
  const displayHost = process.pkg ? 'localhost' : 'localhost';
  if (config.tls.enabled && fs.existsSync(config.tls.key) && fs.existsSync(config.tls.cert)) {
    server = https.createServer(
      { key: fs.readFileSync(config.tls.key), cert: fs.readFileSync(config.tls.cert) },
      app
    );
  } else {
    server = http.createServer(app);
  }
  server.listen(config.port, () => {
    const url = `${protocol}://${displayHost}:${config.port}`;
    logger.info(`WorkBuddy 助手（${protocol.toUpperCase()}）已启动 → ${url}`);
    logger.info(`LLM 状态: ${llm.isEnabled() ? '已启用 (' + config.llm.model + ')' : '未配置 LLM_API_KEY'}`);
    logger.info(`认证: ${config.auth.enabled ? '已启用' : '已禁用'} · 限流: API ${config.rateLimit.apiPerMin}/min`);
    logger.info(`数据目录: ${config.dataDir}`);

    // 桌面体验
    desktop.showSplash(config.port);
    if (process.env.WORKBUDDY_NO_BROWSER !== '1') {
      setTimeout(() => desktop.openBrowser(url), 800);
    }
    if (process.env.WORKBUDDY_NO_TRAY !== '1') {
      desktop.startTray(config.port, () => shutdown());
    }
  });

  function shutdown() {
    logger.info('shutting down...');
    desktop.stopTray();
    try { require('./src/services/browser').stop(); } catch (_) {}
    try { require('./src/services/mcp').disconnectAll(); } catch (_) {}
    try { require('./src/services/automations').shutdown(); } catch (_) {}
    scheduler.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error('startup failed:', e.message);
  process.exit(1);
});
