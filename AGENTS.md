# MEMO

MEMO is a zero-dependency Node.js CLI that gives a Git repo a persistent memory for AI coding agents.

## Where memory lives
- `.memory/` (tracked): project memory — progress log, decisions, errors, next steps, and later `PROJECT_STATE.md`.
- `~/.memo/` (per machine, never in Git): personal notes, logs, local state.

## Before starting work
- Read `.memory/PROJECT_STATE.md` if it exists (`memo report` regenerates it).
- If it does not exist, read `.memory/progress.md`.

## Code map
- `bin/memo.js` — CLI entry (`init | note | hook | report | context | commit | migrate | setup claude | capture | config | process | cycle | status | doctor | pause | resume | install | sessions | show | tasks | clear | console`).
- `src/` — implementation (paths, git, init, note, hook, brief, redact, config, usage, lock, log, repos).
- `src/cycle.js`, `src/status.js`, `src/install.js` — the 15-minute run, `memo status`/`doctor`, first-run setup.
- `src/delete.js`, `src/browse.js`, `src/ui/menu.js` — `memo clear`, the read-only views and `memo console`.
- `scripts/windows/` — `install_memo.bat`, `uninstall_memo.bat`, `register-task.ps1`, `run-hidden.vbs` (CRLF).
- `src/capture/`, `src/store/` — Claude Code capture and the session/record files.
- `src/llm/`, `src/extract/` — provider clients and `memo process` extraction (see `docs/PHASE2_API_EXTRACTION.md`).
- `src/report/`, `src/context.js` — `PROJECT_STATE.md`, `TASKS.md`, and the SessionStart context.
- `src/gitops/memory-commit.js`, `src/migrate.js` — `.memory/`-only commits and legacy-note import.
- `templates/` — post-commit hook, AGENTS block, CLAUDE.md and `.memory/README.md` written by `memo init`.
- `docs/SECURITY.md`, `docs/SUPPORTED_AGENTS.md` — what is captured/sent/deletable, and which agents work.
- `test/` — `node:test` suites; run `npm test`.

<!-- memo:start -->
## Project memory (MEMO)
- Project rules and code map: `AGENTS.md`. Current state: `.memory/PROJECT_STATE.md` (open tasks, errors, decisions, recent sessions).
- Task list: `.memory/TASKS.md`. How the folder works: `.memory/README.md`.
- These files are generated; corrections go through `memo note -t <decision|error|next> "text"`.

### Snapshot (sessions processed up to 2026-10-22)
> Stale: newer sessions are captured but not processed yet — run `memo status`. Check the code before trusting old items.
Intent:
- User asked for guidance on creating MEMO V1 installation flow, minimizing activation, and ensuring AI extraction works (I-c0c79533)
- User asked how to explain the repo in 3 lines and what the session name is. (I-1d9e20de)
- User asked for a summary of completed phases and remaining work in MEMO_IMPLEMENTATION_PLAN.md. (I-5e86c59b)
Open errors:
- Attempt to register a Windows scheduled task failed — observed (E-6de20d24)
- process.test.js test 'expected more than one batch, got 1' failed during extraction cycle — observed (E-7bfef16e)
Active decisions:
- Fix src/redact.js to correct short sk- pattern in redact function (D-ddbe42bd)
- Provider selected Groq for live testing. (D-3acf3223)
Recent sessions:
- 2026-10-22 dfe88d69: During the session, the user inspected the repository state, verified that the Groq key was correctly configured, and examined recent worker logs. Several errors were noted: a failing test on the red…
- 2026-10-22 f2c028c3: The session contained a single system event invoking a model command, but no user or tool interactions were recorded, so no durable outcomes were captured.
- 2026-10-22 1e715c57: During the session the assistant confirmed that the project reached phase P4 with all tests passing, described the new command-line tools and scripts added, and reported that the latest session label…
<!-- memo:end -->
