#!/usr/bin/env node
'use strict';

const HELP = `memo init                         set up memory in this repo (also registers it for capture)
memo note -t decision "text"      log a decision (also: error, next)
memo note --personal "text"       save a fact about you (~/.memo)
memo brief                        regenerate .memory/BRIEF.md
memo setup claude                 add MEMO capture hooks to ~/.claude/settings.json
     [--dry-run] [--remove] [--shell-form]
memo capture                      (internal) Claude Code hook entry, reads hook JSON on stdin
memo capture --sweep              catch up all registered repos from stored cursors
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
    case 'brief':
      require('../src/brief.js').command();
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
