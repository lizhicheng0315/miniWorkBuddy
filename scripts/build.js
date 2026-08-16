'use strict';

/**
 * 用 @yao-pkg/pkg 把项目打成单文件可执行
 *  - Windows: workbuddy.exe
 *  - 体积约 60-90MB（Node + 所有依赖）
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

// 1. 把 sql.js 的 wasm 复制到打包根（pkg assets）
const wasmSrc = path.join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const wasmDst = path.join(ROOT, 'sql-wasm.wasm');
if (fs.existsSync(wasmSrc)) {
  fs.copyFileSync(wasmSrc, wasmDst);
  console.log('==> 已复制 sql-wasm.wasm 到打包根');
} else {
  console.warn('!! 警告：未找到', wasmSrc);
  console.warn('!! 请先运行 npm install');
  process.exit(1);
}

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
  const stat = fs.statSync(path.join(DIST, outName));
  console.log('==> 打包完成！文件大小:', (stat.size / 1024 / 1024).toFixed(1), 'MB');
  console.log('==> 路径:', path.join(DIST, outName));
} catch (e) {
  console.error('!! 打包失败：', e.message);
  process.exit(1);
} finally {
  // 清理根目录的 wasm（git 友好）
  try { fs.unlinkSync(wasmDst); } catch (_) {}
}
