'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sessionsDir } = require('../paths');
const { readJson, writeJsonAtomic } = require('../util');

const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function validSid(sid) {
  return typeof sid === 'string' && SID_RE.test(sid);
}

function indexPath(root) {
  return path.join(sessionsDir(root), 'index.json');
}

function loadIndex(root) {
  const list = readJson(indexPath(root), []);
  return Array.isArray(list) ? list : [];
}

function saveIndex(root, list) {
  writeJsonAtomic(indexPath(root), list);
}

// .memory/sessions/YYYY/MM/DD/<sid>.jsonl
function sessionFile(root, date, sid) {
  if (!validSid(sid)) throw new Error(`invalid session id: ${sid}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date: ${date}`);
  const [y, m, d] = date.split('-');
  return path.join(sessionsDir(root), y, m, d, `${sid}.jsonl`);
}

// Ids and last seq already in a session file (for dedup + continuous seq).
function readExisting(file) {
  const ids = new Set();
  let lastSeq = 0;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { ids, lastSeq };
    throw err;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.id) ids.add(e.id);
      if (typeof e.seq === 'number' && e.seq > lastSeq) lastSeq = e.seq;
    } catch (_) { /* a torn line is ignored; dedup still works for the rest */ }
  }
  return { ids, lastSeq };
}

// Append complete lines and fsync.
function appendEvents(file, events) {
  if (events.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, data, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { validSid, indexPath, loadIndex, saveIndex, sessionFile, readExisting, appendEvents };
