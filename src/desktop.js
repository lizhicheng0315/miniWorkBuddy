'use strict';

/**
 * 桌面体验增强（仅 Windows 生效，pkg 模式下更明显）：
 *   - 系统托盘：常驻右下角，右键菜单"打开主页 / 退出"
 *   - 闪窗：启动时显示一个临时 Windows Toast 让用户知道服务起来了
 *   - 自动开浏览器：服务 ready 后调用系统默认浏览器
 *
 * 实现原则：
 *   - 纯 stdlib + node-notifier（不依赖 Electron）
 *   - 托盘通过 PowerShell + System.Windows.Forms.NotifyIcon 注入（运行时仅 ~100ms 开销）
 *   - 所有 GUI 调用 try/catch 兜底，失败不影响服务运行
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const notifier = require('node-notifier');
const logger = require('./logger');
const config = require('./config');

let trayProcess = null;

/**
 * 启动时弹一个简短闪窗 + 写日志
 */
function showSplash(port) {
  const msg = `服务已启动\nhttp://localhost:${port}\n数据目录：${config.dataDir}`;
  // 尝试 Windows Toast；失败时降级为控制台
  try {
    notifier.notify(
      {
        title: '🧭 WorkBuddy 助手',
        message: msg,
        sound: false,
        wait: false,
        appID: 'WorkBuddy Assistant',
      },
      (err) => { if (err) logger.warn('splash notify err:', err.message); }
    );
  } catch (e) {
    logger.warn('splash failed (likely sandboxed env):', e.message);
  }
  // 控制台高亮提示（CLI 模式用户能看到）
  const bar = '═'.repeat(60);
  process.stdout.write(`\n\x1b[36m${bar}\x1b[0m\n`);
  process.stdout.write(`\x1b[36m  🧭 WorkBuddy 助手已就绪  →  http://localhost:${port}\x1b[0m\n`);
  process.stdout.write(`\x1b[36m  数据目录: ${config.dataDir}\x1b[0m\n`);
  process.stdout.write(`\x1b[36m${bar}\x1b[0m\n\n`);
}

/**
 * 打开默认浏览器到主页
 */
function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` :
                process.platform === 'darwin' ? `open "${url}"` :
                `xdg-open "${url}"`;
    exec(cmd, (err) => {
      if (err) logger.warn('open browser failed:', err.message);
    });
  } catch (e) {
    logger.warn('open browser threw:', e.message);
  }
}

/**
 * 启动系统托盘（PowerShell + WPF NotifyIcon，纯 stdlib）
 *  - 右键菜单：打开主页 / 打开数据目录 / 退出
 *  - 退出时调用 onExit 回调（让 server 优雅 shutdown）
 */
function startTray(port, onExit) {
  if (process.platform !== 'win32') {
    logger.info('tray: not on Windows, skip');
    return;
  }
  // 写入 ps1 脚本到临时目录（避免长命令转义问题）
  const psFile = path.join(os.tmpdir(), 'workbuddy-tray.ps1');
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Visible = $true
$notify.Text = 'WorkBuddy 助手'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('打开主页 (http://localhost:${port})')
$open.add_Click({ Start-Process 'http://localhost:${port}' })
$menu.Items.Add('-') | Out-Null
$folder = $menu.Items.Add('打开数据目录')
$folder.add_Click({ Start-Process explorer.exe '${config.dataDir.replace(/\\/g, '\\\\')}' })
$menu.Items.Add('-') | Out-Null
$exit = $menu.Items.Add('退出')
$exit.add_Click({
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$notify.ContextMenuStrip = $menu
$notify.add_DoubleClick({ Start-Process 'http://localhost:${port}' })

[System.Windows.Forms.Application]::Run()
`;
  fs.writeFileSync(psFile, ps, 'utf8');
  logger.info('tray: launching PowerShell NotifyIcon');

  try {
    trayProcess = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', psFile],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    trayProcess.unref();
    trayProcess.on('exit', (code) => {
      logger.info('tray: PowerShell exited code=' + code);
      // 托盘是常驻子进程，被用户主动关掉时不应关闭 server
      // onExit 仅在 stopTray() 里显式调用（SIGINT/SIGTERM 流程）
    });
  } catch (e) {
    logger.warn('tray spawn failed:', e.message);
  }
}

/**
 * 关闭托盘
 */
function stopTray() {
  if (trayProcess && !trayProcess.killed) {
    try {
      // PowerShell 的 [Application]::Exit() 会自然结束进程
      // 这里仅兜底：超时强杀
      setTimeout(() => { try { trayProcess.kill(); } catch (_) {} }, 1000);
    } catch (_) {}
  }
}

module.exports = { showSplash, openBrowser, startTray, stopTray };
