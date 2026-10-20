'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalize, relPath } = require('../src/capture/claude');

const FIX = path.join(__dirname, 'fixtures', 'claude');
const ROOT = 'C:\\Users\\dev\\My Projects\\demo';
const HOME = 'C:\\Users\\dev';

function run(name) {
  const tools = {};
  const lines = fs.readFileSync(path.join(FIX, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean);
  const out = [];
  lines.forEach((raw, i) => {
    for (const e of normalize(JSON.parse(raw), { sid: 'sid-test', root: ROOT, home: HOME, tools, lineNo: i + 1, raw })) out.push(e);
  });
  return out;
}

function shape(events) {
  return events.map((e) => (e.tool ? `${e.type}:${e.tool}` : e.type));
}

test('basic fixture → expected envelope types', () => {
  assert.deepEqual(shape(run('basic')), [
    'user_prompt', 'assistant_text', 'tool_call:Read', 'tool_call:Edit', 'tool_result:Edit',
    'tool_call:Bash', 'tool_result:Bash', 'tool_call:Write', 'tool_result:Write', 'assistant_text', 'user_prompt'
  ]);
});

test('error-then-fix fixture → failing then passing tool results', () => {
  const ev = run('error-then-fix');
  assert.deepEqual(shape(ev), [
    'user_prompt', 'tool_call:Bash', 'tool_result:Bash', 'assistant_text', 'tool_call:Edit', 'tool_result:Edit',
    'tool_call:Bash', 'tool_result:Bash', 'assistant_text', 'system', 'user_prompt'
  ]);
  const results = ev.filter((e) => e.type === 'tool_result' && e.tool === 'Bash');
  assert.equal(results[0].ok, false);
  assert.equal(results[0].truncated, true);
  assert.ok(results[0].text.length <= 500 + 300 + 3);
  assert.match(results[0].text, /# fail 1/, 'tail of long output kept');
  assert.equal(results[1].ok, true);
});

test('compact fixture → one compaction marker, slash command, no summary text', () => {
  const ev = run('compact');
  assert.deepEqual(shape(ev), [
    'user_prompt', 'assistant_text', 'system', 'system', 'user_prompt', 'tool_call:Glob', 'tool_result:Glob', 'assistant_text'
  ]);
  assert.equal(ev.filter((e) => e.text === 'context compacted').length, 1);
  assert.equal(ev[2].text, 'command /compact');
});

test('thinking, file contents, write contents, sidechain, meta, reminders never appear', () => {
  const all = JSON.stringify(['basic', 'error-then-fix', 'compact'].flatMap(run));
  for (const bad of ['SECRET_THINKING', 'FILE_CONTENT_SHOULD_NOT_APPEAR', 'WRITE_CONTENT_SHOULD_NOT_APPEAR',
    'SIDECHAIN_SHOULD_NOT_APPEAR', 'DENIED_ENV_CONTENT', 'system-reminder', 'Session linked', 'SUMMARY_TEXT', 'Compacted']) {
    assert.ok(!all.includes(bad), `${bad} leaked`);
  }
});

test('denylisted path: both call and result dropped', () => {
  const all = JSON.stringify(run('basic'));
  assert.ok(!all.includes('.env'));
});

test('secrets redacted, absolute paths hidden', () => {
  const all = JSON.stringify(['basic', 'error-then-fix'].flatMap(run));
  assert.ok(!all.includes('sk-ant-'));
  assert.ok(!all.includes('hunter2'));
  assert.ok(!/Users[\\/]+dev/.test(all), 'absolute home path leaked');
  assert.match(all, /\[REDACTED\]/);
});

test('envelope fields: id format, ts with offset, src line, stable ids', () => {
  const a = run('basic');
  const b = run('basic');
  assert.deepEqual(a.map((e) => e.id), b.map((e) => e.id));
  assert.equal(new Set(a.map((e) => e.id)).size, a.length, 'ids unique');
  for (const e of a) {
    assert.match(e.id, /^e-[0-9a-f]{8}$/);
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    assert.equal(e.v, 1);
    assert.equal(e.agent, 'claude-code');
    assert.equal(typeof e.src.line, 'number');
  }
});

test('relPath: windows + posix, inside/outside, traversal', () => {
  const win = { root: 'C:/Users/dev/My Projects/मेमो' };
  assert.equal(relPath('C:\\Users\\dev\\My Projects\\मेमो\\src\\a.js', win), 'src/a.js');
  assert.equal(relPath('c:/users/dev/my projects/मेमो/src/a.js', win), 'src/a.js');
  assert.equal(relPath('C:\\Users\\dev\\other\\a.js', win), '<outside-repo>');
  assert.equal(relPath('C:/Users/dev/My Projects/मेमो/../x.js', win), '<outside-repo>');
  const nix = { root: '/home/u/repo', cwd: '/home/u/repo/src' };
  assert.equal(relPath('/home/u/repo/src/x.js', nix), 'src/x.js');
  assert.equal(relPath('x.js', nix), 'src/x.js');
  assert.equal(relPath('../../etc/passwd', nix), '<outside-repo>');
  assert.equal(relPath('/home/u/repo2/x.js', nix), '<outside-repo>');
});

test('tolerant: unknown or malformed shapes produce no events and no throw', () => {
  const ctx = { sid: 's', root: '/r', tools: {}, lineNo: 1 };
  for (const line of [null, 1, {}, { type: 'user' }, { type: 'assistant', message: { content: 5 } },
    { type: 'user', message: { content: [null, { type: 'tool_result' }] } }, { type: 'summary', summary: 'x' }]) {
    assert.doesNotThrow(() => normalize(line, ctx));
  }
  assert.deepEqual(normalize({ type: 'summary', summary: 'x' }, ctx), []);
});
