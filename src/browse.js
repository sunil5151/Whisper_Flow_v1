'use strict';

// `memo sessions`, `memo show`, `memo tasks` — read-only views of .memory/ (P5).
// Pure renderers so the menu and the CLI print exactly the same screens.

const fs = require('node:fs');
const path = require('node:path');

const { repoRoot } = require('./git');
const sessions = require('./store/sessions');
const records = require('./store/records');
const state = require('./report/state');
const { classifyRecords } = require('./delete');
const { fwd } = require('./util');

function bytesOf(file) {
  try { return fs.statSync(file).size; } catch (_) { return 0; }
}

function sessionBytes(root, entry) {
  return bytesOf(sessions.sessionFile(root, entry.date, entry.sid)) +
    bytesOf(sessions.summaryFile(root, entry.date, entry.sid));
}

function kb(n) {
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

// Dates that have sessions, newest first.
function listDates(root) {
  const byDate = new Map();
  for (const e of sessions.liveEntries(root)) {
    const row = byDate.get(e.date) || { date: e.date, sessions: 0, events: 0, bytes: 0 };
    row.sessions++;
    row.events += Number(e.events) || 0;
    row.bytes += sessionBytes(root, e);
    byDate.set(e.date, row);
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function listSessions(root, date) {
  return sessions.liveEntries(root)
    .filter((e) => !date || e.date === date)
    .sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));
}

function renderDates(root) {
  const rows = listDates(root);
  const lines = ['Dates with captured sessions'];
  if (rows.length === 0) lines.push('  (none yet)');
  for (const r of rows.slice(0, 20)) {
    lines.push('  ' + r.date + '   ' + String(r.sessions).padStart(3) + ' session(s) · ' +
      String(r.events).padStart(5) + ' events · ' + kb(r.bytes));
  }
  if (rows.length > 20) lines.push('  … ' + (rows.length - 20) + ' more');
  return lines.join('\n') + '\n';
}

function renderSessions(root, date) {
  const rows = listSessions(root, date);
  const lines = ['Sessions' + (date ? ' on ' + date : '')];
  if (rows.length === 0) lines.push('  (none)');
  for (const e of rows.slice(0, 25)) {
    const events = Number(e.events) || 0;
    const done = Number(e.processedThrough) || 0;
    lines.push('  ' + String(e.start || '').slice(11, 16).padEnd(5) + ' · ' + e.sid.slice(0, 8) + ' · ' +
      String(e.agent || 'claude-code').padEnd(11) + ' · ' + String(events).padStart(4) + ' events · ' +
      (done >= events ? 'processed' : done + '/' + events).padEnd(9) + ' · ' + state.oneLine(e.summary || '', 60));
  }
  if (rows.length > 25) lines.push('  … ' + (rows.length - 25) + ' more');
  return lines.join('\n') + '\n';
}

// Summary text, file paths and the records this session produced.
function renderShow(root, wanted) {
  const found = sessions.resolveSid(root, String(wanted || ''));
  if (found.error) return found.error + '\n';
  const e = found.entry;
  const jsonl = sessions.sessionFile(root, e.date, e.sid);
  const md = sessions.summaryFile(root, e.date, e.sid);
  const eventIds = new Set(sessions.readEventIds(jsonl));
  const { only, mixed } = classifyRecords(root, { sids: [e.sid], eventIds });

  const lines = [
    'Session ' + e.sid.slice(0, 8) + ' · ' + e.date + ' · ' + (e.agent || 'claude-code'),
    'events ' + (Number(e.events) || 0) + ' · processed ' + (Number(e.processedThrough) || 0) +
      ' · status ' + (e.status || 'unknown') + ' · ' + kb(sessionBytes(root, e)),
    'events file  ' + fwd(path.relative(root, jsonl)),
    'summary file ' + fwd(path.relative(root, md)) + (fs.existsSync(md) ? '' : ' (not written yet)'),
    ''
  ];
  let summary = '';
  try { summary = fs.readFileSync(md, 'utf8'); } catch (_) { summary = ''; }
  if (summary) lines.push(summary.trimEnd(), '');
  else lines.push(e.summary ? e.summary : '(no summary yet — run `memo process`)', '');

  lines.push('Records from this session only (' + only.length + ')');
  for (const r of only) lines.push('  - ' + r.id + ' ' + r.type + ' · ' + r.label);
  if (only.length === 0) lines.push('  (none)');
  lines.push('Records that also cite other sources (' + mixed.length + ')');
  for (const r of mixed) lines.push('  - ' + r.id + ' ' + r.type + ' · ' + r.label);
  if (mixed.length === 0) lines.push('  (none)');
  return lines.join('\n') + '\n';
}

const OPEN = ['open', 'in_progress', 'blocked'];

function renderTasks(root, { all = false } = {}) {
  const tasks = records.foldAll(root).filter((r) => r.type === 'task');
  const shown = (all ? tasks : tasks.filter((t) => OPEN.includes(t.status) || t.status === 'implemented_unverified'))
    .sort(state.byPriorityAge);
  const lines = ['Tasks' + (all ? ' (all)' : ' (open, in progress, blocked, implemented but unverified)')];
  if (shown.length === 0) lines.push('  (none)');
  for (const t of shown.slice(0, 40)) {
    lines.push('  ' + t.id + ' · ' + String(t.priority || 'unranked').padEnd(8) + ' · ' +
      String(t.status).padEnd(22) + ' · ' + String(t.effort_estimate || '?').padEnd(6) + ' · ' + state.label(t));
  }
  if (shown.length > 40) lines.push('  … ' + (shown.length - 40) + ' more');
  lines.push('Full table: .memory/TASKS.md');
  return lines.join('\n') + '\n';
}

function currentRoot(argv = []) {
  const i = argv.indexOf('--repo');
  return repoRoot(i !== -1 && argv[i + 1] ? path.resolve(argv[i + 1]) : process.cwd());
}

function sessionsCommand(argv = []) {
  const root = currentRoot(argv);
  const i = argv.indexOf('--date');
  const date = i !== -1 ? argv[i + 1] : null;
  process.stdout.write(date ? renderSessions(root, date) : renderDates(root));
}

function showCommand(argv = []) {
  const root = currentRoot(argv);
  const sid = argv.find((a) => !a.startsWith('--'));
  if (!sid) throw new Error('usage: memo show <sid8|sid>');
  process.stdout.write(renderShow(root, sid));
}

function tasksCommand(argv = []) {
  process.stdout.write(renderTasks(currentRoot(argv), { all: argv.includes('--all') }));
}

module.exports = {
  listDates, listSessions, renderDates, renderSessions, renderShow, renderTasks,
  sessionsCommand, showCommand, tasksCommand, currentRoot
};
