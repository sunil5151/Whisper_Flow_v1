'use strict';

// The console menu and the browse screens: pure rendering only, no readline here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const menu = require('../src/ui/menu');
const browse = require('../src/browse');

const SID_A = 'aaaaaaaa-1111-4222-8333-444444444444';
const SID_B = 'bbbbbbbb-1111-4222-8333-444444444444';

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-menu-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const dir = path.join(root, '.memory', 'sessions', '2026', '10', '21');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SID_A + '.jsonl'),
    [1, 2, 3].map((seq) => JSON.stringify({
      v: 1, id: 'e-aaaa000' + seq, sid: SID_A, seq, ts: '2026-10-21T09:0' + seq + ':00.000+05:30',
      agent: 'claude-code', type: 'assistant_text', text: 'x'
    })).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, SID_A + '.md'), '# Session aaaaaaaa\n\nfixed the redact regex\n');
  const older = path.join(root, '.memory', 'sessions', '2026', '10', '20');
  fs.mkdirSync(older, { recursive: true });
  fs.writeFileSync(path.join(older, SID_B + '.jsonl'), '');
  fs.writeFileSync(path.join(root, '.memory', 'sessions', 'index.json'), JSON.stringify([
    { sid: SID_A, agent: 'claude-code', date: '2026-10-21', start: '2026-10-21T09:01:00.000+05:30',
      end: '2026-10-21T09:03:00.000+05:30', events: 3, processedThrough: 3, summary: 'fixed the redact regex', status: 'ended' },
    { sid: SID_B, agent: 'claude-code', date: '2026-10-20', start: '2026-10-20T20:00:00.000+05:30',
      end: '2026-10-20T20:10:00.000+05:30', events: 5, processedThrough: 2, summary: '', status: 'ended' },
    { sid: 'cccccccc-1111-4222-8333-444444444444', agent: 'claude-code', date: '2026-10-19', deletedAt: '2026-10-21T10:00:00.000+05:30' }
  ], null, 2) + '\n');

  const records = path.join(root, '.memory', 'records');
  fs.mkdirSync(records, { recursive: true });
  fs.writeFileSync(path.join(records, 'tasks.jsonl'),
    JSON.stringify({ op: 'create', id: 'T-11112222', type: 'task', ts: '2026-10-21T09:10:00.000+05:30',
      title: 'write the installer', status: 'open', priority: 'high', effort_estimate: '1-2h',
      capability: 'medium', evidence: ['e-aaaa0001'], sessions: [SID_A] }) + '\n' +
    JSON.stringify({ op: 'create', id: 'T-33334444', type: 'task', ts: '2026-10-21T09:11:00.000+05:30',
      title: 'ship it', status: 'done', evidence: ['e-aaaa0002'], sessions: [SID_A] }) + '\n');
  fs.writeFileSync(path.join(records, 'decisions.jsonl'),
    JSON.stringify({ op: 'create', id: 'D-aaaa1111', type: 'decision', ts: '2026-10-21T09:12:00.000+05:30',
      statement: 'ship a VBS launcher', status: 'active', evidence: ['e-aaaa0003'], sessions: [SID_A] }) + '\n');
  return { root };
}

test('the main menu lists every entry and flags a paused install', () => {
  const text = menu.renderMenu({ paused: false }, 'C:/code/my-repo');
  for (const [key, label] of menu.ITEMS) assert.match(text, new RegExp('\\s' + key + '\\s+' + label));
  assert.match(text, /my-repo/);
  assert.equal(/PAUSED/.test(text), false);
  assert.match(menu.renderMenu({ paused: true }, 'C:/code/my-repo'), /\[PAUSED\]/);
  assert.ok(text.trimEnd().split('\n').length <= 25);
});

test('the clear screen warns before anything is typed', () => {
  const text = menu.renderClearMenu();
  assert.match(text, /dry run first/);
  assert.match(text, /type DELETE/);
  assert.match(text, /Older Git commits still contain this data/);
  assert.match(menu.renderPurgeNote(), /git filter-repo/);
  assert.ok(text.trimEnd().split('\n').length <= 25);
});

test('browse by date lists dates newest first, without deleted sessions', (t) => {
  const ctx = setup(t);
  const text = browse.renderDates(ctx.root);
  const dates = text.match(/2026-10-\d\d/g);
  assert.deepEqual(dates, ['2026-10-21', '2026-10-20']);
  assert.match(text, /2026-10-21\s+1 session\(s\) ·\s+3 events/);
});

test('the session list shows time, id, events, progress and summary', (t) => {
  const ctx = setup(t);
  const text = browse.renderSessions(ctx.root, '2026-10-21');
  assert.match(text, /09:01 · aaaaaaaa · claude-code ·\s+3 events · processed · fixed the redact regex/);
  assert.equal(/bbbbbbbb/.test(text), false, 'the other date is not listed');
  assert.match(browse.renderSessions(ctx.root, null), /bbbbbbbb .* 2\/5/);
});

test('show prints the summary, the file paths and the records of one session', (t) => {
  const ctx = setup(t);
  const text = browse.renderShow(ctx.root, 'aaaaaaaa');
  assert.match(text, /events file {2}\.memory\/sessions\/2026\/10\/21\/aaaaaaaa/);
  assert.match(text, /summary file \.memory\/sessions\/2026\/10\/21\/aaaaaaaa-1111-4222-8333-444444444444\.md/);
  assert.match(text, /fixed the redact regex/);
  assert.match(text, /T-11112222 task/);
  assert.match(text, /D-aaaa1111 decision/);
});

test('show refuses an unknown or ambiguous id instead of guessing', (t) => {
  const ctx = setup(t);
  assert.match(browse.renderShow(ctx.root, 'zzzz'), /no session matches zzzz/);
  assert.match(browse.renderShow(ctx.root, '../etc'), /invalid session id/);
});

test('tasks shows open work by default and everything with --all', (t) => {
  const ctx = setup(t);
  const open = browse.renderTasks(ctx.root, { all: false });
  assert.match(open, /T-11112222 · high {5}· open/);
  assert.equal(/T-33334444/.test(open), false);
  assert.match(browse.renderTasks(ctx.root, { all: true }), /T-33334444/);
});
