'use strict';

// API keys, stored once per machine and never inside a repo.
//
// Lookup order: the env var named by config.apiKeyEnv → the provider's usual env var
// (GROQ_API_KEY, …) → the stored credential in ~/.memo/secrets/<provider>.*
//
// Windows: the key is encrypted with DPAPI for the current Windows user
// (ConvertFrom-SecureString), so the file is useless on another account or machine.
// Elsewhere: a 0600 plain file. MEMO_SECRET_BACKEND=file forces the plain file (tests).
// The key travels to and from PowerShell over stdin/stdout only, never on a command line.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { memoHome } = require('./paths');

const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const ENCRYPT_PS = '$k=[Console]::In.ReadToEnd().Trim(); if(-not $k){exit 3}; ' +
  '[Console]::Out.Write((ConvertTo-SecureString $k -AsPlainText -Force | ConvertFrom-SecureString))';
const DECRYPT_PS = '$e=[Console]::In.ReadToEnd().Trim(); $s=ConvertTo-SecureString $e; ' +
  '$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); ' +
  'try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))}' +
  'finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}';

const cache = new Map();

function backend() {
  if (process.env.MEMO_SECRET_BACKEND === 'file') return 'file';
  return process.platform === 'win32' ? 'dpapi' : 'file';
}

function secretsDir() {
  return path.join(memoHome(), 'secrets');
}

function safeName(name) {
  const n = String(name || '').toLowerCase();
  if (!NAME_RE.test(n)) throw new Error('invalid credential name: ' + name);
  return n;
}

function fileFor(name, kind = backend()) {
  return path.join(secretsDir(), safeName(name) + (kind === 'dpapi' ? '.dpapi' : '.key'));
}

function powershell(script, input) {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    input, encoding: 'utf8', windowsHide: true, timeout: 30000
  });
  if (res.error) throw new Error('PowerShell is not available: ' + res.error.message);
  if (res.status !== 0) throw new Error('PowerShell DPAPI call failed (exit ' + res.status + ')');
  return String(res.stdout || '').trim();
}

function validKey(key) {
  const k = String(key || '').trim();
  if (k.length < 8 || k.length > 512 || /\s/.test(k)) return null;
  return k;
}

function store(name, key) {
  const k = validKey(key);
  if (!k) throw new Error('that does not look like an API key (8–512 characters, no spaces)');
  const kind = backend();
  const file = fileFor(name, kind);
  fs.mkdirSync(secretsDir(), { recursive: true });
  const body = kind === 'dpapi' ? powershell(ENCRYPT_PS, k) : k;
  if (!body) throw new Error('encryption returned nothing');
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, body + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* not supported on every fs */ }
  cache.set(safeName(name), k);
  return { file, backend: kind };
}

function has(name) {
  try { return fs.existsSync(fileFor(name)); } catch (_) { return false; }
}

// Decrypted key, or '' when none is stored or it cannot be read.
function read(name) {
  const n = safeName(name);
  if (cache.has(n)) return cache.get(n);
  const kind = backend();
  let raw;
  try { raw = fs.readFileSync(fileFor(n, kind), 'utf8').trim(); } catch (_) { return ''; }
  if (!raw) return '';
  let key = '';
  try { key = kind === 'dpapi' ? powershell(DECRYPT_PS, raw) : raw; } catch (_) { key = ''; }
  key = validKey(key) || '';
  cache.set(n, key);
  return key;
}

function remove(name) {
  cache.delete(safeName(name));
  let removed = false;
  for (const kind of ['dpapi', 'file']) {
    try { fs.unlinkSync(fileFor(name, kind)); removed = true; } catch (_) { /* absent */ }
  }
  return removed;
}

function clearCache() {
  cache.clear();
}

module.exports = { backend, secretsDir, fileFor, store, has, read, remove, validKey, clearCache };
