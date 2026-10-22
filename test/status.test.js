'use strict';

// `memo status` / `memo doctor` render from local files only — no network, no key.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshRequire() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(path.sep + 'src' + path.sep)) delete require.cache[key];
  }
  return {
    status: require('../src/status'),
    config: require('../src/config'),
    cycle: require('../src/cycle')
  };
}

function setup(t, { logs = [], statusJson = null, config: cfg = {}, repoRoot = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-status-test-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  const saved = { MEMO_HOME: process.env.MEMO_HOME, MEMO_CLAUDE_SETTINGS: process.env.MEMO_CLAUDE_SETTINGS };
  process.env.MEMO_HOME = home;
  process.env.MEMO_CLAUDE_SETTINGS = path.join(base, 'claude.json');
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(base, { recursive: true, force: true });
    freshRequire();
  });

  const root = repoRoot || path.join(base, 'my-repo');
  fs.mkdirSync(path.join(root, '.memory', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, '.memory', 'PROJECT_STATE.md'), '# state\n');
  fs.writeFileSync(path.join(root, '.memory', 'sessions', 'index.json'), JSON.stringify([
    { sid: 'aaaaaaaa-1111-4222-8333-444444444444', agent: 'claude-code', date: '2026-10-21', events: 9, processedThrough: 9 },
    { sid: 'bbbbbbbb-1111-4222-8333-444444444444', agent: 'claude-code', date: '2026-10-21', events: 4, processedThrough: 1 },
    { sid: 'cccccccc-1111-4222-8333-444444444444', agent: 'claude-code', date: '2026-10-20', deletedAt: '2026-10-21T10:00:00.000+05:30' }
  ], null, 2));

  fs.writeFileSync(path.join(home, 'repos.json'), JSON.stringify([
    { id: 'my-repo-12345678', root: root.replace(/\\/g, '/'), addedAt: '2026-10-20T10:00:00.000+05:30', enabled: true }
  ], null, 2));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 1, provider: 'mock', model: 'claude-haiku-5-5', ...cfg }, null, 2));
  if (logs.length) fs.writeFileSync(path.join(home, 'logs', 'cycles.jsonl'), logs.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(home, 'logs', 'usage.jsonl'), [
    { ts: new Date().toISOString().slice(0, 10) + 'T10:00:00.000+05:30', model: 'claude-haiku-5-5', in: 120000, out: 9000, costEst: 0.0165 },
    { ts: new Date().toISOString().slice(0, 10) + 'T10:30:00.000+05:30', model: 'claude-haiku-5-5', in: 80000, out: 5000, costEst: 0.0105 }
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (statusJson) fs.writeFileSync(path.join(home, 'status.json'), JSON.stringify(statusJson, null, 2));

  return { base, home, root, ...freshRequire() };
}

const NOW = new Date().toISOString().slice(0, 19) + '.000+00:00';

test('status renders from the logs in at most 20 lines', (t) => {
  const ctx = setup(t, {
    logs: [
      { ts: NOW, event: 'cycle_start', status: 'running' },
      { ts: NOW, event: 'repo', repo: 'my-repo', repoId: 'my-repo-12345678', newEvents: 9, jobs: 1, calls: 1, committed: 'abc1234', status: 'ok', ms: 900 },
      { ts: NOW, event: 'cycle_end', status: 'ok', repos: 1, ms: 950 }
    ],
    statusJson: {
      lastCycle: { ts: NOW, status: 'ok', ms: 950, repos: 1, calls: 1, newEvents: 9, committed: 1 },
      lastOk: NOW, lastFailed: { ts: '2026-10-26T22:15:00.000+05:30', reason: 'api_failed: timeout' },
      nextExpected: NOW
    }
  });
  const text = ctx.status.renderStatus(ctx.config.load());
  const lines = text.trimEnd().split('\n');
  assert.ok(lines.length <= 20, 'status must stay short, got ' + lines.length);
  assert.match(lines[0], /^MEMO {2}/);
  assert.match(lines[0], /mock\/claude-haiku-5-5/);
  assert.match(lines[0], /Paused: no/);
  assert.match(text, /Last cycle .* ok/);
  assert.match(text, /last failure 2026-10-26 22:15 api_failed: timeout/);
  assert.match(text, /This month: 2 calls · 0\.20M in \/ 0\.01M out · ≈ \$0\.03 of \$5 budget/);
  assert.match(text, /my-repo {2,}sessions 2 · unprocessed 3 · last commit abc1234/);
  assert.match(text, /state behind/);
  assert.match(text, /Logs: /);
});

test('status says so when nothing has run yet', (t) => {
  const ctx = setup(t);
  const text = ctx.status.renderStatus(ctx.config.load());
  assert.match(text, /Last cycle never/);
  assert.match(text, /last failure none/);
  assert.match(text, /last commit —/);
});

test('paused config shows in the header', (t) => {
  const ctx = setup(t, { config: { paused: true } });
  assert.match(ctx.status.renderStatus(ctx.config.load()), /Paused: yes/);
});

test('doctor reports the missing pieces with a fix hint each', async (t) => {
  const ctx = setup(t);
  const results = await ctx.status.checks(ctx.config.load(), { live: false });
  const by = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.equal(by.node.ok, true);
  assert.equal(by['claude hooks'].ok, false);
  assert.match(by['claude hooks'].fix, /memo setup claude/);
  assert.equal(by['last cycle'].ok, false, 'no cycle has run in this temp home');
  assert.equal(by.repos.ok, true);
  assert.equal(by.paused.ok, true);
  for (const r of results) {
    if (!r.ok) assert.ok(r.fix && r.fix.length > 0, r.name + ' needs a fix hint');
  }
  const rendered = ctx.status.renderDoctor(results);
  assert.match(rendered, /^(PASS|FAIL) {2}/m);
  assert.match(rendered, /checks (passed|failed)/);
});

test('doctor passes the claude-hooks check once the hooks are installed', async (t) => {
  const ctx = setup(t);
  fs.writeFileSync(process.env.MEMO_CLAUDE_SETTINGS, JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node', args: ['C:/memo/bin/memo.js', 'capture'] }] }] }
  }, null, 2));
  const results = await ctx.status.checks(ctx.config.load(), { live: false });
  const hooks = results.find((r) => r.name === 'claude hooks');
  assert.equal(hooks.ok, true);
  assert.match(hooks.detail, /SessionStart/);
});

test('doctor --live is the only check that calls a provider', async (t) => {
  const ctx = setup(t, { config: { provider: 'mock', apiKeyEnv: 'MEMO_TEST_KEY' } });
  const saved = process.env.MEMO_TEST_KEY;
  process.env.MEMO_TEST_KEY = 'test-key-1234';
  t.after(() => { if (saved === undefined) delete process.env.MEMO_TEST_KEY; else process.env.MEMO_TEST_KEY = saved; });
  const offline = await ctx.status.checks(ctx.config.load(), { live: false });
  assert.equal(offline.some((r) => r.name === 'api ping'), false);
  const live = await ctx.status.checks(ctx.config.load(), { live: true });
  const ping = live.find((r) => r.name === 'api ping');
  assert.equal(ping.ok, true, ping.detail);
});
