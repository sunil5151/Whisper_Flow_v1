'use strict';

// `memo schedule install | remove | status` — the background worker.
// Windows: a per-user Task Scheduler task (no admin) running `memo cycle` every
// config.intervalMinutes, at logon, and as soon as possible after a missed run (sleep, shutdown).
// It runs only while you are logged on; nothing runs while the machine is off or asleep.
// Other platforms: print the cron line instead of installing anything.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { memoBin, memoHome } = require('./paths');
const config = require('./config');

const TASK_NAME = 'MEMO Background Processor';

function scriptsDir() {
  return path.join(__dirname, '..', 'scripts', 'windows');
}

function ps(args, { timeout = 60000, env = {} } = {}) {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8', windowsHide: true, timeout, env: { ...process.env, ...env }
  });
  return {
    ok: !res.error && res.status === 0,
    out: String(res.stdout || '').trim(),
    err: res.error ? res.error.message : String(res.stderr || '').trim()
  };
}

function taskName() {
  return process.env.MEMO_TASK_NAME || TASK_NAME;
}

// Removing the pre-installer worker task touches tasks outside MEMO's own name, so it only
// happens for the real task — never when MEMO_TASK_NAME points a test or dry run elsewhere.
function legacyArgs() {
  return taskName() === TASK_NAME ? ['-RemoveLegacy', '-BackupDir', path.join(memoHome(), 'backup')] : [];
}

// Registers or updates the task (never a duplicate) and removes the pre-installer "worker.cmd" task.
function install({ intervalMinutes = config.load().intervalMinutes } = {}) {
  if (process.platform !== 'win32') {
    return {
      ok: false, unsupported: true,
      detail: 'automatic scheduling is Windows-only in V1. Add this to `crontab -e`:\n  */' +
        intervalMinutes + ' * * * * "' + process.execPath + '" "' + path.resolve(memoBin()) + '" cycle --quiet'
    };
  }
  const res = ps(['-File', path.join(scriptsDir(), 'register-task.ps1'),
    '-NodeExe', process.execPath, '-MemoJs', path.resolve(memoBin()), '-TaskName', taskName(),
    '-IntervalMinutes', String(intervalMinutes), ...legacyArgs()]);
  return { ok: res.ok, detail: res.ok ? res.out : (res.out + '\n' + res.err).trim() };
}

function remove() {
  if (process.platform !== 'win32') return { ok: true, detail: 'nothing to remove (remove the cron line by hand if you added one)' };
  const res = ps(['-File', path.join(scriptsDir(), 'register-task.ps1'),
    '-NodeExe', process.execPath, '-MemoJs', path.resolve(memoBin()), '-TaskName', taskName(), '-Remove', ...legacyArgs()]);
  return { ok: res.ok, detail: res.ok ? res.out : (res.out + '\n' + res.err).trim() };
}

const INFO_PS = [
  // The name comes from the environment: as an argument PowerShell would split it at spaces.
  '$t = Get-ScheduledTask -TaskName $env:MEMO_INFO_TASK -ErrorAction SilentlyContinue;',
  'if (-not $t) { "{}" ; exit 0 }',
  '$i = $t | Get-ScheduledTaskInfo;',
  '$a = ($t.Actions | Select-Object -First 1);',
  '$fmt = { param($d) if ($d -and $d.Year -gt 2000) { $d.ToString("o") } else { $null } };',
  '[pscustomobject]@{ exists = $true; state = [string]$t.State; lastRun = (& $fmt $i.LastRunTime);',
  '  nextRun = (& $fmt $i.NextRunTime); lastResult = [int64]$i.LastTaskResult; missedRuns = [int]$i.NumberOfMissedRuns;',
  '  action = ([string]$a.Execute + " " + [string]$a.Arguments) } | ConvertTo-Json -Compress'
].join(' ');

/**
 * Task Scheduler's own view of the task.
 * @returns {{supported, exists, state?, lastRun?, nextRun?, lastResult?, action?, pointsHere?}}
 */
function info() {
  if (process.platform !== 'win32') return { supported: false, exists: false };
  if (process.env.MEMO_FAKE_TASK) {
    try { return { supported: true, ...JSON.parse(process.env.MEMO_FAKE_TASK) }; } catch (_) { /* fall through */ }
  }
  const res = ps(['-Command', INFO_PS], { timeout: 30000, env: { MEMO_INFO_TASK: taskName() } });
  let parsed = {};
  try { parsed = res.out ? JSON.parse(res.out) : {}; } catch (_) { parsed = {}; }
  const out = { supported: true, exists: Boolean(parsed.exists), ...parsed };
  if (out.action) out.pointsHere = out.action.toLowerCase().includes(path.resolve(memoBin()).toLowerCase());
  return out;
}

// 0 = success, 0x41301 = currently running, 0x41303 = has not run yet.
function resultText(code) {
  if (code === undefined || code === null) return 'unknown';
  const known = { 0: 'success', 267009: 'running now', 267011: 'not run yet', 3221225786: 'interrupted (Ctrl+C / logoff)' };
  return known[code] || '0x' + Number(code).toString(16);
}

function command(argv = []) {
  const sub = argv[0] || 'status';
  if (sub === 'install') {
    const res = install();
    process.stdout.write(res.detail + '\n');
    if (!res.ok && !res.unsupported) process.exitCode = 1;
    return res;
  }
  if (sub === 'remove') {
    const res = remove();
    process.stdout.write(res.detail + '\n');
    if (!res.ok) process.exitCode = 1;
    return res;
  }
  if (sub !== 'status') {
    process.stderr.write('usage: memo schedule [status | install | remove]\n');
    process.exitCode = 1;
    return null;
  }
  const i = info();
  if (!i.supported) process.stdout.write('not Windows — run `memo schedule install` for the cron line\n');
  else if (!i.exists) process.stdout.write('task "' + taskName() + '" not registered — run `memo schedule install`\n');
  else {
    process.stdout.write([
      'task       ' + taskName() + ' (' + i.state + ')',
      'last run   ' + (i.lastRun ? i.lastRun.slice(0, 16).replace('T', ' ') : 'never') + ' → ' + resultText(i.lastResult),
      'next run   ' + (i.nextRun ? i.nextRun.slice(0, 16).replace('T', ' ') : '—'),
      'runs       ' + (i.pointsHere ? 'this MEMO install' : 'ANOTHER path: ' + i.action + ' — run `memo schedule install`')
    ].join('\n') + '\n');
  }
  return i;
}

module.exports = { TASK_NAME, taskName, install, remove, info, resultText, command, scriptsDir };
