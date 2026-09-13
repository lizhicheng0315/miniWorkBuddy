'use strict';

/**
 * 对话内审批队列（仿 Codex approval）：
 *   - 敏感工具执行前创建一个审批项
 *   - SSE 把审批卡片推给前端，当前工具调用 await 用户批准/拒绝
 *   - 默认 5 分钟超时未响应 = 拒绝
 */

const crypto = require('crypto');

const WAIT_MS = 5 * 60 * 1000;
const pending = new Map();

function create(userId, info = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  const timer = setTimeout(() => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    resolveFn({ approved: false, reason: 'timeout' });
  }, WAIT_MS);
  pending.set(id, {
    id,
    userId: Number(userId),
    info,
    timer,
    resolve: (v) => {
      clearTimeout(timer);
      pending.delete(id);
      resolveFn(v);
    },
    createdAt: Date.now(),
  });
  return { id, promise };
}

function resolve(userId, id, approved, reason = '') {
  const item = pending.get(String(id));
  if (!item || item.userId !== Number(userId)) return null;
  item.resolve({ approved: !!approved, reason: String(reason || '').slice(0, 300) });
  return true;
}

function listPending(userId) {
  return [...pending.values()]
    .filter((it) => it.userId === Number(userId))
    .map((it) => ({ id: it.id, ...it.info, created_at: it.createdAt }));
}

function cancelAll() {
  for (const it of pending.values()) {
    try { it.resolve({ approved: false, reason: 'server_shutdown' }); } catch (_) {}
  }
  pending.clear();
}

module.exports = { create, resolve, listPending, cancelAll, WAIT_MS };
