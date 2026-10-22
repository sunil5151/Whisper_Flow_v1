'use strict';

// `memo status`, `memo doctor`, `memo pause`, `memo resume` (P4).
// Everything here reads local state only; `memo doctor --live` is the one exception.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { memoHome, logsDir, claudeSettingsPath } = require('./paths');
const config = require('./config');
const repos = require('./repos');
const usage = require('./usage');
const sessions = require('./store/sessions');
const cycle = require('./cycle');
const { fwd, readJson, isoLocal } = require('./util');
const { isMemoHandler } = require('./capture/install-claude');

const TASK_NAME = 'MEMO Background Processor';
const FRESH_CYCLE_MIN = 30;

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

function readStatusFile() {
  try { return readJson(cycle.statusPath(), null); } catch (_) { return null; }
}

// Last `event: "repo"` line of each repo in cycles.jsonl (newest wins).
function lastRepoLines() {
  const byRepo = new Map();
  for (const file of [path.join(logsDir(), 'cycles.jsonl.1'), path.join(logsDir(), 'cycles.jsonl')]) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj && obj.event === 'repo' && obj.repoId) byRepo.set(obj.repoId, obj);
    }
  }
  return byRepo;
}

// Windows only: is the scheduled task registered?
function taskRegistered() {
  if (process.platform !== 'win32') return { ok: false, detail: 'not Windows — use cron with `memo cycle`' };
  try {
    execFileSync('schtasks', ['/query', '/tn', TASK_NAME], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, detail: 'task registered' };
  } catch (_) {
    return { ok: false, detail: 'task not found — run scripts/windows/install_memo.bat' };
  }
}

function claudeHooks() {
  const file = claudeSettingsPath();
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    return { ok: false, detail: err.code === 'ENOENT' ? 'no ' + fwd(file) : 'unreadable: ' + err.message };
  }
  const hooks = settings && settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const events = Object.keys(hooks).filter((e) => (Array.isArray(hooks[e]) ? hooks[e] : [])
    .some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isMemoHandler)));
  return { ok: events.length > 0, detail: events.length > 0 ? 'hooks on ' + events.join(', ') : 'no MEMO hooks' };
}

function repoRows() {
  const byRepo = lastRepoLines();
  return repos.load().map((repo) => {
    let live = [];
    let unprocessed = 0;
    let fresh = false;
    try {
      live = sessions.liveEntries(repo.root);
      for (const e of live) unprocessed += Math.max(0, (Number(e.events) || 0) - (Number(e.processedThrough) || 0));
      fresh = fs.existsSync(path.join(repo.root, '.memory', 'PROJECT_STATE.md'));
    } catch (_) { /* repo folder may be gone */ }
    const last = byRepo.get(repo.id) || null;
    return {
      id: repo.id,
      name: path.basename(repo.root),
      root: repo.root,
      enabled: repo.enabled !== false,
      exists: fs.existsSync(repo.root),
      sessions: live.length,
      unprocessed,
      state: fresh ? (unprocessed === 0 ? 'fresh' : 'behind') : 'missing',
      lastCommit: last && last.committed ? last.committed : null,
      lastStatus: last ? last.status : 'never run',
      lastTs: last ? last.ts : null
    };
  });
}

function renderStatus(cfg = config.load()) {
  const st = readStatusFile();
  const task = taskRegistered();
  const key = config.apiKey(cfg);
  const month = usage.monthTotals();
  const lines = [];

  const head = task.ok ? 'Running (task registered' + (st && st.nextExpected ? ', next ≈ ' + hhmm(st.nextExpected) : '') + ')'
    : 'Not scheduled (run install_memo.bat)';
  lines.push('MEMO  ' + head + '   API: ' + cfg.provider + '/' + cfg.model + ' key ' +
    (key ? 'set' : 'MISSING') + '   Paused: ' + (cfg.paused ? 'yes' : 'no'));

  const last = st && st.lastCycle ? st.lastCycle : null;
  const failed = st && st.lastFailed ? st.lastFailed : null;
  lines.push('Last cycle ' + (last ? display(last.ts) + ' ' + last.status + ' (' + last.ms + ' ms)' : 'never') +
    ' · last failure ' + (failed ? display(failed.ts) + ' ' + failed.reason : 'none'));
  lines.push('This month: ' + month.calls + ' calls · ' + (month.input / 1e6).toFixed(2) + 'M in / ' +
    (month.output / 1e6).toFixed(2) + 'M out · ≈ $' + month.costUsd.toFixed(2) +
    (month.costKnown ? '' : '+ (some models unpriced)') + ' of $' + cfg.monthlyBudgetUsd + ' budget');

  const rows = repoRows();
  lines.push('Repos:');
  if (rows.length === 0) lines.push('  (none registered — run `memo init` in a repo)');
  for (const r of rows.slice(0, 8)) {
    lines.push('  ' + r.name.padEnd(24) + ' sessions ' + r.sessions + ' · unprocessed ' + r.unprocessed +
      ' · last commit ' + (r.lastCommit ? r.lastCommit + ' ' + hhmm(r.lastTs) : '—') +
      ' · state ' + r.state + (r.enabled ? '' : ' · disabled') + (r.exists ? '' : ' · FOLDER MISSING'));
  }
  if (rows.length > 8) lines.push('  … ' + (rows.length - 8) + ' more');
  lines.push('Logs: ' + fwd(logsDir()));
  return lines.join('\n') + '\n';
}

function nodeMajor() {
  return Number(String(process.versions.node).split('.')[0]) || 0;
}

function gitVersion() {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch (_) {
    return null;
  }
}

function gitIdentity(root) {
  for (const key of ['user.name', 'user.email']) {
    try {
      const v = execFileSync('git', ['config', key], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
      if (!v) return false;
    } catch (_) { return false; }
  }
  return true;
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
 * All doctor checks. Returns [{ok, name, detail, fix}].
 * @param {boolean} live also make one cheap provider call
 */
async function checks(cfg = config.load(), { live = false } = {}) {
  const out = [];
  const add = (ok, name, detail, fix) => out.push({ ok, name, detail, fix: ok ? null : fix || null });

  add(nodeMajor() >= 20, 'node', 'v' + process.versions.node, 'install Node 20+ (winget install OpenJS.NodeJS.LTS)');
  const git = gitVersion();
  add(Boolean(git), 'git', git || 'not found', 'install Git and reopen the terminal');
  add(writable(memoHome()), 'memo home', fwd(memoHome()), 'check folder permissions or set MEMO_HOME');

  const list = repos.load();
  add(list.length > 0, 'repos', list.length + ' registered', 'run `memo init` inside a repo');
  for (const repo of list) {
    if (!fs.existsSync(repo.root)) {
      add(false, 'repo ' + path.basename(repo.root), 'folder missing', 'remove it from ' + fwd(repos.registryPath()));
      continue;
    }
    add(gitIdentity(repo.root), 'identity ' + path.basename(repo.root), 'git user.name / user.email',
      'git -C "' + repo.root + '" config user.email you@example.com');
  }

  const hooks = claudeHooks();
  add(hooks.ok, 'claude hooks', hooks.detail, 'run `memo setup claude`');

  const key = config.apiKey(cfg);
  add(Boolean(key), 'api key', config.keyEnvName(cfg) + ' → ' + config.maskKey(key),
    'setx ' + cfg.apiKeyEnv + ' "<your key>" then reopen the terminal');
  add(Boolean(config.priceFor(cfg, cfg.model)), 'price', 'prices.' + cfg.model,
    'memo config set prices.' + cfg.model + '.inPerM <usd>');
  add(cfg.paused !== true, 'paused', cfg.paused ? 'paused' : 'no', 'memo resume');

  const task = taskRegistered();
  add(task.ok, 'scheduled task', task.detail, 'run scripts/windows/install_memo.bat');

  const st = readStatusFile();
  const age = st && st.lastCycle ? minutesSince(st.lastCycle.ts) : null;
  add(age !== null && age <= FRESH_CYCLE_MIN, 'last cycle',
    age === null ? 'never ran' : age + ' min ago (' + st.lastCycle.status + ')', 'run `memo cycle` once');

  if (live) {
    if (!key) add(false, 'api ping', 'skipped — no key', 'set the key first');
    else {
      const provider = require('./llm/provider');
      try {
        const res = await provider.create(cfg).complete({
          system: 'Reply with the single word: ok',
          user: 'ping', maxTokens: 8
        });
        usage.record({ repoId: null, job: 'doctor', model: res.model, in: res.usage.input, out: res.usage.output,
          costEst: usage.costOf(cfg, res.model, res.usage.input, res.usage.output) });
        add(true, 'api ping', cfg.provider + '/' + res.model + ' answered');
      } catch (err) {
        add(false, 'api ping', (err && err.kind ? err.kind + ': ' : '') + (err && err.message), 'check key, model name and network');
      }
    }
  }
  return out;
}

function renderDoctor(results) {
  const lines = results.map((r) => (r.ok ? 'PASS  ' : 'FAIL  ') + r.name.padEnd(22) + ' ' + r.detail +
    (r.ok ? '' : '\n      fix: ' + r.fix));
  const failed = results.filter((r) => !r.ok).length;
  lines.push(failed === 0 ? 'all ' + results.length + ' checks passed' : failed + ' of ' + results.length + ' checks failed');
  return lines.join('\n') + '\n';
}

async function doctorCommand(argv = []) {
  const results = await checks(config.load(), { live: argv.includes('--live') });
  process.stdout.write(renderDoctor(results));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
  return results;
}

function statusCommand() {
  process.stdout.write(renderStatus());
}

function pauseCommand(paused) {
  const { cfg, changed } = config.set('paused', paused ? 'true' : 'false');
  process.stdout.write((paused ? 'paused' : 'resumed') + (changed ? '' : ' (already)') +
    ' — the scheduled task stays registered; next cycle ' + (cfg.paused ? 'will do nothing' : 'runs normally') + '\n');
  return cfg;
}

module.exports = {
  statusCommand, doctorCommand, pauseCommand, renderStatus, renderDoctor, checks,
  repoRows, lastRepoLines, taskRegistered, claudeHooks, display, TASK_NAME
};
