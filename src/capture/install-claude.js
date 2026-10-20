'use strict';

// `memo setup claude` — merge MEMO capture hooks into ~/.claude/settings.json.
// Backs up first, never touches other hooks, idempotent, aborts on invalid JSON.

const fs = require('node:fs');
const { claudeSettingsPath, memoBin } = require('../paths');
const { fwd, writeFileAtomic } = require('../util');

const EVENTS = {
  SessionStart: { timeout: 10 },
  Stop: { async: true },
  PreCompact: { async: true },
  SessionEnd: { timeout: 5 }
};

function memoHandler(event, { shellForm = false } = {}) {
  const node = fwd(process.execPath);
  const bin = fwd(require('node:path').resolve(memoBin()));
  const h = shellForm
    ? { type: 'command', command: `"${node}" "${bin}" capture` }
    : { type: 'command', command: node, args: [bin, 'capture'] };
  return { ...h, ...EVENTS[event] };
}

function isMemoHandler(h) {
  if (!h || typeof h !== 'object' || h.type !== 'command') return false;
  const joined = `${h.command || ''} ${Array.isArray(h.args) ? h.args.join(' ') : ''}`;
  return /memo\.js/.test(joined) && /\bcapture\b/.test(joined);
}

function readSettings(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, settings: {} };
    throw err;
  }
  if (!raw.trim()) return { exists: true, settings: {} };
  let settings;
  try { settings = JSON.parse(raw); } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}). Nothing changed. Fix the file and rerun.`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${file} must contain a JSON object. Nothing changed.`);
  }
  return { exists: true, settings };
}

function sameHandler(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Pure: returns { settings, report: [[status, event]] }
function addHooks(settings, opts = {}) {
  const next = JSON.parse(JSON.stringify(settings));
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) next.hooks = {};
  const report = [];
  for (const event of Object.keys(EVENTS)) {
    const want = memoHandler(event, opts);
    if (!Array.isArray(next.hooks[event])) next.hooks[event] = [];
    const groups = next.hooks[event];
    let found = null;
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      const i = g.hooks.findIndex(isMemoHandler);
      if (i >= 0) { found = { g, i }; break; }
    }
    if (!found) {
      groups.push({ hooks: [want] });
      report.push(['created', event]);
    } else if (sameHandler(found.g.hooks[found.i], want)) {
      report.push(['skipped', event]);
    } else {
      found.g.hooks[found.i] = want;
      report.push(['updated', event]);
    }
  }
  return { settings: next, report };
}

function removeHooks(settings) {
  const next = JSON.parse(JSON.stringify(settings));
  const report = [];
  if (!next.hooks || typeof next.hooks !== 'object') return { settings: next, report };
  for (const event of Object.keys(next.hooks)) {
    const groups = next.hooks[event];
    if (!Array.isArray(groups)) continue;
    let removed = 0;
    const kept = [];
    for (const g of groups) {
      if (g && Array.isArray(g.hooks)) {
        const before = g.hooks.length;
        g.hooks = g.hooks.filter((h) => !isMemoHandler(h));
        removed += before - g.hooks.length;
        if (g.hooks.length === 0 && before > 0) continue;
      }
      kept.push(g);
    }
    if (removed > 0) {
      report.push(['removed', event]);
      if (kept.length === 0) delete next.hooks[event];
      else next.hooks[event] = kept;
    }
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, report };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function setupClaude(argv = []) {
  const dryRun = argv.includes('--dry-run');
  const remove = argv.includes('--remove');
  const shellForm = argv.includes('--shell-form');
  const file = claudeSettingsPath();
  const { exists, settings } = readSettings(file);
  const { settings: next, report } = remove ? removeHooks(settings) : addHooks(settings, { shellForm });
  const changed = JSON.stringify(next) !== JSON.stringify(settings);

  for (const [status, event] of report) console.log(`${dryRun && status !== 'skipped' ? `would ${status}` : status}  ${event}`);
  if (remove && report.length === 0) console.log('nothing to remove');
  if (!changed) {
    console.log(`unchanged  ${fwd(file)}`);
    return { changed: false, report };
  }
  if (dryRun) {
    console.log(`dry run: ${fwd(file)} not written`);
    return { changed: false, report };
  }
  let backup = null;
  if (exists) {
    backup = `${file}.memo-backup-${stamp()}`;
    fs.copyFileSync(file, backup);
    console.log(`backup   ${fwd(backup)}`);
  }
  writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n');
  console.log(`written  ${fwd(file)}`);
  return { changed: true, report, backup };
}

module.exports = { setupClaude, addHooks, removeHooks, isMemoHandler, memoHandler, EVENTS };
