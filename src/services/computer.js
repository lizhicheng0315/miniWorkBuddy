'use strict';

/**
 * Computer Use 服务（仿 Codex computer use）：
 *   - 通过 PowerShell + user32/.NET 实现窗口枚举、截屏、鼠标/键盘/滚动、激活窗口
 *   - 需要管理员开启开关后，才能执行任意 PowerShell 命令 / 启动程序（默认关闭）
 *   - 仅 Windows 可用；非 Windows 返回明确错误，不影响其他功能
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const media = require('./media');

const PS_SCRIPT = `
param([string]$Payload)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
function Out-Json($o) { Write-Output ($o | ConvertTo-Json -Compress -Depth 8) }
try {
  $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
  $p = $json | ConvertFrom-Json
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WbWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
  switch ($p.action) {
    'listWindows' {
      $list = New-Object System.Collections.ArrayList
      $cb = [WbWin32+EnumWindowsProc]{
        param($hwnd, $l)
        if ([WbWin32]::IsWindowVisible($hwnd)) {
          $len = [WbWin32]::GetWindowTextLength($hwnd)
          if ($len -gt 0) {
            $sb = New-Object System.Text.StringBuilder ($len + 1)
            [void][WbWin32]::GetWindowText($hwnd, $sb, $sb.Capacity)
            $rect = New-Object WbWin32+RECT
            [void][WbWin32]::GetWindowRect($hwnd, [ref]$rect)
            $pid = 0
            [void][WbWin32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
            $procName = ''
            try { $procName = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch {}
            [void]$list.Add([pscustomobject]@{
              handle = $hwnd.ToInt64()
              title = $sb.ToString()
              process = $procName
              x = $rect.Left
              y = $rect.Top
              width = $rect.Right - $rect.Left
              height = $rect.Bottom - $rect.Top
            })
          }
        }
        return $true
      }
      [void][WbWin32]::EnumWindows($cb, [IntPtr]::Zero)
      Out-Json @{ ok = $true; windows = @($list | Sort-Object title) }
      return
    }
    'screenshot' {
      if ($p.windowId) {
        $rect = New-Object WbWin32+RECT
        [void][WbWin32]::GetWindowRect([IntPtr][int64]$p.windowId, [ref]$rect)
        $bounds = New-Object System.Drawing.Rectangle($rect.Left, $rect.Top, $rect.Right - $rect.Left, $rect.Bottom - $rect.Top)
      } else {
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      }
      $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
      $bmp.Save($p.outPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
      Out-Json @{ ok = $true; path = $p.outPath; width = $bounds.Width; height = $bounds.Height; x = $bounds.Left; y = $bounds.Top }
      return
    }
    'mouse' {
      [void][WbWin32]::SetCursorPos([int]$p.x, [int]$p.y)
      Start-Sleep -Milliseconds 40
      switch ($p.action2) {
        'click' {
          [void][WbWin32]::mouse_event([uint32]0x02, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 40
          [void][WbWin32]::mouse_event([uint32]0x04, 0, 0, 0, [UIntPtr]::Zero)
        }
        'dblclick' {
          [void][WbWin32]::mouse_event([uint32]0x02, 0, 0, 0, [UIntPtr]::Zero)
          [void][WbWin32]::mouse_event([uint32]0x04, 0, 0, 0, [UIntPtr]::Zero)
          [void][WbWin32]::mouse_event([uint32]0x02, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 40
          [void][WbWin32]::mouse_event([uint32]0x04, 0, 0, 0, [UIntPtr]::Zero)
        }
        'rightclick' {
          [void][WbWin32]::mouse_event([uint32]0x08, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 40
          [void][WbWin32]::mouse_event([uint32]0x10, 0, 0, 0, [UIntPtr]::Zero)
        }
        'down' { [void][WbWin32]::mouse_event([uint32]0x02, 0, 0, 0, [UIntPtr]::Zero) }
        'up' { [void][WbWin32]::mouse_event([uint32]0x04, 0, 0, 0, [UIntPtr]::Zero) }
      }
      Out-Json @{ ok = $true; x = $p.x; y = $p.y; action = $p.action2 }
      return
    }
    'type' {
      [System.Windows.Forms.Clipboard]::SetText([string]$p.text)
      Start-Sleep -Milliseconds 60
      [void][WbWin32]::keybd_event([byte]0x11, 0, 0, [UIntPtr]::Zero)
      [void][WbWin32]::keybd_event([byte]0x56, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 40
      [void][WbWin32]::keybd_event([byte]0x56, 0, 2, [UIntPtr]::Zero)
      [void][WbWin32]::keybd_event([byte]0x11, 0, 2, [UIntPtr]::Zero)
      Out-Json @{ ok = $true; chars = ([string]$p.text).Length }
      return
    }
    'key' {
      function PressKey([int]$vk) {
        [void][WbWin32]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 25
        [void][WbWin32]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
      }
      $mods = @($p.modifiers | ForEach-Object { [int]$_ })
      foreach ($m in $mods) { [void][WbWin32]::keybd_event([byte]$m, 0, 0, [UIntPtr]::Zero) }
      PressKey ([int]$p.vk)
      for ($i = $mods.Count - 1; $i -ge 0; $i--) { [void][WbWin32]::keybd_event([byte]$mods[$i], 0, 2, [UIntPtr]::Zero) }
      Out-Json @{ ok = $true; key = $p.key; vk = $p.vk }
      return
    }
    'scroll' {
      [void][WbWin32]::mouse_event([uint32]0x0800, 0, 0, [uint32]$p.delta, [UIntPtr]::Zero)
      Out-Json @{ ok = $true; delta = $p.delta }
      return
    }
    'activate' {
      $hwnd = [IntPtr][int64]$p.windowId
      [void][WbWin32]::ShowWindow($hwnd, 9)
      [void][WbWin32]::SetForegroundWindow($hwnd)
      Out-Json @{ ok = $true; windowId = $p.windowId }
      return
    }
    'launch' {
      if ($p.args) { Start-Process -FilePath $p.app -ArgumentList $p.args }
      else { Start-Process -FilePath $p.app }
      Out-Json @{ ok = $true; app = $p.app }
      return
    }
    default { throw "unknown action: $($p.action)" }
  }
} catch {
  Out-Json @{ ok = $false; error = $_.Exception.Message }
}
`;

const KEY_MAP = {
  Enter: 13, Return: 13,
  Tab: 9,
  Esc: 27, Escape: 27,
  Backspace: 8, Back: 8,
  Delete: 46, Del: 46,
  Insert: 45, Ins: 45,
  Home: 36, End: 35,
  PageUp: 33, PgUp: 33, PageDown: 34, PgDn: 34,
  ArrowUp: 38, Up: 38, ArrowDown: 40, Down: 40,
  ArrowLeft: 37, Left: 37, ArrowRight: 39, Right: 39,
  Space: 32, ' ': 32,
  Control: 17, Ctrl: 17, Alt: 18, Shift: 16, Win: 91, Meta: 91,
  CapsLock: 20, NumLock: 144, ScrollLock: 145, Pause: 19, PrintScreen: 44,
};
for (let i = 1; i <= 24; i++) KEY_MAP['F' + i] = 111 + i;

function scriptFile() {
  return path.join(config.dataDir, 'scripts', 'computer-use.ps1');
}

function ensureScript() {
  const file = scriptFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, PS_SCRIPT, 'utf8');
  return file;
}

function execAction(action, payload = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve({ ok: false, error: 'Computer Use 目前仅支持 Windows（当前 ' + process.platform + '）' });
    }
    let child;
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch (_) {}
      finish({ ok: false, error: 'computer use 超时（30s）' });
    }, 30_000);
    try {
      const file = ensureScript();
      const body = Buffer.from(JSON.stringify({ ...payload, action }), 'utf8').toString('base64');
      child = spawn('powershell.exe', [
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', file, '-Payload', body,
      ], { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => finish({ ok: false, error: e.message }));
      child.on('close', (code) => {
        const s = out.trim();
        try {
          finish(JSON.parse(s));
        } catch (_) {
          finish({ ok: code === 0, error: err.trim() || 'computer use 输出异常: ' + s.slice(0, 200) });
        }
      });
    } catch (e) {
      finish({ ok: false, error: e.message });
    }
  });
}

async function listWindows() {
  const r = await execAction('listWindows');
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, windows: r.windows || [] };
}

async function screenshot(opts = {}) {
  const file = media.newFile('computer');
  const r = await execAction('screenshot', { outPath: file.full, windowId: opts.windowId || null });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    path: r.path,
    url: media.urlFor(file.name),
    name: file.name,
    width: r.width, height: r.height, x: r.x, y: r.y,
  };
}

async function mouse(x, y, action = 'move') {
  return execAction('mouse', { x: Number(x) || 0, y: Number(y) || 0, action2: action });
}

async function typeText(text) {
  if (!text) return { ok: false, error: '没有可输入的文本' };
  return execAction('type', { text: String(text).slice(0, 5000) });
}

function resolveKey(key) {
  const k = String(key || '').trim();
  const vk = KEY_MAP[k] || KEY_MAP[k.toLowerCase()];
  return vk ? { key: k, vk } : null;
}

async function pressKey(key, modifiers = []) {
  const hit = resolveKey(key);
  if (!hit) return { ok: false, error: `未知按键：${key}` };
  const mods = (Array.isArray(modifiers) ? modifiers : []).map((m) => resolveKey(m)?.vk).filter(Boolean);
  return execAction('key', { key: hit.key, vk: hit.vk, modifiers: mods });
}

async function scroll(dx, dy) {
  const delta = (Number(dy) || 0) * 120;
  return execAction('scroll', { delta });
}

async function activateWindow(windowId) {
  return execAction('activate', { windowId: Number(windowId) });
}

async function launch(app, args, opts = {}) {
  if (!opts.fullAccess && !allowShell()) return { ok: false, error: '启动程序需要先开启「允许执行系统命令」' };
  return execAction('launch', { app: String(app), args: Array.isArray(args) ? args : [] });
}

function allowShell() {
  try {
    const db = require('../db');
    const v = db.getSetting('COMPUTER_ALLOW_SHELL');
    if (v) return /^(1|true|yes|on)$/i.test(v);
  } catch (_) {}
  return !!config.computer.allowShell;
}

function setAllowShell(enabled) {
  const db = require('../db');
  db.setSetting('COMPUTER_ALLOW_SHELL', enabled ? '1' : '0');
  return allowShell();
}

/**
 * 执行任意 PowerShell 命令（危险能力，默认关闭）
 */
function runCommand(cmd) {
  return new Promise((resolve) => {
    if (!allowShell()) {
      return resolve({ ok: false, error: '未开启「允许执行系统命令」。在电脑面板打开开关后重试。' });
    }
    const text = String(cmd || '').trim();
    if (!text) return resolve({ ok: false, error: '命令为空' });
    let child;
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch (_) {}
      finish({ ok: false, error: '命令执行超时（20s）' });
    }, 20_000);
    try {
      const full = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${text}`;
      const enc = Buffer.from(full, 'utf16le').toString('base64');
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', enc], { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out = (out + d).slice(0, 64_000); });
      child.stderr.on('data', (d) => { err = (err + d).slice(0, 16_000); });
      child.on('error', (e) => finish({ ok: false, error: e.message }));
      child.on('close', (code) => finish({ ok: code === 0, stdout: out.slice(0, 64_000), stderr: err, code }));
    } catch (e) {
      finish({ ok: false, error: e.message });
    }
  });
}

async function status() {
  const exe = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', '([System.Environment]::OSVersion.VersionString)'], { windowsHide: true });
  const osVersion = await new Promise((resolve) => {
    let out = '';
    exe.stdout.on('data', (d) => { out += d; });
    exe.on('error', () => resolve(''));
    exe.on('close', () => resolve(out.trim()));
  });
  return {
    ok: true,
    platform: process.platform,
    windows: process.platform === 'win32',
    os_version: osVersion,
    allow_shell: allowShell(),
    screenshots_dir: media.dir(),
  };
}

module.exports = {
  status,
  listWindows,
  screenshot,
  mouse,
  typeText,
  pressKey,
  scroll,
  activateWindow,
  launch,
  runCommand,
  allowShell,
  setAllowShell,
  resolveKey,
  KEY_MAP,
};
