'use strict';

// `memo capture` — Claude Code hook entry point and `--sweep` catch-up.
// Reads new transcript bytes since the stored offset, normalizes, redacts,
// appends to .memory/sessions/YYYY/MM/DD/<sid>.jsonl. Never fails the caller.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stateDir, memoHome } = require('../paths');
const { repoRoot } = require('../git');
const repos = require('../repos');
const { acquire } = require('../lock');
const { log } = require('../log');
const { readJson, writeJsonAtomic, localDate } = require('../util');
const { DEFAULT_DENY_PATHS } = require('../redact');
const { normalize } = require('./claude');
const sessions = require('../store/sessions');

const STDIN_MAX = 1024 * 1024;
const STDIN_TIMEOUT_MS = 2000;
const MAX_TOOL_IDS = 500;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > STDIN_MAX) return finish();
      chunks.push(c);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function loadDenyPaths() {
  try {
    const cfg = readJson(path.join(memoHome(), 'config.json'), null);
    if (cfg && Array.isArray(cfg.denyPaths)) return cfg.denyPaths;
  } catch (_) { /* bad config → defaults */ }
  return DEFAULT_DENY_PATHS;
}

function cursorsPath(repoId) {
  return path.join(stateDir(repoId), 'cursors.json');
}

function trimTools(tools) {
  const keys = Object.keys(tools);
  if (keys.length <= MAX_TOOL_IDS) return tools;
  const out = {};
  for (const k of keys.slice(-MAX_TOOL_IDS)) out[k] = tools[k];
  return out;
}

function readRange(file, start, end) {
  const len = end - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Capture one session of one registered repo.
 * @returns {{status: string, newEvents: number}}
 */
function captureSession({ repo, sid, transcriptPath, event = 'sweep', source, lockWaitMs = 1500 }) {
  const root = repo.root;
  const t0 = Date.now();
  const sid8 = String(sid).slice(0, 8);
  if (!sessions.validSid(sid)) {
    log('capture', { event, repo: repo.id, status: 'invalid_sid' });
    return { status: 'invalid_sid', newEvents: 0 };
  }
  const lock = acquire(path.join(stateDir(repo.id), 'capture.lock'), { staleMs: 60000, waitMs: lockWaitMs });
  if (!lock) {
    log('capture', { event, repo: repo.id, sid: sid8, status: 'busy' });
    return { status: 'busy', newEvents: 0 };
  }
  if (lock.recovered) log('capture', { event, repo: repo.id, sid: sid8, status: 'stale_lock_recovered' });
  try {
    const cPath = cursorsPath(repo.id);
    const cursors = readJson(cPath, {});
    let cur = cursors[sid];
    const tPath = transcriptPath || (cur && cur.transcriptPath);
    const index = sessions.loadIndex(root);
    const before = JSON.stringify(index);
    let entry = index.find((e) => e.sid === sid);

    const setStatus = () => {
      if (!entry) return;
      if (event === 'SessionEnd') entry.status = 'ended';
      else if (event === 'SessionStart' || (entry.status === 'transcript_missing' && event !== 'sweep')) entry.status = 'active';
    };
    const saveIndexIfChanged = () => {
      if (JSON.stringify(index) !== before) sessions.saveIndex(root, index);
    };

    let stat = null;
    if (tPath) {
      try { stat = fs.statSync(tPath); } catch (_) { stat = null; }
    }
    if (!stat) {
      // SessionStart may fire before the transcript file exists: remember the path, no gap.
      if (tPath && (!cur || cur.transcriptPath !== tPath)) {
        cursors[sid] = { ...(cur || { offset: 0, lineNo: 0, tools: {} }), transcriptPath: tPath };
        writeJsonAtomic(cPath, cursors);
      }
      let status = tPath ? 'transcript_missing' : 'no_transcript';
      if (event === 'SessionStart' && !entry) status = 'waiting_for_transcript';
      else if (entry && event !== 'SessionEnd') entry.status = 'transcript_missing';
      setStatus();
      saveIndexIfChanged();
      log('capture', { event, repo: repo.id, sid: sid8, status, ms: Date.now() - t0 });
      return { status, newEvents: 0 };
    }

    if (!cur) cur = { transcriptPath: tPath, offset: 0, lineNo: 0, tools: {} };
    cur.transcriptPath = tPath;
    cur.tools = cur.tools || {};
    let status = 'ok';
    if (stat.size < cur.offset) {
      log('capture', { event, repo: repo.id, sid: sid8, status: 'transcript_rewritten', oldOffset: cur.offset, size: stat.size });
      cur.offset = 0;
      cur.lineNo = 0;
      status = 'transcript_rewritten';
    }

    const envelopes = [];
    let badLines = 0;
    let consumed = 0;
    if (stat.size > cur.offset) {
      const buf = readRange(tPath, cur.offset, stat.size);
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl >= 0) {
        consumed = lastNl + 1;
        const text = buf.subarray(0, consumed).toString('utf8');
        const ctx = { sid, root, cwd: root, home: os.homedir(), tools: cur.tools, denyPaths: loadDenyPaths() };
        for (const rawLine of text.slice(0, -1).split('\n')) {
          cur.lineNo++;
          const raw = rawLine.replace(/\r$/, '');
          if (!raw.trim()) continue;
          let obj;
          try { obj = JSON.parse(raw); } catch (_) {
            badLines++;
            log('capture', { event, repo: repo.id, sid: sid8, status: 'bad_line', line: cur.lineNo });
            continue;
          }
          ctx.lineNo = cur.lineNo;
          ctx.raw = raw;
          for (const env of normalize(obj, ctx)) envelopes.push(env);
        }
      }
      // bytes after the last "\n" are an incomplete line: left for the next run
    }

    let added = [];
    if (envelopes.length > 0) {
      const date = entry ? entry.date : localDate(envelopes[0].ts);
      const file = sessions.sessionFile(root, date, sid);
      const existing = sessions.readExisting(file);
      let seq = existing.lastSeq;
      for (const env of envelopes) {
        if (existing.ids.has(env.id)) continue;
        existing.ids.add(env.id);
        seq++;
        const { v, id, sid: s, ts, agent, type, ...rest } = env;
        added.push({ v, id, sid: s, seq, ts, agent, type, ...rest });
      }
      sessions.appendEvents(file, added);
      if (added.length > 0) {
        if (!entry) {
          entry = { sid, agent: 'claude-code', date, start: added[0].ts, end: added[0].ts, events: 0, processedThrough: 0, summary: '', status: 'active' };
          index.push(entry);
        }
        entry.events = seq;
        entry.end = added[added.length - 1].ts;
      }
    }

    cur.offset += consumed;
    cur.fileSize = stat.size;
    if (added.length > 0) cur.lastEventId = added[added.length - 1].id;
    cur.tools = trimTools(cur.tools);
    cursors[sid] = cur;
    writeJsonAtomic(cPath, cursors);

    setStatus();
    saveIndexIfChanged();
    log('capture', { event, source, repo: repo.id, sid: sid8, status, newEvents: added.length, badLines, ms: Date.now() - t0 });
    return { status, newEvents: added.length };
  } finally {
    lock.release();
  }
}

function sweep() {
  const results = [];
  for (const repo of repos.load()) {
    if (!repo.enabled) continue;
    let cursors = {};
    try { cursors = readJson(cursorsPath(repo.id), {}); } catch (err) {
      log('capture', { event: 'sweep', repo: repo.id, status: 'bad_cursors', error: err.message });
      continue;
    }
    for (const sid of Object.keys(cursors)) {
      try {
        results.push({ repo: repo.id, sid, ...captureSession({ repo, sid, event: 'sweep', lockWaitMs: 5000 }) });
      } catch (err) {
        log('capture', { event: 'sweep', repo: repo.id, sid: sid.slice(0, 8), status: 'error', error: err.message });
        results.push({ repo: repo.id, sid, status: 'error', newEvents: 0 });
      }
    }
  }
  return results;
}

async function hookEntry() {
  const raw = await readStdin();
  let data;
  try { data = JSON.parse(raw); } catch (_) {
    log('capture', { event: 'unknown', status: 'bad_stdin', bytes: raw.length });
    return;
  }
  const event = String(data.hook_event_name || 'unknown');
  const cwd = data.cwd || process.cwd();
  let root;
  try { root = repoRoot(cwd); } catch (_) {
    log('capture', { event, status: 'skip_not_git' });
    return;
  }
  const repo = repos.find(root);
  if (!repo || repo.enabled === false) {
    log('capture', { event, status: 'skip_unregistered' });
    return;
  }
  captureSession({
    repo,
    sid: data.session_id,
    transcriptPath: data.transcript_path,
    event,
    source: data.source || data.reason,
    lockWaitMs: event === 'SessionEnd' ? 800 : 1500
  });
}

// CLI: always resolves, never throws.
async function command(argv = []) {
  try {
    if (argv.includes('--sweep')) {
      const results = sweep();
      const total = results.reduce((n, r) => n + (r.newEvents || 0), 0);
      if (process.stdout.isTTY || argv.includes('--verbose')) {
        console.log(`swept ${results.length} session(s), ${total} new event(s)`);
      }
      return;
    }
    await hookEntry();
  } catch (err) {
    log('capture', { status: 'error', error: err && err.message ? err.message : String(err) });
  }
}

module.exports = { command, captureSession, sweep, readStdin };
