'use strict';

/**
 * 极简滑动窗口限流（不依赖外部包）。
 *   - keyFn: (req) => string
 *   - limit: 窗口内最大次数
 *   - windowMs: 窗口长度
 * 返回 Express 中间件。
 */

const buckets = new Map(); // key -> [timestamps]

function makeLimiter({ keyFn, limit, windowMs, name = 'rl' }) {
  return function limiter(req, res, next) {
    const k = (keyFn && keyFn(req)) || req.ip || 'anon';
    const full = name + ':' + k;
    const now = Date.now();
    let arr = buckets.get(full);
    if (!arr) { arr = []; buckets.set(full, arr); }
    // 清理过期
    while (arr.length && arr[0] < now - windowMs) arr.shift();
    if (arr.length >= limit) {
      const retryAfter = Math.ceil((arr[0] + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: '请求过于频繁', retry_after_sec: retryAfter });
    }
    arr.push(now);
    next();
  };
}

// 定期清理空 buckets，防止内存增长
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets.entries()) {
    if (arr.every((t) => t < now - 60 * 60 * 1000)) buckets.delete(k);
  }
}, 5 * 60 * 1000).unref();

module.exports = { makeLimiter };
