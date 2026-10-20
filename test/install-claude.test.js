'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { addHooks, removeHooks, isMemoHandler } = require('../src/capture/install-claude');

const MEMO = path.join(__dirname, '..', 'bin', 'memo.js');

function setup(t, content) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-setup-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, '.claude', 'settings.json');
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  const run = (...args) => spawnSync(process.execPath, [MEMO, 'setup', 'claude', ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, MEMO_CLAUDE_SETTINGS: file, MEMO_HOME: path.join(base, 'home') }
  });
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const backups = () => fs.existsSync(path.dirname(file))
    ? fs.readdirSync(path.dirname(file)).filter((f) => f.includes('memo-backup')) : [];
  return { file, run, read, backups };
}

const EVENTS = ['SessionStart', 'Stop', 'PreCompact', 'SessionEnd'];

function memoHandlers(settings, event) {
  return (settings.hooks[event] || []).flatMap((g) => g.hooks || []).filter(isMemoHandler);
}

test('missing settings → created with 4 MEMO hooks (exec form, forward slashes)', (t) => {
  const s = setup(t);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  const cfg = s.read();
  for (const e of EVENTS) {
    const h = memoHandlers(cfg, e);
    assert.equal(h.length, 1, e);
    assert.equal(h[0].type, 'command');
    assert.ok(!h[0].command.includes('\\'));
    assert.equal(h[0].args[1], 'capture');
    assert.match(h[0].args[0], /bin\/memo\.js$/);
    assert.ok(path.isAbsolute(h[0].args[0]));
  }
  assert.equal(memoHandlers(cfg, 'Stop')[0].async, true);
  assert.equal(memoHandlers(cfg, 'PreCompact')[0].async, true);
  assert.equal(memoHandlers(cfg, 'SessionStart')[0].timeout, 10);
  assert.equal(memoHandlers(cfg, 'SessionEnd')[0].timeout, 5);
  assert.equal(s.backups().length, 0, 'no backup when no file existed');
});

test('existing hooks and settings preserved; backup written; second run skipped', (t) => {
  const other = { type: 'command', command: 'echo hi' };
  const s = setup(t, { model: 'x', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ matcher: '', hooks: [other] }], PreToolUse: [{ matcher: 'Bash', hooks: [other] }] } });
  assert.equal(s.run().status, 0);
  const cfg = s.read();
  assert.equal(cfg.model, 'x');
  assert.deepEqual(cfg.permissions, { allow: ['Bash(ls)'] });
  assert.deepEqual(cfg.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [other] }]);
  assert.deepEqual(cfg.hooks.Stop[0], { matcher: '', hooks: [other] });
  assert.equal(memoHandlers(cfg, 'Stop').length, 1);
  assert.equal(s.backups().length, 1);

  const r2 = s.run();
  assert.match(r2.stdout, /skipped {2}Stop/);
  assert.match(r2.stdout, /unchanged/);
  assert.equal(s.backups().length, 1, 'no backup when nothing changed');
  assert.deepEqual(s.read(), cfg);
});

test('--remove removes only MEMO entries', (t) => {
  const other = { type: 'command', command: 'echo hi' };
  const s = setup(t, { hooks: { Stop: [{ hooks: [other] }] } });
  s.run();
  const r = s.run('--remove');
  assert.equal(r.status, 0);
  assert.deepEqual(s.read(), { hooks: { Stop: [{ hooks: [other] }] } });
  assert.match(s.run('--remove').stdout, /nothing to remove/);
});

test('--dry-run writes nothing', (t) => {
  const s = setup(t, { a: 1 });
  const r = s.run('--dry-run');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /would created {2}SessionStart/);
  assert.deepEqual(s.read(), { a: 1 });
  assert.equal(s.backups().length, 0);
});

test('invalid JSON → abort, file unchanged', (t) => {
  const s = setup(t, '{ "hooks": ');
  const r = s.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(fs.readFileSync(s.file, 'utf8'), '{ "hooks": ');
  assert.equal(s.backups().length, 0);
});

test('moved install path → updated in place, not duplicated', () => {
  const stale = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['/old/place/bin/memo.js', 'capture'], async: true }] }] } };
  const { settings, report } = addHooks(stale);
  assert.deepEqual(report.find((r) => r[1] === 'Stop'), ['updated', 'Stop']);
  assert.equal(memoHandlers(settings, 'Stop').length, 1);
  assert.notEqual(memoHandlers(settings, 'Stop')[0].args[0], '/old/place/bin/memo.js');
});

test('--shell-form uses one quoted command string', () => {
  const { settings } = addHooks({}, { shellForm: true });
  const h = memoHandlers(settings, 'Stop')[0];
  assert.equal(h.args, undefined);
  assert.match(h.command, /^".+" ".+memo\.js" capture$/);
  assert.deepEqual(removeHooks(settings).settings, {});
});
