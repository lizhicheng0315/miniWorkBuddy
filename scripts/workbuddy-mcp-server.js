'use strict';

/**
 * WorkBuddy MCP server（stdio，仿 `codex mcp-server`）：
 * 把 WorkBuddy 的 agent / sessions / memory / review / sandbox 暴露为 MCP tools。
 */

const db = require('../src/db');
const nlp = require('../src/services/nlp');
const chatstore = require('../src/services/chatstore');
const memory = require('../src/services/memory');
const review = require('../src/services/review');
const sandbox = require('../src/services/sandbox');

const TOOLS = [
  {
    name: 'agent_run',
    description: '在 WorkBuddy 上运行一个 Agent 任务',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        planMode: { type: 'boolean' },
        approvalMode: { type: 'string' },
        model: { type: 'string' },
      },
      required: ['message'],
    },
  },
  {
    name: 'sessions_list',
    description: '列出 WorkBuddy 会话',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_recall',
    description: '召回 WorkBuddy 长期记忆',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'review_changes',
    description: '审阅当前未提交的代码变更',
    inputSchema: { type: 'object', properties: { base: { type: 'string' } } },
  },
  {
    name: 'sandbox_read_file',
    description: '读取工作区文件',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function respondError(id, message) {
  write({ jsonrpc: '2.0', id, error: { code: -32000, message: String(message) } });
}

async function callTool(name, args = {}) {
  if (name === 'agent_run') {
    const r = await nlp.chat(1, args.message, {
      planMode: !!args.planMode,
      approvalMode: args.approvalMode || 'auto',
      model: args.model || undefined,
      onDelta: () => {},
    });
    return r && r.reply ? r.reply : JSON.stringify(r);
  }
  if (name === 'sessions_list') return JSON.stringify(chatstore.listSessions(1));
  if (name === 'memory_recall') return JSON.stringify(memory.recall(1, args.query, args.limit || 8));
  if (name === 'review_changes') {
    const r = await review.run(1, args.base);
    return r.text || r.error || '';
  }
  if (name === 'sandbox_read_file') return sandbox.readFile(1, args.path).content;
  throw new Error('unknown tool: ' + name);
}

async function handle(msg) {
  const { id, method, params = {} } = msg || {};
  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'workbuddy', version: '0.1.0' },
      });
      return;
    }
    if (method === 'notifications/initialized') return;
    if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const text = await callTool(name, args || {});
      respond(id, { content: [{ type: 'text', text: String(text) }], isError: false });
      return;
    }
    if (method === 'shutdown') {
      respond(id, { ok: true });
      setTimeout(() => process.exit(0), 10);
      return;
    }
    respondError(id, 'unknown method: ' + method);
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
