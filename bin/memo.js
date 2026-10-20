#!/usr/bin/env node
'use strict';

const HELP = `memo init                         set up memory in this repo
memo note -t decision "text"      log a decision (also: error, next)
memo note --personal "text"       save a fact about you (~/.memo)
memo brief                        regenerate .memory/BRIEF.md
memo hook                         (internal) called by git post-commit
`;

function main(argv) {
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

try {
  main(process.argv);
} catch (err) {
  if (process.env.MEMO_DEBUG === '1') {
    console.error(err && err.stack ? err.stack : err);
  } else {
    console.error('memo: ' + (err && err.message ? err.message : String(err)));
  }
  process.exit(1);
}
