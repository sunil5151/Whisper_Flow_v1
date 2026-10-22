'use strict';

// `memo install` — first-run setup called by scripts/windows/install_memo.bat (P4).
// Creates ~/.memo with a default config, installs the Claude Code hooks and prints
// the privacy notice. Secrets are never read, written or printed here.

const fs = require('node:fs');
const readline = require('node:readline');

const { memoHome, logsDir } = require('./paths');
const config = require('./config');
const { fwd } = require('./util');
const { setupClaude } = require('./capture/install-claude');

const PRIVACY = [
  'What MEMO captures and where it goes',
  '  captured  your Claude Code prompts, assistant replies, tool names, file paths and',
  '            trimmed tool output for repos you ran `memo init` in',
  '  dropped   thinking blocks, file contents, image blocks and anything matching denyPaths',
  '  stored    .memory/ inside that repo (committed to Git) and ~/.memo/ on this machine only',
  '  sent      batches of those events to the configured API provider for extraction',
  '  not sent  anything from unregistered repos; nothing while `memo pause` is on',
  '  stop it   `memo pause`, or uninstall_memo.bat, or `memo setup claude --remove`',
  '  delete it `memo clear --session <id>` / `--date <YYYY-MM-DD>` / `--all-repo-data`',
  '  warning   redaction is regex-based. Read .memory/ once before you push it anywhere.'
];

function ask(rl, question, fallback) {
  return new Promise((resolve) => {
    rl.question(question + (fallback ? ' [' + fallback + ']' : '') + ': ', (answer) => {
      resolve(String(answer || '').trim() || fallback);
    });
  });
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

async function install(argv = []) {
  const out = [];
  fs.mkdirSync(memoHome(), { recursive: true });
  fs.mkdirSync(logsDir(), { recursive: true });
  const existed = fs.existsSync(config.configPath());
  let cfg = config.ensure();
  out.push((existed ? 'kept     ' : 'created  ') + fwd(config.configPath()));

  let provider = flag(argv, '--provider');
  let model = flag(argv, '--model');
  const interactive = !argv.includes('--yes') && process.stdin.isTTY && (!provider || !model);

  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      provider = provider || await ask(rl, 'provider (' + config.PROVIDERS.join('/') + ')', cfg.provider);
      model = model || await ask(rl, 'model id', cfg.model);
    } finally {
      rl.close();
    }
  }
  if (provider && provider !== cfg.provider) {
    cfg = config.set('provider', provider).cfg;
    out.push('set      provider ' + cfg.provider);
  }
  if (model && model !== cfg.model) {
    cfg = config.set('model', model).cfg;
    out.push('set      model ' + cfg.model);
  }

  process.stdout.write(out.join('\n') + '\n');
  setupClaude(argv.includes('--dry-run') ? ['--dry-run'] : []);

  process.stdout.write('\n' + PRIVACY.join('\n') + '\n\n');
  const key = config.apiKey(cfg);
  process.stdout.write('api key  ' + config.keyEnvName(cfg) + ' → ' + config.maskKey(key) + '\n');
  if (!key) {
    process.stdout.write('         set it with:  setx ' + cfg.apiKeyEnv + ' "<your key>"   (then reopen the terminal)\n');
  }
  if (!config.priceFor(cfg, cfg.model)) {
    process.stdout.write('price    unknown for ' + cfg.model + ' — memo config set prices.' + cfg.model + '.inPerM <usd>\n');
  }
  process.stdout.write('next     run `memo doctor`, then `memo cycle` once\n');
  return cfg;
}

module.exports = { install, PRIVACY };
