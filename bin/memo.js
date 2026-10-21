#!/usr/bin/env node
'use strict';

const HELP = `memo init                         set up memory in this repo (also registers it for capture)
memo note -t decision "text"      log a decision (also: error, next)
memo note --personal "text"       save a fact about you (~/.memo)
memo report                       regenerate .memory/PROJECT_STATE.md and TASKS.md (alias: brief)
memo context                      print the compact project state given to new agent sessions
memo commit [--repo <path>]       commit only .memory/ (never other files, never push)
memo migrate                      import old decisions.md/errors.md/next.md into records
memo setup claude                 add MEMO capture hooks to ~/.claude/settings.json
     [--dry-run] [--remove] [--shell-form]
memo capture                      (internal) Claude Code hook entry, reads hook JSON on stdin
memo capture --sweep              catch up all registered repos from stored cursors
memo config                       print ~/.memo/config.json (no secrets)
memo config set <key> <value>     change one setting
memo process                      extract records from new captured events
     [--repo <path>] [--dry-run] [--retry-failed] [--commit]
memo hook                         (internal) called by git post-commit
`;

async function main(argv) {
  const cmd = argv[2];
  switch (cmd) {
    case 'init':
      require('../src/init.js')();
      break;
    case 'note':
      require('../src/note.js')(argv.slice(3));
      break;
    case 'hook':
      require('../src/hook.js')();
      break;
    case 'report':
    case 'brief':
      require('../src/brief.js').command();
      break;
    case 'context':
      require('../src/context.js').command();
      break;
    case 'commit':
      require('../src/gitops/memory-commit.js').command(argv.slice(3));
      break;
    case 'migrate':
      require('../src/migrate.js').command();
      break;
    case 'setup':
      if (argv[3] !== 'claude') {
        process.stderr.write('usage: memo setup claude [--dry-run] [--remove] [--shell-form]\n');
        process.exitCode = 1;
        return;
      }
      require('../src/capture/install-claude.js').setupClaude(argv.slice(4));
      break;
    case 'capture':
      // Hook path: never print errors, always exit 0.
      await require('../src/capture/capture.js').command(argv.slice(3));
      process.exit(0);
      break;
    case 'config': {
      const config = require('../src/config.js');
      if (argv[3] === 'set') {
        if (!argv[4] || argv[5] === undefined) {
          process.stderr.write('usage: memo config set <key> <value>\n');
          process.exitCode = 1;
          return;
        }
        const { changed } = config.set(argv[4], argv.slice(5).join(' '));
        process.stdout.write((changed ? 'set' : 'unchanged') + '  ' + argv[4] + '\n');
        return;
      }
      if (argv[3]) {
        process.stderr.write('usage: memo config [set <key> <value>]\n');
        process.exitCode = 1;
        return;
      }
      process.stdout.write(config.describe(config.ensure()));
      break;
    }
    case 'process':
      await require('../src/extract/process.js').command(argv.slice(3));
      break;
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(HELP);
      process.exitCode = 1;
  }
}

main(process.argv).catch((err) => {
  if (process.argv[2] === 'capture') process.exit(0);
  if (process.env.MEMO_DEBUG === '1') {
    console.error(err && err.stack ? err.stack : err);
  } else {
    console.error('memo: ' + (err && err.message ? err.message : String(err)));
  }
  process.exit(1);
});
