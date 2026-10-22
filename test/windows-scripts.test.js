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

const ROOT = path.join(__dirname, '..');

test('the root installers exist, are CRLF, and the old launchers forward to them', () => {
  for (const name of ['setup_memo.bat', 'uninstall_memo.bat']) {
    const raw = fs.readFileSync(path.join(ROOT, name), 'latin1');
    assert.equal((raw.match(/\r\n/g) || []).length, (raw.match(/\n/g) || []).length, name + ' must be CRLF only');
  }
  assert.match(fs.readFileSync(path.join(DIR, 'install_memo.bat'), 'latin1'), /setup_memo\.bat/);
  assert.match(fs.readFileSync(path.join(DIR, 'uninstall_memo.bat'), 'latin1'), /uninstall_memo\.bat/);
});

test('the installer checks Windows, git and node before touching anything', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'setup_memo.bat'), 'latin1');
  assert.match(bat, /Version 10\./);
  assert.match(bat, /call :ensure git Git\.Git/);
  assert.match(bat, /call :ensure node OpenJS\.NodeJS\.LTS/);
  assert.match(bat, /NODEMAJOR! GEQ 20/);
  assert.match(bat, /winget install/);
  assert.match(bat, /bin\\memo\.js" install/);
  assert.match(bat, /bin\\memo\.js" doctor/);
  assert.ok(bat.indexOf('call :ensure git') < bat.indexOf('memo.js" install'), 'prerequisites come first');
});

test('the installer never handles the API key itself', () => {
  // The key is read without echo by `memo install` (src/key.js) and stored with DPAPI.
  const bat = fs.readFileSync(path.join(ROOT, 'setup_memo.bat'), 'latin1');
  assert.equal(/set \/p *"?KEY=/i.test(bat), false, 'the key must never go through set /p');
  assert.equal(/setx|SetEnvironmentVariable/i.test(bat), false, 'the key must not become an environment variable');
});

test('uninstall removes integrations but keeps the data unless explicitly told', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'uninstall_memo.bat'), 'latin1');
  assert.match(bat, /memo\.js" uninstall/);
  assert.match(bat, /NOT deleted/);
  assert.match(bat, /\[y\/N\]/);
});

test('register-task.ps1 takes the documented parameters and never duplicates the task', () => {
  const ps = fs.readFileSync(path.join(DIR, 'register-task.ps1'), 'latin1');
  for (const needle of ['$NodeExe', '$MemoJs', '$TaskName', '$IntervalMinutes', '$Remove',
    'MultipleInstances IgnoreNew', 'StartWhenAvailable', 'ExecutionTimeLimit', 'AtLogOn', 'Set-ScheduledTask']) {
    assert.ok(ps.includes(needle), 'register-task.ps1 should mention ' + needle);
  }
});
