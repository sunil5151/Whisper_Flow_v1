'use strict';

// The global `memo` command on Windows: %LOCALAPPDATA%\MEMO\bin\memo.cmd, with that folder on the
// user PATH (HKCU, no admin). The shim calls this install's node.exe and bin/memo.js by absolute
// path, so spaces in either path are fine and no npm global prefix is involved.
// MEMO_SHIM_DIR overrides the folder; MEMO_NO_PATH_EDIT=1 leaves PATH alone (tests).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { memoBin } = require('./paths');

function shimDir() {
  if (process.env.MEMO_SHIM_DIR) return process.env.MEMO_SHIM_DIR;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'MEMO', 'bin');
}

function shimContent() {
  return '@echo off\r\nrem MEMO command shim, written by `memo install`. Rerun setup_memo.bat to refresh.\r\n' +
    '"' + process.execPath + '" "' + path.resolve(memoBin()) + '" %*\r\n';
}

// PowerShell reads the folder from the environment, so no quoting of user paths is needed.
const ADD_PS = "$d=$env:MEMO_SHIM_PATH; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''}; " +
  "$parts=@($p -split ';' | Where-Object { $_ -ne '' }); if($parts -notcontains $d){ " +
  "[Environment]::SetEnvironmentVariable('Path', (($parts + $d) -join ';'), 'User'); 'added' } else { 'present' }";
const REMOVE_PS = "$d=$env:MEMO_SHIM_PATH; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){'absent'; exit 0}; " +
  "$parts=@($p -split ';' | Where-Object { $_ -ne '' }); if($parts -contains $d){ " +
  "[Environment]::SetEnvironmentVariable('Path', (($parts | Where-Object { $_ -ne $d }) -join ';'), 'User'); 'removed' } else { 'absent' }";

function userPath(script, dir) {
  if (process.platform !== 'win32' || process.env.MEMO_NO_PATH_EDIT === '1') return 'skipped';
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, MEMO_SHIM_PATH: dir }, timeout: 30000
  });
  return res.status === 0 ? String(res.stdout || '').trim() : 'failed';
}

/** @returns {{ok, file, path: 'added'|'present'|'skipped'|'failed'|'n/a', changed}} */
function install() {
  if (process.platform !== 'win32' && !process.env.MEMO_SHIM_DIR) {
    return { ok: true, file: null, path: 'n/a', detail: 'not Windows — use `npm link` in the MEMO folder for a global command' };
  }
  const dir = shimDir();
  const file = path.join(dir, 'memo.cmd');
  const content = shimContent();
  let before = null;
  try { before = fs.readFileSync(file, 'utf8'); } catch (_) { /* new */ }
  if (before !== content) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  const p = userPath(ADD_PS, dir);
  return { ok: p !== 'failed', file, path: p, changed: before !== content };
}

function remove() {
  const dir = shimDir();
  let removed = false;
  try { fs.unlinkSync(path.join(dir, 'memo.cmd')); removed = true; } catch (_) { /* absent */ }
  try { fs.rmdirSync(dir); } catch (_) { /* not empty or absent */ }
  return { removed, path: userPath(REMOVE_PS, dir) };
}

module.exports = { shimDir, shimContent, install, remove };
