'use strict';

const notifier = require('node-notifier');
const { spawn } = require('child_process');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

/**
 * 触发一条 Windows 系统通知。
 * @param {{title:string, message:string, sound?:boolean}} opts
 */
function notify(opts) {
  const { title, message, sound } = opts;
  const useSound = sound !== undefined ? sound : config.notify.sound;

  return new Promise((resolve) => {
    try {
      notifier.notify(
        {
          title: String(title || 'WorkBuddy'),
          message: String(message || ''),
          sound: useSound,
          wait: false,
          timeout: 10,
          appID: 'WorkBuddy Assistant',
        },
        (err, response, metadata) => {
          if (err) {
            logger.warn('notifier error:', err.message);
          } else {
            logger.info('notified:', title);
          }
          resolve(response || metadata);
        }
      );
    } catch (e) {
      logger.error('notify failed:', e.message);
      // fallback: 控制台 + 写日志
      console.log(`\n🔔 [Notify] ${title}\n   ${message}\n`);
      resolve(null);
    }
  });
}

/**
 * 播放系统提示音（独立通道，失败不影响主通知）。
 */
function playSystemSound() {
  if (!config.notify.sound) return;
  try {
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 300; [System.Media.SystemSounds]::Exclamation.Play()",
      ],
      { stdio: 'ignore' }
    );
    ps.on('error', (e) => logger.warn('sound play error:', e.message));
  } catch (e) {
    logger.warn('sound play outer error:', e.message);
  }
}

/**
 * 复合通知：toast + 声音 + 控制台回显。
 */
async function alert(title, message) {
  console.log(`\n🔔 [${new Date().toLocaleString()}] ${title}\n   ${message}\n`);
  playSystemSound();
  await notify({ title, message });
}

module.exports = { notify, alert, playSystemSound };
