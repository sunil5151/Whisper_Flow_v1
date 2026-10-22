'use strict';

// .memory/PROJECT_STATE.md — deterministic render of records + session index (P3).
// If the body is unchanged, the previous header line is kept so no noise diff appears.

const fs = require('node:fs');
const path = require('node:path');
const { memoryDir, logsDir } = require('../paths');
const records = require('../store/records');
const sessions = require('../store/sessions');
const { writeFileAtomic, isoLocal } = require('../util');

const MAX_LINES = 250;
const SECTION_MAX = 20;
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2, unranked: 3 };
const OPEN_TASK = ['open', 'in_progress', 'blocked'];
const OPEN_ERROR = ['observed', 'investigating', 'attempted', 'reopened'];
const DAY_MS = 24 * 60 * 60 * 1000;

function display(ts) {
  return ts ? isoLocal(ts).slice(0, 16).replace('T', ' ') : 'n/a';
}

function oneLine(text, max = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function byTsDesc(a, b) {
  return String(b.ts || '').localeCompare(String(a.ts || '')) || String(a.id).localeCompare(String(b.id));
}

// Open tasks: priority first, then oldest first.
function byPriorityAge(a, b) {
  const pa = PRIORITY_ORDER[a.priority] ?? 3;
  const pb = PRIORITY_ORDER[b.priority] ?? 3;
  return pa - pb || String(a.ts || '').localeCompare(String(b.ts || '')) || String(a.id).localeCompare(String(b.id));
}

function label(rec) {
  return oneLine(rec.type === 'task' && rec.title ? rec.title : rec.statement);
}

function evidenceText(rec) {
  const ev = Array.isArray(rec.evidence) ? rec.evidence.slice(0, 5) : [];
  return ev.length ? ' · evidence ' + ev.join(', ') : '';
}

function sessionLink(entry) {
  const rel = path.relative(memoryDir('.'), sessions.sessionFile('.', entry.date, entry.sid));
  return rel.replace(/\\/g, '/').replace(/\.jsonl$/, '.md');
}

function sessionsNewestFirst(index) {
  return index.slice().sort((a, b) => String(b.end || b.start || '').localeCompare(String(a.end || a.start || '')));
}

// Collect everything the reports need in one pass.
function loadState(root) {
  const all = records.foldAll(root);
  // Tombstones (`memo clear`) stay in index.json to block re-capture, but are never reported.
  const index = sessions.liveEntries(root);
  return { all, index };
}

function taskLine(t) {
  const parts = [label(t), t.status, t.effort_estimate || '?', t.capability || '?', '`' + t.id + '`'];
  if (t.downgraded) parts.splice(2, 0, 'downgraded');
  return '- ' + parts.join(' · ');
}

function recLine(rec, extra = '') {
  return '- ' + label(rec) + extra + ' · `' + rec.id + '`';
}

function buildSections(state, now) {
  const { all, index } = state;
  const of = (type, statuses) => all.filter((r) => r.type === type && (!statuses || statuses.includes(r.status)));
  const sorted = sessionsNewestFirst(index);

  const intent = of('intent', ['active']).sort(byTsDesc).map((r) => recLine(r));
  const status = sorted.filter((e) => e.summary).slice(0, 5)
    .map((e) => `- ${e.date} · ${e.sid.slice(0, 8)} · ${oneLine(e.summary, 240)} · [summary](${sessionLink(e)})`);
  const openTasks = of('task', OPEN_TASK).sort(byPriorityAge).map(taskLine);
  const blockers = [
    ...of('task', ['blocked']).sort(byTsDesc).map((r) => recLine(r, ' · task blocked' +
      (Array.isArray(r.blockers) && r.blockers.length ? ': ' + oneLine(r.blockers.join('; '), 120) : ''))),
    ...of('error', OPEN_ERROR).sort(byTsDesc).map((r) => recLine(r, ' · ' + r.status))
  ];
  const decisions = of('decision', ['active']).sort(byTsDesc)
    .map((r) => recLine(r, r.rationale ? ' — ' + oneLine(r.rationale, 160) : ''));
  const verified = [...of('error', ['verified']), ...of('task', ['verified'])].sort(byTsDesc)
    .map((r) => recLine(r, evidenceText(r)));
  const unverified = [...of('error', ['resolved_unverified']), ...of('task', ['implemented_unverified'])].sort(byTsDesc)
    .map((r) => recLine(r, ' · ' + r.status + (r.downgraded ? ' (downgraded)' : '')));
  const learnings = [...of('learning', ['active', 'unverified']), ...of('fact', ['active', 'unverified'])].sort(byTsDesc)
    .map((r) => recLine(r, r.status === 'unverified' ? ' · unverified' : ''));
  const questions = of('question', ['open']).sort(byTsDesc).map((r) => recLine(r));
  const cutoff = now.getTime() - 14 * DAY_MS;
  const completed = [...of('task', ['done']), ...of('question', ['answered'])]
    .filter((r) => Date.parse(r.ts) >= cutoff).sort(byTsDesc).map((r) => recLine(r, ' · ' + r.status));
  const sessionList = sorted.map((e) => `- ${e.date} · ${e.sid.slice(0, 8)} · ${e.events || 0} events` +
    (e.summary ? ` · [summary](${sessionLink(e)})` : ''));

  return [
    ['Intent', intent],
    ['Status', status],
    ['Open tasks', openTasks],
    ['Blockers & open errors', blockers],
    ['Active decisions', decisions],
    ['Verified fixes', verified],
    ['Implemented, not verified', unverified],
    ['Learnings & constraints', learnings],
    ['Open questions', questions],
    ['Recently completed (14 days)', completed],
    ['Sessions', sessionList]
  ];
}

function assembleBody(sections, cap) {
  const lines = [];
  for (const [title, items] of sections) {
    lines.push('## ' + title);
    const shown = items.slice(0, cap);
    if (shown.length === 0) lines.push('(none)');
    else lines.push(...shown);
    if (items.length > shown.length) lines.push(`- … ${items.length - shown.length} more`);
    lines.push('');
  }
  lines.push('## How to read this folder → .memory/README.md');
  return lines;
}

function lastProcessedTs(root, index) {
  let best = '';
  for (const e of index) {
    const through = Number(e.processedThrough) || 0;
    if (through <= 0) continue;
    let ts = '';
    if (through >= (Number(e.events) || 0)) ts = e.end || '';
    else {
      try {
        const raw = fs.readFileSync(sessions.sessionFile(root, e.date, e.sid), 'utf8');
        for (const line of raw.split('\n')) {
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.seq === through) { ts = ev.ts; break; }
          } catch (_) { /* torn line */ }
        }
      } catch (_) { /* missing file */ }
    }
    if (ts && ts > best) best = ts;
  }
  return best;
}

function lastCycle() {
  try {
    const lines = fs.readFileSync(path.join(logsDir(), 'cycles.jsonl'), 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    return `${last.status === 'ok' ? 'ok' : 'failed'} ${display(last.ts)}`;
  } catch (_) {
    return 'never';
  }
}

function headerLine(root, state, now) {
  const unprocessed = state.index.reduce((n, e) => n + Math.max(0, (Number(e.events) || 0) - (Number(e.processedThrough) || 0)), 0);
  const lp = lastProcessedTs(root, state.index);
  return `Generated: ${display(now)} · Last processed event: ${lp ? display(lp) : 'none'} · ` +
    `Unprocessed events: ${unprocessed} · Last cycle: ${lastCycle()}`;
}

/**
 * Render PROJECT_STATE.md text. Line 2 is the header; everything else is the body.
 */
function renderState(root, { now = new Date(), state = loadState(root) } = {}) {
  const title = '# Project state — ' + path.basename(path.resolve(root));
  const note = '> Generated by MEMO from .memory/records. Do not edit; corrections: `memo note` or `memo clear --record`.';
  const sections = buildSections(state, now);
  let cap = SECTION_MAX;
  let body = assembleBody(sections, cap);
  while (body.length + 4 > MAX_LINES && cap > 1) {
    cap--;
    body = assembleBody(sections, cap);
  }
  return [title, headerLine(root, state, now), note, '', ...body].join('\n') + '\n';
}

// Write a generated file, keeping the old header line when the body did not change.
function writeKeepingHeader(file, text) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch (_) { /* first write */ }
  const strip = (s) => s.split('\n').filter((_, i) => i !== 1).join('\n');
  if (old !== null && strip(old) === strip(text)) return false;
  writeFileAtomic(file, text);
  return true;
}

function statePath(root) {
  return path.join(memoryDir(root), 'PROJECT_STATE.md');
}

function writeState(root, opts = {}) {
  return writeKeepingHeader(statePath(root), renderState(root, opts));
}

module.exports = {
  renderState, writeState, display, writeKeepingHeader, statePath, loadState, buildSections,
  sessionsNewestFirst, sessionLink, label, oneLine, byPriorityAge, byTsDesc, OPEN_TASK, OPEN_ERROR
};
