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

// Session summary file next to the .jsonl.
function summaryFile(root, date, sid) {
  return sessionFile(root, date, sid).replace(/\.jsonl$/, '.md');
}

// Live (non-deleted) index entries.
function liveEntries(root) {
  return loadIndex(root).filter((e) => e && validSid(e.sid) && !e.deletedAt);
}

// Resolve a full sid or an unambiguous prefix (e.g. the 8 chars shown in reports).
// Returns {entry} | {error}.
function resolveSid(root, wanted) {
  if (typeof wanted !== 'string' || !validSid(wanted)) return { error: 'invalid session id: ' + wanted };
  const live = liveEntries(root);
  const exact = live.find((e) => e.sid === wanted);
  if (exact) return { entry: exact };
  const hits = live.filter((e) => e.sid.startsWith(wanted));
  if (hits.length === 1) return { entry: hits[0] };
  if (hits.length === 0) return { error: 'no session matches ' + wanted };
  return { error: wanted + ' matches ' + hits.length + ' sessions — use the full id' };
}

// Replace an entry with a tombstone so capture never re-imports the session (P5).
function tombstone(root, sid, when) {
  const index = loadIndex(root);
  const i = index.findIndex((e) => e && e.sid === sid);
  const mark = { sid, agent: i >= 0 ? index[i].agent : 'claude-code', date: i >= 0 ? index[i].date : '', deletedAt: when };
  if (i >= 0) index[i] = mark; else index.push(mark);
  saveIndex(root, index);
  return mark;
}

// Event ids stored in one session file.
function readEventIds(file) {
  const ids = [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return ids;
    throw err;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.id === 'string') ids.push(e.id);
    } catch (_) { /* torn line ignored */ }
  }
  return ids;
}

module.exports = {
  validSid, indexPath, loadIndex, saveIndex, sessionFile, summaryFile, readExisting, appendEvents,
  liveEntries, resolveSid, tombstone, readEventIds
};
