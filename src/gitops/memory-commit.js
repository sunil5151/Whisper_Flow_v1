'use strict';

// `memo commit` — commit only .memory/ (plan §3 #14, P3), plus an agent instruction file
// (AGENTS.md, …) when its only change against HEAD is inside the generated memo block.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { repoRoot } = require('../git');
const config = require('../config');
const { log } = require('../log');
const { localDate } = require('../util');
const { findSecrets } = require('../redact');
const agentFiles = require('../report/agents');

const BUSY_MARKERS = ['index.lock', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'];

function git(root, args, env) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env
  }).trim();
}

function gitDir(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-dir']));
}

function identityMissing(root) {
  for (const key of ['user.name', 'user.email']) {
    try { if (!git(root, ['config', key])) return true; } catch (_) { return true; }
  }
  return false;
}

// Session ids touched by the staged .memory diff.
function describe(files) {
  const sids = new Set();
  for (const f of files) {
    const m = /^\.memory\/sessions\/\d{4}\/\d{2}\/\d{2}\/([^/]+)\.(jsonl|md)$/.exec(f);
    if (m) sids.add(m[1]);
  }
  return { sids: [...sids].sort() };
}

function countRecordLines(root) {
  // Added lines in record files of the staged diff = record changes.
  const out = git(root, ['diff', '--cached', '--numstat', '--', '.memory/records']);
  return out ? out.split('\n').reduce((n, l) => n + (Number(l.split('\t')[0]) || 0), 0) : 0;
}

function message(root, files) {
  const { sids } = describe(files);
  const m = countRecordLines(root);
  let msg = `memo: archive ${sids.length} session(s), ${m} record change(s) — ${localDate()}`;
  if (sids.length === 1) msg += ` (${sids[0].slice(0, 8)})`;
  return msg;
}

// Tracked agent files whose working-tree change is confined to the memo block.
function blockOnlyFiles(root) {
  return agentFiles.AGENT_FILES.filter((rel) => {
    let current;
    try { current = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return false; }
    let head;
    try { head = git(root, ['show', 'HEAD:' + rel]); } catch (_) { return false; }
    return current.replace(/\r\n?/g, '\n').trim() !== head.replace(/\r\n?/g, '\n').trim() &&
      agentFiles.sameOutsideBlock(current, head);
  });
}

/**
 * @returns {{status: 'committed'|'no_changes'|'disabled'|'git_busy'|'no_identity', hash?, message?}}
 */
function commitMemory(root, { cfg = config.load(), message: custom = null } = {}) {
  if (cfg.autoCommit === false) return { status: 'disabled' };
  const gd = gitDir(root);
  const busy = BUSY_MARKERS.find((m) => fs.existsSync(path.join(gd, m)));
  if (busy) {
    log('commit', { root: path.basename(root), status: 'git_busy', marker: busy });
    return { status: 'git_busy', marker: busy };
  }
  const paths = ['.memory', ...blockOnlyFiles(root)];
  if (!git(root, ['status', '--porcelain', '--', ...paths])) return { status: 'no_changes' };
  if (identityMissing(root)) {
    log('commit', { root: path.basename(root), status: 'no_identity' });
    return { status: 'no_identity' };
  }
  git(root, ['add', '-A', '--', ...paths]);
  const files = git(root, ['diff', '--cached', '--name-only', '--', ...paths]).split('\n').filter(Boolean);
  if (files.length === 0) return { status: 'no_changes' };
  // Last line of defence: redaction runs at capture, but never commit a recognisable credential.
  const added = git(root, ['diff', '--cached', '-U0', '--no-color', '--', ...paths]).split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  const found = findSecrets(added);
  if (found.length > 0) {
    git(root, ['reset', '-q', '--', ...paths]);
    log('commit', { root: path.basename(root), status: 'secret_blocked', formats: found });
    return { status: 'secret_blocked', formats: found };
  }
  const msg = custom || message(root, files);
  git(root, ['commit', '--no-verify', '--only', '-q', '-m', msg, '--', ...paths], { MEMO_INTERNAL_COMMIT: '1' });
  const hash = git(root, ['rev-parse', '--short', 'HEAD']);
  log('commit', { root: path.basename(root), status: 'committed', hash, files: files.length });
  return { status: 'committed', hash, message: msg, files: files.length };
}

function command(argv = []) {
  const flag = argv.indexOf('--repo');
  const root = repoRoot(flag !== -1 && argv[flag + 1] ? path.resolve(argv[flag + 1]) : process.cwd());
  const res = commitMemory(root);
  if (res.status === 'committed') console.log(`committed ${res.hash}  ${res.message}`);
  else if (res.status === 'no_changes') console.log('no changes in .memory/');
  else if (res.status === 'disabled') console.log('autoCommit is false — nothing committed');
  else if (res.status === 'git_busy') console.log(`git is busy (${res.marker}) — try again later`);
  else if (res.status === 'secret_blocked') {
    console.error('NOT committed: .memory/ changes contain what looks like a credential (' + res.formats.join(', ') +
      '). Find it with `git diff -- .memory`, remove it (memo clear --session <sid>), and rotate that key.');
    process.exitCode = 1;
  }
  else if (res.status === 'no_identity') {
    console.error('git user.name/user.email not set — MEMO will not set them for you');
    process.exitCode = 1;
  }
  return res;
}

module.exports = { commitMemory, command, describe, blockOnlyFiles, BUSY_MARKERS };
