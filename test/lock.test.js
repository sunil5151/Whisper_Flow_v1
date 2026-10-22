'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { acquire } = require('../src/lock');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-lock-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'cycle.lock');
}

test('a free lock is taken and the file carries pid and start time', (t) => {
  const file = tmp(t);
  const lock = acquire(file);
  assert.ok(lock, 'expected the lock');
  assert.equal(lock.recovered, false);
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(body.pid, process.pid);
  assert.match(body.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  lock.release();
  assert.equal(fs.existsSync(file), false);
});

test('a live lock makes the second caller skip', (t) => {
  const file = tmp(t);
  const first = acquire(file);
  assert.ok(first);
  assert.equal(acquire(file, { staleMs: 20 * 60 * 1000 }), null);
  first.release();
  const third = acquire(file);
  assert.ok(third);
  third.release();
});

test('a stale lock is taken over and reported as recovered', (t) => {
  const file = tmp(t);
  const first = acquire(file);
  assert.ok(first);
  const old = Date.now() - 25 * 60 * 1000;
  fs.utimesSync(file, new Date(old), new Date(old));
  const second = acquire(file, { staleMs: 20 * 60 * 1000 });
  assert.ok(second, 'a 25 min old lock must be recoverable');
  assert.equal(second.recovered, true);
  second.release();
});

test('release is idempotent and never throws', (t) => {
  const file = tmp(t);
  const lock = acquire(file);
  lock.release();
  lock.release();
  assert.equal(fs.existsSync(file), false);
});
