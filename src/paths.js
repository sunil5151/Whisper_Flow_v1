'use strict';

const os = require('os');
const path = require('path');

function memoryDir(root) {
  return path.join(root, '.memory');
}

function memoHome() {
  return process.env.MEMO_HOME || path.join(os.homedir(), '.memo');
}

function memoBin() {
  return path.join(__dirname, '..', 'bin', 'memo.js');
}

function sessionsDir(root) {
  return path.join(memoryDir(root), 'sessions');
}

function stateDir(repoId) {
  return path.join(memoHome(), 'state', repoId);
}

function logsDir() {
  return path.join(memoHome(), 'logs');
}

function claudeSettingsPath() {
  return process.env.MEMO_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
}

module.exports = { memoryDir, memoHome, memoBin, sessionsDir, stateDir, logsDir, claudeSettingsPath };
