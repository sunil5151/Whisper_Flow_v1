'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const MEMO = path.join(__dirname, '..', 'bin', 'memo.js');
const FIX = path.join(__dirname, 'fixtures', 'claude');
const HAS_GIT = !spawnSync('git', ['--version'], { windowsHide: true }).error;
const SKIP = !HAS_GIT && 'git not installed';

function setup(t, { repoName = 'repo', init = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-cap-test-'));
  const root = path.join(base, repoName);
  const home = path.join(base, 'home');
  const transcripts = path.join(base, 'transcripts');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(transcripts);
  const env = { ...process.env, MEMO_HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true, env });
  const memo = (args, input) => spawnSync(process.execPath, [MEMO, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, env, input
  });
  if (init) assert.equal(memo(['init']).status, 0);
  return { base, root, home, transcripts, memo, env };
}

function fixtureLines(name) {
  return fs.readFileSync(path.join(FIX, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean);
}

function hook(ctx, { sid, tPath, event = 'Stop', cwd, extra = {} }) {
  const payload = JSON.stringify({ session_id: sid, transcript_path: tPath, cwd: cwd || ctx.root, hook_event_name: event, ...extra });
  const r = ctx.memo(['capture'], payload);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return r;
}

function sessionEvents(root) {
  const dir = path.join(root, '.memory', 'sessions');
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.jsonl')) out.push({ file: p, events: fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function index(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.memory', 'sessions', 'index.json'), 'utf8'));
}

function assertContinuous(events) {
  events.forEach((e, i) => assert.equal(e.seq, i + 1));
  assert.equal(new Set(events.map((e) => e.id)).size, events.length, 'duplicate ids');
}

const SID = 'aaaaaaaa-1111-4222-8333-444444444444';

test('incremental capture: half then rest → no duplicates, continuous seq, YYYY/MM/DD path', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const lines = fixtureLines('basic');
  const tPath = path.join(ctx.transcripts, `${SID}.jsonl`);
  const half = Math.floor(lines.length / 2);
  fs.writeFileSync(tPath, lines.slice(0, half).join('\n') + '\n');
  hook(ctx, { sid: SID, tPath, event: 'SessionStart', extra: { source: 'startup' } });
  const first = sessionEvents(ctx.root)[0].events.length;
  assert.ok(first > 0);
  fs.appendFileSync(tPath, lines.slice(half).join('\n') + '\n');
  hook(ctx, { sid: SID, tPath });
  hook(ctx, { sid: SID, tPath }); // replay: nothing new
  const files = sessionEvents(ctx.root);
  assert.equal(files.length, 1);
  assert.equal(files[0].events.length, 11);
  assertContinuous(files[0].events);
  const rel = path.relative(path.join(ctx.root, '.memory', 'sessions'), files[0].file).split(path.sep);
  assert.equal(rel.length, 4);
  assert.match(rel.slice(0, 3).join('/'), /^\d{4}\/\d{2}\/\d{2}$/);
  assert.equal(rel[3], `${SID}.jsonl`);
  const idx = index(ctx.root);
  assert.equal(idx.length, 1);
  assert.equal(idx[0].events, 11);
  assert.equal(idx[0].status, 'active');
  assert.equal(idx[0].processedThrough, 0);
});

test('partial last line is held back until complete', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const lines = fixtureLines('error-then-fix');
  const tPath = path.join(ctx.transcripts, `${SID}.jsonl`);
  const all = lines.join('\n') + '\n';
  const cutAt = all.indexOf(lines[3]) + 20; // middle of line 4
  fs.writeFileSync(tPath, all.slice(0, cutAt));
  hook(ctx, { sid: SID, tPath });
  const n1 = sessionEvents(ctx.root)[0].events.length;
  fs.appendFileSync(tPath, all.slice(cutAt));
  hook(ctx, { sid: SID, tPath });
  const ev = sessionEvents(ctx.root)[0].events;
  assert.ok(ev.length > n1);
  assert.equal(ev.length, 11);
  assertContinuous(ev);
  const log = fs.readFileSync(path.join(ctx.home, 'logs', 'capture.jsonl'), 'utf8');
  assert.ok(!log.includes('bad_line'), 'partial line must not be parsed');
});

test('rewritten (shorter) transcript → no duplicates', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const lines = fixtureLines('compact');
  const tPath = path.join(ctx.transcripts, `${SID}.jsonl`);
  fs.writeFileSync(tPath, lines.join('\n') + '\n');
  hook(ctx, { sid: SID, tPath });
  const before = sessionEvents(ctx.root)[0].events.length;
  fs.writeFileSync(tPath, lines.slice(0, 4).join('\n') + '\n'); // shorter
  hook(ctx, { sid: SID, tPath });
  fs.appendFileSync(tPath, lines.slice(4).join('\n') + '\n');
  hook(ctx, { sid: SID, tPath });
  const ev = sessionEvents(ctx.root)[0].events;
  assert.equal(ev.length, before);
  assertContinuous(ev);
  assert.match(fs.readFileSync(path.join(ctx.home, 'logs', 'capture.jsonl'), 'utf8'), /transcript_rewritten/);
});

test('unregistered repo → nothing written, exit 0', { skip: SKIP }, (t) => {
  const ctx = setup(t, { init: false });
  const tPath = path.join(ctx.transcripts, `${SID}.jsonl`);
  fs.writeFileSync(tPath, fixtureLines('basic').join('\n') + '\n');
  hook(ctx, { sid: SID, tPath });
  assert.equal(fs.existsSync(path.join(ctx.root, '.memory')), false);
  assert.match(fs.readFileSync(path.join(ctx.home, 'logs', 'capture.jsonl'), 'utf8'), /skip_unregistered/);
});

test('secrets on disk are [REDACTED]; thinking and file contents absent', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const tPath = path.join(ctx.transcripts, `${SID}.jsonl`);
  const extra = JSON.stringify({ type: 'user', uuid: 'u-secret', timestamp: '2026-10-21T10:00:00.000Z', message: { role: 'user', content: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 and postgres://admin:s3cretpass@db:5432/x' } });
  fs.writeFileSync(tPath, fixtureLines('basic').join('\n') + '\n' + extra + '\n');
  hook(ctx, { sid: SID, tPath });
  const raw = fs.readFileSync(sessionEvents(ctx.root)[0].file, 'utf8');
  for (const bad of ['ghp_', 's3cretpass', 'sk-ant-', 'SECRET_THINKING', 'FILE_CONTENT_SHOULD_NOT_APPEAR', 'DENIED_ENV_CONTENT']) {
    assert.ok(!raw.includes(bad), `${bad} on disk`);
  }
  assert.match(raw, /postgres:\/\/\[REDACTED\]@db/);
});

test('resume continues same file; SessionEnd marks ended; new session gets new file', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const tPath = path.join(ctx.transcripts, `${SID}.jsonl`);
  const lines = fixtureLines('basic');
  fs.writeFileSync(tPath, lines.slice(0, 6).join('\n') + '\n');
  hook(ctx, { sid: SID, tPath, event: 'SessionStart', extra: { source: 'startup' } });
  hook(ctx, { sid: SID, tPath, event: 'SessionEnd', extra: { reason: 'prompt_input_exit' } });
  assert.equal(index(ctx.root)[0].status, 'ended');
  fs.appendFileSync(tPath, lines.slice(6).join('\n') + '\n');
  hook(ctx, { sid: SID, tPath, event: 'SessionStart', extra: { source: 'resume' } });
  assert.equal(sessionEvents(ctx.root).length, 1);
  assert.equal(index(ctx.root)[0].status, 'active');
  const sid2 = 'bbbbbbbb-1111-4222-8333-444444444444';
  const t2 = path.join(ctx.transcripts, `${sid2}.jsonl`);
  fs.writeFileSync(t2, fixtureLines('compact').join('\n') + '\n');
  hook(ctx, { sid: sid2, tPath: t2 });
  assert.equal(sessionEvents(ctx.root).length, 2);
  assert.equal(index(ctx.root).length, 2);
});

test('SessionStart before transcript exists → no index entry, later Stop captures', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const tPath = path.join(ctx.transcripts, `${SID}.jsonl`);
  hook(ctx, { sid: SID, tPath, event: 'SessionStart', extra: { source: 'startup' } });
  assert.equal(fs.existsSync(path.join(ctx.root, '.memory', 'sessions', 'index.json')), false);
  fs.writeFileSync(tPath, fixtureLines('basic').join('\n') + '\n');
  hook(ctx, { sid: SID, tPath });
  assert.equal(sessionEvents(ctx.root)[0].events.length, 11);
});

test('sweep catches up from stored cursor; hook from a subdirectory works', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const tPath = path.join(ctx.transcripts, `${SID}.jsonl`);
  const lines = fixtureLines('basic');
  fs.writeFileSync(tPath, lines.slice(0, 5).join('\n') + '\n');
  fs.mkdirSync(path.join(ctx.root, 'sub'));
  hook(ctx, { sid: SID, tPath, cwd: path.join(ctx.root, 'sub') });
  fs.appendFileSync(tPath, lines.slice(5).join('\n') + '\n');
  const r = ctx.memo(['capture', '--sweep', '--verbose']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /swept 1 session\(s\)/);
  const ev = sessionEvents(ctx.root)[0].events;
  assert.equal(ev.length, 11);
  assertContinuous(ev);
});

test('path traversal in session id is rejected', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const tPath = path.join(ctx.transcripts, 'x.jsonl');
  fs.writeFileSync(tPath, fixtureLines('basic').join('\n') + '\n');
  hook(ctx, { sid: '../../evil', tPath });
  assert.equal(sessionEvents(ctx.root).length, 0);
});

test('bad stdin and missing transcript never fail', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['capture'], 'not json');
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  hook(ctx, { sid: SID, tPath: path.join(ctx.transcripts, 'missing.jsonl') });
});

test('repo path with spaces and non-ASCII', { skip: SKIP }, (t) => {
  const ctx = setup(t, { repoName: 'My Projects/मेमो' });
  const tPath = path.join(ctx.transcripts, `${SID}.jsonl`);
  fs.writeFileSync(tPath, fixtureLines('error-then-fix').join('\n') + '\n');
  hook(ctx, { sid: SID, tPath });
  const ev = sessionEvents(ctx.root)[0].events;
  assert.equal(ev.length, 11);
  const repos = JSON.parse(fs.readFileSync(path.join(ctx.home, 'repos.json'), 'utf8'));
  assert.equal(repos.length, 1);
  assert.ok(repos[0].root.endsWith('My Projects/मेमो'));
});

test('memo init registers once (idempotent)', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['init']);
  assert.match(r.stdout, /skipped {2}repo registered/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.home, 'repos.json'), 'utf8')).length, 1);
  assert.ok(fs.existsSync(path.join(ctx.root, '.memory', 'sessions')));
});

test('capture of 1 MB new transcript finishes under 1 s (in-process)', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  process.env.MEMO_HOME = ctx.home;
  t.after(() => { delete process.env.MEMO_HOME; });
  const { captureSession } = require('../src/capture/capture');
  const repos = require('../src/repos');
  const repo = repos.find(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ctx.root, encoding: 'utf8' }).trim());
  assert.ok(repo);
  const tPath = path.join(ctx.transcripts, `${SID}.jsonl`);
  const out = [];
  let size = 0;
  for (let i = 0; size < 1024 * 1024; i++) {
    const l = JSON.stringify({ type: 'assistant', uuid: `u${i}`, timestamp: '2026-10-21T10:00:00.000Z', message: { content: [{ type: 'text', text: `step ${i} `.repeat(30) }] } });
    out.push(l);
    size += l.length + 1;
  }
  fs.writeFileSync(tPath, out.join('\n') + '\n');
  const t0 = Date.now();
  const r = captureSession({ repo, sid: SID, transcriptPath: tPath, event: 'Stop' });
  const ms = Date.now() - t0;
  assert.equal(r.newEvents, out.length);
  assert.ok(ms < 1000, `took ${ms} ms`);
});
