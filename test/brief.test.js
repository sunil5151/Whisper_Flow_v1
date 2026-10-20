'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildBrief } = require('../src/brief');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-brief-test-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-home-test-'));
  const mem = path.join(root, '.memory');
  fs.mkdirSync(mem);
  fs.writeFileSync(path.join(mem, 'progress.md'), '# Progress\n');
  fs.writeFileSync(path.join(mem, 'decisions.md'), '# Decisions\n');
  fs.writeFileSync(path.join(mem, 'errors.md'), '# Errors\n');
  fs.writeFileSync(path.join(mem, 'next.md'), '# Next\n');
  const oldHome = process.env.MEMO_HOME;
  process.env.MEMO_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.MEMO_HOME;
    else process.env.MEMO_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { root, mem, home };
}

function entries(count, label) {
  return '# Entries\n' + Array.from({ length: count }, (_, i) => `\n## 2026-01-${String((i % 28) + 1).padStart(2, '0')} 12:00 · ${label} ${i}\n${'line '.repeat(8)}\n`).join('');
}

test('brief keeps newest entries first and excludes checked next items', (t) => {
  const { root, mem } = fixture(t);
  fs.writeFileSync(path.join(mem, 'decisions.md'), entries(3, 'decision'));
  fs.writeFileSync(path.join(mem, 'next.md'), '# Next\n- [ ] unfinished\n- [x] finished\n');
  const brief = buildBrief(root);
  assert.ok(brief.indexOf('decision 2') < brief.indexOf('decision 1'));
  assert.match(brief, /- \[ \] unfinished/);
  assert.doesNotMatch(brief, /- \\[x\\] finished/);
});

test('brief includes personal lines at the top when present', (t) => {
  const { root, home } = fixture(t);
  fs.writeFileSync(path.join(home, 'personal.md'), '# About me\n- first fact\n- second fact\n');
  const brief = buildBrief(root);
  assert.ok(brief.indexOf('## About me') < brief.indexOf('## Open next steps'));
  assert.ok(brief.indexOf('first fact') < brief.indexOf('## Open next steps'));
});

test('missing personal file omits About me section', (t) => {
  const { root } = fixture(t);
  assert.doesNotMatch(buildBrief(root), /## About me/);
});

test('brief is capped at 150 lines for large histories', (t) => {
  const { root, mem } = fixture(t);
  fs.writeFileSync(path.join(mem, 'progress.md'), entries(50, 'commit'));
  fs.writeFileSync(path.join(mem, 'decisions.md'), entries(50, 'decision'));
  fs.writeFileSync(path.join(mem, 'errors.md'), entries(50, 'error'));
  fs.writeFileSync(path.join(mem, 'next.md'), '# Next\n' + Array.from({ length: 50 }, (_, i) => `- [ ] next ${i}\n`).join(''));
  const brief = buildBrief(root);
  assert.ok(brief.split('\n').length - 1 <= 150);
});
