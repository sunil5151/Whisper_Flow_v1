'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

function fwd(p) {
  return String(p).replace(/\\/g, '/');
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n');
}

function readJson(filePath, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  return JSON.parse(raw);
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

// ISO 8601 in local time with offset, e.g. 2026-10-22T14:03:11.120+05:30
function isoLocal(input) {
  const d = input instanceof Date ? input : new Date(input || Date.now());
  if (Number.isNaN(d.getTime())) return isoLocal(new Date());
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// Local calendar date YYYY-MM-DD
function localDate(input) {
  return isoLocal(input).slice(0, 10);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

module.exports = { sha1, fwd, writeFileAtomic, writeJsonAtomic, readJson, isoLocal, localDate, sleepMs };
