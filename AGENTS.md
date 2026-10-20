# MEMO

MEMO is a zero-dependency Node.js CLI that gives a Git repo a persistent memory for AI coding agents.

## Where memory lives
- `.memory/` (tracked): project memory — progress log, decisions, errors, next steps, and later `PROJECT_STATE.md`.
- `~/.memo/` (per machine, never in Git): personal notes, logs, local state.

## Before starting work
- Read `.memory/PROJECT_STATE.md` if it exists. Otherwise:
Read .memory/BRIEF.md before starting.
- If neither exists, run `memo brief` or read `.memory/progress.md`.

## Code map
- `bin/memo.js` — CLI entry (`init | note | hook | brief`).
- `src/` — implementation (paths, git, init, note, hook, brief, redact).
- `templates/post-commit` — Git hook template installed by `memo init`.
- `test/` — `node:test` suites; run `npm test`.
