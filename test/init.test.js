'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const MEMO = path.join(__dirname, '..', 'bin', 'memo.js');
const HAS_GIT = !spawnSync('git', ['--version'], { windowsHide: true }).error;

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-init-test-'));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const gitConfig = path.join(base, 'gitconfig');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  fs.writeFileSync(gitConfig, '[user]\n\tname = MEMO Test\n\temail = memo@test.invalid\n[commit]\n\tgpgsign = false\n');
  const env = {
    ...process.env,
    MEMO_HOME: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1'
  };
  delete env.MEMO_INTERNAL_COMMIT;
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const git = (args, extraEnv = {}) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true, env: { ...env, ...extraEnv }
  });
  const memo = (args) => execFileSync(process.execPath, [MEMO, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, env
  });
  return { root, home, git, memo };
}

function progress(root) {
  return fs.readFileSync(path.join(root, '.memory', 'progress.md'), 'utf8');
}

function entryCount(root) {
  return (progress(root).match(/^## .* · commit /gm) || []).length;
}

test('init installs an LF-only post-commit hook and records commits', { skip: !HAS_GIT && 'git not installed' }, (t) => {
  const { root, git, memo } = setup(t);
  git(['init', '-q']);
  memo(['init']);

  const hookPath = path.resolve(root, git(['rev-parse', '--git-path', 'hooks']).trim(), 'post-commit');
  const hook = fs.readFileSync(hookPath, 'utf8');
  assert.ok(hook.includes('# memo-hook'));
  assert.ok(!hook.includes('\r'), 'hook must not contain CR');

  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'add a']);
  assert.equal(entryCount(root), 1);
  assert.match(progress(root), /add a/);

  git(['add', '-A', '--', '.memory']);
  git(['commit', '-q', '-m', 'memory only', '--', '.memory']);
  assert.equal(entryCount(root), 1, 'memory-only commit must not add an entry');

  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
  git(['add', 'b.txt']);
  git(['commit', '-q', '-m', 'internal'], { MEMO_INTERNAL_COMMIT: '1' });
  assert.equal(entryCount(root), 1, 'MEMO_INTERNAL_COMMIT=1 must skip the hook');
});

test('init normalizes CRLF when appending to an existing hook', { skip: !HAS_GIT && 'git not installed' }, (t) => {
  const { root, git, memo } = setup(t);
  git(['init', '-q']);
  const hookPath = path.resolve(root, git(['rev-parse', '--git-path', 'hooks']).trim(), 'post-commit');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, '#!/bin/sh\r\necho existing\r\n', { mode: 0o755 });
  memo(['init']);
  const hook = fs.readFileSync(hookPath, 'utf8');
  assert.ok(!hook.includes('\r'));
  assert.ok(hook.includes('echo existing'));
  assert.ok(hook.includes('# memo-hook'));
});

test('personal note skips exact duplicates', (t) => {
  const { root, home, memo } = setup(t);
  assert.match(memo(['note', '--personal', 'I prefer short replies']), /Saved/);
  assert.match(memo(['note', '--personal', 'I prefer short replies']), /Already saved/);
  const lines = fs.readFileSync(path.join(home, 'personal.md'), 'utf8').split('\n');
  assert.equal(lines.filter((l) => l === '- I prefer short replies').length, 1);
  assert.ok(root);
});
