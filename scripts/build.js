'use strict';

/**
 * 用 @yao-pkg/pkg 把项目打成便携可执行包
 *  - Windows: workbuddy.exe
 *  - 体积约 60-90MB（Node + 所有依赖）
 *  - SQLite WASM 与可执行文件放在同一目录
 *
 * 用法：
 *   npm run build
 *
 * 输出：
 *   dist/workbuddy-<platform>-<arch>.exe
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DIST, { recursive: true });

// 平台映射
const platform = process.platform === 'win32' ? 'win' :
                  process.platform === 'darwin' ? 'macos' : 'linux';
const arch = process.arch === 'x64' ? 'x64' :
             process.arch === 'arm64' ? 'arm64' : 'x64';

const outName = `workbuddy-${platform}-${arch}` + (platform === 'win' ? '.exe' : '');

console.log('==> 检测到平台:', process.platform, process.arch);
console.log('==> 目标产物:', outName);
console.log('==> 准备 pkg 资源...');

// 1. 校验 SQLite WASM 源文件
const wasmSrc = path.join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
if (!fs.existsSync(wasmSrc)) {
  console.warn('!! 警告：未找到', wasmSrc);
  console.warn('!! 请先运行 npm install');
  process.exit(1);
}
console.log('==> 已确认 sql-wasm.wasm');

// 2. 调用 pkg
const pkgTarget = `node18-${platform === 'win' ? 'win' : platform === 'macos' ? 'macos' : 'linux'}-${arch}`;
const cmd = [
  'npx',
  '@yao-pkg/pkg',
  '.',
  '--targets', `node18-${platform}-${arch}`,
  '--output', path.join(DIST, outName),
  '--compress', 'GZip',
].join(' ');

console.log('==> 执行:', cmd);
try {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
  const outPath = path.join(DIST, outName);
  const stat = fs.statSync(outPath);
  // db.js reads this file from the executable directory at runtime.
  const wasmOut = path.join(DIST, 'sql-wasm.wasm');
  fs.copyFileSync(wasmSrc, wasmOut);
  if (!fs.existsSync(wasmOut) || fs.statSync(wasmOut).size === 0) {
    throw new Error('sql-wasm.wasm was not copied to dist');
  }
  console.log('==> 打包完成！文件大小:', (stat.size / 1024 / 1024).toFixed(1), 'MB');
  console.log('==> 路径:', outPath);
  console.log('==> 运行文件:', wasmOut);
} catch (e) {
  console.error('!! 打包失败：', e.message);
  process.exit(1);
}
