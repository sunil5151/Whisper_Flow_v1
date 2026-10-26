'use strict';

// `memo clear`: dry run by default, honest deletion, tombstones that survive a sweep.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const MEMO = path.join(__dirname, '..', 'bin', 'memo.js');
const HAS_GIT = !spawnSync('git', ['--version'], { windowsHide: true }).error;
const SKIP = !HAS_GIT && 'git not installed';

const SID_A = 'aaaaaaaa-1111-4222-8333-444444444444';
const SID_B = 'bbbbbbbb-1111-4222-8333-444444444444';
const DATE = '2026-10-21';

function eventsFor(sid, prefix) {
  const at = (n) => '2026-10-21T09:0' + n + ':00.000+05:30';
  return [1, 2, 3].map((seq) => ({
    v: 1, id: 'e-' + prefix + '000' + seq, sid, seq, ts: at(seq), agent: 'claude-code',
    type: seq === 1 ? 'user_prompt' : 'assistant_text', text: 'event ' + seq + ' of ' + prefix
  }));
}

function recordLine(over) {
  return {
    op: 'create', id: over.id, type: over.type, ts: '2026-10-21T09:10:00.000+05:30', job: 'j-test',
    statement: over.statement, status: over.status || 'active', confidence: 'medium',
    evidence: over.evidence, sessions: over.sessions, source: 'llm'
  };
}

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-clear-test-'));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const gitConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(gitConfig, '[user]\n\tname = MEMO Test\n\temail = memo@test.invalid\n[commit]\n\tgpgsign = false\n');
  const env = {
    ...process.env, MEMO_HOME: home, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
    MEMO_CLAUDE_SETTINGS: path.join(base, 'claude.json')
  };
  delete env.MEMO_MOCK_LLM;
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true, env });

  const memo = (args) => spawnSync(process.execPath, [MEMO, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, env
  });
  assert.equal(memo(['init']).status, 0);
  fs.writeFileSync(path.join(home, 'config.json'),
    JSON.stringify({ v: 1, provider: 'mock', model: 'claude-haiku-5-5' }, null, 2) + '\n');

  const dir = path.join(root, '.memory', 'sessions', '2026', '10', '21');
  fs.mkdirSync(dir, { recursive: true });
  const index = [];
  for (const [sid, prefix] of [[SID_A, 'aaaa'], [SID_B, 'bbbb']]) {
    const list = eventsFor(sid, prefix);
    fs.writeFileSync(path.join(dir, sid + '.jsonl'), list.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, sid + '.md'), '# Session ' + sid.slice(0, 8) + '\n\nsummary text\n');
    index.push({
      sid, agent: 'claude-code', date: DATE, start: list[0].ts, end: list[2].ts,
      events: 3, processedThrough: 3, summary: 'did things in ' + prefix, status: 'ended'
    });
  }
  fs.writeFileSync(path.join(root, '.memory', 'sessions', 'index.json'), JSON.stringify(index, null, 2) + '\n');

  const records = path.join(root, '.memory', 'records');
  fs.mkdirSync(records, { recursive: true });
  fs.writeFileSync(path.join(records, 'decisions.jsonl'),
    JSON.stringify(recordLine({
      id: 'D-only0001', type: 'decision', statement: 'only from session A',
      evidence: ['e-aaaa0001'], sessions: [SID_A]
    })) + '\n' +
    JSON.stringify(recordLine({
      id: 'D-mixed001', type: 'decision', statement: 'from both sessions',
      evidence: ['e-aaaa0002', 'e-bbbb0002'], sessions: [SID_A, SID_B]
    })) + '\n' +
    JSON.stringify(recordLine({
      id: 'D-other001', type: 'decision', statement: 'only from session B',
      evidence: ['e-bbbb0003'], sessions: [SID_B]
    })) + '\n');

  // Pretend capture has a cursor for session A, as it would after a live session.
  const repoId = JSON.parse(fs.readFileSync(path.join(home, 'repos.json'), 'utf8'))[0].id;
  const stateDir = path.join(home, 'state', repoId);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'cursors.json'), JSON.stringify({
    [SID_A]: { transcriptPath: path.join(base, 'transcript-a.jsonl').replace(/\\/g, '/'), offset: 0, lineNo: 0, tools: {} }
  }, null, 2));
  fs.writeFileSync(path.join(base, 'transcript-a.jsonl'),
    JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello again' } }) + '\n');

  execFileSync('git', ['add', '-A'], { cwd: root, windowsHide: true, env });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root, windowsHide: true, env });

  return { base, root, home, env, memo, repoId, dir, stateDir };
}

function decisions(root) {
  const file = path.join(root, '.memory', 'records', 'decisions.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function index(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.memory', 'sessions', 'index.json'), 'utf8'));
}

test('a dry run lists files and records and changes nothing', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['clear', '--session', 'aaaaaaaa']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /clear session aaaaaaaa/);
  assert.match(r.stdout, /\.memory\/sessions\/2026\/10\/21\/aaaaaaaa-1111-4222-8333-444444444444\.jsonl/);
  assert.match(r.stdout, /D-only0001/);
  assert.match(r.stdout, /D-mixed001/);
  assert.match(r.stdout, /dry run — nothing was deleted/);
  assert.ok(fs.existsSync(path.join(ctx.dir, SID_A + '.jsonl')));
  assert.equal(decisions(ctx.root).length, 3);
});

test('deleting a session removes its files, keeps the other, strips mixed evidence', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['clear', '--session', SID_A, '--with-derived', '--yes']);
  assert.equal(r.status, 0, r.stderr);

  assert.equal(fs.existsSync(path.join(ctx.dir, SID_A + '.jsonl')), false);
  assert.equal(fs.existsSync(path.join(ctx.dir, SID_A + '.md')), false);
  assert.ok(fs.existsSync(path.join(ctx.dir, SID_B + '.jsonl')), 'the other session stays');

  const left = decisions(ctx.root);
  assert.equal(left.find((d) => d.id === 'D-only0001'), undefined, 'derived-only record is gone');
  const mixed = left.find((d) => d.id === 'D-mixed001');
  assert.deepEqual(mixed.evidence, ['e-bbbb0002'], 'only the deleted session evidence is stripped');
  assert.deepEqual(mixed.sessions, [SID_B]);
  assert.equal(mixed.source_deleted, true);
  assert.ok(left.find((d) => d.id === 'D-other001'), 'untouched record stays untouched');

  const tomb = index(ctx.root).find((e) => e.sid === SID_A);
  assert.ok(tomb.deletedAt, 'a tombstone replaces the index entry');

  const state = fs.readFileSync(path.join(ctx.root, '.memory', 'PROJECT_STATE.md'), 'utf8');
  assert.equal(state.includes('only from session A'), false);
  assert.equal(state.includes(SID_A.slice(0, 8)), false);

  assert.match(r.stdout, /Older Git commits still contain this data/);
  const files = execFileSync('git', ['show', '--name-only', '--format=%s', 'HEAD'],
    { cwd: ctx.root, encoding: 'utf8', windowsHide: true }).trim().split('\n');
  assert.match(files[0], /^memo: remove captured session data for session aaaaaaaa$/);
  for (const f of files.slice(1).filter(Boolean)) assert.match(f, /^(\.memory\/|AGENTS\.md$|GEMINI\.md$|\.github\/copilot-instructions\.md$)/);
  for (const rel of ['AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md']) {
    assert.equal(fs.readFileSync(path.join(ctx.root, rel), 'utf8').includes(SID_A.slice(0, 8)), false, rel);
  }
});

test('without --with-derived the derived record is kept but loses its evidence', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const dry = ctx.memo(['clear', '--session', SID_A]);
  assert.match(dry.stdout, /add --with-derived to delete them too/);
  assert.equal(ctx.memo(['clear', '--session', SID_A, '--yes']).status, 0);
  const only = decisions(ctx.root).find((d) => d.id === 'D-only0001');
  assert.ok(only, 'the record survives');
  assert.deepEqual(only.evidence, []);
  assert.equal(only.source_deleted, true);
});

test('a tombstoned session is not re-imported by the next sweep', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  assert.equal(ctx.memo(['clear', '--session', SID_A, '--yes']).status, 0);
  const sweep = ctx.memo(['capture', '--sweep', '--verbose']);
  assert.equal(sweep.status, 0, sweep.stderr);
  assert.equal(fs.existsSync(path.join(ctx.dir, SID_A + '.jsonl')), false, 'the session must stay deleted');
  const entry = index(ctx.root).find((e) => e.sid === SID_A);
  assert.ok(entry.deletedAt);
  assert.equal(entry.events, undefined);
});

test('a whole date needs --confirm and then removes every session of that day', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const refused = ctx.memo(['clear', '--date', DATE, '--yes']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /needs --confirm 2026-10-21/);
  assert.ok(fs.existsSync(path.join(ctx.dir, SID_A + '.jsonl')));

  const r = ctx.memo(['clear', '--date', DATE, '--with-derived', '--yes', '--confirm', DATE]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(ctx.dir, SID_A + '.jsonl')), false);
  assert.equal(fs.existsSync(path.join(ctx.dir, SID_B + '.jsonl')), false);
  assert.equal(decisions(ctx.root).length, 0);
  assert.equal(index(ctx.root).every((e) => e.deletedAt), true);
});

test('one record can be deleted on its own', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['clear', '--record', 'D-mixed001', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(decisions(ctx.root).map((d) => d.id).sort(), ['D-only0001', 'D-other001']);
  assert.ok(fs.existsSync(path.join(ctx.dir, SID_A + '.jsonl')), 'session files are untouched');
});

test('bad targets are refused without touching anything', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  for (const args of [
    ['clear', '--session', '../../etc/passwd', '--yes'],
    ['clear', '--session', 'zzzzzzzz', '--yes'],
    ['clear', '--date', '21-10-2026', '--yes'],
    ['clear', '--record', 'D-nope0000', '--yes'],
    ['clear', '--session', SID_A, '--date', DATE]
  ]) {
    const r = ctx.memo(args);
    assert.equal(r.status, 1, args.join(' ') + ' should fail');
  }
  assert.ok(fs.existsSync(path.join(ctx.dir, SID_A + '.jsonl')));
  assert.equal(decisions(ctx.root).length, 3);
});

test('--all-repo-data needs the typed phrase and keeps legacy notes', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  fs.mkdirSync(path.join(ctx.root, '.memory', 'legacy'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, '.memory', 'legacy', 'decisions.md'), '# old\n');

  const refused = ctx.memo(['clear', '--all-repo-data', '--yes']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /DELETE-ALL-MEMO-DATA/);
  assert.ok(fs.existsSync(path.join(ctx.dir, SID_A + '.jsonl')));

  const r = ctx.memo(['clear', '--all-repo-data', '--yes', '--confirm', 'DELETE-ALL-MEMO-DATA']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(ctx.dir, SID_A + '.jsonl')), false);
  assert.deepEqual(index(ctx.root), []);
  assert.equal(decisions(ctx.root).length, 0);
  assert.equal(fs.existsSync(path.join(ctx.stateDir, 'cursors.json')), false,
    'the capture cursors must go too, or the next sweep re-imports everything');
  assert.equal(ctx.memo(['capture', '--sweep', '--verbose']).status, 0);
  assert.deepEqual(index(ctx.root), [], 'a sweep after the wipe brings nothing back');
  assert.ok(fs.existsSync(path.join(ctx.root, '.memory', 'legacy', 'decisions.md')), 'legacy notes are kept');
  assert.ok(fs.existsSync(path.join(ctx.root, '.memory', 'progress.md')), 'the commit log is kept');
});
