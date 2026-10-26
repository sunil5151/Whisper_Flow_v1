'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const records = require('../src/store/records');
const { migrate } = require('../src/migrate');

const MEMO = path.join(__dirname, '..', 'bin', 'memo.js');
const HAS_GIT = !spawnSync('git', ['--version'], { windowsHide: true }).error;

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-migrate-test-'));
  const root = path.join(base, 'repo');
  const mem = path.join(root, '.memory');
  fs.mkdirSync(mem, { recursive: true });
  const prevHome = process.env.MEMO_HOME;
  process.env.MEMO_HOME = path.join(base, 'home');
  t.after(() => {
    if (prevHome === undefined) delete process.env.MEMO_HOME; else process.env.MEMO_HOME = prevHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(mem, 'decisions.md'), '# Decisions\n\n## 2026-10-20 10:00 · decision\nUse Node\n\n## 2026-10-21 11:00 · decision\nKeep .memory\n');
  fs.writeFileSync(path.join(mem, 'errors.md'), '# Errors\n\n## 2026-10-20 12:00 · error\nHook CRLF breaks\n');
  fs.writeFileSync(path.join(mem, 'next.md'), '# Next\n- [ ] write docs\n- [x] fix hook\n');
  fs.writeFileSync(path.join(mem, 'BRIEF.md'), '# BRIEF\n');
  return { root, mem };
}

test('legacy notes become records and files move to .memory/legacy', { skip: !HAS_GIT && 'git not installed' }, (t) => {
  const { root, mem } = setup(t);
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  execFileSync('git', ['add', '.memory/decisions.md'], { cwd: root, windowsHide: true });

  const res = migrate(root);
  assert.equal(res.imported, 5);
  const all = records.foldAll(root);
  const by = (stmt) => all.find((r) => r.statement === stmt);
  assert.equal(by('Use Node').status, 'active');
  assert.equal(by('Use Node').source, 'legacy');
  assert.equal(by('Use Node').type, 'decision');
  assert.equal(by('Hook CRLF breaks').status, 'observed');
  assert.equal(by('write docs').status, 'open');
  assert.equal(by('fix hook').status, 'done');
  assert.match(by('Use Node').ts, /^2026-10-20T10:00/);

  for (const f of ['decisions.md', 'errors.md', 'next.md']) {
    assert.ok(!fs.existsSync(path.join(mem, f)));
    assert.ok(fs.existsSync(path.join(mem, 'legacy', f)));
  }
  assert.ok(!fs.existsSync(path.join(mem, 'BRIEF.md')));
  // Tracked file moved with git mv: the rename is staged.
  const staged = execFileSync('git', ['diff', '--cached', '--name-status'], { cwd: root, encoding: 'utf8' });
  assert.match(staged, /\.memory\/legacy\/decisions\.md/);
  assert.match(fs.readFileSync(path.join(mem, 'PROJECT_STATE.md'), 'utf8'), /Use Node/);
  assert.match(fs.readFileSync(path.join(mem, 'TASKS.md'), 'utf8'), /write docs/);

  const snapshot = () => fs.readdirSync(path.join(mem, 'records')).map((f) => fs.readFileSync(path.join(mem, 'records', f), 'utf8')).join('');
  const before = snapshot();
  const again = migrate(root);
  assert.equal(again.imported, 0);
  assert.equal(again.moved.length, 0);
  assert.equal(snapshot(), before);
});

test('migrate imports once even if legacy files reappear', (t) => {
  const { root, mem } = setup(t);
  migrate(root);
  const count = records.readLines(root, 'decision').length;
  fs.writeFileSync(path.join(mem, 'decisions.md'), '# Decisions\n\n## 2026-10-20 10:00 · decision\nUse Node\n');
  const res = migrate(root);
  assert.equal(res.skipped, true);
  assert.equal(records.readLines(root, 'decision').length, count);
  assert.equal(fs.readdirSync(path.join(mem, 'legacy')).filter((f) => f.startsWith('decisions')).length, 2);
});

test('memo init writes the AGENTS block once, creates CLAUDE.md and hints at migrate', { skip: !HAS_GIT && 'git not installed' }, (t) => {
  const { root } = setup(t);
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\nRead .memory/BRIEF.md before starting.\n');
  const run = () => execFileSync(process.execPath, [MEMO, 'init'], { cwd: root, encoding: 'utf8', windowsHide: true, env: process.env });
  const out = run();
  assert.match(out, /run `memo migrate`/);
  assert.match(out, /created {2}CLAUDE\.md/);
  run();
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.equal((agents.match(/<!-- memo:start -->/g) || []).length, 1);
  assert.match(agents, /^# Agents\n\n<!-- memo:start -->/);
  assert.doesNotMatch(agents, /BRIEF\.md/);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  const tasks = JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'tasks.json'), 'utf8')).tasks;
  assert.equal(tasks.length, 1, 'the folder-open task is written once');
  assert.deepEqual([tasks[0].command, tasks[0].args, tasks[0].runOptions.runOn], ['memo', ['cycle', '--quiet'], 'folderOpen']);
  for (const rel of ['.github/copilot-instructions.md', 'GEMINI.md']) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.equal((text.match(/<!-- memo:start -->/g) || []).length, 1, rel);
    assert.match(text, /### Snapshot \(sessions processed up to none\)\n\(no records yet\)\n<!-- memo:end -->/, rel);
  }
  assert.ok(fs.existsSync(path.join(root, '.memory', 'README.md')));
  assert.ok(fs.existsSync(path.join(root, '.memory', 'PROJECT_STATE.md')));
  assert.ok(fs.existsSync(path.join(root, '.memory', 'records')));
});

test('memo note writes a manual record and refreshes reports', { skip: !HAS_GIT && 'git not installed' }, (t) => {
  const { root, mem } = setup(t);
  for (const f of ['decisions.md', 'errors.md', 'next.md']) fs.unlinkSync(path.join(mem, f));
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  const memo = (...args) => execFileSync(process.execPath, [MEMO, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, env: process.env });
  assert.match(memo('note', '-t', 'next', 'ship it'), /Saved → \.memory\/records\/tasks\.jsonl/);
  assert.match(memo('note', '-t', 'next', 'ship it'), /Already saved/);
  const rec = records.foldAll(root).find((r) => r.statement === 'ship it');
  assert.equal(rec.source, 'manual');
  assert.equal(rec.status, 'open');
  assert.match(fs.readFileSync(path.join(mem, 'TASKS.md'), 'utf8'), /ship it/);
});

test('memo init adds its task to an existing tasks.json and leaves a commented one alone', { skip: !HAS_GIT && 'git not installed' }, (t) => {
  const { root } = setup(t);
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  const file = path.join(root, '.vscode', 'tasks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: '2.0.0', tasks: [{ label: 'build', type: 'shell', command: 'make' }] }));
  const run = () => execFileSync(process.execPath, [MEMO, 'init'], { cwd: root, encoding: 'utf8', windowsHide: true, env: process.env });
  run();
  run();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.map((x) => x.label), ['build', 'MEMO: sync conversations']);

  const commented = '// mine\n{ "version": "2.0.0", "tasks": [] }\n';
  fs.writeFileSync(file, commented);
  assert.match(run(), /hint: \.vscode\/tasks\.json has comments/);
  assert.equal(fs.readFileSync(file, 'utf8'), commented);
});
