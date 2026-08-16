const http = require('http');
function req(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request(
      { hostname: '127.0.0.1', port: 3000, path: p, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, text: buf }); }
        });
      }
    );
    r.on('error', (e) => resolve({ error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
(async () => {
  const ADMIN_PW = process.env.WBD_ADMIN_PASSWORD || 'password123'; // 默认仅本地开发；生产请用环境变量覆盖
  const r = await req('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  console.log('login status:', r.status, JSON.stringify(r.json || r).slice(0, 300));
})();
