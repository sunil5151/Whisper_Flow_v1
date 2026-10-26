'use strict';

// `memo cycle` end to end with the mock provider: no key, no network, temp repos only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const MEMO = path.join(__dirname, '..', 'bin', 'memo.js');
const HAS_GIT = !spawnSync('git', ['--version'], { windowsHide: true }).error;
const SKIP = !HAS_GIT && 'git not installed';

const SID = 'eeeeeeee-1111-4222-8333-555555555555';
const DATE = '2026-10-21';

function events(sid) {
  const at = (n) => '2026-10-21T09:0' + n + ':00.000+05:30';
  const e = (seq, id, type, extra) => ({ v: 1, id, sid, seq, ts: at(seq), agent: 'claude-code', type, ...extra });
  return [
    e(1, 'e-aaaa0001', 'user_prompt', { text: 'npm test is failing, fix it' }),
    e(2, 'e-aaaa0002', 'tool_call', { tool: 'Bash', text: 'npm test' }),
    e(3, 'e-aaaa0003', 'tool_result', { tool: 'Bash', ok: false, text: '# pass 14\n# fail 1' }),
    e(4, 'e-aaaa0004', 'assistant_text', { text: 'The redact test fails because the sk- pattern is too short.' }),
    e(5, 'e-aaaa0005', 'tool_call', { tool: 'Edit', text: 'src/redact.js (-1 +1 lines)' }),
    e(6, 'e-aaaa0006', 'tool_result', { tool: 'Edit', ok: true, text: 'ok' }),
    e(7, 'e-aaaa0007', 'tool_call', { tool: 'Bash', text: 'npm test' }),
    e(8, 'e-aaaa0008', 'tool_result', { tool: 'Bash', ok: true, text: '# tests 15\n# pass 15\n# fail 0' }),
    e(9, 'e-aaaa0009', 'assistant_text', { text: 'All 15 tests pass now.' })
  ];
}

function setup(t, { config: patch = {}, withEvents = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-cycle-test-'));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const gitConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(gitConfig, '[user]\n\tname = MEMO Test\n\temail = memo@test.invalid\n[commit]\n\tgpgsign = false\n');
  const env = {
    ...process.env, MEMO_HOME: home, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
    MEMO_CLAUDE_SETTINGS: path.join(base, 'claude-settings.json')
  };
  delete env.MEMO_MOCK_LLM;

  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true, env });
  const memo = (args, extraEnv, cwd) => spawnSync(process.execPath, [MEMO, ...args], {
    cwd: cwd || root, encoding: 'utf8', windowsHide: true, env: { ...env, ...extraEnv }
  });
  assert.equal(memo(['init']).status, 0);

  fs.writeFileSync(path.join(home, 'config.json'),
    JSON.stringify({ v: 1, provider: 'mock', model: 'claude-haiku-5-5', ...patch }, null, 2) + '\n');

  // A base commit, so "nothing new" really means a clean working tree.
  fs.writeFileSync(path.join(root, 'README.md'), '# test repo\n');
  execFileSync('git', ['add', '-A'], { cwd: root, windowsHide: true, env });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root, windowsHide: true, env });

  if (withEvents) {
    const dir = path.join(root, '.memory', 'sessions', '2026', '10', '21');
    fs.mkdirSync(dir, { recursive: true });
    const list = events(SID);
    fs.writeFileSync(path.join(dir, SID + '.jsonl'), list.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(root, '.memory', 'sessions', 'index.json'), JSON.stringify([{
      sid: SID, agent: 'claude-code', date: DATE, start: list[0].ts, end: list[8].ts,
      events: 9, processedThrough: 0, summary: '', status: 'ended'
    }], null, 2) + '\n');
  }
  return { base, root, home, env, memo };
}

function cycleLines(home) {
  const file = path.join(home, 'logs', 'cycles.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function lastRepoLine(home) {
  return cycleLines(home).filter((l) => l.event === 'repo').pop();
}

function usageLines(home) {
  const file = path.join(home, 'logs', 'usage.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function gitLog(root) {
  return execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim().split('\n');
}

test('a cycle with new events processes, reports and commits only .memory', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['cycle'], { MEMO_MOCK_LLM: 'error-fixed-verified' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cycle ok/);

  const repoLine = lastRepoLine(ctx.home);
  assert.equal(repoLine.status, 'ok');
  assert.equal(repoLine.jobs, 1);
  assert.ok(repoLine.committed, 'the cycle should commit');

  const files = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'],
    { cwd: ctx.root, encoding: 'utf8', windowsHide: true }).trim().split('\n');
  assert.ok(files.length > 0);
  for (const f of files) assert.match(f, /^(\.memory\/|AGENTS\.md$|GEMINI\.md$|\.github\/copilot-instructions\.md$)/);
  assert.ok(fs.existsSync(path.join(ctx.root, '.memory', 'PROJECT_STATE.md')));

  const status = JSON.parse(fs.readFileSync(path.join(ctx.home, 'status.json'), 'utf8'));
  assert.equal(status.lastCycle.status, 'ok');
  assert.ok(status.lastOk);
  assert.ok(status.nextExpected > status.lastCycle.ts);
});

test('with no new data the cycle makes no provider call and commits nothing', { skip: SKIP }, (t) => {
  const ctx = setup(t, { withEvents: false });
  // The first cycle commits what `memo init` and the post-commit hook left behind.
  assert.equal(ctx.memo(['cycle'], { MEMO_MOCK_LLM: 'decision' }).status, 0);
  const before = gitLog(ctx.root).length;
  const started = Date.now();
  const r = ctx.memo(['cycle'], { MEMO_MOCK_LLM: 'decision' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(usageLines(ctx.home), []);
  assert.equal(gitLog(ctx.root).length, before);
  const repoLine = lastRepoLine(ctx.home);
  assert.equal(repoLine.status, 'no_new_data');
  assert.equal(repoLine.calls, 0);
  assert.ok(Date.now() - started < 10000, 'a no-op cycle must stay fast');
});

test('a live cycle lock makes the next cycle skip, a stale one is recovered', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const lock = path.join(ctx.home, 'cycle.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  const skipped = ctx.memo(['cycle'], { MEMO_MOCK_LLM: 'decision' });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /another cycle is running/);
  assert.ok(cycleLines(ctx.home).some((l) => l.event === 'overlap_skip'));
  assert.deepEqual(usageLines(ctx.home), []);

  const old = Date.now() - 25 * 60 * 1000;
  fs.utimesSync(lock, new Date(old), new Date(old));
  const recovered = ctx.memo(['cycle'], { MEMO_MOCK_LLM: 'error-fixed-verified' });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.ok(cycleLines(ctx.home).some((l) => l.event === 'stale_lock_recovered'));
  assert.equal(fs.existsSync(lock), false, 'the lock is released at the end');
});

test('paused: nothing is captured, processed or committed', { skip: SKIP }, (t) => {
  const ctx = setup(t, { config: { paused: true } });
  const before = gitLog(ctx.root).length;
  const r = ctx.memo(['cycle'], { MEMO_MOCK_LLM: 'decision' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /paused/);
  assert.deepEqual(usageLines(ctx.home), []);
  assert.equal(gitLog(ctx.root).length, before);
  assert.ok(cycleLines(ctx.home).some((l) => l.event === 'cycle_end' && l.status === 'paused'));
});

test('budget reached: no API call, but the raw events are still committed', { skip: SKIP }, (t) => {
  const ctx = setup(t, { config: { monthlyBudgetUsd: 0 } });
  // Put the events where capture --sweep has nothing to do but process does.
  const r = ctx.memo(['cycle'], { MEMO_MOCK_LLM: 'decision' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(usageLines(ctx.home), []);
  const repoLine = lastRepoLine(ctx.home);
  assert.equal(repoLine.status, 'budget_reached');
  assert.equal(repoLine.calls, 0);
  // PROJECT_STATE.md still lists the session, so the commit happened.
  assert.ok(gitLog(ctx.root).some((s) => /^memo: archive/.test(s)));
});

test('one broken repo does not stop the healthy one', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const broken = path.join(ctx.base, 'broken');
  fs.mkdirSync(broken, { recursive: true });
  const registry = JSON.parse(fs.readFileSync(path.join(ctx.home, 'repos.json'), 'utf8'));
  registry.unshift({ id: 'broken-00000000', root: broken.replace(/\\/g, '/'), addedAt: '2026-10-21T00:00:00.000+05:30', enabled: true });
  fs.writeFileSync(path.join(ctx.home, 'repos.json'), JSON.stringify(registry, null, 2) + '\n');

  const r = ctx.memo(['cycle'], { MEMO_MOCK_LLM: 'error-fixed-verified' });
  assert.equal(r.status, 0, r.stderr);
  const lines = cycleLines(ctx.home).filter((l) => l.event === 'repo');
  assert.equal(lines.length, 2);
  assert.equal(lines.find((l) => l.repoId === 'broken-00000000').status, 'error');
  const healthy = lines.find((l) => l.repoId !== 'broken-00000000');
  assert.equal(healthy.status, 'ok');
  assert.ok(healthy.committed);
});
