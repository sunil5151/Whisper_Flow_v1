'use strict';

// `memo key set | status | remove | import` — the API key, once per machine (see src/secrets.js).
// The key is typed without echo (or piped on stdin), stored encrypted, and only ever shown as …last4.

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const config = require('./config');
const secrets = require('./secrets');
const limits = require('./llm/limits');

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

// Hidden line input on a terminal. Rejects on Ctrl+C.
function promptHidden(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('no terminal to read the key from'));
      return;
    }
    output.write(question);
    let buf = '';
    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
    };
    function onData(chunk) {
      for (const c of String(chunk)) {
        if (c === '\r' || c === '\n') {
          cleanup();
          output.write('\n');
          resolve(buf.trim());
          return;
        }
        if (c === '\u0003') {
          cleanup();
          output.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (c === '\u0008' || c === '\u007f') buf = buf.slice(0, -1);
        else if (c >= ' ') buf += c;
      }
    }
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    input.on('data', onData);
  });
}

function readPipedStdin() {
  try { return fs.readFileSync(0, 'utf8').trim(); } catch (_) { return ''; }
}

// Removes a user-level environment variable (Windows: registry HKCU\Environment).
function removeUserEnv(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  delete process.env[name];
  if (process.platform !== 'win32') return false;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Environment]::SetEnvironmentVariable('" + name + "', $null, 'User')"], { windowsHide: true, encoding: 'utf8' });
  return res.status === 0;
}

function save(provider, key) {
  const res = secrets.store(provider, key);
  // A new key ends an auth/quota pause straight away.
  limits.clearCooldown();
  return res;
}

function describeStored(provider) {
  if (!secrets.has(provider)) return 'no stored key for ' + provider;
  const key = secrets.read(provider);
  if (!key) return 'stored key for ' + provider + ' cannot be decrypted by this Windows user — run `memo key set`';
  return 'stored key for ' + provider + ' ' + config.maskKey(key) + ' (' + (secrets.backend() === 'dpapi'
    ? 'Windows DPAPI, readable only by this Windows user on this machine' : '0600 file') + ')';
}

async function setCommand(argv, cfg) {
  const provider = flag(argv, '--provider') || cfg.provider;
  if (!config.PROVIDERS.includes(provider) || provider === 'mock') throw new Error('memo key set needs a real provider, not ' + provider);
  let key;
  if (process.stdin.isTTY) {
    const url = config.PRESETS[provider] && config.PRESETS[provider].keyUrl;
    if (url) process.stdout.write('Get a ' + provider + ' API key at ' + url + '\n');
    key = await promptHidden('Paste your ' + provider + ' API key (input hidden), then Enter: ');
  } else {
    key = readPipedStdin();
  }
  if (!key) throw new Error('no key entered — nothing changed');
  const res = save(provider, key);
  process.stdout.write('stored   ' + provider + ' key ' + config.maskKey(secrets.validKey(key)) + ' in ' +
    (res.backend === 'dpapi' ? 'Windows DPAPI store' : 'file store') + '\n');
  if (process.env[config.keyEnvName({ ...cfg, provider })]) {
    process.stdout.write('note     env ' + config.keyEnvName({ ...cfg, provider }) +
      ' is also set and takes precedence — `memo key import --env ' + config.keyEnvName({ ...cfg, provider }) + ' --remove-source`\n');
  }
  return res;
}

function importCommand(argv, cfg) {
  const provider = flag(argv, '--provider') || cfg.provider;
  const file = flag(argv, '--file');
  const env = flag(argv, '--env');
  const removeSource = argv.includes('--remove-source');
  if (!file && !env) throw new Error('usage: memo key import --file <path> | --env <NAME> [--remove-source] [--provider p]');
  let key = '';
  if (file) {
    try { key = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0].trim(); } catch (err) {
      throw new Error('cannot read ' + file + ': ' + err.code);
    }
  } else {
    key = String(process.env[env] || '').trim();
  }
  if (!secrets.validKey(key)) throw new Error('no usable key found in ' + (file || 'env ' + env));
  save(provider, key);
  process.stdout.write('imported ' + provider + ' key ' + config.maskKey(key) + ' from ' + (file || 'env ' + env) + '\n');
  if (removeSource) {
    if (file) {
      fs.unlinkSync(file);
      process.stdout.write('deleted  ' + file + '\n');
    } else {
      removeUserEnv(env);
      process.stdout.write('removed  user environment variable ' + env + ' (open terminals keep their copy until closed)\n');
    }
  }
}

async function command(argv = []) {
  const sub = argv[0] || 'status';
  const rest = argv.slice(1);
  const cfg = config.load();
  if (sub === 'set') return setCommand(rest, cfg);
  if (sub === 'import') return importCommand(rest, cfg);
  if (sub === 'remove') {
    const provider = flag(rest, '--provider') || cfg.provider;
    process.stdout.write((secrets.remove(provider) ? 'removed  ' : 'nothing  ') + 'stored key for ' + provider + '\n');
    return null;
  }
  if (sub === 'status') {
    const src = config.keySource(cfg);
    process.stdout.write('provider ' + cfg.provider + '\nin use   ' + (src.source === 'none' ? 'none — run `memo key set`' : src.detail) +
      '\n' + (cfg.provider === 'mock' ? '' : 'store    ' + describeStored(cfg.provider) + '\n'));
    return src;
  }
  process.stderr.write('usage: memo key [status | set | remove | import --file <path> | import --env <NAME>]\n');
  process.exitCode = 1;
  return null;
}

module.exports = { command, promptHidden, save, removeUserEnv, describeStored };
