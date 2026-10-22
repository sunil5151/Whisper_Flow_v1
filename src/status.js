'use strict';

// `memo status`, `memo usage`, `memo doctor`, `memo pause`, `memo resume` (P4, V1).
// Everything here reads local state only; `memo doctor --live` is the one exception.
// Words used consistently: "captured" (on disk), "pending" (not yet extracted),
// "real calls" (provider answered), "mock calls" (fixtures, never counted as real),
// "failed attempts" (provider errors), "records" (validated and persisted).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { memoHome, logsDir, claudeSettingsPath, memoBin } = require('./paths');
const config = require('./config');
const repos = require('./repos');
const usage = require('./usage');
const sessions = require('./store/sessions');
const records = require('./store/records');
const cycle = require('./cycle');
const schedule = require('./schedule');
const limits = require('./llm/limits');
const { fwd, readJson, isoLocal } = require('./util');
const { isMemoHandler } = require('./capture/install-claude');

const TASK_NAME = schedule.TASK_NAME;

function display(ts) {
  return ts ? isoLocal(ts).slice(0, 16).replace('T', ' ') : 'never';
}

function hhmm(ts) {
  return ts ? isoLocal(ts).slice(11, 16) : '—';
}

function minutesSince(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? Math.round((Date.now() - t) / 60000) : null;
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function readStatusFile() {
  try { return readJson(cycle.statusPath(), null); } catch (_) { return null; }
}

function readLog(name) {
  return usage.readLog(name);
}

// Last `event: "repo"` line of each repo in cycles.jsonl (newest wins).
function lastRepoLines() {
  const byRepo = new Map();
  for (const obj of readLog('cycles')) {
    if (obj && obj.event === 'repo' && obj.repoId) byRepo.set(obj.repoId, obj);
  }
  return byRepo;
}

// Newest capture written by a Claude Code hook (not by the background sweep).
function lastHookEvent() {
  let last = null;
  for (const obj of readLog('capture')) {
    if (obj && obj.event && obj.event !== 'sweep' && obj.event !== 'unknown' && obj.repo) last = obj;
  }
  return last;
}

function taskRegistered() {
  const i = schedule.info();
  if (!i.supported) return { ok: false, detail: 'not Windows — use cron with `memo cycle` (memo schedule install prints the line)', info: i };
  if (!i.exists) return { ok: false, detail: 'task not found — run `memo schedule install`', info: i };
  if (i.pointsHere === false) return { ok: false, detail: 'task runs a different MEMO path — run `memo schedule install`', info: i };
  return { ok: true, detail: 'task registered (' + i.state + ')', info: i };
}

// Hooks present, and the memo.js they call still exists.
function claudeHooks() {
  const file = claudeSettingsPath();
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    return { ok: false, detail: err.code === 'ENOENT' ? 'no ' + fwd(file) : 'unreadable: ' + err.message };
  }
  const hooks = settings && settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const events = [];
  const targets = new Set();
  for (const e of Object.keys(hooks)) {
    for (const g of Array.isArray(hooks[e]) ? hooks[e] : []) {
      for (const h of g && Array.isArray(g.hooks) ? g.hooks : []) {
        if (!isMemoHandler(h)) continue;
        if (!events.includes(e)) events.push(e);
        // Exec form: memo.js is one of args. Shell form: a quoted (or bare) token in command.
        let target = Array.isArray(h.args) ? h.args.find((a) => /memo\.js$/i.test(String(a))) : null;
        if (!target) {
          const m = String(h.command || '').match(/"([^"]*memo\.js)"/) || String(h.command || '').match(/(\S*memo\.js)/);
          if (m) target = m[1];
        }
        if (target) targets.add(String(target).trim());
      }
    }
  }
  const missing = [...targets].filter((t) => !fs.existsSync(t));
  return {
    ok: events.length > 0,
    events,
    stale: missing,
    detail: events.length > 0 ? 'hooks on ' + events.join(', ') : 'no MEMO hooks'
  };
}

// Pending events of one repo and a chars/4 token estimate of what would be sent.
function pendingFor(repo) {
  const out = { sessions: 0, events: 0, tokens: 0 };
  let index = [];
  try { index = sessions.liveEntries(repo.root); } catch (_) { return out; }
  const { readSessionEvents } = require('./extract/process');
  for (const entry of index) {
    const left = (Number(entry.events) || 0) - (Number(entry.processedThrough) || 0);
    if (left <= 0) continue;
    out.sessions++;
    out.events += left;
    try {
      for (const e of readSessionEvents(repo.root, entry.date, entry.sid)) {
        if ((Number(e.seq) || 0) > (Number(entry.processedThrough) || 0)) out.tokens += usage.estimateTokens(JSON.stringify(e));
      }
    } catch (_) { /* unreadable session file */ }
  }
  return out;
}

// Job states of one repo from ~/.memo/state/<id>/jobs.json.
function jobsFor(repo) {
  const counts = { applied: 0, retrying: 0, parked: 0, lastError: null };
  let jobs = {};
  try { jobs = require('./extract/process').loadJobs(repo.id); } catch (_) { jobs = {}; }
  for (const j of Object.values(jobs)) {
    if (!j || typeof j !== 'object') continue;
    if (j.status === 'applied') counts.applied++;
    else if (j.status === 'failed_permanent' || j.status === 'failed_retryable') { counts.parked++; counts.lastError = j.lastError; }
    else if (j.status === 'pending' && j.lastError) { counts.retrying++; counts.lastError = j.lastError; }
  }
  return counts;
}

function lastProcessOk(repo) {
  try { return readJson(require('./extract/process').lastOkPath(repo.id), null); } catch (_) { return null; }
}

function repoRows() {
  const byRepo = lastRepoLines();
  return repos.load().map((repo) => {
    let live = [];
    let unprocessed = 0;
    let fresh = false;
    let recordCount = 0;
    try {
      live = sessions.liveEntries(repo.root);
      for (const e of live) unprocessed += Math.max(0, (Number(e.events) || 0) - (Number(e.processedThrough) || 0));
      fresh = fs.existsSync(path.join(repo.root, '.memory', 'PROJECT_STATE.md'));
      recordCount = records.byId(repo.root).size;
    } catch (_) { /* repo folder may be gone */ }
    const last = byRepo.get(repo.id) || null;
    return {
      id: repo.id,
      name: path.basename(repo.root),
      root: repo.root,
      enabled: repo.enabled !== false,
      exists: fs.existsSync(repo.root),
      sessions: live.length,
      captured: live.reduce((n, e) => n + (Number(e.events) || 0), 0),
      unprocessed,
      records: recordCount,
      state: fresh ? (unprocessed === 0 ? 'fresh' : 'behind') : 'missing',
      lastCommit: last && last.committed ? last.committed : null,
      lastStatus: last ? last.status : 'never run',
      lastTs: last ? last.ts : null
    };
  });
}

function limitsLine(cfg) {
  const seen = limits.get(cfg.provider, cfg.model);
  if (!seen) return null;
  const bits = [];
  if (seen.limitRequests !== undefined) {
    bits.push('requests ' + (seen.remainingRequests !== undefined ? fmtNum(seen.remainingRequests) + '/' : '') + fmtNum(seen.limitRequests) + ' left (per day)');
  }
  if (seen.limitTokens !== undefined) {
    bits.push('tokens ' + (seen.remainingTokens !== undefined ? fmtNum(seen.remainingTokens) + '/' : '') + fmtNum(seen.limitTokens) + ' left (per minute)');
  }
  if (bits.length === 0) return null;
  return 'Provider limits (as reported at ' + hhmm(seen.ts) + '): ' + bits.join(' · ');
}

function renderStatus(cfg = config.load()) {
  const st = readStatusFile();
  const task = taskRegistered();
  const key = config.keySource(cfg);
  const month = usage.monthTotals();
  const failed = usage.failures(usage.currentMonth());
  const lines = [];

  let head;
  if (task.ok) {
    const i = task.info;
    head = 'Scheduled (every ' + cfg.intervalMinutes + ' min' + (i.nextRun ? ', next ≈ ' + hhmm(i.nextRun) : '') +
      (i.lastRun ? ', last run ' + hhmm(i.lastRun) + ' ' + schedule.resultText(i.lastResult) : '') + ')';
  } else {
    head = 'Not scheduled (' + task.detail + ')';
  }
  lines.push('MEMO  ' + head + '   API: ' + cfg.provider + '/' + cfg.model + ' key ' +
    (key.source === 'none' ? 'MISSING' : key.source === 'mock' ? 'n/a (mock)' : key.source) + '   Paused: ' + (cfg.paused ? 'yes' : 'no'));

  const last = st && st.lastCycle ? st.lastCycle : null;
  const lastFail = st && st.lastFailed ? st.lastFailed : null;
  lines.push('Last cycle ' + (last ? display(last.ts) + ' ' + last.status + ' (' + last.ms + ' ms)' : 'never') +
    ' · last failure ' + (lastFail ? display(lastFail.ts) + ' ' + lastFail.reason : 'none'));

  const hooks = claudeHooks();
  const hook = lastHookEvent();
  lines.push('Capture: ' + (hooks.ok ? hooks.detail : 'Claude Code hooks NOT installed (memo setup claude)') +
    (hooks.stale && hooks.stale.length ? ' · STALE PATH ' + hooks.stale[0] : '') +
    ' · last hook event ' + (hook ? display(hook.ts) : 'never'));

  const rows = repoRows();
  let pendingEvents = 0;
  let pendingTokens = 0;
  let parked = 0;
  let retrying = 0;
  let lastOk = null;
  for (const repo of repos.load()) {
    const p = pendingFor(repo);
    pendingEvents += p.events;
    pendingTokens += p.tokens;
    const j = jobsFor(repo);
    parked += j.parked;
    retrying += j.retrying;
    const ok = lastProcessOk(repo);
    if (ok && !ok.mock && (!lastOk || ok.ts > lastOk)) lastOk = ok.ts;
  }
  const cool = limits.cooldown();
  lines.push('Processing: last success ' + (lastOk ? display(lastOk) : 'never') +
    ' · pending ' + fmtNum(pendingEvents) + ' events (≈ ' + fmtNum(pendingTokens) + ' tokens est.)' +
    (retrying ? ' · ' + retrying + ' job(s) retrying' : '') + (parked ? ' · ' + parked + ' job(s) parked' : '') +
    (cool ? ' · API paused until ' + display(cool.until) + ' (' + cool.kind + ')' : ''));

  lines.push('This month: ' + month.calls + ' calls · ' + (month.input / 1e6).toFixed(2) + 'M in / ' +
    (month.output / 1e6).toFixed(2) + 'M out · ≈ $' + month.costUsd.toFixed(2) +
    (month.costKnown ? '' : '+ (some models unpriced)') + ' estimated of $' + cfg.monthlyBudgetUsd + ' budget' +
    ' · ' + failed.total + ' failed attempts' + (month.mockCalls ? ' · ' + month.mockCalls + ' mock calls not counted' : ''));

  const lim = limitsLine(cfg);
  if (lim) lines.push(lim);

  lines.push('Repos:');
  if (rows.length === 0) lines.push('  (none registered — run `memo init` in a repo)');
  for (const r of rows.slice(0, 6)) {
    lines.push('  ' + r.name.padEnd(24) + ' sessions ' + r.sessions + ' · unprocessed ' + r.unprocessed +
      ' · records ' + r.records + ' · last commit ' + (r.lastCommit ? r.lastCommit + ' ' + hhmm(r.lastTs) : '—') +
      ' · state ' + r.state + (r.enabled ? '' : ' · disabled') + (r.exists ? '' : ' · FOLDER MISSING'));
  }
  if (rows.length > 6) lines.push('  … ' + (rows.length - 6) + ' more');
  lines.push('Logs: ' + fwd(logsDir()) + ' · details: memo usage · checks: memo doctor');
  return lines.join('\n') + '\n';
}

// `memo usage` — the numbers behind the status line, today and this month.
function renderUsage(cfg = config.load()) {
  const lines = [];
  const day = usage.dayTotals();
  const month = usage.monthTotals();
  const price = config.priceFor(cfg, cfg.model);
  const budget = usage.budgetState(cfg);
  const row = (label, t, f) => label.padEnd(12) + String(t.calls).padStart(6) + ' real calls · ' +
    fmtNum(t.input).padStart(10) + ' in · ' + fmtNum(t.output).padStart(9) + ' out · ≈ $' + t.costUsd.toFixed(4) +
    ' est. · ' + f.total + ' failed attempts' + (t.mockCalls ? ' · ' + t.mockCalls + ' mock' : '');
  lines.push('Provider     ' + cfg.provider + '/' + cfg.model + (price ? '  (price $' + price.inPerM + ' / $' + price.outPerM + ' per 1M in/out, from config)' : '  (no price configured — cost unknown)'));
  lines.push(row('today', day, usage.failures(usage.today())));
  lines.push(row('this month', month, usage.failures(usage.currentMonth())));
  const fk = usage.failures(usage.currentMonth()).byKind;
  if (Object.keys(fk).length) lines.push('failures     ' + Object.entries(fk).map(([k, n]) => k + ' ' + n).join(' · '));
  lines.push('budgets      monthly $' + cfg.monthlyBudgetUsd + ' (estimated cost)' +
    ' · daily tokens ' + (cfg.dailyTokenBudget > 0 ? fmtNum(budget.dayTokens) + ' of ' + fmtNum(cfg.dailyTokenBudget) : 'no cap') +
    (budget.reached ? ' · REACHED: ' + budget.reason : ''));
  lines.push('per call     input ≤ ' + fmtNum(limits.inputCap(cfg)) + ' tokens (configured ' + fmtNum(cfg.maxInputTokensPerCall) +
    ') · output ≤ ' + fmtNum(cfg.maxOutputTokens) + ' · ≤ ' + cfg.maxCallsPerCycle + ' calls per cycle');
  const lim = limitsLine(cfg);
  lines.push(lim || 'Provider limits: none reported yet (shown after the first real call; MEMO does not guess them)');
  const cool = limits.cooldown();
  if (cool) lines.push('API paused   until ' + display(cool.until) + ' — ' + cool.kind + ': ' + cool.reason);
  let pendingEvents = 0;
  let pendingTokens = 0;
  for (const repo of repos.load()) {
    const p = pendingFor(repo);
    pendingEvents += p.events;
    pendingTokens += p.tokens;
  }
  lines.push('pending      ' + fmtNum(pendingEvents) + ' captured events not yet extracted (≈ ' + fmtNum(pendingTokens) + ' input tokens, estimated chars/4)');
  return lines.join('\n') + '\n';
}

function nodeMajor() {
  return Number(String(process.versions.node).split('.')[0]) || 0;
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
  } catch (_) {
    return null;
  }
}

function gitIdentity(root) {
  for (const key of ['user.name', 'user.email']) {
    const v = run('git', ['-C', root, 'config', key]);
    if (!v) return false;
  }
  return true;
}

function onPath(name) {
  const out = run(process.platform === 'win32' ? 'where' : 'which', [name]);
  return out ? out.split(/\r?\n/)[0] : null;
}

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.memo-write-probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * One small real request. Used by `memo doctor --live`, `memo key set` and the installer.
 * @returns {{ok, detail, kind?, mock?}}
 */
async function ping(cfg = config.load()) {
  const provider = require('./llm/provider');
  if (cfg.provider !== 'mock' && !config.apiKey(cfg)) return { ok: false, kind: 'auth', detail: 'no API key — run `memo key set`' };
  try {
    const res = await provider.create(cfg).complete({
      system: 'You are a connectivity check. Reply with this JSON object only: {"ok": true}',
      user: 'ping', maxTokens: 300, json: true
    });
    const mock = cfg.provider === 'mock' || res.mock === true;
    usage.record({
      repoId: null, job: 'doctor', provider: cfg.provider, mock, model: res.model, in: res.usage.input, out: res.usage.output,
      costEst: mock ? 0 : usage.costOf(cfg, res.model, res.usage.input, res.usage.output)
    });
    if (!mock) limits.clearCooldown();
    return {
      ok: true, mock,
      detail: mock ? 'mock provider answered (no real API call was made)'
        : cfg.provider + '/' + res.model + ' answered · ' + res.usage.input + ' in / ' + res.usage.output + ' out tokens'
    };
  } catch (err) {
    const kind = err && err.kind ? err.kind : 'error';
    const why = kind === 'auth' ? 'the provider rejected the key'
      : kind === 'quota' ? 'the provider says credits/quota are exhausted'
        : kind === 'rate_limited' ? 'rate limited by the provider — try again later'
          : kind === 'bad_request' ? 'request refused — check the model id (memo config set model <id>)'
            : 'network or provider problem';
    return { ok: false, kind, detail: why + ' (' + kind + ': ' + (err && err.message) + ')' };
  }
}

/**
 * All doctor checks. Returns [{ok, level, name, detail, fix}]; level is pass | warn | fail.
 * @param {boolean} live also make one cheap provider call
 */
async function checks(cfg = config.load(), { live = false } = {}) {
  const out = [];
  const add = (ok, name, detail, fix, level) => out.push({
    ok, level: ok ? 'pass' : level || 'fail', name, detail, fix: ok ? null : fix || null
  });

  add(nodeMajor() >= 20, 'node', 'v' + process.versions.node, 'install Node 20+ (winget install OpenJS.NodeJS.LTS) or rerun setup_memo.bat');
  const git = run('git', ['--version']);
  add(Boolean(git), 'git', git || 'not found', 'install Git (winget install Git.Git) and reopen the terminal');
  add(writable(memoHome()), 'memo home', fwd(memoHome()), 'check folder permissions or set MEMO_HOME');
  const memoCmd = onPath('memo');
  const shimFile = path.join(require('./shim').shimDir(), 'memo.cmd');
  const shimOnly = !memoCmd && process.platform === 'win32' && fs.existsSync(shimFile);
  add(Boolean(memoCmd) || shimOnly, 'memo command', memoCmd ? fwd(memoCmd) : shimOnly ? fwd(shimFile) + ' (open a new terminal to use it)' : 'not on PATH',
    'rerun setup_memo.bat (`memo repair`), then open a new terminal', 'warn');
  const claude = onPath('claude');
  add(Boolean(claude), 'claude code', claude ? fwd(claude) : 'not found on PATH',
    'install Claude Code: https://docs.claude.com/en/docs/claude-code (setup_memo.bat can do it)', 'warn');

  const list = repos.load();
  add(list.length > 0, 'repos', list.length + ' registered', 'run `memo init` inside a project', 'warn');
  for (const repo of list) {
    if (!fs.existsSync(repo.root)) {
      add(false, 'repo ' + path.basename(repo.root), 'folder missing', 'remove it from ' + fwd(repos.registryPath()), 'warn');
      continue;
    }
    if (cfg.autoCommit) {
      add(gitIdentity(repo.root), 'identity ' + path.basename(repo.root), 'git user.name / user.email',
        'git -C "' + repo.root + '" config user.email you@example.com', 'warn');
    }
  }

  const hooks = claudeHooks();
  add(hooks.ok, 'claude hooks', hooks.detail, 'run `memo setup claude`');
  if (hooks.ok) {
    add(hooks.stale.length === 0, 'hook target', hooks.stale.length ? 'missing ' + hooks.stale.join(', ') : 'memo.js exists',
      'run `memo setup claude` (MEMO moved since the hooks were written)');
    const hook = lastHookEvent();
    add(Boolean(hook), 'hooks firing', hook ? 'last event ' + display(hook.ts) + ' (' + hook.event + ')' : 'no hook event recorded yet',
      'start a Claude Code session inside a repo where you ran `memo init`', 'warn');
  }

  const key = config.keySource(cfg);
  add(key.source !== 'none', 'api key', key.detail, 'run `memo key set`');
  if (cfg.provider !== 'mock') {
    add(Boolean(config.priceFor(cfg, cfg.model)), 'price', 'prices.' + cfg.model,
      'memo config set prices.' + cfg.model + '.inPerM <usd> (cost is shown as unknown until then)', 'warn');
  }
  add(cfg.paused !== true, 'paused', cfg.paused ? 'paused' : 'no', 'memo resume', 'warn');
  const cool = limits.cooldown();
  add(!cool, 'api cooldown', cool ? 'no calls until ' + display(cool.until) + ' (' + cool.kind + ': ' + cool.reason + ')' : 'none',
    cool && cool.kind === 'auth' ? 'run `memo key set` with a valid key' : 'wait; queued events are kept and processed after the pause', 'warn');

  const task = taskRegistered();
  add(task.ok, 'scheduled task', task.detail, 'run `memo schedule install`');
  if (task.ok && task.info.lastRun) {
    const code = task.info.lastResult;
    add(code === 0 || code === 267009 || code === 267011, 'task last result',
      schedule.resultText(code) + ' at ' + display(task.info.lastRun), 'see ~/.memo/logs/cycles.jsonl; run `memo cycle` by hand to see the error', 'warn');
  }

  const st = readStatusFile();
  const age = st && st.lastCycle ? minutesSince(st.lastCycle.ts) : null;
  add(age !== null && age <= Number(cfg.intervalMinutes) * 2 + 5, 'last cycle',
    age === null ? 'never ran' : age + ' min ago (' + st.lastCycle.status + ')',
    'run `memo cycle` once; if the task is registered, check that you stayed logged on', 'warn');

  let parked = 0;
  for (const repo of list) parked += jobsFor(repo).parked;
  add(parked === 0, 'parked jobs', parked + ' parked', 'they retry on their own after 6 h, or now: memo process --retry-failed', 'warn');

  if (live) {
    const p = await ping(cfg);
    add(p.ok, 'api ping', p.detail, 'check the key (memo key set), model id and network');
  }
  return out;
}

function renderDoctor(results) {
  const tag = { pass: 'PASS  ', warn: 'WARN  ', fail: 'FAIL  ' };
  const lines = results.map((r) => tag[r.level || (r.ok ? 'pass' : 'fail')] + r.name.padEnd(18) + ' ' + r.detail +
    (r.ok ? '' : '\n      fix: ' + r.fix));
  const failed = results.filter((r) => (r.level || (r.ok ? 'pass' : 'fail')) === 'fail').length;
  const warned = results.filter((r) => r.level === 'warn').length;
  lines.push(failed === 0
    ? 'all required checks passed (' + results.length + ' checks' + (warned ? ', ' + warned + ' warning(s)' : '') + ')'
    : failed + ' of ' + results.length + ' checks failed' + (warned ? ', ' + warned + ' warning(s)' : ''));
  return lines.join('\n') + '\n';
}

async function doctorCommand(argv = []) {
  const results = await checks(config.load(), { live: argv.includes('--live') });
  process.stdout.write(renderDoctor(results));
  if (results.some((r) => r.level === 'fail')) process.exitCode = 1;
  return results;
}

function statusCommand() {
  process.stdout.write(renderStatus());
}

function usageCommand() {
  process.stdout.write(renderUsage());
}

function pauseCommand(paused) {
  const { cfg, changed } = config.set('paused', paused ? 'true' : 'false');
  process.stdout.write((paused ? 'paused' : 'resumed') + (changed ? '' : ' (already)') +
    ' — the scheduled task stays registered; next cycle ' + (cfg.paused ? 'will do nothing' : 'runs normally') + '\n');
  return cfg;
}

module.exports = {
  statusCommand, usageCommand, doctorCommand, pauseCommand, renderStatus, renderUsage, renderDoctor, checks, ping,
  repoRows, lastRepoLines, lastHookEvent, pendingFor, jobsFor, taskRegistered, claudeHooks, display, TASK_NAME, memoBin
};
