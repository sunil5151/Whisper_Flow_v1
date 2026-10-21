'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const records = require('../src/store/records');
const sessions = require('../src/store/sessions');
const state = require('../src/report/state');
const tasks = require('../src/report/tasks');

const GOLDEN = path.join(__dirname, 'fixtures', 'report', 'PROJECT_STATE.golden.md');
const NOW = new Date('2026-10-26T12:00:00+05:30');

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-state-test-'));
  const root = path.join(base, 'demo');
  fs.mkdirSync(root);
  const prevHome = process.env.MEMO_HOME;
  process.env.MEMO_HOME = path.join(base, 'home');
  t.after(() => {
    if (prevHome === undefined) delete process.env.MEMO_HOME; else process.env.MEMO_HOME = prevHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
  return root;
}

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

function seed(root) {
  sessions.saveIndex(root, [{
    sid: SID, agent: 'claude-code', date: '2026-10-25', start: '2026-10-25T10:00:00.000+05:30',
    end: '2026-10-25T11:00:00.000+05:30', events: 12, processedThrough: 12,
    summary: 'Fixed the CRLF hook bug and added tests.', status: 'ended'
  }]);
  const base = { job: 'j-1', sessions: [SID], source: 'llm', evidence: ['e-00000001'] };
  records.append(root, [
    { op: 'create', id: 'I-00000001', type: 'intent', ts: '2026-10-25T10:01:00.000+05:30', ...base, statement: 'Ship MEMO MVP by 29 Oct', status: 'active' },
    { op: 'create', id: 'T-00000001', type: 'task', ts: '2026-10-25T10:02:00.000+05:30', ...base, title: 'Write README', statement: 'Write README', status: 'open', priority: 'normal', effort_estimate: '30-60m', capability: 'low' },
    { op: 'create', id: 'T-00000002', type: 'task', ts: '2026-10-25T10:03:00.000+05:30', ...base, title: 'Fix hook on Windows', statement: 'Fix hook on Windows', status: 'open', priority: 'high', effort_estimate: '1-2h', capability: 'medium' },
    { op: 'create', id: 'T-00000003', type: 'task', ts: '2026-10-25T10:04:00.000+05:30', ...base, title: 'Add capture', statement: 'Add capture', status: 'implemented_unverified', downgraded: true },
    { op: 'create', id: 'T-00000004', type: 'task', ts: '2026-10-25T10:05:00.000+05:30', ...base, title: 'Old chore', statement: 'Old chore', status: 'done' },
    { op: 'create', id: 'E-00000001', type: 'error', ts: '2026-10-25T10:06:00.000+05:30', ...base, statement: 'post-commit hook fails with CRLF', status: 'verified', evidence: ['e-00000002'] },
    { op: 'create', id: 'E-00000002', type: 'error', ts: '2026-10-25T10:07:00.000+05:30', ...base, statement: 'npm test cannot find dir', status: 'observed' },
    { op: 'create', id: 'D-00000001', type: 'decision', ts: '2026-10-25T10:08:00.000+05:30', ...base, statement: 'Keep .memory/ as canonical folder', rationale: 'avoids migration', status: 'active' },
    { op: 'create', id: 'D-00000002', type: 'decision', ts: '2026-10-25T10:09:00.000+05:30', ...base, statement: 'Use SQLite', status: 'rejected' },
    { op: 'create', id: 'L-00000001', type: 'learning', ts: '2026-10-25T10:10:00.000+05:30', ...base, statement: 'Git hooks need LF endings', status: 'active' },
    { op: 'create', id: 'Q-00000001', type: 'question', ts: '2026-10-25T10:11:00.000+05:30', ...base, statement: 'Does AtLogOn need admin?', status: 'open' }
  ]);
}

test('PROJECT_STATE.md matches the golden file and rerenders byte-identically', (t) => {
  const root = setup(t);
  seed(root);
  const text = state.renderState(root, { now: NOW });
  const body = (s) => s.split('\n').filter((_, i) => i !== 1).join('\n');
  if (process.env.MEMO_UPDATE_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, text);
  }
  assert.equal(body(text), body(fs.readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n')));
  assert.equal(state.renderState(root, { now: NOW }), text);
});

test('unchanged body keeps the previous Generated line (no noise diff)', (t) => {
  const root = setup(t);
  seed(root);
  assert.equal(state.writeState(root, { now: NOW }), true);
  const first = fs.readFileSync(state.statePath(root), 'utf8');
  assert.equal(state.writeState(root, { now: new Date('2026-10-27T09:00:00+05:30') }), false);
  assert.equal(fs.readFileSync(state.statePath(root), 'utf8'), first);
  assert.equal(tasks.writeTasks(root, { now: NOW }), true);
  assert.equal(tasks.writeTasks(root, { now: new Date('2026-10-28T09:00:00+05:30') }), false);
});

test('downgraded items appear under "Implemented, not verified"', (t) => {
  const root = setup(t);
  seed(root);
  const text = state.renderState(root, { now: NOW });
  const section = text.split('## Implemented, not verified')[1].split('\n## ')[0];
  assert.match(section, /Add capture · implemented_unverified \(downgraded\) · `T-00000003`/);
  const verified = text.split('## Verified fixes')[1].split('\n## ')[0];
  assert.doesNotMatch(verified, /T-00000003/);
});

test('open tasks are ordered by priority, rejected decisions are hidden', (t) => {
  const root = setup(t);
  seed(root);
  const text = state.renderState(root, { now: NOW });
  assert.ok(text.indexOf('T-00000002') < text.indexOf('T-00000001'));
  assert.doesNotMatch(text, /Use SQLite/);
});

test('report stays within 250 lines with many records', (t) => {
  const root = setup(t);
  const lines = [];
  for (let i = 0; i < 300; i++) {
    lines.push({ op: 'create', id: `T-${String(i).padStart(8, '0')}`, type: 'task', ts: '2026-10-25T10:00:00.000+05:30', title: `task ${i}`, statement: `task ${i}`, status: 'open' });
  }
  records.append(root, lines);
  const text = state.renderState(root, { now: NOW });
  assert.ok(text.split('\n').length <= 251, `got ${text.split('\n').length} lines`);
  assert.match(text, /… \d+ more/);
});

test('TASKS.md lists open tasks in a table and completed ones below', (t) => {
  const root = setup(t);
  seed(root);
  const text = tasks.renderTasks(root, { now: NOW });
  const [open, done] = text.split('## Completed');
  assert.match(open, /\| `T-00000002` \| Fix hook on Windows \| open \| high \| 1-2h \| medium \|/);
  assert.match(open, /T-00000003/);
  assert.match(done, /`T-00000004` \| Old chore \| done/);
});
