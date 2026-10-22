'use strict';

// Validator rules of §6.3. Pure functions: no git, no key, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validate, parse } = require('../src/extract/validate');

const EVENTS = [
  { id: 'e-aaaa0001', seq: 1, type: 'user_prompt', text: 'npm test is failing, fix it' },
  { id: 'e-aaaa0002', seq: 2, type: 'tool_call', tool: 'Bash', text: 'npm test' },
  { id: 'e-aaaa0003', seq: 3, type: 'tool_result', tool: 'Bash', ok: false, text: '# pass 14\n# fail 1' },
  { id: 'e-aaaa0004', seq: 4, type: 'assistant_text', text: 'The sk- pattern is too short.' },
  { id: 'e-aaaa0005', seq: 5, type: 'tool_call', tool: 'Edit', text: 'src/redact.js (-1 +1 lines)' },
  { id: 'e-aaaa0008', seq: 8, type: 'tool_result', tool: 'Bash', ok: true, text: '# pass 15\n# fail 0' }
];

const EXISTING = new Map([
  ['T-1b2c3d4e', { id: 'T-1b2c3d4e', type: 'task', status: 'open', statement: 'Fix the redact pattern' }],
  ['D-7a1c09e2', { id: 'D-7a1c09e2', type: 'decision', status: 'active', statement: 'Keep .memory/ canonical' }]
]);

function ctx() {
  return { eventIds: new Set(EVENTS.map((e) => e.id)), events: EVENTS, existing: EXISTING };
}

function fixture(name) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'llm', name + '.json'), 'utf8'));
  return typeof raw.response === 'string' ? raw.response : JSON.stringify(raw.response);
}

test('decision fixture → one decision with rationale and evidence', () => {
  const r = validate(fixture('decision'), ctx());
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  const d = r.items[0];
  assert.equal(d.type, 'decision');
  assert.equal(d.op, 'create');
  assert.equal(d.status, 'active');
  assert.match(d.rationale, /16-character/);
  assert.deepEqual(d.evidence, ['e-aaaa0004']);
  assert.deepEqual(d.files, ['src/redact.js']);
  assert.ok(r.summary.length > 0 && r.summary.length <= 600);
  assert.equal(d.downgraded, undefined);
});

test('verified is allowed when evidence has a passing tool_result', () => {
  const r = validate(fixture('error-fixed-verified'), ctx());
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].type, 'error');
  assert.equal(r.items[0].status, 'verified');
  assert.equal(r.items[0].downgraded, undefined);
});

test('verified/done without a passing tool_result are downgraded', () => {
  const r = validate(fixture('error-fixed-overclaim'), ctx());
  assert.equal(r.items.length, 2);
  const err = r.items.find((i) => i.type === 'error');
  assert.equal(err.status, 'resolved_unverified');
  assert.equal(err.downgraded, true);
  const task = r.items.find((i) => i.type === 'task');
  assert.equal(task.status, 'implemented_unverified');
  assert.equal(task.downgraded, true);
  assert.deepEqual(r.gaps, ['no passing test result in these events']);
});

test('a rejected option stays rejected, not an active decision', () => {
  const r = validate(fixture('rejected-option'), ctx());
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].status, 'rejected');
});

test('items with an unknown evidence id are dropped, good ones kept', () => {
  const r = validate(fixture('bad-evidence'), ctx());
  assert.equal(r.items.length, 1);
  assert.match(r.items[0].statement, /first thing to break/);
  assert.equal(r.dropped.length, 1);
  assert.match(r.dropped[0].reason, /evidence/);
});

test('update with a nonexistent id is dropped', () => {
  const r = validate(fixture('bad-update'), ctx());
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].type, 'fact');
  assert.equal(r.dropped.length, 1);
  assert.match(r.dropped[0].reason, /does not exist/);
});

test('update with a mismatched type is dropped', () => {
  const r = validate({
    schema: 1,
    items: [{ op: 'update', id: 'T-1b2c3d4e', type: 'decision', status: 'active', evidence: ['e-aaaa0008'] }]
  }, ctx());
  assert.equal(r.items.length, 0);
  assert.match(r.dropped[0].reason, /type mismatch/);
});

test('update with a valid id and status is kept', () => {
  const r = validate({
    schema: 1,
    items: [{ op: 'update', id: 'T-1b2c3d4e', status: 'implemented_unverified', evidence: ['e-aaaa0008'] }]
  }, ctx());
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, 'T-1b2c3d4e');
  assert.equal(r.items[0].type, 'task');
  assert.equal(r.items[0].status, 'implemented_unverified');
});

test('record id counts as evidence, so an update can cite one', () => {
  const r = validate({
    schema: 1,
    items: [{ op: 'update', id: 'D-7a1c09e2', status: 'superseded', evidence: ['D-7a1c09e2'] }]
  }, ctx());
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].status, 'superseded');
});

test('intent needs user_prompt evidence', () => {
  const bad = validate({
    schema: 1,
    items: [{ op: 'create', type: 'intent', statement: 'Ship P2', status: 'active', evidence: ['e-aaaa0008'] }]
  }, ctx());
  assert.equal(bad.items.length, 0);
  assert.match(bad.dropped[0].reason, /user_prompt/);

  const good = validate({
    schema: 1,
    items: [{ op: 'create', type: 'intent', statement: 'Ship P2', status: 'active', evidence: ['e-aaaa0001'] }]
  }, ctx());
  assert.equal(good.items.length, 1);
});

test('unknown fields dropped, strings capped, bad file paths removed', () => {
  const r = validate(fixture('oversized'), ctx());
  assert.equal(r.items.length, 1);
  const item = r.items[0];
  assert.equal(item.surprise_field, undefined);
  assert.equal(item.statement.length, 500);
  assert.equal(r.summary.length, 600);
  assert.deepEqual(item.files, ['src/ok.js']);
});

test('at most 25 items survive', () => {
  const items = [];
  for (let i = 0; i < 40; i++) {
    items.push({ op: 'create', type: 'fact', statement: 'fact number ' + i, status: 'active', evidence: ['e-aaaa0003'] });
  }
  const r = validate({ schema: 1, items }, ctx());
  assert.equal(r.items.length, 25);
  assert.ok(r.notes.some((n) => /truncated to 25/.test(n)));
});

test('unknown type and unknown op are dropped', () => {
  const r = validate({
    schema: 1,
    items: [
      { op: 'create', type: 'vibe', statement: 'x', evidence: ['e-aaaa0003'] },
      { op: 'delete', type: 'fact', id: 'F-1', evidence: ['e-aaaa0003'] },
      { op: 'create', type: 'fact', statement: 'kept', evidence: ['e-aaaa0003'] }
    ]
  }, ctx());
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].statement, 'kept');
  assert.equal(r.dropped.length, 2);
});

test('invalid status: a create falls back to the type default, an update is dropped', () => {
  const r = validate({
    schema: 1,
    items: [
      { op: 'create', type: 'task', title: 'x', statement: 'do x', status: 'almost_done', evidence: ['e-aaaa0003'] },
      { op: 'update', id: 'T-1b2c3d4e', status: 'almost_done', evidence: ['e-aaaa0003'] }
    ]
  }, ctx());
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].status, 'open');
  assert.ok(r.notes.some((n) => /almost_done/.test(n)));
  assert.match(r.dropped[0].reason, /invalid status/);
});

test('task fields are normalized and auto_exec is never armed by the model', () => {
  const r = validate({
    schema: 1,
    items: [{
      op: 'create', type: 'task', title: 'Audit patterns', statement: 'Audit all patterns',
      status: 'open', priority: 'urgent', capability: 'wizard', effort_estimate: '1-2h',
      auto_exec: true, evidence: ['e-aaaa0004'], completion_evidence: ['e-nope', 'e-aaaa0008']
    }]
  }, ctx());
  const task = r.items[0];
  assert.equal(task.auto_exec, false);
  assert.equal(task.priority, 'unranked');
  assert.equal(task.capability, undefined);
  assert.equal(task.effort_basis, 'estimated');
  assert.deepEqual(task.completion_evidence, ['e-aaaa0008']);
});

test('create without a statement is dropped', () => {
  const r = validate({
    schema: 1,
    items: [{ op: 'create', type: 'error', status: 'observed', evidence: ['e-aaaa0003'] }]
  }, ctx());
  assert.equal(r.items.length, 0);
  assert.match(r.dropped[0].reason, /without statement/);
});

test('malformed JSON reports a parse error instead of throwing', () => {
  const r = validate(fixture('malformed'), ctx());
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(r.items.length, 0);
});

test('a fenced or prose-wrapped JSON object is still parsed', () => {
  const body = { schema: 1, session_summary: 'ok', items: [], gaps: [] };
  for (const text of ['```json\n' + JSON.stringify(body) + '\n```', 'Here you go:\n' + JSON.stringify(body)]) {
    const r = validate(text, ctx());
    assert.equal(r.ok, true, text.slice(0, 20));
    assert.equal(r.summary, 'ok');
  }
  assert.equal(parse('[]').ok, false);
  assert.equal(parse('').ok, false);
});
