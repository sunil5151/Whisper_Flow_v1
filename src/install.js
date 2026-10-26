'use strict';

// `memo install` — the one-time machine setup run by setup_memo.bat (safe to rerun = repair).
//   1 config          ~/.memo/config.json (kept if present; OpenRouter by default)
//   2 provider/model  asked once, Enter keeps the current value
//   3 API key         stored encrypted (src/secrets.js); old plain-text keys are offered for migration
//   4 Claude hooks    ~/.claude/settings.json (backed up, idempotent)
//   5 schedule        per-user scheduled task, replaces the pre-installer worker task
//   6 live test       one tiny real request, so a bad key or model shows up now, not in a week
// `memo uninstall` undoes 4 and 5 (and, if asked, the key); it never deletes .memory/ data.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const { memoHome, logsDir } = require('./paths');
const config = require('./config');
const secrets = require('./secrets');
const { fwd } = require('./util');
const { setupClaude } = require('./capture/install-claude');

const PRIVACY = [
  'What MEMO captures and where it goes',
  '  captured  your Claude Code prompts, assistant replies, tool names, file paths and',
  '            trimmed tool output — only in repos where you ran `memo init`',
  '  dropped   thinking blocks, file contents, image blocks and anything matching denyPaths',
  '  stored    .memory/ inside that repo (committed to Git) and ~/.memo/ on this machine only',
  '  sent      new, redacted events in small batches to your AI provider for extraction',
  '  not sent  your source files, anything from other repos, anything while `memo pause` is on',
  '  key       stored encrypted for your Windows account (DPAPI), never in a repo, never printed',
  '  stop it   `memo pause`, or `memo uninstall`',
  '  delete it `memo clear --session <id>` / `--date <YYYY-MM-DD>` / `--all-repo-data`',
  '  warning   redaction is regex-based. Read .memory/ once before you push it anywhere public.'
];

const LEGACY_KEY_FILES = () => [path.join(memoHome(), 'key.txt')];

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

function makeAsk() {
  let rl = null;
  const ask = (question, fallback) => new Promise((resolve) => {
    if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question + (fallback !== undefined && fallback !== '' ? ' [' + fallback + ']' : '') + ': ', (answer) => {
      const a = String(answer || '').trim();
      resolve(a || (fallback === undefined ? '' : String(fallback)));
    });
  });
  // readline must be closed before the raw-mode key prompt takes stdin over.
  ask.close = () => { if (rl) { rl.close(); rl = null; } };
  return ask;
}

function yes(answer) {
  return /^y(es)?$/i.test(String(answer || '').trim());
}

function say(tag, text) {
  process.stdout.write(('[' + tag + ']').padEnd(8) + ' ' + text + '\n');
}

function legacyKeySources(cfg) {
  const out = [];
  for (const file of LEGACY_KEY_FILES()) {
    try {
      const key = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0].trim();
      if (secrets.validKey(key)) out.push({ kind: 'file', where: file, key });
    } catch (_) { /* absent */ }
  }
  const envName = config.keyEnvName(cfg);
  if (process.env[envName] && secrets.validKey(process.env[envName])) {
    out.push({ kind: 'env', where: envName, key: process.env[envName].trim() });
  }
  return out;
}

async function chooseProvider(cfg, argv, ask, interactive) {
  let provider = flag(argv, '--provider');
  let model = flag(argv, '--model');
  if (interactive && !provider) {
    process.stdout.write('\nAI provider for memory extraction:\n');
    config.PROVIDERS.forEach((p, i) => process.stdout.write('  ' + (i + 1) + '. ' + p.padEnd(10) + ' ' + config.PRESETS[p].label + '\n'));
    const answer = await ask('choose 1-' + config.PROVIDERS.length + ' or a name', cfg.provider);
    provider = config.PROVIDERS[Number(answer) - 1] || answer;
  }
  if (provider && !config.PROVIDERS.includes(provider)) throw new Error('unknown provider ' + provider + ' (one of ' + config.PROVIDERS.join(', ') + ')');
  if (provider && provider !== cfg.provider) {
    cfg = config.set('provider', provider).cfg;
    if (!model && cfg.model !== config.PRESETS[provider].model) model = config.PRESETS[provider].model;
  }
  if (interactive && !flag(argv, '--model') && cfg.provider !== 'mock') {
    model = await ask('model id (Enter keeps it)', model || cfg.model);
  }
  if (model && model !== cfg.model) cfg = config.set('model', model).cfg;
  if (cfg.provider === 'openai' && interactive) {
    const url = await ask('OpenAI-compatible base URL (Enter = api.openai.com)', cfg.baseUrl || '');
    if ((url || null) !== cfg.baseUrl) cfg = config.set('baseUrl', url || 'null').cfg;
  }
  say('ok', 'provider ' + cfg.provider + ' · model ' + cfg.model + (cfg.baseUrl ? ' · ' + cfg.baseUrl : ''));
  return cfg;
}

async function setupKey(cfg, argv, ask, interactive) {
  if (cfg.provider === 'mock') {
    say('ok', 'mock provider: no key needed (results are canned fixtures, not real AI output)');
    return true;
  }
  const keyModule = require('./key');
  const stored = secrets.has(cfg.provider) && secrets.read(cfg.provider);
  if (stored) {
    say('ok', 'API key stored for ' + cfg.provider + ' ' + config.maskKey(stored));
    if (!interactive || !yes(await ask('replace it? [y/N]', 'n'))) {
      offerLegacyCleanup(cfg);
      return true;
    }
  } else {
    const file = flag(argv, '--key-file');
    const sources = file ? [{ kind: 'file', where: file, key: readKeyFile(file) }] : legacyKeySources(cfg);
    for (const src of sources.filter((s) => s.key)) {
      const label = src.kind === 'file' ? fwd(src.where) + ' (plain text)' : 'environment variable ' + src.where;
      const take = !interactive || yes(await ask('found an API key in ' + label + '. Move it into the encrypted store? [Y/n]', 'y'));
      if (!take) continue;
      keyModule.save(cfg.provider, src.key);
      say('ok', 'key ' + config.maskKey(src.key) + ' moved into the ' + secrets.backend() + ' store');
      const remove = interactive && yes(await ask(src.kind === 'file'
        ? 'delete the plain-text file ' + fwd(src.where) + ' now? [Y/n]'
        : 'remove ' + src.where + ' from your user environment? [Y/n]', 'y'));
      if (remove && src.kind === 'file') { fs.unlinkSync(src.where); say('ok', 'deleted ' + fwd(src.where)); }
      else if (remove) { keyModule.removeUserEnv(src.where); say('ok', 'removed user environment variable ' + src.where); }
      else say('warn', 'the plain copy in ' + label + ' still exists — delete it when you are ready');
      return true;
    }
    if (!interactive) {
      say('warn', 'no API key yet — run `memo key set` (it will be stored encrypted)');
      return false;
    }
  }
  const url = config.PRESETS[cfg.provider].keyUrl;
  if (url) process.stdout.write('\nGet a key at ' + url + '\n');
  ask.close();
  for (let attempt = 0; attempt < 3; attempt++) {
    let key = '';
    try {
      key = await keyModule.promptHidden('Paste your ' + cfg.provider + ' API key (input hidden), then Enter: ');
    } catch (err) {
      say('warn', 'key entry ' + err.message + ' — run `memo key set` later');
      return false;
    }
    if (!key) { say('warn', 'nothing entered — run `memo key set` later'); return false; }
    try {
      keyModule.save(cfg.provider, key);
      say('ok', 'key ' + config.maskKey(secrets.validKey(key)) + ' stored (' +
        (secrets.backend() === 'dpapi' ? 'encrypted for your Windows account' : 'file readable only by you') + ')');
      return true;
    } catch (err) {
      say('fail', err.message);
    }
  }
  return false;
}

function readKeyFile(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0].trim(); } catch (_) { return ''; }
}

function offerLegacyCleanup(cfg) {
  for (const src of legacyKeySources(cfg)) {
    if (src.kind === 'file') say('warn', 'a plain-text key is still in ' + fwd(src.where) + ' — `memo key import --file "' + src.where + '" --remove-source`');
    else say('note', 'env ' + src.where + ' is set and overrides the stored key — `memo key import --env ' + src.where + ' --remove-source`');
  }
}

function installSchedule(cfg) {
  const schedule = require('./schedule');
  const res = schedule.install({ intervalMinutes: cfg.intervalMinutes });
  if (res.unsupported) { say('warn', res.detail); return true; }
  for (const line of String(res.detail || '').split(/\r?\n/).filter(Boolean)) process.stdout.write('         ' + line.replace(/^\[(ok|skip|warn)\]\s*/, '') + '\n');
  say(res.ok ? 'ok' : 'fail', res.ok ? 'background processing every ' + cfg.intervalMinutes + ' min while you are logged on'
    : 'could not register the scheduled task — `memo cycle` still works by hand');
  return res.ok;
}

async function liveTest(cfg, ask, interactive) {
  const { ping } = require('./status');
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ping(cfg);
    if (res.ok) { say('ok', 'provider test: ' + res.detail); return true; }
    say('fail', 'provider test: ' + res.detail);
    if (res.kind !== 'auth' || !interactive) return false;
    const again = yes(await ask('enter the key again? [Y/n]', 'y'));
    if (!again) return false;
    ask.close();
    try {
      const key = await require('./key').promptHidden('Paste your ' + cfg.provider + ' API key (input hidden), then Enter: ');
      if (key) require('./key').save(cfg.provider, key);
    } catch (_) { return false; }
  }
  return false;
}

async function install(argv = []) {
  const interactive = !argv.includes('--yes') && Boolean(process.stdin.isTTY);
  const ask = makeAsk();
  const result = { config: false, key: false, hooks: false, schedule: false, live: null };
  try {
    process.stdout.write('MEMO setup — ' + (fs.existsSync(config.configPath()) ? 'existing install found, keeping your settings' : 'first run') + '\n');
    fs.mkdirSync(memoHome(), { recursive: true });
    fs.mkdirSync(logsDir(), { recursive: true });
    const existed = fs.existsSync(config.configPath());
    let cfg = config.ensure();
    // Rewrite once so older files pick up migrations (e.g. Groq via provider "openai").
    cfg = config.save(cfg);
    say('ok', (existed ? 'kept    ' : 'created ') + fwd(config.configPath()));
    result.config = true;

    const shim = require('./shim').install();
    if (shim.file) say(shim.ok ? 'ok' : 'warn', 'memo command ' + fwd(shim.file) + (shim.path === 'added' ? ' (folder added to your PATH — new terminals see it)' : shim.path === 'failed' ? ' (could not add it to PATH)' : ''));
    else say('note', shim.detail);

    cfg = await chooseProvider(cfg, argv, ask, interactive);
    result.key = await setupKey(cfg, argv, ask, interactive);
    cfg = config.load();

    process.stdout.write('\n');
    try {
      setupClaude(argv.includes('--dry-run') ? ['--dry-run'] : []);
      result.hooks = true;
      say('ok', 'Claude Code hooks installed (capture + context at session start)');
    } catch (err) {
      say('fail', 'Claude Code hooks: ' + err.message);
    }

    if (!argv.includes('--no-schedule')) result.schedule = installSchedule(cfg);
    else result.schedule = true;

    if (result.key && !argv.includes('--skip-live')) result.live = await liveTest(cfg, ask, interactive);

    process.stdout.write('\n' + PRIVACY.join('\n') + '\n\n');
    const ok = result.config && result.key && result.hooks && result.schedule && result.live !== false;
    if (ok) {
      say('done', 'MEMO is installed.');
      process.stdout.write('         Next: open a terminal in a project and run  memo init\n' +
        '         Then just use Claude Code there. Check anytime with  memo status\n');
    } else {
      say('todo', 'MEMO is installed but not fully working yet:');
      if (!result.key) process.stdout.write('         - add your API key:        memo key set\n');
      if (result.live === false) process.stdout.write('         - fix the provider test:   memo doctor --live\n');
      if (!result.hooks) process.stdout.write('         - install Claude hooks:    memo setup claude\n');
      if (!result.schedule) process.stdout.write('         - schedule the worker:     memo schedule install\n');
      process.stdout.write('         Rerun setup_memo.bat at any time; it keeps what already works.\n');
      process.exitCode = 1;
    }
    return { ...result, ok, cfg };
  } finally {
    ask.close();
  }
}

async function uninstall(argv = []) {
  const interactive = !argv.includes('--yes') && Boolean(process.stdin.isTTY);
  const ask = makeAsk();
  try {
    process.stdout.write('MEMO uninstall — removes the background task and the Claude Code hooks.\n' +
      'Your memory data stays: .memory/ in each repo and ' + fwd(memoHome()) + '.\n\n');
    const schedule = require('./schedule');
    const s = schedule.remove();
    for (const line of String(s.detail || '').split(/\r?\n/).filter(Boolean)) process.stdout.write('         ' + line + '\n');
    try { setupClaude(['--remove']); say('ok', 'Claude Code hooks removed'); } catch (err) { say('fail', 'hooks: ' + err.message); }
    const shim = require('./shim').remove();
    say('ok', 'memo command ' + (shim.removed ? 'removed' : 'not present') + (shim.path === 'removed' ? ' (and its PATH entry)' : ''));

    const cfg = config.load();
    let removeKey = argv.includes('--remove-key');
    if (!removeKey && interactive && cfg.provider !== 'mock' && secrets.has(cfg.provider)) {
      removeKey = yes(await ask('also delete the stored API key? [y/N]', 'n'));
    }
    if (removeKey) {
      for (const p of config.PROVIDERS) if (p !== 'mock') secrets.remove(p);
      say('ok', 'stored API keys deleted');
    } else {
      say('ok', 'stored API key kept (delete later with `memo key remove`)');
    }

    let purge = argv.includes('--purge-home') && flag(argv, '--confirm') === 'DELETE-MEMO-HOME';
    if (!purge && interactive) {
      process.stdout.write('\nTo also delete ' + fwd(memoHome()) + ' (settings, logs, cursors — NOT your .memory/ folders),\n');
      purge = (await ask('type DELETE-MEMO-HOME, or press Enter to keep it', '')) === 'DELETE-MEMO-HOME';
    }
    if (purge) {
      if (path.resolve(memoHome()) === path.resolve(os.homedir())) throw new Error('refusing to delete the home directory');
      fs.rmSync(memoHome(), { recursive: true, force: true });
      say('ok', 'deleted ' + fwd(memoHome()));
    } else {
      say('ok', 'kept ' + fwd(memoHome()));
    }
    process.stdout.write('\nTo erase captured data inside one repo:  memo clear --all-repo-data --yes --confirm DELETE-ALL-MEMO-DATA\n');
    return { ok: true };
  } finally {
    ask.close();
  }
}

module.exports = { install, uninstall, PRIVACY, legacyKeySources };
