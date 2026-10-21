'use strict';

// .memory/sessions/YYYY/MM/DD/<sid>.md — one header plus one paragraph per processed batch.
// Append-only: the job guard in extract/process.js is what keeps it from repeating.

const fs = require('node:fs');
const path = require('node:path');
const sessions = require('../store/sessions');
const { isoLocal } = require('../util');

function summaryPath(root, date, sid) {
  return sessions.sessionFile(root, date, sid).replace(/\.jsonl$/, '.md');
}

function header({ sid, date, agent, model, events }) {
  return [
    '# Session ' + String(sid).slice(0, 8) + ' — ' + date,
    '',
    'Session: `' + sid + '`  ',
    'Agent: ' + (agent || 'claude-code') + '  ',
    'Model: ' + (model || 'unknown') + '  ',
    'Events: ' + (events || 0),
    '',
    'Written by MEMO from the captured events of this session. Do not edit.',
    ''
  ].join('\n');
}

// Display time, local YYYY-MM-DD HH:MM (§7).
function displayTime(ts) {
  return isoLocal(ts).slice(0, 16).replace('T', ' ');
}

/**
 * Append one summary paragraph. Returns {path, written:boolean}.
 */
function appendSummary(root, { sid, date, agent, model, summary, from, to, job, recordIds = [], gaps = [] }) {
  const file = summaryPath(root, date, sid);
  const text = String(summary || '').trim();
  if (!text) return { path: file, written: false };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // Same job already written → leave the file byte-identical.
  if (job && existing.includes('job `' + job + '`')) return { path: file, written: false };

  const parts = [];
  if (!existing) parts.push(header({ sid, date, agent, model, events: to }));
  parts.push('## ' + displayTime() + ' · events ' + (Number(from) + 1) + '–' + to +
    (job ? ' · job `' + job + '`' : ''));
  parts.push('');
  parts.push(text);
  if (recordIds.length > 0) {
    parts.push('');
    parts.push('Records: ' + recordIds.map((id) => '`' + id + '`').join(', '));
  }
  if (gaps.length > 0) {
    parts.push('');
    parts.push('Gaps: ' + gaps.join('; '));
  }
  parts.push('');
  const block = parts.join('\n');
  fs.appendFileSync(file, (existing && !existing.endsWith('\n') ? '\n' : '') + block, 'utf8');
  return { path: file, written: true };
}

module.exports = { summaryPath, appendSummary, header, displayTime };
