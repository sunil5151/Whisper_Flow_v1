'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const records = require('../src/store/records');
const sessions = require('../src/store/sessions');
const { buildContext, MAX_CHARS } = require('../src/context');

const MEMO = path.join(__dirname, '..', 'bin', 'memo.js');
const HAS_GIT = !spawnSync('git', ['--version'], { windowsHide: true }).error;

function tmp(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-context-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

test('context stays under 8,000 chars with 200 records', (t) => {
  const root = path.join(tmp(t), 'repo');
  const types = ['task', 'error', 'decision', 'intent'];
  const statuses = { task: 'open', error: 'observed', decision: 'active', intent: 'active' };
  const lines = [];
  for (let i = 0; i < 200; i++) {
    const type = types[i % types.length];
    const statement = `${type} number ${i} `.repeat(15);
    lines.push({ op: 'create', id: records.makeId(type, statement, 'x'), type, ts: `2026-10-25T10:${String(i % 60).padStart(2, '0')}:00.000+05:30`, title: statement, statement, status: statuses[type] });
  }
  records.append(root, lines);
  sessions.saveIndex(root, [{ sid: 's1', date: '2026-10-25', end: '2026-10-25T11:00:00.000+05:30', events: 3, processedThrough: 3, summary: 'x'.repeat(2000) }]);
  const text = buildContext(root);
  assert.ok(text.length <= MAX_CHARS, `got ${text.length}`);
  assert.match(text, /Open tasks:/);
  assert.match(text, /Full detail: \.memory\/PROJECT_STATE\.md\n$/);
  assert.equal((text.match(/^- task /gm) || []).length, 10);
});

test('context wording is factual (no imperatives) and includes recent sessions', (t) => {
  const root = path.join(tmp(t), 'repo');
  records.append(root, [{ op: 'create', id: 'D-1', type: 'decision', ts: '2026-10-25T10:00:00.000+05:30', statement: 'Keep Node', status: 'active' }]);
  sessions.saveIndex(root, [{ sid: 'abcdef1234', date: '2026-10-25', end: '2026-10-25T11:00:00.000+05:30', events: 2, processedThrough: 2, summary: 'Set up capture.' }]);
  const text = buildContext(root);
  assert.match(text, /Active decisions:\n- Keep Node \(D-1\)/);
  assert.match(text, /2026-10-25 abcdef12: Set up capture\./);
  assert.doesNotMatch(text, /\b(you must|always|never|ignore)\b/i);
});

test('SessionStart hook prints context for a registered repo, nothing otherwise', { skip: !HAS_GIT && 'git not installed' }, (t) => {
  const base = tmp(t);
  const root = path.join(base, 'repo with space');
  const other = path.join(base, 'other');
  fs.mkdirSync(root);
  fs.mkdirSync(other);
  const env = { ...process.env, MEMO_HOME: path.join(base, 'home'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const dir of [root, other]) execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  execFileSync(process.execPath, [MEMO, 'init'], { cwd: root, env, windowsHide: true });
  records.append(root, [{ op: 'create', id: 'T-1', type: 'task', ts: '2026-10-25T10:00:00.000+05:30', title: 'Write docs', statement: 'Write docs', status: 'open' }]);

  const hook = (cwd) => execFileSync(process.execPath, [MEMO, 'capture'], {
    cwd, env, windowsHide: true, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'sess-1', cwd, transcript_path: path.join(base, 'none.jsonl') })
  });
  assert.match(hook(root), /Write docs — open \(T-1\)/);
  assert.equal(hook(other), '');
  assert.match(execFileSync(process.execPath, [MEMO, 'context'], { cwd: root, env, windowsHide: true, encoding: 'utf8' }), /T-1/);
});

test('agent-file snapshot carries open items inline and warns when processing is behind', (t) => {
  const agents = require('../src/report/agents');
  const root = path.join(tmp(t), 'repo');
  records.append(root, [{ op: 'create', id: 'E-1', type: 'error', ts: '2026-10-20T10:00:00.000+05:30', statement: 'Task registration fails', status: 'observed' }]);
  const done = { sid: 'aaaaaaaa11', date: '2026-10-20', end: '2026-10-20T11:00:00.000+05:30', events: 2, processedThrough: 2, summary: 'Fixed capture.' };
  sessions.saveIndex(root, [done]);
  const fresh = agents.snapshot(root);
  assert.match(fresh, /### Snapshot \(sessions processed up to 2026-10-20\)/);
  assert.match(fresh, /Open errors:\n- Task registration fails — observed \(E-1\)/);
  assert.doesNotMatch(fresh, /Stale/);
  assert.equal(agents.snapshot(root), fresh, 'same data → same text');
  assert.match(fresh, /\nRecent sessions:\n- 2026-10-20 aaaaaaaa: Fixed capture\. → \.memory\/sessions\/2026\/10\/20\/aaaaaaaa11\.md\n/);
  assert.ok(fresh.indexOf('Recent sessions:') < fresh.indexOf('Open errors:'), 'sessions come first');

  sessions.saveIndex(root, [done, { sid: 'bbbbbbbb22', date: '2026-10-25', end: '2026-10-25T11:00:00.000+05:30', events: 5, processedThrough: 0 }]);
  assert.match(agents.snapshot(root), /> Stale: newer sessions are captured but not processed yet/);
});
