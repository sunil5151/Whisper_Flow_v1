'use strict';

// `memo context` — compact, factual project state for a new agent session (≤ 8,000 chars).
// Printed by the SessionStart path of `memo capture`; Claude Code adds stdout to context.

const fs = require('node:fs');
const path = require('node:path');
const { repoRoot } = require('./git');
const { memoryDir } = require('./paths');
const repos = require('./repos');
const state = require('./report/state');

const MAX_CHARS = 8000;

function buildContext(root, { maxChars = MAX_CHARS } = {}) {
  const { all, index } = state.loadState(root);
  const of = (type, statuses) => all.filter((r) => r.type === type && statuses.includes(r.status));
  const line = (r, extra = '') => '- ' + state.label(r) + extra + ' (' + r.id + ')';

  const sections = [
    ['Intent', of('intent', ['active']).sort(state.byTsDesc).slice(0, 5).map((r) => line(r))],
    ['Open tasks', of('task', state.OPEN_TASK).sort(state.byPriorityAge).slice(0, 10)
      .map((r) => line(r, ' — ' + r.status + (r.priority ? ', ' + r.priority : '')))],
    ['Open errors', of('error', state.OPEN_ERROR).sort(state.byTsDesc).slice(0, 10).map((r) => line(r, ' — ' + r.status))],
    ['Active decisions', of('decision', ['active']).sort(state.byTsDesc).slice(0, 10).map((r) => line(r))],
    ['Recent sessions', state.sessionsNewestFirst(index).filter((e) => e.summary).slice(0, 3)
      .map((e) => `- ${e.date} ${e.sid.slice(0, 8)}: ${state.oneLine(e.summary, 400)}`)]
  ];

  const head = `MEMO project memory for ${path.basename(path.resolve(root))} (${all.length} records, ${index.length} sessions).`;
  const tail = 'Full detail: .memory/PROJECT_STATE.md';
  let out = head + '\n';
  for (const [title, items] of sections) {
    if (items.length === 0) continue;
    const block = '\n' + title + ':\n';
    if (out.length + block.length + tail.length + 2 > maxChars) break;
    out += block;
    for (const item of items) {
      if (out.length + item.length + tail.length + 3 > maxChars) break;
      out += item + '\n';
    }
  }
  return out + '\n' + tail + '\n';
}

// Text for the current (or given) repo, or '' when the repo is not registered.
function contextFor(cwd) {
  let root;
  try { root = repoRoot(cwd); } catch (_) { return ''; }
  const repo = repos.find(root);
  if (!repo || repo.enabled === false) return '';
  if (!fs.existsSync(memoryDir(root))) return '';
  return buildContext(root);
}

function command() {
  process.stdout.write(contextFor(process.cwd()));
}

module.exports = { buildContext, contextFor, command, MAX_CHARS };
