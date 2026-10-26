'use strict';

// Gemini (Antigravity) conversations are matched to the repo by their first tool path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const MEMO = path.join(__dirname, '..', 'bin', 'memo.js');
const SKIP = spawnSync('git', ['--version'], { windowsHide: true }).error && 'git not installed';
const SID = 'd4c4ea82-b31a-42ec-b131-f8dde9506265';

// Antigravity stores tool args as JSON-encoded strings.
const arg = (v) => JSON.stringify(v);

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-gemini-test-'));
  const root = path.join(base, 'repo');
  const agHome = path.join(base, 'antigravity');
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, MEMO_HOME: path.join(base, 'home'), ANTIGRAVITY_HOME: agHome, GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true, env });
  const memo = (args) => spawnSync(process.execPath, [MEMO, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, env });
  assert.equal(memo(['init']).status, 0);
  const conversation = (sid, steps) => {
    const dir = path.join(agHome, 'brain', sid, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), steps.map((s) => JSON.stringify(s)).join('\n') + '\n');
    return path.join(dir, 'transcript.jsonl');
  };
  return { base, root, memo, conversation };
}

test('sweep imports this repo\'s Antigravity conversations and pairs results with their calls', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const at = '2026-10-26T02:39:27Z';
  ctx.conversation(SID, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: at,
      content: '<USER_REQUEST>\ncan you see previous conversation\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, thinking: 'PRIVATE THOUGHT',
      tool_calls: [
        { name: 'read_file', args: { Path: arg(path.join(ctx.root, '.memory', 'PROJECT_STATE.md')), StartLine: '1' } },
        { name: 'run_command', args: { CommandLine: arg('npm test'), Cwd: arg(ctx.root) } }
      ] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: at, content: 'Created At: x\nCompleted At: y\nFILE CONTENTS' },
    { step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: at, content: 'Created At: x\nCompleted At: y\n176 pass' },
    { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, content: 'Yes, MEMO has the history.' }
  ]);
  ctx.conversation('2c8d2a1d-7a54-4964-bd5f-9d30cff70a90', [
    { step_index: 0, type: 'PLANNER_RESPONSE', created_at: at, tool_calls: [{ name: 'view_file', args: { AbsolutePath: arg(path.join(ctx.base, 'elsewhere', 'a.js')) } }] }
  ]);

  assert.equal(ctx.memo(['capture', '--sweep']).status, 0);
  const idx = JSON.parse(fs.readFileSync(path.join(ctx.root, '.memory', 'sessions', 'index.json'), 'utf8'));
  assert.deepEqual(idx.map((e) => [e.sid, e.agent]), [[SID, 'gemini']]);
  const [y, m, d] = idx[0].date.split('-');
  const events = fs.readFileSync(path.join(ctx.root, '.memory', 'sessions', y, m, d, SID + '.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.type, e.tool || null, e.text]), [
    ['user_prompt', null, 'can you see previous conversation'],
    ['tool_call', 'read_file', '.memory/PROJECT_STATE.md'],
    ['tool_call', 'run_command', 'npm test'],
    ['tool_result', 'run_command', '176 pass'],
    ['assistant_text', null, 'Yes, MEMO has the history.']
  ]);
  assert.doesNotMatch(JSON.stringify(events), /FILE CONTENTS|PRIVATE THOUGHT|ADDITIONAL_METADATA/);

  assert.equal(ctx.memo(['capture', '--sweep']).status, 0);
  const again = fs.readFileSync(path.join(ctx.root, '.memory', 'sessions', y, m, d, SID + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(again.length, events.length, 'a second sweep adds nothing');
});
