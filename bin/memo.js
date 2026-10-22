#!/usr/bin/env node
'use strict';

const HELP = `MEMO — persistent project memory for AI coding sessions

Start here
  memo install                      one-time machine setup (setup_memo.bat runs this; rerun = repair)
       [--provider groq|anthropic|openai|mock] [--model <id>] [--yes] [--skip-live]
  memo init                         activate MEMO in the current Git repo
  memo status                       is it working? capture, pending work, API calls, limits
  memo doctor [--live]              check every piece; --live sends one tiny real request

API key and provider
  memo key set | status | remove    store the key encrypted for your Windows user (never in a repo)
  memo key import --file <p> | --env <NAME> [--remove-source]   move an old plain-text key
  memo config                       show settings (never the key)
  memo config set <key> <value>     e.g. model, intervalMinutes, dailyTokenBudget, monthlyBudgetUsd
  memo usage                        tokens, estimated cost, failures, provider-reported limits

Background work
  memo cycle                        one run now: capture sweep, extraction, reports, .memory commit
  memo process [--repo <path>] [--dry-run] [--retry-failed] [--commit]   extraction only
  memo schedule [status | install | remove]   the Windows scheduled task
  memo pause | memo resume          stop/start API processing (capture keeps working)
  memo repair                       reapply hooks and the scheduled task, keep everything else
  memo uninstall [--remove-key]     remove task and hooks; memory data is kept

Your memory
  memo context                      the project state a new Claude Code session receives
  memo report                       regenerate .memory/PROJECT_STATE.md and TASKS.md (alias: brief)
  memo tasks [--all]                open tasks
  memo sessions [--date YYYY-MM-DD] captured sessions;  memo show <sid8> for one session
  memo note -t decision|error|next "text"   add a note by hand (--personal: ~/.memo only)
  memo clear --session <sid> | --date <d> | --record <id> | --all-repo-data
       [--with-derived] [--yes] [--confirm <text>]   dry run unless --yes
  memo console                      numbered menu over the above
  memo commit [--repo <path>]       commit only .memory/ (never other files, never push)
  memo migrate                      import old decisions.md/errors.md/next.md into records

Internal (called by hooks)
  memo setup claude [--dry-run] [--remove]   add/remove the Claude Code hooks
  memo capture [--sweep]            Claude Code hook entry / catch-up
  memo hook                         git post-commit entry
  memo --version
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
        // The scheduled task carries the interval: re-register it so the change takes effect.
        if (changed && argv[4] === 'intervalMinutes') {
          const schedule = require('../src/schedule.js');
          if (schedule.info().exists) process.stdout.write(schedule.install().detail + '\n');
        }
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
    case 'repair':
      await require('../src/install.js').install(['--yes', ...argv.slice(3)]);
      break;
    case 'uninstall':
      await require('../src/install.js').uninstall(argv.slice(3));
      break;
    case 'key':
      await require('../src/key.js').command(argv.slice(3));
      break;
    case 'schedule':
      require('../src/schedule.js').command(argv.slice(3));
      break;
    case 'usage':
      require('../src/status.js').usageCommand();
      break;
    case '--version':
    case '-v':
      process.stdout.write(require('../package.json').version + '\n');
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
    case 'help':
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
