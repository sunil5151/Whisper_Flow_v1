'use strict';

// `memo console` — numbered terminal menu over the same functions the CLI uses (P5).
// Rendering is pure (testable); only run() touches readline.

const readline = require('node:readline');
const path = require('node:path');

const { repoRoot } = require('../git');
const config = require('../config');
const status = require('../status');
const browse = require('../browse');
const del = require('../delete');
const cycle = require('../cycle');

const ITEMS = [
  ['1', 'Status'],
  ['2', 'Browse by date'],
  ['3', 'Tasks'],
  ['4', 'Clear data'],
  ['5', 'Pause / Resume'],
  ['6', 'Run cycle now'],
  ['0', 'Exit']
];

function renderMenu(cfg = config.load(), root = null) {
  const lines = ['', 'MEMO console' + (root ? '  —  ' + path.basename(root) : '') +
    (cfg.paused ? '   [PAUSED]' : '')];
  for (const [key, label] of ITEMS) lines.push('  ' + key + '  ' + label);
  return lines.join('\n') + '\n';
}

const CLEAR_MENU = [
  ['1', 'one session'],
  ['2', 'one whole date'],
  ['3', 'one record id'],
  ['0', 'back']
];

function renderClearMenu() {
  const lines = ['', 'Clear data — dry run first, nothing is deleted until you type DELETE'];
  for (const [key, label] of CLEAR_MENU) lines.push('  ' + key + '  ' + label);
  lines.push('  History note: ' + del.HISTORY_NOTE);
  return lines.join('\n') + '\n';
}

// Git history is never rewritten by MEMO; the menu says so instead of pretending.
function renderPurgeNote() {
  return 'MEMO never rewrites Git history. To erase data from old commits you would run\n' +
    '`git filter-repo` yourself and force-push — that rewrites every commit id and breaks clones.\n';
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(String(a || '').trim())));
}

async function clearFlow(rl, root, out) {
  out(renderClearMenu());
  const pick = await ask(rl, 'choice: ');
  if (pick === '0' || pick === '') return;
  let scope = null;
  let value = null;
  if (pick === '1') {
    out(browse.renderSessions(root));
    scope = 'session';
    value = await ask(rl, 'session id (8 chars is enough): ');
  } else if (pick === '2') {
    out(browse.renderDates(root));
    scope = 'date';
    value = await ask(rl, 'date (YYYY-MM-DD): ');
  } else if (pick === '3') {
    scope = 'record';
    value = await ask(rl, 'record id (e.g. T-1b2c3d4e): ');
  } else {
    out('unknown choice\n');
    return;
  }

  const withDerived = (await ask(rl, 'also delete records that come only from it? [y/N]: ')).toLowerCase() === 'y';
  const plan = del.planDelete(root, { scope, value, withDerived });
  out(del.renderPlan(plan));
  if (plan.error) return;
  if (scope === 'date') {
    const typed = await ask(rl, 'type the date again to confirm: ');
    if (typed !== value) { out('not confirmed — nothing deleted\n'); return; }
  }
  const confirm = await ask(rl, 'type DELETE to apply: ');
  if (confirm !== 'DELETE') { out('not confirmed — nothing deleted\n'); return; }
  const res = del.applyDelete(root, plan);
  out('deleted ' + res.filesDeleted + ' file(s), ' + res.recordsDeleted + ' record(s), stripped ' +
    res.recordsStripped + '\n' + (res.commit ? 'commit: ' + res.commit.status + (res.commit.hash ? ' ' + res.commit.hash : '') + '\n' : '') +
    res.note + '\n' + renderPurgeNote());
}

async function run({ input = process.stdin, output = process.stdout } = {}) {
  let root = null;
  try { root = repoRoot(process.cwd()); } catch (_) { root = null; }
  const out = (text) => output.write(text);
  if (!root) {
    out('not inside a git repo — cd into a repo that ran `memo init`\n');
    return 1;
  }
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const cfg = config.load();
      out(renderMenu(cfg, root));
      const choice = await ask(rl, 'choice: ');
      if (choice === '0' || choice === 'q' || choice === '') break;
      if (choice === '1') out(status.renderStatus(cfg));
      else if (choice === '2') {
        out(browse.renderDates(root));
        const date = await ask(rl, 'date (blank = all): ');
        out(browse.renderSessions(root, date || null));
        const sid = await ask(rl, 'session id to open (blank = back): ');
        if (sid) out(browse.renderShow(root, sid));
      } else if (choice === '3') out(browse.renderTasks(root, { all: false }));
      else if (choice === '4') await clearFlow(rl, root, out);
      else if (choice === '5') status.pauseCommand(!cfg.paused);
      else if (choice === '6') {
        out('running one cycle…\n');
        const res = await cycle.runCycle();
        out('cycle ' + res.status + ' in ' + res.ms + ' ms\n');
      } else out('unknown choice\n');
    }
  } finally {
    rl.close();
  }
  return 0;
}

module.exports = { run, renderMenu, renderClearMenu, renderPurgeNote, ITEMS, CLEAR_MENU };
