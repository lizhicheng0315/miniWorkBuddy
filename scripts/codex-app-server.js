'use strict';

/**
 * 最小 stdio app-server（仿 `codex app-server`）：
 * 逐行读取 JSON-RPC 2.0 请求，返回 JSON-RPC 响应。
 */

const db = require('../src/db');
const nlp = require('../src/services/nlp');
const chatstore = require('../src/services/chatstore');

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function respondError(id, message) {
  write({ jsonrpc: '2.0', id, error: { code: -32000, message: String(message) } });
}

async function handle(msg) {
  const { id, method, params = {} } = msg || {};
  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '1',
        serverInfo: { name: 'workbuddy-app-server', version: '0.1.0' },
        capabilities: { sessions: true, run: true, stream: false },
      });
      return;
    }
    if (method === 'sessions/list') {
      respond(id, { sessions: chatstore.listSessions(params.userId || 1) });
      return;
    }
    if (method === 'sessions/create') {
      respond(id, chatstore.createSession(params.userId || 1, params.title || 'New thread'));
      return;
    }
    if (method === 'agent/run') {
      const prompt = params.prompt || params.message;
      if (!prompt) return respondError(id, 'prompt 必填');
      const result = await nlp.chat(params.userId || 1, String(prompt), {
        approvalMode: params.approvalMode || 'auto',
        model: params.model || undefined,
        planMode: !!params.planMode,
        deepThink: !!params.deepThink,
        onDelta: () => {},
      });
      respond(id, result);
      return;
    }
    if (method === 'shutdown') {
      respond(id, { ok: true });
      setTimeout(() => process.exit(0), 10);
      return;
    }
    respondError(id, `unknown method: ${method}`);
  } catch (e) {
    respondError(id, e.message);
  }
}

async function main() {
  await db.init();
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      handle(msg);
    }
  });
}

main().catch((e) => {
  write({ jsonrpc: '2.0', error: { code: -32001, message: e.message } });
  process.exit(1);
});
