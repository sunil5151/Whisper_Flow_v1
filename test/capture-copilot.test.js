'use strict';

// Copilot agent sessions are found by git root on the sweep and stored like Claude Code ones.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const MEMO = path.join(__dirname, '..', 'bin', 'memo.js');
const SKIP = spawnSync('git', ['--version'], { windowsHide: true }).error && 'git not installed';
const SID = '1599537d-fb95-4a21-907c-b8ed56ad7737';

function ev(type, data, i) {
  return JSON.stringify({ type, data, id: 'id-' + i, timestamp: '2026-10-26T00:3' + i + ':00.000Z', parentId: null });
}

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-copilot-test-'));
  const root = path.join(base, 'repo');
  const other = path.join(base, 'other');
  const copilotHome = path.join(base, 'copilot');
  for (const d of [root, other, path.join(base, 'home')]) fs.mkdirSync(d, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, MEMO_HOME: path.join(base, 'home'), COPILOT_HOME: copilotHome, GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true, env });
  const memo = (args) => spawnSync(process.execPath, [MEMO, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, env });
  assert.equal(memo(['init']).status, 0);
  const session = (sid, gitRoot, lines) => {
    const dir = path.join(copilotHome, 'session-state', sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'id: ' + sid + '\ncwd: ' + gitRoot.toLowerCase() + '\ngit_root: ' + gitRoot + '\n');
    fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
    return path.join(dir, 'events.jsonl');
  };
  return { root, other, memo, session };
}

function stored(root) {
  const idx = JSON.parse(fs.readFileSync(path.join(root, '.memory', 'sessions', 'index.json'), 'utf8'));
  const entry = idx.find((e) => e.sid === SID);
  if (!entry) return { idx, entry, events: [] };
  const [y, m, d] = entry.date.split('-');
  const file = path.join(root, '.memory', 'sessions', y, m, d, SID + '.jsonl');
  return { idx, entry, events: fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

test('sweep imports this repo\'s Copilot sessions, incrementally, and skips other repos', { skip: SKIP }, (t) => {
  const ctx = setup(t);
  const file = ctx.session(SID, ctx.root, [
    ev('session.start', { sessionId: SID, context: { cwd: ctx.root } }, 0),
    ev('user.message', { content: 'purani chat mein kya baat hui', transformedContent: '<current_datetime>x</current_datetime>' }, 1),
    ev('tool.execution_start', { toolCallId: 'c1', toolName: 'view', arguments: { path: path.join(ctx.root, 'src', 'a.js') } }, 2),
    ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: 'FILE CONTENTS' } }, 3),
    ev('tool.execution_start', { toolCallId: 'c2', toolName: 'powershell', arguments: { command: 'npm test' } }, 4),
    ev('tool.execution_complete', { toolCallId: 'c2', success: false, result: { content: '1 failing' } }, 5),
    ev('assistant.message', { content: 'Tests fail in redact.', encryptedContent: 'SECRET-BLOB', toolRequests: [] }, 6)
  ]);
  ctx.session('0b21cd05-a0d3-4546-8f85-461c35a93cb3', ctx.other, [ev('user.message', { content: 'elsewhere' }, 1)]);

  assert.equal(ctx.memo(['capture', '--sweep']).status, 0);
  const first = stored(ctx.root);
  assert.equal(first.idx.length, 1, 'only this repo');
  assert.equal(first.entry.agent, 'copilot');
  assert.deepEqual(first.events.map((e) => [e.type, e.tool || null, e.text, e.ok]), [
    ['user_prompt', null, 'purani chat mein kya baat hui', undefined],
    ['tool_call', 'view', 'src/a.js', undefined],
    ['tool_call', 'powershell', 'npm test', undefined],
    ['tool_result', 'powershell', '1 failing', false],
    ['assistant_text', null, 'Tests fail in redact.', undefined]
  ]);
  assert.ok(first.events.every((e) => e.agent === 'copilot'));
  assert.doesNotMatch(JSON.stringify(first.events), /FILE CONTENTS|SECRET-BLOB|current_datetime/);

  const fwd = ctx.root.replace(/\\/g, '/');
  const spelled = [ctx.root, fwd, fwd.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()), 'file:///' + fwd.replace(':', '%3A')];
  fs.appendFileSync(file, [
    ev('tool.execution_start', { toolCallId: 'c3', toolName: 'list_sessions', arguments: { workspace: ctx.root } }, 8),
    ev('tool.execution_complete', { toolCallId: 'c3', success: true, result: { content: spelled.join(' | ') } }, 9)
  ].join('\n') + '\n');
  assert.equal(ctx.memo(['capture', '--sweep']).status, 0);
  const scrubbed = stored(ctx.root).events.slice(-2).map((e) => e.text).join('\n');
  assert.match(scrubbed, /<repo>/);
  for (const s of spelled) assert.ok(!scrubbed.toLowerCase().includes(s.replace('file:///', '').toLowerCase()), s);
  if (/^[A-Za-z]:/.test(ctx.root)) assert.ok(!scrubbed.includes(ctx.root.replace(/\\/g, '\\\\')), 'JSON-escaped path');

  fs.appendFileSync(file, ev('user.message', { content: 'aur kuch?' }, 7) + '\n');
  assert.equal(ctx.memo(['capture', '--sweep']).status, 0);
  assert.equal(ctx.memo(['capture', '--sweep']).status, 0);
  const second = stored(ctx.root);
  assert.equal(second.events.length, 8, 'only the new lines are added, nothing twice');
  assert.equal(second.events[7].text, 'aur kuch?');
  assert.equal(second.entry.events, 8);
});
