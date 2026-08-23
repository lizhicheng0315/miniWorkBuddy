// 流式诊断：记录每个 SSE 块的到达时间与类型
const http = require('http');

(async () => {
  function req(m, p, b, t) {
    return new Promise((r) => {
      const d = b ? JSON.stringify(b) : '';
      const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) };
      if (t) h.Authorization = 'Bearer ' + t;
      const rq = http.request({ hostname: '127.0.0.1', port: 3000, path: p, method: m, headers: h }, (rs) => {
        let buf = '';
        rs.on('data', (c) => buf += c);
        rs.on('end', () => r({ s: rs.statusCode, body: buf }));
      });
      rq.on('error', (e) => r({ err: e.message }));
      if (d) rq.write(d);
      rq.end();
    });
  }

  const L = await req('POST', '/api/auth/login', { username: 'admin', password: process.env.WBD_ADMIN_PASSWORD || 'password123' });
  const T = JSON.parse(L.body).token;

  console.log('=== SSE 到达时序诊断 ===');
  const t0 = Date.now();
  await new Promise((resolve) => {
    const rq = http.request({
      hostname: '127.0.0.1', port: 3000, path: '/api/ai/chat/stream', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
    }, (rs) => {
      let firstDeltaAt = null;
      let deltaCount = 0;
      let lastLog = 0;
      rs.on('data', (c) => {
        const s = c.toString();
        const evs = (s.match(/event: (\w+)/g) || []).map((x) => x.replace('event: ', ''));
        const dN = evs.filter((x) => x === 'delta').length;
        if (dN && !firstDeltaAt) firstDeltaAt = Date.now() - t0;
        deltaCount += dN;
        // 只打印非 delta 块 + 每500ms一次delta汇总（避免刷屏）
        if (!dN || Date.now() - lastLog > 500) {
          console.log(`+${String(Date.now() - t0).padStart(5)}ms  ${evs.join(',') || '(心跳/空)'}`);
          if (dN) lastLog = Date.now();
        }
      });
      rs.on('end', () => {
        console.log('─────────────────────');
        console.log(`首个 delta 延迟: ${firstDeltaAt}ms`);
        console.log(`delta 总数: ${deltaCount}`);
        console.log(deltaCount > 3 ? '✅ 服务端是真流式' : '❌ 服务端疑似一次性输出');
        resolve();
      });
    });
    rq.write(JSON.stringify({ message: '用三句话介绍上海' }));
    rq.end();
  });
})();
