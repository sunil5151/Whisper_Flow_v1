'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { commitMemory } = require('../src/gitops/memory-commit');

const MEMO = path.join(__dirname, '..', 'bin', 'memo.js');
const HAS_GIT = !spawnSync('git', ['--version'], { windowsHide: true }).error;
const skip = !HAS_GIT && 'git not installed';
const CFG = { autoCommit: true };

function setup(t, { identity = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-commit-test-'));
  const root = path.join(base, 'my repo');
  fs.mkdirSync(root);
  const gitConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(gitConfig, (identity ? '[user]\n\tname = MEMO Test\n\temail = memo@test.invalid\n' : '') + '[commit]\n\tgpgsign = false\n');
  const saved = {};
  const env = { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', MEMO_HOME: path.join(base, 'home'),
    GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined, EMAIL: undefined };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  if (!identity) git('config', 'user.useConfigOnly', 'true');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  return { root, git, write };
}

function seedBase({ git, write }) {
  write('src.js', '1\n');
  write('b.js', '1\n');
  write('.memory/keep.md', 'k\n');
  git('add', '.');
  git('-c', 'user.name=Seed', '-c', 'user.email=seed@test.invalid', 'commit', '-q', '-m', 'base');
}

test('commits only .memory and keeps the user\'s staged work staged', { skip }, (t) => {
  const ctx = setup(t);
  const { root, git, write } = ctx;
  seedBase(ctx);
  write('src.js', '2\n');
  git('add', 'src.js');
  write('b.js', '2\n');
  write('c.js', 'new\n');
  write('.memory/x', 'x\n');

  const res = commitMemory(root, { cfg: CFG });
  assert.equal(res.status, 'committed');
  assert.equal(git('show', '--name-only', '--format=', 'HEAD'), '.memory/x');
  assert.match(git('log', '-1', '--format=%s'), /^memo: archive 0 session\(s\), 0 record change\(s\) — \d{4}-\d{2}-\d{2}$/);
  assert.equal(git('diff', '--cached', '--name-only'), 'src.js');
  const status = git('status', '--porcelain');
  assert.match(status, /^M  src\.js$/m);
  assert.match(status, /^ ?M b\.js$/m);
  assert.doesNotMatch(status, /^M  b\.js$/m);
  assert.match(status, /^\?\? c\.js$/m);

  const head = git('rev-parse', 'HEAD');
  assert.equal(commitMemory(root, { cfg: CFG }).status, 'no_changes');
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('deleted file under .memory is committed as a deletion', { skip }, (t) => {
  const ctx = setup(t);
  seedBase(ctx);
  fs.unlinkSync(path.join(ctx.root, '.memory', 'keep.md'));
  assert.equal(commitMemory(ctx.root, { cfg: CFG }).status, 'committed');
  assert.equal(ctx.git('show', '--name-status', '--format=', 'HEAD'), 'D\t.memory/keep.md');
});

test('message counts sessions and record lines; single session adds sid8', { skip }, (t) => {
  const ctx = setup(t);
  seedBase(ctx);
  ctx.write('.memory/sessions/2026/10/25/abcdef12-3456.jsonl', '{}\n');
  ctx.write('.memory/records/tasks.jsonl', '{"a":1}\n{"b":2}\n');
  const res = commitMemory(ctx.root, { cfg: CFG });
  assert.match(res.message, /^memo: archive 1 session\(s\), 2 record change\(s\) — \d{4}-\d{2}-\d{2} \(abcdef12\)$/);
});

test('MEMO_INTERNAL_COMMIT makes the post-commit hook skip', { skip }, (t) => {
  const ctx = setup(t);
  seedBase(ctx);
  execFileSync(process.execPath, [MEMO, 'init'], { cwd: ctx.root, windowsHide: true, env: process.env });
  ctx.git('add', '-A');
  ctx.git('commit', '-q', '-m', 'init memo');
  const progress = () => fs.readFileSync(path.join(ctx.root, '.memory', 'progress.md'), 'utf8');
  const before = progress();
  ctx.write('.memory/y', 'y\n');
  assert.equal(commitMemory(ctx.root, { cfg: CFG }).status, 'committed');
  assert.equal(progress(), before);
  assert.equal(ctx.git('status', '--porcelain', '--', '.memory'), '');
});

test('missing identity → no_identity, no commit', { skip }, (t) => {
  const ctx = setup(t, { identity: false });
  ctx.write('.memory/x', 'x\n');
  assert.equal(commitMemory(ctx.root, { cfg: CFG }).status, 'no_identity');
  assert.throws(() => ctx.git('rev-parse', 'HEAD'));
});

test('busy repo and autoCommit:false do nothing', { skip }, (t) => {
  const ctx = setup(t);
  seedBase(ctx);
  ctx.write('.memory/x', 'x\n');
  assert.equal(commitMemory(ctx.root, { cfg: { autoCommit: false } }).status, 'disabled');
  fs.writeFileSync(path.join(ctx.root, '.git', 'MERGE_HEAD'), 'deadbeef\n');
  assert.equal(commitMemory(ctx.root, { cfg: CFG }).status, 'git_busy');
  assert.equal(ctx.git('log', '--format=%s'), 'base');
});

test('an agent file is committed only when its change is inside the memo block', { skip }, (t) => {
  const ctx = setup(t);
  const { git, write } = ctx;
  const block = (s) => '<!-- memo:start -->\n' + s + '\n<!-- memo:end -->\n';
  write('AGENTS.md', '# Rules\n\n' + block('old'));
  write('GEMINI.md', '# Gemini\n\n' + block('old'));
  seedBase(ctx);

  write('AGENTS.md', '# Rules\n\n' + block('new snapshot'));
  write('GEMINI.md', '# Gemini, edited by the user\n\n' + block('new snapshot'));
  write('.memory/x', 'x\n');
  const res = commitMemory(ctx.root, { cfg: CFG });
  assert.equal(res.status, 'committed');
  const committed = git('show', '--name-only', '--format=', 'HEAD').split('\n').sort();
  assert.deepEqual(committed, ['.memory/x', 'AGENTS.md']);
  assert.match(git('status', '--porcelain'), /GEMINI\.md/);
});
