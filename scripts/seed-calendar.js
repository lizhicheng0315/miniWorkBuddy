// 验证日历视图：插入几个不同日期的事件，验证渲染
const http = require('http');

function req(m, p, b, t) { return new Promise(r => { const d = b ? JSON.stringify(b) : ''; const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) }; if (t) h.Authorization = 'Bearer ' + t; const rq = http.request({ hostname: '127.0.0.1', port: 3000, path: p, method: m, headers: h, timeout: 10000 }, rs => { let buf=''; rs.on('data',c=>buf+=c); rs.on('end',()=>{ try{r({s:rs.statusCode,j:JSON.parse(buf)})}catch{r({s:rs.statusCode,t:buf})} }); }); rq.on('error',e=>r({err:e.message})); rq.on('timeout',()=>{rq.destroy();r({err:'timeout'})}); if(d)rq.write(d); rq.end(); }); }

(async () => {
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: process.env.WBD_ADMIN_PASSWORD || 'password123' });
  const T = login.j.token;
  console.log('login:', login.s);

  // 清空旧日程
  for (const ev of (await req('GET', '/api/schedule', null, T)).j) {
    await req('DELETE', '/api/schedule/' + ev.id, null, T);
  }
  // 清空旧待办
  for (const t of (await req('GET', '/api/todos', null, T)).j) {
    await req('DELETE', '/api/todos/' + t.id, null, T);
  }

  // 加 3 个不同优先级的待办
  await req('POST', '/api/todos', { title: '紧急：写周报', priority: 1, due_at: new Date(Date.now() - 86400000).toISOString() }, T);
  await req('POST', '/api/todos', { title: '普通任务：回邮件', priority: 2 }, T);
  await req('POST', '/api/todos', { title: '不急：整理文件', priority: 3 }, T);

  // 加 5 个不同日期的日程
  const today = new Date();
  const offsets = [-2, 0, 0, 1, 3, 5]; // 几天前, 今天 2 个, 后天, 3 天后, 5 天后
  const titles = ['昨天-客户电话', '今天-晨会', '今天-项目演示', '后天-产品评审', '3天后-体检', '5天后-旅游'];
  for (let i = 0; i < offsets.length; i++) {
    const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offsets[i], 10 + i, 0);
    await req('POST', '/api/schedule', {
      title: titles[i],
      start_at: dt.toISOString(),
      remind_before_min: 15,
    }, T);
  }

  // 验证
  const todos = (await req('GET', '/api/todos', null, T)).j;
  const events = (await req('GET', '/api/schedule', null, T)).j;
  console.log('todos:', todos.length, '→', todos.map(t => `[p${t.priority}] ${t.title}`));
  console.log('events:', events.length, '→', events.map(e => `${e.title} @ ${new Date(e.start_at).toLocaleString()}`));

  // 验证日历 API 数据
  console.log('\n=== 验证日历应该正确显示 ===');
  const today_key = today.toDateString();
  const todayEvents = events.filter(e => new Date(e.start_at).toDateString() === today_key);
  console.log('今天 (' + today.toLocaleDateString() + ') 应该有 2 个事件, 实际:', todayEvents.length);
  console.log('  →', todayEvents.map(e => e.title));

  const overdueTodos = todos.filter(t => t.due_at && t.status !== 'done' && new Date(t.due_at) < new Date());
  console.log('过期待办:', overdueTodos.length, '→', overdueTodos.map(t => t.title));

  console.log('\n✅ 数据准备完成，刷新浏览器看效果');
})();
