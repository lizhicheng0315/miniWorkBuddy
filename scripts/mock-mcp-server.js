'use strict';

// 最小 MCP stdio server，用于本地端到端测试
let buf = '';

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

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
    if (msg.id === undefined) continue;
    if (msg.method === 'initialize') {
      respond(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '0.1.0' },
      });
    } else if (msg.method === 'tools/list') {
      respond(msg.id, {
        tools: [{
          name: 'echo',
          description: '回显输入文本',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        }],
      });
    } else if (msg.method === 'tools/call') {
      respond(msg.id, {
        content: [{ type: 'text', text: 'echo: ' + ((msg.params && msg.params.arguments && msg.params.arguments.text) || '') }],
        isError: false,
      });
    } else {
      respond(msg.id, {});
    }
  }
});
