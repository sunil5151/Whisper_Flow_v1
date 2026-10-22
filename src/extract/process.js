'use strict';

// `memo process` — turn captured events into evidence-linked records (P2).
//
// Per repo, per session with events > processedThrough:
//   batch → job id → skip if already applied → prompt → provider → validate
//   → append records → session summary → advance processedThrough (last, atomically).
// Crash-safe: records carry their job id, so a replay of an applied job writes nothing.

const fs = require('node:fs');
const path = require('node:path');

const { stateDir } = require('../paths');
const { repoRoot } = require('../git');
const repos = require('../repos');
const config = require('../config');
const { acquire } = require('../lock');
const { log } = require('../log');
const { sha1, readJson, writeJsonAtomic, isoLocal } = require('../util');
const usage = require('../usage');
const sessions = require('../store/sessions');
const records = require('../store/records');
const prompt = require('./prompt');
const { validate } = require('./validate');
const provider = require('../llm/provider');
const sessionSummary = require('../report/session-summary');

const MAX_OUTPUT_TOKENS = 2000;
// Output size used only for the --dry-run cost estimate (plan §10.2: ~1.5k per call).
const OUTPUT_ESTIMATE = 1500;
const MAX_ATTEMPTS = 5;

function jobsPath(repoId) {
  return path.join(stateDir(repoId), 'jobs.json');
}

function loadJobs(repoId) {
  const value = readJson(jobsPath(repoId), {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function saveJobs(repoId, jobs) {
  writeJsonAtomic(jobsPath(repoId), jobs);
}

function jobId(sid, from, to) {
  return 'j-' + sha1(sid + ':' + from + ':' + to).slice(0, 10);
}

// Events of one session file, in seq order.
function readSessionEvents(root, date, sid) {
  const file = sessions.sessionFile(root, date, sid);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* torn line ignored */ }
  }
  out.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return out;
}

// Validated items → record op-log lines (§6.2).
function toRecordLines(items, { sid, job, existing }) {
  const lines = [];
  const seen = new Set();
  for (const item of items) {
    const line = { ...item, ts: isoLocal(), job, sessions: [sid], source: 'llm' };
    if (item.op === 'create') {
      const id = records.makeId(item.type, item.statement || item.title, item.evidence[0]);
      // Step 8: an id that already exists becomes an update, not a duplicate create.
      if (existing.has(id) || seen.has(id)) line.op = 'update';
      line.id = id;
    }
    seen.add(line.id);
    lines.push(line);
  }
  // Stable field order: op, id, type, ts, job first.
  return lines.map((l) => {
    const { op, id, type, ts, job: j, ...rest } = l;
    return { op, id, type, ts, job: j, ...rest };
  });
}

function emptyResult(repo, status) {
  return {
    repo: repo.id,
    root: repo.root,
    status,
    sessions: 0,
    newEvents: 0,
    batches: 0,
    jobs: 0,
    calls: 0,
    in: 0,
    out: 0,
    costEst: 0,
    costKnown: true,
    estimatedInputTokens: 0,
    records: 0,
    summaries: 0,
    leftover: 0,
    dropped: 0,
    errors: []
  };
}

/**
 * Process one registered repo.
 * @param {object} args {repo, cfg, dryRun, retryFailed, maxCalls, providerImpl}
 */
async function processRepo({ repo, cfg, dryRun = false, retryFailed = false, maxCalls = null, providerImpl = null }) {
  const root = repo.root;
  const result = emptyResult(repo, 'ok');
  const callCap = maxCalls === null ? Number(cfg.maxCallsPerCycle) : maxCalls;

  const index = sessions.loadIndex(root);
  const pendingSessions = index.filter((entry) => {
    if (!entry || !sessions.validSid(entry.sid) || entry.deletedAt) return false;
    return (Number(entry.events) || 0) > (Number(entry.processedThrough) || 0);
  });
  result.sessions = pendingSessions.length;
  for (const entry of pendingSessions) {
    result.newEvents += (Number(entry.events) || 0) - (Number(entry.processedThrough) || 0);
  }
  if (pendingSessions.length === 0) {
    result.status = 'no_new_data';
    return result;
  }

  if (!dryRun) {
    if (cfg.apiEnabled === false || cfg.paused === true) {
      result.status = 'api_disabled';
      return result;
    }
    const budget = usage.budgetState(cfg);
    if (budget.reached) {
      result.status = 'budget_reached';
      result.leftover = result.newEvents;
      return result;
    }
  }

  const lock = dryRun ? { release() {} } : acquire(path.join(stateDir(repo.id), 'process.lock'), { staleMs: 20 * 60 * 1000 });
  if (!lock) {
    result.status = 'busy';
    return result;
  }

  const llm = dryRun ? null : (providerImpl || provider.create(cfg));
  const jobs = loadJobs(repo.id);
  let stop = null;

  try {
    for (const entry of pendingSessions) {
      if (stop) break;
      const sid = entry.sid;
      const all = readSessionEvents(root, entry.date, sid);
      if (all.length === 0) {
        result.errors.push({ sid, error: 'session file missing or empty' });
        continue;
      }
      let processedThrough = Number(entry.processedThrough) || 0;
      const pending = all.filter((e) => (Number(e.seq) || 0) > processedThrough);
      if (pending.length === 0) continue;

      const openRecords = records.openRecords(root, 60);
      const batches = prompt.batchEvents(pending, {
        maxInputTokens: Number(cfg.maxInputTokensPerCall),
        openRecords,
        repo: path.basename(root)
      });
      result.batches += batches.length;

      for (const batch of batches) {
        const from = processedThrough;
        const to = Number(batch[batch.length - 1].seq) || from;
        const job = jobId(sid, from, to);
        const jobState = jobs[job] || { sid, from, to, status: 'pending', attempts: 0, lastError: null, ts: isoLocal() };

        if (jobState.status === 'failed_permanent' && !retryFailed) {
          result.errors.push({ sid, job, error: 'job failed_permanent (use --retry-failed)' });
          break;
        }
        if (jobState.status === 'failed_retryable' && !retryFailed) {
          result.errors.push({ sid, job, error: 'job failed_retryable (use --retry-failed)' });
          break;
        }

        // Step 4: records already carry this job → it was applied before a crash.
        if (records.hasJob(root, job)) {
          processedThrough = to;
          jobs[job] = { ...jobState, status: 'applied', ts: isoLocal() };
          entry.processedThrough = processedThrough;
          sessions.saveIndex(root, index);
          saveJobs(repo.id, jobs);
          result.jobs++;
          continue;
        }

        const built = prompt.build({
          repo: path.basename(root),
          openRecords: records.openRecords(root, 60),
          events: batch,
          denyPaths: cfg.denyPaths
        });
        result.estimatedInputTokens += built.inputTokens;

        if (dryRun) {
          result.jobs++;
          continue;
        }

        if (callCap !== null && result.calls >= callCap) {
          result.status = 'max_calls';
          stop = 'max_calls';
          break;
        }
        if (usage.budgetState(cfg).reached) {
          result.status = 'budget_reached';
          stop = 'budget_reached';
          break;
        }

        const existing = records.byId(root);
        let response;
        let checked;
        try {
          response = await llm.complete({ system: built.system, user: built.user, maxTokens: MAX_OUTPUT_TOKENS });
          result.calls++;
          const cost = usage.costOf(cfg, response.model, response.usage.input, response.usage.output);
          usage.record({ repoId: repo.id, job, model: response.model, in: response.usage.input, out: response.usage.output, costEst: cost });
          result.in += response.usage.input;
          result.out += response.usage.output;
          if (cost === null) result.costKnown = false;
          else result.costEst += cost;

          checked = validate(response.text, { eventIds: built.eventIds, events: built.events, existing });

          // Step 7: one repair call, then the job is permanently failed.
          if (!checked.ok) {
            const repair = await llm.complete({
              system: built.system,
              user: prompt.repairUser(built.user, checked.error),
              maxTokens: MAX_OUTPUT_TOKENS
            });
            result.calls++;
            const repairCost = usage.costOf(cfg, repair.model, repair.usage.input, repair.usage.output);
            usage.record({ repoId: repo.id, job, model: repair.model, in: repair.usage.input, out: repair.usage.output, costEst: repairCost });
            result.in += repair.usage.input;
            result.out += repair.usage.output;
            if (repairCost === null) result.costKnown = false;
            else result.costEst += repairCost;
            checked = validate(repair.text, { eventIds: built.eventIds, events: built.events, existing });
            response = repair;
          }
        } catch (err) {
          const kind = err && err.kind ? err.kind : 'retryable';
          // auth / quota are environment problems, not job problems: no attempt is counted.
          const attempts = kind === 'auth' || kind === 'quota'
            ? (Number(jobState.attempts) || 0)
            : (Number(jobState.attempts) || 0) + 1;
          const status = kind === 'auth' || kind === 'quota' ? 'pending'
            : attempts < MAX_ATTEMPTS ? 'pending' : 'failed_retryable';
          jobs[job] = { ...jobState, status, attempts, lastError: kind + ': ' + (err && err.message), ts: isoLocal() };
          saveJobs(repo.id, jobs);
          result.errors.push({ sid, job, error: kind + ': ' + (err && err.message) });
          result.status = 'api_failed';
          log('process', { repo: repo.id, sid: sid.slice(0, 8), job, status: 'api_failed', kind, attempts });
          // Nothing was written; events and processedThrough stay untouched for the next run.
          if (kind === 'auth' || kind === 'quota') stop = kind;
          break;
        }

        if (!checked.ok) {
          jobs[job] = {
            ...jobState, status: 'failed_permanent',
            attempts: (Number(jobState.attempts) || 0) + 1,
            lastError: 'invalid JSON after repair: ' + checked.error, ts: isoLocal()
          };
          saveJobs(repo.id, jobs);
          result.errors.push({ sid, job, error: 'invalid JSON after repair' });
          result.status = 'failed_permanent';
          log('process', { repo: repo.id, sid: sid.slice(0, 8), job, status: 'failed_permanent' });
          break;
        }

        const lines = toRecordLines(checked.items, { sid, job, existing });
        if (lines.length > 0) {
          records.ensureDir(root);
          records.append(root, lines);
          result.records += lines.length;
        }
        result.dropped += checked.dropped.length;

        const written = sessionSummary.appendSummary(root, {
          sid,
          date: entry.date,
          agent: entry.agent,
          model: response.model,
          summary: checked.summary,
          from,
          to,
          job,
          recordIds: lines.map((l) => l.id),
          gaps: checked.gaps
        });
        if (written.written) result.summaries++;

        jobs[job] = {
          ...jobState, status: 'applied', attempts: (Number(jobState.attempts) || 0) + 1,
          lastError: null, ts: isoLocal(), items: lines.length
        };
        saveJobs(repo.id, jobs);

        // Step 9: advance processedThrough last, so a crash replays the job instead of losing it.
        processedThrough = to;
        entry.processedThrough = processedThrough;
        if (checked.summary) entry.summary = checked.summary.slice(0, 300);
        sessions.saveIndex(root, index);
        result.jobs++;

        log('process', {
          repo: repo.id, sid: sid.slice(0, 8), job, status: 'ok',
          events: batch.length, items: lines.length, dropped: checked.dropped.length,
          in: response.usage.input, out: response.usage.output
        });
      }
    }
  } finally {
    lock.release();
  }

  // Exact backlog: what every session still has beyond its (possibly advanced) cursor.
  if (!dryRun) {
    result.leftover = index.reduce((n, entry) => {
      const left = (Number(entry.events) || 0) - (Number(entry.processedThrough) || 0);
      return n + (left > 0 ? left : 0);
    }, 0);
  }

  if (!dryRun && result.jobs > 0) {
    try { require('../brief').report(root); } catch (err) {
      log('process', { repo: repo.id, status: 'report_error', error: err.message });
    }
  }

  if (dryRun) result.status = 'dry_run';
  else if (result.status === 'ok' && result.jobs === 0) {
    // Events were pending but nothing ran: parked jobs, not an empty queue.
    result.status = result.errors.length > 0 ? 'blocked' : 'no_new_data';
  }
  return result;
}

function fmtUsd(value) {
  if (value === null || value === undefined) return 'unknown';
  if (value === 0) return '$0.00';
  return '$' + (value < 0.01 ? value.toFixed(5) : value.toFixed(4));
}

function fmtNum(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function reportLines(result, cfg, dryRun) {
  const name = path.basename(result.root);
  const lines = [name + '  (' + result.status + ')'];
  if (dryRun) {
    const price = config.priceFor(cfg, cfg.model);
    const estOut = result.jobs * OUTPUT_ESTIMATE;
    const cost = price
      ? result.estimatedInputTokens / 1e6 * price.inPerM + estOut / 1e6 * price.outPerM
      : null;
    lines.push('  sessions with new events ' + result.sessions + ' · new events ' + fmtNum(result.newEvents) +
      ' · batches/calls ' + result.jobs);
    lines.push('  estimated input tokens ' + fmtNum(result.estimatedInputTokens) +
      ' · assumed output ' + fmtNum(estOut) + ' (' + OUTPUT_ESTIMATE + '/call)');
    lines.push('  estimated cost ' + (cost === null
      ? 'unknown — no price for ' + cfg.model + ' in config'
      : '≈ ' + fmtUsd(Math.round(cost * 1e6) / 1e6) + ' with ' + cfg.provider + '/' + cfg.model));
    lines.push('  no API call was made (--dry-run)');
  } else {
    lines.push('  sessions ' + result.sessions + ' · new events ' + fmtNum(result.newEvents) +
      ' · jobs ' + result.jobs + ' · calls ' + result.calls);
    lines.push('  records written ' + result.records + ' · items dropped ' + result.dropped +
      ' · summaries ' + result.summaries);
    lines.push('  tokens ' + fmtNum(result.in) + ' in / ' + fmtNum(result.out) + ' out · cost ' +
      (result.costKnown ? '≈ ' + fmtUsd(result.costEst) : '≈ ' + fmtUsd(result.costEst) + ' (some models unpriced)'));
    if (result.leftover > 0) lines.push('  backlog ' + fmtNum(result.leftover) + ' event(s) left for the next run');
  }
  for (const err of result.errors) lines.push('  ! ' + (err.sid ? err.sid.slice(0, 8) + ': ' : '') + err.error);
  return lines;
}

// Repos to work on: --repo <path>, else every enabled registered repo.
function targetRepos(repoArg) {
  if (repoArg) {
    const root = repoRoot(path.resolve(repoArg));
    const repo = repos.find(root);
    if (!repo) throw new Error('repo is not registered — run `memo init` in ' + root);
    if (repo.enabled === false) throw new Error('repo is disabled in ~/.memo/repos.json');
    return [repo];
  }
  return repos.load().filter((r) => r.enabled !== false);
}

async function command(argv = []) {
  const dryRun = argv.includes('--dry-run');
  const retryFailed = argv.includes('--retry-failed');
  const commit = argv.includes('--commit');
  const repoFlag = argv.indexOf('--repo');
  const repoArg = repoFlag !== -1 ? argv[repoFlag + 1] : null;
  if (repoFlag !== -1 && !repoArg) throw new Error('usage: memo process --repo <path>');

  const cfg = config.load();
  let list;
  if (repoArg) {
    list = targetRepos(repoArg);
  } else {
    list = targetRepos(null);
    if (list.length === 0) {
      // Fall back to the current repo so `memo process` works right after `memo init`.
      try {
        const repo = repos.find(repoRoot(process.cwd()));
        if (repo) list = [repo];
      } catch (_) { /* not in a git repo */ }
    }
  }
  if (list.length === 0) {
    process.stdout.write('no registered repos — run `memo init` in a repo first\n');
    return { results: [] };
  }

  const out = [];
  let callsLeft = Number(cfg.maxCallsPerCycle);
  for (const repo of list) {
    try {
      const result = await processRepo({ repo, cfg, dryRun, retryFailed, maxCalls: dryRun ? null : callsLeft });
      if (!dryRun) callsLeft = Math.max(0, callsLeft - result.calls);
      out.push(result);
      process.stdout.write(reportLines(result, cfg, dryRun).join('\n') + '\n');
      if (commit && !dryRun) {
        const res = require('../gitops/memory-commit').commitMemory(repo.root, { cfg });
        process.stdout.write('  commit: ' + res.status + (res.hash ? ' ' + res.hash : '') + '\n');
      }
    } catch (err) {
      const result = emptyResult(repo, 'error');
      result.errors.push({ error: err && err.message ? err.message : String(err) });
      out.push(result);
      log('process', { repo: repo.id, status: 'error', error: err && err.message });
      process.stdout.write(path.basename(repo.root) + '  (error)\n  ! ' + (err && err.message) + '\n');
    }
  }
  if (!dryRun) {
    const month = usage.monthTotals();
    process.stdout.write('this month: ' + month.calls + ' call(s) · ' + fmtNum(month.input) + ' in / ' +
      fmtNum(month.output) + ' out · ≈ ' + fmtUsd(month.costUsd) + ' of $' + cfg.monthlyBudgetUsd + ' budget\n');
  }
  return { results: out };
}

module.exports = {
  command, processRepo, jobId, jobsPath, loadJobs, saveJobs, readSessionEvents,
  toRecordLines, reportLines, targetRepos, MAX_OUTPUT_TOKENS, OUTPUT_ESTIMATE, MAX_ATTEMPTS
};
