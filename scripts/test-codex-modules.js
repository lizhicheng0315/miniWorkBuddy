'use strict';

/**
 * 针对 Codex 式新增模块的冒烟测试：
 *   memory / skills / computer / browser / nlp 工具注册
 * 用法：SMOKE_DATA_DIR=<临时目录> node scripts/test-codex-modules.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const base = process.env.SMOKE_DATA_DIR || path.join(os.tmpdir(), 'workbuddy-codex-smoke-' + Date.now());
process.env.DATA_DIR = base;
process.env.NOTIFY_TASKS = 'false';

async function main() {
  const db = require('../src/db');
  await db.init();

  // ===== 长期记忆 =====
  const memory = require('../src/services/memory');
  const item = memory.create(1, {
    kind: 'preference',
    content: '测试用户喜欢在早上集中处理邮件',
    tags: ['工作', '习惯'],
    importance: 3,
  });
  if (!item || !item.id) throw new Error('memory.create failed');
  const recalled = memory.recall(1, '早上 邮件 工作');
  if (!recalled.some((m) => m.id === item.id)) throw new Error('memory.recall failed');
  const stats = memory.getStats(1);
  if (!stats.total) throw new Error('memory.stats failed');
  memory.remove(1, item.id);
  console.log('✔ memory module');

  // ===== 会话工作区绑定（Local / Worktree） =====
  const chatstore = require('../src/services/chatstore');
  const envSession = chatstore.createSession(1, 'environment smoke');
  const bound = chatstore.updateEnvironment(1, envSession.id, {
    workspace_mode: 'worktree',
    worktree_path: '../dsh-worktree-smoke',
    worktree_branch: 'smoke',
  });
  if (!bound || bound.workspace_mode !== 'worktree' || bound.worktree_branch !== 'smoke') {
    throw new Error('chat session environment binding failed');
  }
  const projectBound = chatstore.updateProject(1, envSession.id, 'SmokeProject');
  if (!projectBound || projectBound.project !== 'SmokeProject') throw new Error('chat session project update failed');
  if (!chatstore.listProjects(1).some((p) => p.project === 'SmokeProject')) throw new Error('chat project list failed');
  chatstore.addMessage(1, envSession.id, 'user', 'fork me');
  const ctxStats = chatstore.contextStats(1, envSession.id);
  if (!ctxStats || ctxStats.messages !== 1 || typeof ctxStats.estimated_tokens !== 'number') {
    throw new Error('context stats failed');
  }
  const searchHits = chatstore.searchMessages(1, 'fork me');
  if (!searchHits.some((m) => m.session_id === envSession.id)) throw new Error('chat message search failed');
  const forked = chatstore.forkSession(1, envSession.id);
  if (!forked || !forked.title.includes('fork') || chatstore.getMessages(1, forked.id).length !== 1) {
    throw new Error('chat session fork failed');
  }
  chatstore.deleteSession(1, forked.id);
  chatstore.deleteSession(1, envSession.id);
  console.log('✔ session workspace binding');

  // ===== 技能区 =====
  const skills = require('../src/services/skills');
  const skillList = skills.list();
  if (!skillList.some((s) => s.name === 'computer-use')) throw new Error('skills list missing computer-use');
  const agentSkills = skills.listForAgent(200);
  if (!Array.isArray(agentSkills) || agentSkills.join('').length > 600) throw new Error('skills context budget failed');
  if (skills.deriveSkillName('https://github.com/foo/bar-skill.git') !== 'bar-skill') {
    throw new Error('skill name derivation failed');
  }
  const read = skills.read('browser-use');
  if (!read || !read.content.includes('Browser Use')) throw new Error('skills read failed');
  const tmpSkill = skills.save('smoke-test-skill', {
    description: '临时测试技能',
    when_to_use: '测试',
    content: '# 测试技能\n\n1. 第一步',
  });
  if (!tmpSkill.content.includes('测试技能')) throw new Error('skills save failed');
  skills.remove('smoke-test-skill');
  console.log('✔ skills module');

  // ===== 沙箱执行策略 =====
  const sandbox = require('../src/services/sandbox');
  const policy = sandbox.policy(1);
  if (!policy.sandbox || policy.allowShell) throw new Error('sandbox policy default is wrong');
  if (!sandbox.isDangerous('Remove-Item -Recurse C:\\Temp')) throw new Error('sandbox dangerous detection failed');
  const file = sandbox.readFile(1, 'package.json');
  if (!file.content.includes('workbuddy-assistant')) throw new Error('sandbox readFile failed');
  const found = sandbox.searchFiles(1, 'package.json');
  if (!found.includes('package.json')) throw new Error('sandbox searchFiles failed');
  const listing = sandbox.listDir(1, 'src');
  if (!listing.items.some((i) => i.name === 'services' && i.type === 'dir')) throw new Error('sandbox listDir failed');
  const writeTest = path.resolve(__dirname, '..', '.smoke-write-test.txt');
  sandbox.writeFile(1, '.smoke-write-test.txt', 'hello write');
  if (!fs.readFileSync(writeTest, 'utf8').includes('hello write')) throw new Error('sandbox writeFile failed');
  fs.rmSync(writeTest, { force: true });
  const denied = await sandbox.runCommand(1, 'whoami');
  if (denied.ok || denied.denied !== 'sandbox_policy') throw new Error('sandbox shell should be denied by default');
  const git = await sandbox.gitStatus(1);
  if (!git.ok) throw new Error('sandbox gitStatus failed: ' + (git.stderr || git.error || ''));
  const diff = await sandbox.gitDiff(1, { stat: true });
  if (!diff.ok) throw new Error('sandbox gitDiff failed: ' + (diff.stderr || diff.error || ''));
  const worktrees = await sandbox.gitWorktreeList(1);
  if (!worktrees.ok) throw new Error('sandbox gitWorktreeList failed: ' + (worktrees.stderr || worktrees.error || ''));
  const review = require('../src/services/review');
  const reviewCtx = await review.collect(1);
  if (typeof reviewCtx.hasChanges !== 'boolean') throw new Error('review collect failed');
  const reviewFiles = await review.files(1);
  if (!Array.isArray(reviewFiles)) throw new Error('review files failed');
  const reviewHunks = await review.hunks(1, 'src/services/sandbox.js');
  if (!reviewHunks || !Array.isArray(reviewHunks.hunks)) throw new Error('review hunks failed');
  if (typeof review.discardHunks !== 'function') throw new Error('review discardHunks missing');
  const rules = require('../src/services/rules');
  if (typeof rules.get(1).exists !== 'boolean') throw new Error('rules get failed');
  if (!Array.isArray(rules.list(1))) throw new Error('rules list failed');
  const llmSvc = require('../src/services/llm');
  llmSvc.updateConfig({ reasoningEffort: 'low' });
  if (llmSvc.resolveReasoningEffort() !== 'low') throw new Error('reasoning effort config failed');
  llmSvc.updateConfig({ reasoningEffort: '' });
  const diagnosticsRoute = require('../src/routes/diagnostics');
  if (typeof diagnosticsRoute !== 'function') throw new Error('diagnostics route failed');
  console.log('✔ sandbox module');

  // ===== Codex apply_patch =====
  const patch = require('../src/services/patch');
  const patchFile = path.resolve(__dirname, '..', '.smoke-patch-test.txt');
  try {
    const added = patch.applyPatch(1, [
      '*** Begin Patch',
      '*** Add File: .smoke-patch-test.txt',
      '+hello',
      '+world',
      '*** End Patch',
    ].join('\n'));
    if (!added.ok || !fs.existsSync(patchFile)) throw new Error('apply_patch add failed: ' + (added.error || ''));
    const updated = patch.applyPatch(1, [
      '*** Begin Patch',
      '*** Update File: .smoke-patch-test.txt',
      '@@',
      '-hello',
      '+hello codex',
      '*** End Patch',
    ].join('\n'));
    if (!updated.ok || !fs.readFileSync(patchFile, 'utf8').includes('hello codex')) {
      throw new Error('apply_patch update failed: ' + (updated.error || ''));
    }
  } finally {
    try { fs.rmSync(patchFile, { force: true }); } catch (_) {}
  }
  console.log('✔ apply_patch');

  // ===== MCP（stdio 端到端） =====
  const mcp = require('../src/services/mcp');
  mcp.upsertServer(1, {
    name: 'mock',
    transport: 'stdio',
    command: process.execPath,
    args: [path.resolve(__dirname, 'mock-mcp-server.js')],
  });
  const mcpTools = await mcp.listTools(1, 'mock');
  if (!mcpTools.some((t) => t.name === 'echo')) throw new Error('MCP tools/list failed');
  const mcpResult = await mcp.callTool(1, 'mock', 'echo', { text: 'hello mcp' });
  const mcpText = (mcpResult.content || []).map((c) => c.text || '').join(' ');
  if (!mcpText.includes('hello mcp')) throw new Error('MCP tools/call failed');
  mcp.disconnect(1, 'mock');
  console.log('✔ MCP stdio');

  // ===== MCP OAuth（PKCE 授权 URL 生成） =====
  const mcpOAuth = require('../src/services/mcpOAuth');
  const oauthStart = mcpOAuth.start(1, {
    name: 'oauth-test',
    authorizationUrl: 'https://example.com/oauth/authorize',
    clientId: 'test-client',
  });
  if (!oauthStart.url.includes('code_challenge=') || !oauthStart.url.includes('state=')) {
    throw new Error('MCP OAuth start failed');
  }
  if (await mcpOAuth.accessToken(1, { name: 'oauth-test' })) throw new Error('MCP OAuth token should be empty');
  mcp.upsertServer(1, { name: 'discover-test', transport: 'http', url: 'https://mcp.example.com/mcp' });
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth-protected-resource')) {
      return { ok: true, json: async () => ({ authorization_servers: ['https://auth.example.com'] }) };
    }
    if (u.includes('oauth-authorization-server')) {
      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
          scopes_supported: ['read', 'write'],
        }),
      };
    }
    if (u.includes('/register')) return { ok: true, json: async () => ({ client_id: 'dcr-client' }) };
    throw new Error('unexpected fetch ' + u);
  };
  try {
    const discovered = await mcpOAuth.discover(1, 'discover-test');
    if (!discovered.ok || discovered.client_id !== 'dcr-client') throw new Error('MCP OAuth discover failed');
  } finally {
    global.fetch = origFetch;
    mcp.removeServer(1, 'discover-test');
  }
  console.log('✔ MCP OAuth');

  // ===== Remote host / handoff =====
  const remote = require('../src/services/remote');
  remote.upsertHost(1, { name: 'mock-remote', baseUrl: 'http://remote.test', token: 't' });
  const origRemoteFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (obj) => ({ ok: true, text: async () => JSON.stringify(obj) });
    if (u.endsWith('/api/health')) return json({ ok: true });
    if (u.endsWith('/api/agent/run')) return json({ result: { reply: 'remote ok' } });
    if (u.endsWith('/api/agent/sessions') && opts.method === 'POST') return json({ id: 42, title: 'handoff' });
    if (u.includes('/api/agent/sessions/42/messages')) return json({ ok: true });
    throw new Error('unexpected remote fetch ' + u);
  };
  try {
    const rr = await remote.runRemote(1, 'mock-remote', 'hello');
    if (!rr.result || rr.result.reply !== 'remote ok') throw new Error('remote run failed');
    const s = chatstore.createSession(1, 'remote smoke');
    chatstore.addMessage(1, s.id, 'user', 'hello remote');
    const handoff = await remote.handoff(1, 'mock-remote', s.id);
    if (handoff.remoteSessionId !== 42 || handoff.messages !== 1) throw new Error('remote handoff failed');
    chatstore.deleteSession(1, s.id);
  } finally {
    global.fetch = origRemoteFetch;
    remote.removeHost(1, 'mock-remote');
  }
  console.log('✔ Remote handoff');

  // ===== Scheduled tasks（automations） =====
  const automations = require('../src/services/automations');
  const automation = automations.create(1, {
    name: 'smoke automation',
    prompt: '每天早上检查待办',
    cron: '0 9 * * *',
  });
  if (!automations.list(1).some((a) => a.id === automation.id)) throw new Error('automation create/list failed');
  const nlpForAutomation = require('../src/services/nlp');
  const origNlpChat = nlpForAutomation.chat;
  nlpForAutomation.chat = async () => ({ intent: 'chat', reply: 'automation ran' });
  try {
    const run = await automations.execute(1, automation);
    if (!run.ok || !String(run.result).includes('automation ran')) throw new Error('automation execute failed');
    const st = automations.stats(1);
    if (typeof st.total !== 'number' || st.total < 1) throw new Error('automation stats failed');
    const dup = automations.duplicate(1, automation.id);
    if (!dup || dup.enabled) throw new Error('automation duplicate failed');
    automations.setAllEnabled(1, false);
    if (automations.get(1, automation.id).enabled) throw new Error('automation pause-all failed');
    automations.remove(1, dup.id);
  } finally {
    nlpForAutomation.chat = origNlpChat;
    automations.remove(1, automation.id);
  }
  console.log('✔ automations');

  // ===== 后台任务（本地 cloud task 等价） =====
  const tasks = require('../src/services/tasks');
  const origTaskChat = nlpForAutomation.chat;
  nlpForAutomation.chat = async () => ({ intent: 'chat', reply: 'background task done' });
  try {
    const task = tasks.create(1, { prompt: '后台跑一下' });
    await new Promise((r) => setTimeout(r, 250));
    const done = tasks.get(1, task.id);
    if (!done || done.status !== 'success' || !String(done.result).includes('background task done')) {
      throw new Error('background task failed');
    }
    tasks.remove(1, task.id);
    const sub = tasks.record(1, { type: 'subagent', title: 'sub smoke', prompt: 'x', status: 'success', result: 'ok' });
    if (!tasks.list(1, { type: 'subagent' }).some((t) => t.id === sub.id)) throw new Error('subagent activity record failed');
    tasks.remove(1, sub.id);
  } finally {
    nlpForAutomation.chat = origTaskChat;
  }
  console.log('✔ background tasks');

  // ===== stdio app-server（仿 codex app-server） =====
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, 'codex-app-server.js')], {
      env: { ...process.env, DATA_DIR: base },
      windowsHide: true,
    });
    let buf = '';
    const responses = [];
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error('app-server timeout'));
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { responses.push(JSON.parse(line)); } catch (_) {}
      }
      if (responses.length >= 3) {
        clearTimeout(timer);
        try { child.kill(); } catch (_) {}
        if (!responses[0].result || responses[0].result.serverInfo.name !== 'workbuddy-app-server') {
          return reject(new Error('app-server initialize failed'));
        }
        if (!responses[1].result || !responses[1].result.id) return reject(new Error('app-server sessions/create failed'));
        resolve();
      }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'sessions/create', params: { title: 'app server smoke' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown' }) + '\n');
  });
  console.log('✔ app-server stdio');

  // ===== WorkBuddy MCP server（stdio） =====
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, 'workbuddy-mcp-server.js')], {
      env: { ...process.env, DATA_DIR: base },
      windowsHide: true,
    });
    let buf = '';
    const responses = [];
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error('workbuddy mcp-server timeout'));
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { responses.push(JSON.parse(line)); } catch (_) {}
      }
      if (responses.length >= 4) {
        clearTimeout(timer);
        try { child.kill(); } catch (_) {}
        const list = responses.find((r) => r.id === 2 && r.result && r.result.tools);
        if (!list || !list.result.tools.some((t) => t.name === 'agent_run')) return reject(new Error('workbuddy mcp tools/list failed'));
        const call = responses.find((r) => r.id === 3 && r.result && r.result.content);
        if (!call) return reject(new Error('workbuddy mcp tools/call failed'));
        resolve();
      }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sessions_list', arguments: {} } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'shutdown' }) + '\n');
  });
  console.log('✔ WorkBuddy MCP server');

  // ===== Codex 插件 manifest =====
  const pluginManifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '.codex-plugin', 'plugin.json'), 'utf8'));
  if (pluginManifest.name !== 'workbuddy' || pluginManifest.version !== '0.1.0') {
    throw new Error('codex plugin manifest failed');
  }
  const pluginMcp = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '.mcp.json'), 'utf8'));
  if (!pluginMcp.mcpServers || !pluginMcp.mcpServers.workbuddy) throw new Error('codex plugin mcp config failed');
  console.log('✔ Codex plugin manifest');

  // ===== Computer Use 状态 =====
  const computer = require('../src/services/computer');
  const cs = await computer.status();
  if (!cs.ok) throw new Error('computer.status failed: ' + (cs.error || ''));
  console.log('✔ computer module (' + cs.platform + ', allow_shell=' + cs.allow_shell + ')');

  // ===== Browser Use 状态 =====
  const browser = require('../src/services/browser');
  const bs = await browser.status();
  if (!bs.ok) throw new Error('browser.status failed');
  console.log('✔ browser module (running=' + bs.running + ', executable=' + (bs.executable ? bs.executable.name : 'none') + ')');

  // ===== agent 工具注册 =====
  const nlp = require('../src/services/nlp');
  const exec = await nlp.executeIntent(
    { intent: 'memory_remember', title: '测试用户每天 9 点开工' },
    1,
    '记住：测试用户每天 9 点开工'
  );
  if (!exec.summary.includes('已记住')) throw new Error('nlp memory_remember tool failed');
  console.log('✔ nlp tool registry');

  // ===== 图像输入（多模态 content array） =====
  const llmImage = require('../src/services/llm');
  const origImgGetClient = llmImage.getClient;
  const origImgResolve = llmImage.resolveConfig;
  const origImgChat = llmImage.chat;
  const origImgStream = llmImage.chatStream;
  let imgCaptured = null;
  llmImage.getClient = () => ({
    chat: {
      completions: {
        create: async ({ messages }) => {
          imgCaptured = messages;
          return { choices: [{ message: { content: JSON.stringify({ action: 'final', reply: '看到了图片' }) } }], usage: null };
        },
      },
    },
  });
  llmImage.resolveConfig = () => ({ apiKey: 'mock', model: 'mock', baseURL: 'http://mock' });
  llmImage.chat = async () => ({ ok: true, text: '看到了图片' });
  llmImage.chatStream = llmImage.chat;
  try {
    await nlp.chat(1, '描述这张图', { images: [{ dataUrl: 'data:image/png;base64,AAA' }], onDelta: () => {} });
  } finally {
    llmImage.getClient = origImgGetClient;
    llmImage.resolveConfig = origImgResolve;
    llmImage.chat = origImgChat;
    llmImage.chatStream = origImgStream;
  }
  const hasImage = (imgCaptured || []).some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
  if (!hasImage) throw new Error('image input content array failed');
  console.log('✔ image input');

  // ===== 迭代式自动工具循环（Codex loop） =====
  const llm = require('../src/services/llm');
  const origGetClient = llm.getClient;
  const origResolve = llm.resolveConfig;
  const origChat = llm.chat;
  const origChatStream = llm.chatStream;
  let loopCalls = 0;
  llm.getClient = () => ({
    chat: {
      completions: {
        create: async () => {
          loopCalls++;
          const content = loopCalls === 1
            ? JSON.stringify({ action: 'call', tool: 'memory_remember', args: { content: '自动循环记忆测试' }, reason: '自动保存' })
            : JSON.stringify({ action: 'final', reply: '已自动记住' });
          return { choices: [{ message: { content } }], usage: null };
        },
      },
    },
  });
  llm.resolveConfig = () => ({ apiKey: 'mock', model: 'mock', baseURL: 'http://mock' });
  llm.chat = async () => ({ ok: true, text: '已自动记住：自动循环记忆测试' });
  llm.chatStream = llm.chat;
  const loopThoughts = [];
  const loopResult = await nlp.chat(1, '记住：自动循环记忆测试', {
    enableSearch: false,
    deepThink: true,
    onThought: (t) => loopThoughts.push(t),
    onDelta: () => {},
  });
  if (loopCalls < 2 || !loopResult.reply.includes('自动记住') || !loopThoughts.some((t) => t.label.includes('调用'))) {
    throw new Error('iterative codex loop failed');
  }
  console.log('✔ codex iterative loop');

  // ===== 请求批准模式：敏感工具必须等待审批 =====
  const approvals = require('../src/services/approvals');
  let approvalCalls = 0;
  llm.getClient = () => ({
    chat: {
      completions: {
        create: async () => {
          approvalCalls++;
          const content = approvalCalls === 1
            ? JSON.stringify({ action: 'call', tool: 'sandbox_list_dir', args: { path: '.' }, reason: '查看工作区' })
            : JSON.stringify({ action: 'final', reply: '目录已列出' });
          return { choices: [{ message: { content } }], usage: null };
        },
      },
    },
  });
  llm.chat = async () => ({ ok: true, text: '目录已列出：.' });
  llm.chatStream = llm.chat;
  const approvalEvents = [];
  const approvalResult = await nlp.chat(1, '看一下工作区目录', {
    approvalMode: 'ask',
    deepThink: true,
    onApproval: (req) => {
      approvalEvents.push(req);
      approvals.resolve(1, req.id, true);
    },
    onDelta: () => {},
  });
  if (approvalEvents.length !== 1 || approvalEvents[0].tool !== 'sandbox_list_dir' || !approvalResult.reply.includes('目录')) {
    throw new Error('approval ask-mode flow failed');
  }
  console.log('✔ approval ask mode');

  // ===== 帮我批准：沙箱内操作自动放行，不弹审批 =====
  approvalCalls = 0;
  const autoApprovalEvents = [];
  const autoResult = await nlp.chat(1, '再列一次目录', {
    approvalMode: 'auto',
    deepThink: true,
    onApproval: (req) => autoApprovalEvents.push(req),
    onDelta: () => {},
  });
  if (autoApprovalEvents.length !== 0 || approvalCalls < 2 || !autoResult.reply.includes('目录')) {
    throw new Error('approval auto-mode flow failed');
  }
  console.log('✔ approval auto mode');

  // ===== 计划模式：只规划，不执行工具 =====
  llm.chat = async () => ({ ok: true, text: '1. 目标：重构服务层\n2. 步骤：读取文件 → 修改 → 测试' });
  llm.chatStream = llm.chat;
  const planResult = await nlp.chat(1, '帮我规划重构服务层', {
    planMode: true,
    goal: '重构服务层并跑通测试',
    onDelta: () => {},
  });
  if (planResult.intent !== 'plan' || !planResult.reply.includes('目标')) {
    throw new Error('plan mode flow failed');
  }
  console.log('✔ plan mode');

  llm.getClient = origGetClient;
  llm.resolveConfig = origResolve;
  llm.chat = origChat;
  llm.chatStream = origChatStream;

  await db.persist();
  await new Promise((r) => setTimeout(r, 120));
  fs.rmSync(base, { recursive: true, force: true });
  console.log('✅ Codex modules smoke passed');
}

main().catch((e) => {
  console.error('❌ smoke failed:', e.message);
  process.exit(1);
});
