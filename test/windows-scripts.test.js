'use strict';

// The Windows launchers must stay CRLF and must not hide errors or echo secrets.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'scripts', 'windows');
const EXPECTED = ['install_memo.bat', 'uninstall_memo.bat', 'memo_status.bat', 'memo_console.bat',
  'register-task.ps1', 'run-hidden.vbs'];

test('every Windows launcher exists', () => {
  for (const name of EXPECTED) assert.ok(fs.existsSync(path.join(DIR, name)), name + ' is missing');
});

test('.bat, .ps1 and .vbs files use CRLF line endings', () => {
  for (const name of EXPECTED) {
    const raw = fs.readFileSync(path.join(DIR, name), 'latin1');
    const lf = (raw.match(/\n/g) || []).length;
    const crlf = (raw.match(/\r\n/g) || []).length;
    assert.ok(lf > 0, name + ' has no line breaks');
    assert.equal(crlf, lf, name + ' must be CRLF only (' + crlf + '/' + lf + ')');
  }
});

test('the installer checks node and git before touching anything', () => {
  const bat = fs.readFileSync(path.join(DIR, 'install_memo.bat'), 'latin1');
  assert.match(bat, /where git/);
  assert.match(bat, /where node/);
  assert.match(bat, /NODEMAJOR! LSS 20/);
  assert.match(bat, /winget install/);
  assert.match(bat, /MEMOJS%" install/);
  assert.match(bat, /register-task\.ps1/);
  assert.match(bat, /doctor/);
});

test('the API key is read without echoing it and only written to the user environment', () => {
  const bat = fs.readFileSync(path.join(DIR, 'install_memo.bat'), 'latin1');
  assert.match(bat, /Read-Host -AsSecureString/);
  assert.match(bat, /SetEnvironmentVariable\('MEMO_API_KEY'/);
  assert.equal(/set \/p *"?KEY=/i.test(bat), false, 'the key must never go through set /p');
});

test('uninstall removes the task and hooks but keeps the data unless explicitly told', () => {
  const bat = fs.readFileSync(path.join(DIR, 'uninstall_memo.bat'), 'latin1');
  assert.match(bat, /-Remove/);
  assert.match(bat, /setup claude --remove/);
  assert.match(bat, /DELETE-ALL-MEMO-DATA/);
  assert.match(bat, /NOT deleted/);
});

test('register-task.ps1 takes the documented parameters and never duplicates the task', () => {
  const ps = fs.readFileSync(path.join(DIR, 'register-task.ps1'), 'latin1');
  for (const needle of ['$NodeExe', '$MemoJs', '$TaskName', '$IntervalMinutes', '$Remove',
    'MultipleInstances IgnoreNew', 'StartWhenAvailable', 'ExecutionTimeLimit', 'AtLogOn', 'Set-ScheduledTask']) {
    assert.ok(ps.includes(needle), 'register-task.ps1 should mention ' + needle);
  }
});
