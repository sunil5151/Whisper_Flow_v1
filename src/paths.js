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

module.exports = { memoryDir, memoHome, memoBin };
