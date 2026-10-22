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
memo cycle                        one scheduled run: capture, process, report, commit
memo status                       what MEMO did and what it cost this month
memo doctor [--live]              check the setup; --live makes one cheap API call
memo pause | memo resume          stop/start processing (task stays registered)
memo install                      first-run setup: config, Claude hooks, privacy notice
     [--provider <p>] [--model <m>] [--yes]
memo sessions [--date YYYY-MM-DD] browse captured dates, or the sessions of one date
memo show <sid8|sid>              one session: summary, files, records it produced
memo tasks [--all]                open tasks in the terminal
memo clear --session <sid> | --date <d> | --record <id> | --all-repo-data
     [--with-derived] [--yes] [--confirm <text>]   dry run unless --yes
memo console                      numbered menu over all of the above
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
    case 'cycle':
      // The scheduled task calls this: it must never exit non-zero (see the catch below).
      await require('../src/cycle.js').command(argv.slice(3));
      process.exitCode = 0;
      break;
    case 'status':
      require('../src/status.js').statusCommand();
      break;
    case 'doctor':
      await require('../src/status.js').doctorCommand(argv.slice(3));
      break;
    case 'pause':
      require('../src/status.js').pauseCommand(true);
      break;
    case 'resume':
      require('../src/status.js').pauseCommand(false);
      break;
    case 'install':
      await require('../src/install.js').install(argv.slice(3));
      break;
    case 'sessions':
      require('../src/browse.js').sessionsCommand(argv.slice(3));
      break;
    case 'show':
      require('../src/browse.js').showCommand(argv.slice(3));
      break;
    case 'tasks':
      require('../src/browse.js').tasksCommand(argv.slice(3));
      break;
    case 'clear':
      require('../src/delete.js').command(argv.slice(3));
      break;
    case 'console':
      process.exitCode = await require('../src/ui/menu.js').run();
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
  // The hook and the scheduled task must never see a failure from MEMO.
  if (process.argv[2] === 'capture' || process.argv[2] === 'cycle') {
    require('../src/log.js').log('cycles', { event: 'crash', status: 'failed', error: err && err.message });
    process.exit(0);
  }
  if (process.env.MEMO_DEBUG === '1') {
    console.error(err && err.stack ? err.stack : err);
  } else {
    console.error('memo: ' + (err && err.message ? err.message : String(err)));
  }
  process.exit(1);
});
