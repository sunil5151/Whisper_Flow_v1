'use strict';

// `memo cycle` — the run the scheduled task performs every 15 minutes (P4).
// Per repo: capture --sweep → process → render reports → commit .memory/.
// One repo failing never stops the others; the command always exits 0.

const path = require('node:path');

const { memoHome } = require('./paths');
const config = require('./config');
const repos = require('./repos');
const { acquire } = require('./lock');
const { log } = require('./log');
const { writeJsonAtomic, readJson, isoLocal } = require('./util');
const capture = require('./capture/capture');
const extract = require('./extract/process');
const brief = require('./brief');
const memoryCommit = require('./gitops/memory-commit');

const LOCK_STALE_MS = 20 * 60 * 1000;
// Worst → best. The repo keeps the worst thing that happened to it.
const SEVERITY = ['error', 'api_failed', 'no_identity', 'git_busy', 'budget_reached', 'capture_gap', 'ok', 'no_new_data'];
// Capture results that mean "data may be missing", not "nothing happened".
const GAP_STATUSES = ['error', 'busy', 'bad_cursors', 'transcript_missing', 'no_transcript', 'transcript_rewritten'];
const OK_CYCLE = ['ok', 'no_new_data', 'paused'];

function lockPath() {
  return path.join(memoHome(), 'cycle.lock');
}

function statusPath() {
  return path.join(memoHome(), 'status.json');
}

function worst(a, b) {
  return SEVERITY.indexOf(a) <= SEVERITY.indexOf(b) ? a : b;
}

/**
 * One repo: capture, process, report, commit.
 * @returns {object} the line logged to cycles.jsonl
 */
async function runRepo(repo, cfg, { callsLeft = null, providerImpl = null } = {}) {
  const t0 = Date.now();
  const line = {
    event: 'repo', repo: path.basename(repo.root), repoId: repo.id,
    newEvents: 0, jobs: 0, calls: 0, in: 0, out: 0, costEst: 0,
    committed: null, status: 'no_new_data', ms: 0
  };

  const captured = capture.sweepRepo(repo);
  for (const c of captured) line.newEvents += Number(c.newEvents) || 0;
  if (captured.some((c) => GAP_STATUSES.includes(c.status))) line.status = worst(line.status, 'capture_gap');

  let processed = null;
  if (cfg.apiEnabled === false) {
    line.apiSkipped = 'api_disabled';
  } else {
    processed = await extract.processRepo({ repo, cfg, maxCalls: callsLeft, providerImpl });
    line.jobs = processed.jobs;
    line.calls = processed.calls;
    line.in = processed.in;
    line.out = processed.out;
    line.costEst = processed.costEst;
    if (processed.leftover > 0) line.leftover = processed.leftover;
    // e.g. max_calls or failed_permanent: not a cycle failure, but worth seeing in the log.
    if (!['ok', 'no_new_data'].includes(processed.status)) line.processStatus = processed.status;
    if (['api_failed', 'budget_reached', 'error'].includes(processed.status)) {
      line.status = worst(line.status, processed.status);
    } else if (processed.jobs > 0) {
      line.status = worst(line.status, 'ok');
    }
  }

  // Reports are cheap and deterministic; re-render whenever anything landed.
  if (line.newEvents > 0 || line.jobs > 0) {
    try {
      brief.report(repo.root);
      line.status = worst(line.status, 'ok');
    } catch (err) {
      line.status = worst(line.status, 'error');
      line.error = 'report: ' + (err && err.message);
    }
  }

  const commit = memoryCommit.commitMemory(repo.root, { cfg });
  if (commit.status === 'committed') {
    line.committed = commit.hash;
    line.status = worst(line.status, 'ok');
  } else if (commit.status === 'git_busy' || commit.status === 'no_identity') {
    line.status = worst(line.status, commit.status);
  }

  line.ms = Date.now() - t0;
  return line;
}

/**
 * The whole cycle. Never throws.
 * @returns {{status: string, repos: object[], ms: number, skipped?: string}}
 */
async function runCycle({ cfg = config.ensure(), providerImpl = null } = {}) {
  const t0 = Date.now();
  const lock = acquire(lockPath(), { staleMs: LOCK_STALE_MS });
  if (!lock) {
    log('cycles', { event: 'overlap_skip', status: 'skipped' });
    return { status: 'skipped', reason: 'overlap_skip', repos: [], ms: Date.now() - t0 };
  }
  if (lock.recovered) log('cycles', { event: 'stale_lock_recovered', status: 'ok' });

  try {
    log('cycles', { event: 'cycle_start', status: 'running', pid: process.pid });

    if (cfg.paused === true) {
      log('cycles', { event: 'cycle_end', status: 'paused', repos: 0, ms: Date.now() - t0 });
      writeStatus({ status: 'paused', repos: [], ms: Date.now() - t0, cfg });
      return { status: 'paused', repos: [], ms: Date.now() - t0 };
    }

    const list = repos.load().filter((r) => r && r.enabled !== false);
    const lines = [];
    let callsLeft = Number(cfg.maxCallsPerCycle);
    for (const repo of list) {
      let line;
      try {
        line = await runRepo(repo, cfg, { callsLeft, providerImpl });
      } catch (err) {
        line = {
          event: 'repo', repo: path.basename(repo.root), repoId: repo.id,
          newEvents: 0, jobs: 0, calls: 0, in: 0, out: 0, costEst: 0,
          committed: null, status: 'error', error: err && err.message ? err.message : String(err), ms: 0
        };
      }
      callsLeft = Math.max(0, callsLeft - (Number(line.calls) || 0));
      log('cycles', line);
      lines.push(line);
    }

    const status = lines.every((l) => OK_CYCLE.includes(l.status)) ? 'ok' : 'failed';
    const ms = Date.now() - t0;
    log('cycles', { event: 'cycle_end', status, repos: lines.length, ms });
    writeStatus({ status, repos: lines, ms, cfg });
    return { status, repos: lines, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    log('cycles', { event: 'cycle_end', status: 'failed', error: err && err.message, ms });
    writeStatus({ status: 'failed', repos: [], ms, cfg, error: err && err.message });
    return { status: 'failed', repos: [], ms, error: err && err.message };
  } finally {
    lock.release();
  }
}

// ~/.memo/status.json — what `memo status` reads without parsing the logs.
function writeStatus({ status, repos: lines, ms, cfg, error = null }) {
  const now = isoLocal();
  let prev = {};
  try { prev = readJson(statusPath(), {}) || {}; } catch (_) { prev = {}; }
  const failing = lines.filter((l) => !OK_CYCLE.includes(l.status));
  const next = {
    lastCycle: {
      ts: now, status, ms, repos: lines.length,
      calls: lines.reduce((n, l) => n + (Number(l.calls) || 0), 0),
      newEvents: lines.reduce((n, l) => n + (Number(l.newEvents) || 0), 0),
      committed: lines.filter((l) => l.committed).length
    },
    lastOk: status === 'ok' || status === 'paused' ? now : prev.lastOk || null,
    lastFailed: status === 'failed'
      ? { ts: now, reason: error || (failing[0] && (failing[0].status + (failing[0].error ? ': ' + failing[0].error : ''))) || 'failed' }
      : prev.lastFailed || null,
    nextExpected: isoLocal(Date.now() + Number(cfg.intervalMinutes || 15) * 60000)
  };
  try { writeJsonAtomic(statusPath(), next); } catch (_) { /* status is advisory only */ }
  return next;
}

function fmtLine(l) {
  const bits = [l.repo.padEnd(24), 'events ' + l.newEvents, 'jobs ' + l.jobs, 'calls ' + l.calls];
  if (l.committed) bits.push('commit ' + l.committed);
  bits.push(l.status);
  if (l.error) bits.push('— ' + l.error);
  return '  ' + bits.join(' · ');
}

async function command(argv = []) {
  const quiet = argv.includes('--quiet');
  const res = await runCycle();
  if (!quiet) {
    if (res.status === 'skipped') process.stdout.write('another cycle is running — skipped\n');
    else if (res.status === 'paused') process.stdout.write('MEMO is paused — nothing ran (memo resume)\n');
    else {
      process.stdout.write('cycle ' + res.status + ' in ' + res.ms + ' ms\n');
      for (const l of res.repos) process.stdout.write(fmtLine(l) + '\n');
      if (res.repos.length === 0) process.stdout.write('  no registered repos — run `memo init` in a repo\n');
    }
  }
  return res;
}

module.exports = { command, runCycle, runRepo, writeStatus, statusPath, lockPath, LOCK_STALE_MS, OK_CYCLE };
