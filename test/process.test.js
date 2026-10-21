'use strict';

// `memo process` end to end with the mock provider: no key, no network.
//
// The synthetic session below is the contract the canned responses in
// test/fixtures/llm/ refer to:
//   e-aaaa0001 seq 1 user_prompt      "npm test is failing, fix it"
//   e-aaaa0002 seq 2 tool_call  Bash  "npm test"
//   e-aaaa0003 seq 3 tool_result Bash ok:false  (failing suite)
//   e-aaaa0004 seq 4 assistant_text   diagnosis
//   e-aaaa0005 seq 5 tool_call  Edit  src/redact.js
//   e-aaaa0006 seq 6 tool_result Edit ok:true
//   e-aaaa0007 seq 7 tool_call  Bash  "npm test"
//   e-aaaa0008 seq 8 tool_result Bash ok:true   (passing suite)
//   e-aaaa0009 seq 9 assistant_text   "All 15 tests pass now."

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

const SID = 'cccccccc-1111-4222-8333-444444444444';
const SID2 = 'dddddddd-1111-4222-8333-444444444444';
const DATE = '2026-10-21';

function events(sid = SID) {
  const at = (n) => '2026-10-21T09:0' + n + ':00.000+05:30';
  const base = (seq, id, type, extra) => ({ v: 1, id, sid, seq, ts: at(seq), agent: 'claude-code', type, ...extra });
  return [
    base(1, 'e-aaaa0001', 'user_prompt', { text: 'npm test is failing, fix it' }),
    base(2, 'e-aaaa0002', 'tool_call', { tool: 'Bash', text: 'npm test' }),
    base(3, 'e-aaaa0003', 'tool_result', { tool: 'Bash', ok: false, text: '# pass 14\n# fail 1' }),
    base(4, 'e-aaaa0004', 'assistant_text', { text: 'The redact test fails because the sk- pattern is too short. Fixing src/redact.js.' }),
    base(5, 'e-aaaa0005', 'tool_call', { tool: 'Edit', text: 'src/redact.js (-1 +1 lines)' }),
    base(6, 'e-aaaa0006', 'tool_result', { tool: 'Edit', ok: true, text: 'ok' }),
    base(7, 'e-aaaa0007', 'tool_call', { tool: 'Bash', text: 'npm test' }),
    base(8, 'e-aaaa0008', 'tool_result', { tool: 'Bash', ok: true, text: '# tests 15\n# pass 15\n# fail 0' }),
    base(9, 'e-aaaa0009', 'assistant_text', { text: 'All 15 tests pass now.' })
  ];
}

function setup(t, { config: configPatch = {}, sessions: extraSessions = [] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-proc-test-'));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, MEMO_HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  delete env.MEMO_MOCK_LLM;
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true, env });

  const memo = (args, extraEnv) => spawnSync(process.execPath, [MEMO, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, env: { ...env, ...extraEnv }
  });
  assert.equal(memo(['init']).status, 0);

  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    v: 1, provider: 'mock', model: 'claude-haiku-5-5', ...configPatch
  }, null, 2) + '\n');

  const index = [];
  const all = [{ sid: SID, list: events(SID) }, ...extraSessions];
  for (const { sid, list } of all) {
    const dir = path.join(root, '.memory', 'sessions', '2026', '10', '21');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sid + '.jsonl'), list.map((e) => JSON.stringify(e)).join('\n') + '\n');
    index.push({
      sid, agent: 'claude-code', date: DATE, start: list[0].ts, end: list[list.length - 1].ts,
      events: list.length, processedThrough: 0, summary: '', status: 'ended'
    });
  }
  fs.writeFileSync(path.join(root, '.memory', 'sessions', 'index.json'), JSON.stringify(index, null, 2) + '\n');

  return { base, root, home, memo, env };
}

function recordLines(root, file) {
  const p = path.join(root, '.memory', 'records', file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function allRecords(root) {
  const dir = path.join(root, '.memory', 'records');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => recordLines(root, f));
}

function usageLines(home) {
  const p = path.join(home, 'logs', 'usage.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function index(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.memory', 'sessions', 'index.json'), 'utf8'));
}

function jobs(home, root) {
  const repos = JSON.parse(fs.readFileSync(path.join(home, 'repos.json'), 'utf8'));
  const file = path.join(home, 'state', repos[0].id, 'jobs.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function summaryFile(root, sid = SID) {
  return path.join(root, '.memory', 'sessions', '2026', '10', '21', sid + '.md');
}

test('--dry-run reports events, tokens and cost and makes zero provider calls', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['process', '--dry-run'], { MEMO_MOCK_LLM: 'decision' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /new events 9/);
  assert.match(r.stdout, /estimated input tokens \d/);
  assert.match(r.stdout, /estimated cost ≈ \$/);
  assert.match(r.stdout, /no API call was made \(--dry-run\)/);
  assert.deepEqual(usageLines(ctx.home), []);
  assert.deepEqual(allRecords(ctx.root), []);
  assert.equal(index(ctx.root)[0].processedThrough, 0);
  assert.equal(fs.existsSync(summaryFile(ctx.root)), false);
});

test('a decision is stored with evidence, job, source and a session summary', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['process'], { MEMO_MOCK_LLM: 'decision' });
  assert.equal(r.status, 0, r.stderr);

  const decisions = recordLines(ctx.root, 'decisions.jsonl');
  assert.equal(decisions.length, 1);
  const d = decisions[0];
  assert.equal(d.op, 'create');
  assert.match(d.id, /^D-[0-9a-f]{8}$/);
  assert.equal(d.type, 'decision');
  assert.equal(d.status, 'active');
  assert.equal(d.source, 'llm');
  assert.deepEqual(d.sessions, [SID]);
  assert.match(d.job, /^j-[0-9a-f]{10}$/);
  assert.deepEqual(d.evidence, ['e-aaaa0004']);
  // Every evidence id must exist in the session file.
  const ids = new Set(events().map((e) => e.id));
  for (const ev of d.evidence) assert.ok(ids.has(ev), ev + ' not in session file');

  assert.equal(index(ctx.root)[0].processedThrough, 9);
  assert.match(index(ctx.root)[0].summary, /redact test failed/);

  const md = fs.readFileSync(summaryFile(ctx.root), 'utf8');
  assert.match(md, /^# Session cccccccc — 2026-10-21/);
  assert.match(md, /Model: claude-haiku-5-5/);
  assert.match(md, /events 1–9 · job `j-/);
  assert.match(md, new RegExp('Records: `' + d.id + '`'));

  const usage = usageLines(ctx.home);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].model, 'claude-haiku-5-5');
  assert.equal(usage[0].in, 4200);
  assert.ok(usage[0].costEst > 0);
  assert.match(r.stdout, /this month: 1 call/);

  const job = Object.values(jobs(ctx.home, ctx.root))[0];
  assert.equal(job.status, 'applied');
  assert.equal(job.from, 0);
  assert.equal(job.to, 9);
});

test('a second run finds no new events: no call, no new records', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  assert.equal(ctx.memo(['process'], { MEMO_MOCK_LLM: 'decision' }).status, 0);
  const before = { records: allRecords(ctx.root).length, usage: usageLines(ctx.home).length };
  const md = fs.readFileSync(summaryFile(ctx.root), 'utf8');

  const r = ctx.memo(['process'], { MEMO_MOCK_LLM: 'decision' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no_new_data/);
  assert.equal(allRecords(ctx.root).length, before.records);
  assert.equal(usageLines(ctx.home).length, before.usage, 'a no-data run must not call the API');
  assert.equal(fs.readFileSync(summaryFile(ctx.root), 'utf8'), md, 'summary must stay byte-identical');
});

test('an overclaimed verified/done is downgraded on disk', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  assert.equal(ctx.memo(['process'], { MEMO_MOCK_LLM: 'error-fixed-overclaim' }).status, 0);
  const err = recordLines(ctx.root, 'errors.jsonl')[0];
  assert.equal(err.status, 'resolved_unverified');
  assert.equal(err.downgraded, true);
  const task = recordLines(ctx.root, 'tasks.jsonl')[0];
  assert.equal(task.status, 'implemented_unverified');
  assert.equal(task.downgraded, true);
  assert.equal(task.auto_exec, false);
  const md = fs.readFileSync(summaryFile(ctx.root), 'utf8');
  assert.match(md, /Gaps: no passing test result/);
});

test('verified survives when a passing tool_result backs it', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  assert.equal(ctx.memo(['process'], { MEMO_MOCK_LLM: 'error-fixed-verified' }).status, 0);
  const err = recordLines(ctx.root, 'errors.jsonl')[0];
  assert.equal(err.status, 'verified');
  assert.equal(err.downgraded, undefined);
});

test('items with unusable evidence or a bad update id are dropped', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['process'], { MEMO_MOCK_LLM: 'bad-evidence' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(recordLines(ctx.root, 'learnings.jsonl').length, 1);
  assert.match(r.stdout, /items dropped 1/);

  const ctx2 = setup(t);
  assert.equal(ctx2.memo(['process'], { MEMO_MOCK_LLM: 'bad-update' }).status, 0);
  assert.equal(recordLines(ctx2.root, 'tasks.jsonl').length, 0);
  assert.equal(recordLines(ctx2.root, 'facts.jsonl').length, 1);
});

test('malformed JSON twice → failed_permanent, nothing written, events untouched', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['process'], { MEMO_MOCK_LLM: 'malformed,malformed2' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /failed_permanent/);
  assert.deepEqual(allRecords(ctx.root), []);
  assert.equal(index(ctx.root)[0].processedThrough, 0, 'events stay unprocessed');
  assert.equal(fs.existsSync(summaryFile(ctx.root)), false);
  assert.equal(usageLines(ctx.home).length, 2, 'first call plus one repair call');
  assert.equal(Object.values(jobs(ctx.home, ctx.root))[0].status, 'failed_permanent');

  // A plain rerun refuses to burn more tokens on it; --retry-failed tries again.
  const again = ctx.memo(['process'], { MEMO_MOCK_LLM: 'decision' });
  assert.match(again.stdout, /failed_permanent \(use --retry-failed\)/);
  assert.equal(usageLines(ctx.home).length, 2);
  const retried = ctx.memo(['process', '--retry-failed'], { MEMO_MOCK_LLM: 'decision' });
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(recordLines(ctx.root, 'decisions.jsonl').length, 1);
  assert.equal(index(ctx.root)[0].processedThrough, 9);
});

test('malformed JSON then a valid repair reply succeeds', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['process'], { MEMO_MOCK_LLM: 'malformed,repair-ok' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(recordLines(ctx.root, 'learnings.jsonl').length, 1);
  assert.equal(usageLines(ctx.home).length, 2);
  assert.equal(index(ctx.root)[0].processedThrough, 9);
});

test('429 then success writes one set of records, no duplicates', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['process'], { MEMO_MOCK_LLM: '429,decision' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(recordLines(ctx.root, 'decisions.jsonl').length, 1);
  assert.equal(usageLines(ctx.home).length, 1, 'a failed attempt costs nothing');
  assert.equal(index(ctx.root)[0].processedThrough, 9);
});

test('401 is not retried: job stays pending, nothing is written', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['process'], { MEMO_MOCK_LLM: 'auth' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /api_failed/);
  assert.match(r.stdout, /auth: mock 401/);
  assert.deepEqual(allRecords(ctx.root), []);
  assert.equal(index(ctx.root)[0].processedThrough, 0);
  const job = Object.values(jobs(ctx.home, ctx.root))[0];
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 0, 'an auth failure is not the job’s fault');
});

test('a repeatedly failing retryable job ends as failed_retryable', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  for (let i = 0; i < 5; i++) {
    assert.equal(ctx.memo(['process'], { MEMO_MOCK_LLM: 'timeout' }).status, 0);
  }
  const job = Object.values(jobs(ctx.home, ctx.root))[0];
  assert.equal(job.attempts, 5);
  assert.equal(job.status, 'failed_retryable');
  assert.deepEqual(allRecords(ctx.root), []);
});

test('budget reached → no provider call at all', { skip: SKIP }, (t) => {
  const ctx = setup(t, { config: { monthlyBudgetUsd: 0 } });
  const r = ctx.memo(['process'], { MEMO_MOCK_LLM: 'decision' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /budget_reached/);
  assert.deepEqual(usageLines(ctx.home), []);
  assert.deepEqual(allRecords(ctx.root), []);
  assert.equal(index(ctx.root)[0].processedThrough, 0);
});

test('apiEnabled false and paused stop the run before any call', { skip: SKIP }, (t) => {
  for (const patch of [{ apiEnabled: false }, { paused: true }]) {
    const ctx = setup(t, { config: patch });
    const r = ctx.memo(['process'], { MEMO_MOCK_LLM: 'decision' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /api_disabled/);
    assert.deepEqual(usageLines(ctx.home), []);
  }
});

test('crash recovery: records already carry the job → advance, do not call again', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const { jobId } = require('../src/extract/process');
  const job = jobId(SID, 0, 9);
  const dir = path.join(ctx.root, '.memory', 'records');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'facts.jsonl'), JSON.stringify({
    op: 'create', id: 'F-11112222', type: 'fact', ts: '2026-10-21T09:10:00+05:30', job,
    status: 'active', statement: 'written before the crash', evidence: ['e-aaaa0003'], sessions: [SID], source: 'llm'
  }) + '\n');

  // 'auth' would fail if a call were attempted at all.
  const r = ctx.memo(['process'], { MEMO_MOCK_LLM: 'auth' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(index(ctx.root)[0].processedThrough, 9, 'applied job must advance the cursor');
  assert.equal(recordLines(ctx.root, 'facts.jsonl').length, 1, 'no second copy');
  assert.deepEqual(usageLines(ctx.home), [], 'no API call for an applied job');
});

test('maxCallsPerCycle caps the run and reports the backlog', { skip: SKIP }, (t) => {
  const ctx = setup(t, {
    config: { maxCallsPerCycle: 1 },
    sessions: [{ sid: SID2, list: events(SID2) }]
  });
  const r = ctx.memo(['process'], { MEMO_MOCK_LLM: 'decision' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /max_calls/);
  assert.match(r.stdout, /backlog 9 event\(s\)/);
  assert.equal(usageLines(ctx.home).length, 1);
  const idx = index(ctx.root);
  assert.equal(idx.find((e) => e.sid === SID).processedThrough, 9);
  assert.equal(idx.find((e) => e.sid === SID2).processedThrough, 0);
});

test('a small token cap splits one session into several jobs', { skip: SKIP }, (t) => {
  const ctx = setup(t, { config: { maxInputTokensPerCall: 1000 } });
  const r = ctx.memo(['process'], { MEMO_MOCK_LLM: 'decision,task' });
  assert.equal(r.status, 0, r.stderr);
  const calls = usageLines(ctx.home).length;
  assert.ok(calls >= 2, 'expected more than one batch, got ' + calls);
  const applied = Object.entries(jobs(ctx.home, ctx.root));
  assert.equal(applied.length, calls, 'one job per batch');
  for (const [, job] of applied) assert.equal(job.status, 'applied');
  assert.equal(new Set(applied.map(([id]) => id)).size, calls, 'job ids must differ per batch');
  assert.equal(index(ctx.root)[0].processedThrough, 9);
  const md = fs.readFileSync(summaryFile(ctx.root), 'utf8');
  assert.equal((md.match(/^## /gm) || []).length, calls, 'one summary paragraph per call');
});

test('a repeated create folds into an update instead of a duplicate id', { skip: SKIP }, (t) => {
  // Two sessions carrying the same events: the second reply repeats the first decision.
  const ctx = setup(t, { sessions: [{ sid: SID2, list: events(SID2) }] });
  const r = ctx.memo(['process'], { MEMO_MOCK_LLM: 'decision' });
  assert.equal(r.status, 0, r.stderr);

  const lines = recordLines(ctx.root, 'decisions.jsonl');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].op, 'create');
  assert.equal(lines[1].op, 'update');
  assert.equal(lines[0].id, lines[1].id);
  assert.notEqual(lines[0].job, lines[1].job);
  const records = require('../src/store/records');
  assert.equal(records.fold(ctx.root, 'decision').size, 1, 'folds back to one decision');
});

test('captured Claude Code events feed straight into process', { skip: SKIP }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-proc-cap-'));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, MEMO_HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  delete env.MEMO_MOCK_LLM;
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true, env });
  const memo = (args, input, extraEnv) => spawnSync(process.execPath, [MEMO, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, env: { ...env, ...extraEnv }, input
  });
  assert.equal(memo(['init']).status, 0);
  assert.equal(memo(['config', 'set', 'provider', 'mock']).status, 0);

  const sid = 'eeeeeeee-1111-4222-8333-444444444444';
  const tPath = path.join(base, sid + '.jsonl');
  fs.copyFileSync(path.join(FIX, 'error-then-fix.jsonl'), tPath);
  const hook = JSON.stringify({ session_id: sid, transcript_path: tPath, cwd: root, hook_event_name: 'Stop' });
  assert.equal(memo(['capture'], hook).status, 0);

  const idxFile = path.join(root, '.memory', 'sessions', 'index.json');
  const captured = JSON.parse(fs.readFileSync(idxFile, 'utf8'))[0];
  assert.ok(captured.events > 0, 'capture produced events');
  assert.equal(captured.processedThrough, 0);

  const dry = memo(['process', '--dry-run'], null, { MEMO_MOCK_LLM: 'empty' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp('new events ' + captured.events));

  const r = memo(['process'], null, { MEMO_MOCK_LLM: 'empty' });
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(fs.readFileSync(idxFile, 'utf8'))[0];
  assert.equal(after.processedThrough, captured.events, 'cursor advances over real captured events');
});

test('nothing sent to the provider matches a redaction pattern', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const previous = process.env.MEMO_HOME;
  process.env.MEMO_HOME = ctx.home;
  t.after(() => {
    if (previous === undefined) delete process.env.MEMO_HOME;
    else process.env.MEMO_HOME = previous;
  });

  const secrets = ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', 'hunter2hunter2'];
  const dir = path.join(ctx.root, '.memory', 'sessions', '2026', '10', '21');
  const list = events();
  // Secrets that slipped past capture must still be redacted before the call.
  list.push({
    v: 1, id: 'e-aaaa0010', sid: SID, seq: 10, ts: '2026-10-21T09:10:00.000+05:30', agent: 'claude-code',
    type: 'user_prompt',
    text: 'deploy with token ' + secrets[0] + ' and key ' + secrets[1] + ' and password=' + secrets[2]
  });
  // An event naming a denylisted path must not be sent at all.
  list.push({
    v: 1, id: 'e-aaaa0011', sid: SID, seq: 11, ts: '2026-10-21T09:11:00.000+05:30', agent: 'claude-code',
    type: 'tool_call', tool: 'Read', text: 'secrets/prod.json'
  });
  fs.writeFileSync(path.join(dir, SID + '.jsonl'), list.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const idx = index(ctx.root);
  idx[0].events = list.length;
  fs.writeFileSync(path.join(ctx.root, '.memory', 'sessions', 'index.json'), JSON.stringify(idx, null, 2) + '\n');

  const { processRepo } = require('../src/extract/process');
  const config = require('../src/config');
  const repos = require('../src/repos');
  const sent = [];
  const providerImpl = {
    name: 'spy',
    async complete({ system, user }) {
      sent.push(system + '\n' + user);
      return {
        text: JSON.stringify({ schema: 1, session_summary: 'spy run', items: [], gaps: [] }),
        usage: { input: 10, output: 10 }, model: 'claude-haiku-5-5', requestId: 'spy-1'
      };
    }
  };
  const repo = repos.find(root(ctx));
  return processRepo({ repo, cfg: config.load(), providerImpl }).then(() => {
    assert.ok(sent.length > 0, 'provider was called');
    const joined = sent.join('\n');
    for (const secret of secrets) {
      assert.ok(!joined.includes(secret), secret.slice(0, 8) + '… reached the provider payload');
    }
    assert.ok(joined.includes('[REDACTED]'), 'redaction marker expected in the payload');
    assert.ok(!joined.includes('e-aaaa0011'), 'event naming a denylisted path was sent');
    assert.ok(!joined.includes('secrets/prod.json'), 'denylisted path reached the provider');
    assert.ok(!/[A-Za-z]:[\\/]Users/.test(joined), 'absolute machine path in payload');
  });
});

function root(ctx) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ctx.root, encoding: 'utf8', windowsHide: true }).trim();
}

test('memo config prints settings and never the key', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const r = ctx.memo(['config'], { MEMO_API_KEY: 'sk-ant-secret-key-value-0000000000' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('sk-ant-secret-key-value-0000000000'), 'key printed');
  assert.match(r.stdout, /set \(…0000\)/);
  assert.match(r.stdout, /provider\s+"mock"/);
  assert.match(r.stdout, /price \(per 1M\)\s+in \$0\.1 \/ out \$0\.5/);

  assert.equal(ctx.memo(['config', 'set', 'monthlyBudgetUsd', '2']).status, 0);
  assert.match(ctx.memo(['config']).stdout, /monthlyBudgetUsd\s+2/);
  const bad = ctx.memo(['config', 'set', 'provider', 'telepathy']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /provider must be one of/);
  const unknown = ctx.memo(['config', 'set', 'nonsense', '1']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown config key/);
});
