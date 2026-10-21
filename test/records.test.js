'use strict';

// Record op-log store (§6.2): ids, folding, open records, job guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const records = require('../src/store/records');

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-rec-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function line(extra) {
  return { op: 'create', type: 'decision', ts: '2026-10-22T14:15:00+05:30', job: 'j-1', status: 'active', ...extra };
}

test('ids use the type prefix and are stable for the same statement and evidence', () => {
  const a = records.makeId('decision', 'Keep .memory/ as canonical folder', 'e-3f2a9c1d');
  const b = records.makeId('decision', '  keep   .MEMORY/ as canonical folder  ', 'e-3f2a9c1d');
  assert.equal(a, b, 'statement normalization should ignore case and whitespace');
  assert.match(a, /^D-[0-9a-f]{8}$/);
  assert.notEqual(a, records.makeId('decision', 'Keep .memory/ as canonical folder', 'e-other01'));
  assert.notEqual(a, records.makeId('learning', 'Keep .memory/ as canonical folder', 'e-3f2a9c1d'));
  assert.match(records.makeId('task', 'x', 'e-1'), /^T-/);
  assert.match(records.makeId('intent', 'x', 'e-1'), /^I-/);
  assert.throws(() => records.makeId('nope', 'x', 'e-1'), /unknown record type/);
});

test('file names follow the plan layout', (t) => {
  const root = tempRoot(t);
  assert.equal(path.basename(records.filePath(root, 'decision')), 'decisions.jsonl');
  assert.equal(path.basename(records.filePath(root, 'error')), 'errors.jsonl');
  assert.equal(path.basename(records.filePath(root, 'learning')), 'learnings.jsonl');
  assert.equal(path.basename(records.filePath(root, 'fact')), 'facts.jsonl');
  assert.equal(path.basename(records.filePath(root, 'task')), 'tasks.jsonl');
  assert.equal(path.basename(records.filePath(root, 'question')), 'questions.jsonl');
  assert.equal(path.basename(records.filePath(root, 'intent')), 'intent.jsonl');
  assert.ok(records.filePath(root, 'task').includes(path.join('.memory', 'records')));
  assert.throws(() => records.filePath(root, 'nope'), /unknown record type/);
});

test('fold applies ops in file order: last op wins, delete removes', (t) => {
  const root = tempRoot(t);
  records.ensureDir(root);
  records.append(root, [
    line({ id: 'D-1', statement: 'first' }),
    line({ id: 'D-2', statement: 'second' }),
    { op: 'update', id: 'D-1', type: 'decision', ts: 'x', job: 'j-2', status: 'superseded' },
    { op: 'delete', id: 'D-2', type: 'decision', ts: 'x', job: 'j-3' }
  ]);
  const folded = records.fold(root, 'decision');
  assert.equal(folded.size, 1);
  const d1 = folded.get('D-1');
  assert.equal(d1.status, 'superseded');
  assert.equal(d1.statement, 'first', 'update must merge onto the create, not replace it');
  assert.equal(d1.op, undefined, 'folded records carry no op');
  assert.equal(folded.has('D-2'), false);
});

test('missing files fold to nothing and a torn line is skipped', (t) => {
  const root = tempRoot(t);
  assert.equal(records.fold(root, 'task').size, 0);
  assert.deepEqual(records.foldAll(root), []);
  records.ensureDir(root);
  fs.writeFileSync(records.filePath(root, 'task'),
    JSON.stringify(line({ id: 'T-1', type: 'task', status: 'open', statement: 'ok' })) + '\n{"op":"create","id":"T-2"\n');
  const folded = records.fold(root, 'task');
  assert.equal(folded.size, 1);
  assert.equal(folded.get('T-1').statement, 'ok');
});

test('openRecords skips terminal statuses and sorts newest first', (t) => {
  const root = tempRoot(t);
  records.ensureDir(root);
  records.append(root, [
    line({ id: 'D-old', ts: '2026-10-01T10:00:00+05:30', statement: 'old active' }),
    line({ id: 'D-new', ts: '2026-10-20T10:00:00+05:30', statement: 'new active' }),
    line({ id: 'D-rej', ts: '2026-10-21T10:00:00+05:30', statement: 'rejected', status: 'rejected' }),
    { op: 'create', id: 'T-done', type: 'task', ts: '2026-10-21T11:00:00+05:30', job: 'j-1', status: 'done', statement: 'done task' },
    { op: 'create', id: 'T-open', type: 'task', ts: '2026-10-19T11:00:00+05:30', job: 'j-1', status: 'open', statement: 'open task' },
    { op: 'create', id: 'E-ver', type: 'error', ts: '2026-10-21T12:00:00+05:30', job: 'j-1', status: 'verified', statement: 'fixed' },
    { op: 'create', id: 'Q-open', type: 'question', ts: '2026-10-18T12:00:00+05:30', job: 'j-1', status: 'open', statement: 'why?' }
  ]);
  const open = records.openRecords(root);
  assert.deepEqual(open.map((r) => r.id), ['D-new', 'T-open', 'Q-open', 'D-old']);
  assert.equal(records.openRecords(root, 2).length, 2);
  assert.equal(records.byId(root).size, 7, 'byId keeps terminal records too');
  assert.equal(records.isTerminal({ type: 'error', status: 'verified' }), true);
  assert.equal(records.isTerminal({ type: 'error', status: 'reopened' }), false);
});

test('hasJob finds a job id in any record file', (t) => {
  const root = tempRoot(t);
  records.ensureDir(root);
  assert.equal(records.hasJob(root, 'j-abc'), false);
  records.append(root, [{ op: 'create', id: 'F-1', type: 'fact', ts: 'x', job: 'j-abc', status: 'active', statement: 'f' }]);
  assert.equal(records.hasJob(root, 'j-abc'), true);
  assert.equal(records.hasJob(root, 'j-other'), false);
  assert.equal(records.hasJob(root, null), false);
});

test('append refuses lines without a known type or op', (t) => {
  const root = tempRoot(t);
  records.ensureDir(root);
  assert.throws(() => records.append(root, [{ op: 'create', id: 'X-1', type: 'nope' }]), /known type/);
  assert.throws(() => records.append(root, [{ op: 'sing', id: 'F-1', type: 'fact' }]), /op create\|update\|delete/);
});

test('append writes one complete JSON line per record', (t) => {
  const root = tempRoot(t);
  records.ensureDir(root);
  records.append(root, [line({ id: 'D-1', statement: 'a' }), line({ id: 'D-2', statement: 'b' })]);
  records.append(root, [line({ id: 'D-3', statement: 'c' })]);
  const raw = fs.readFileSync(records.filePath(root, 'decision'), 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  for (const l of lines) assert.ok(JSON.parse(l).id);
});
