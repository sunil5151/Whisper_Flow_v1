# MEMO

MEMO is a zero-dependency Node.js CLI that gives a Git repo a persistent memory for AI coding agents.

## Where memory lives
- `.memory/` (tracked): project memory — progress log, decisions, errors, next steps, and later `PROJECT_STATE.md`.
- `~/.memo/` (per machine, never in Git): personal notes, logs, local state.

## Before starting work
- Read `.memory/PROJECT_STATE.md` if it exists (`memo report` regenerates it).
- If it does not exist, read `.memory/progress.md`.

## Code map
- `bin/memo.js` — CLI entry (`init | note | hook | report | context | commit | migrate | setup claude | capture | config | process`).
- `src/` — implementation (paths, git, init, note, hook, brief, redact, config, usage).
- `src/capture/`, `src/store/` — Claude Code capture and the session/record files.
- `src/llm/`, `src/extract/` — provider clients and `memo process` extraction (see `docs/PHASE2_API_EXTRACTION.md`).
- `src/report/`, `src/context.js` — `PROJECT_STATE.md`, `TASKS.md`, and the SessionStart context.
- `src/gitops/memory-commit.js`, `src/migrate.js` — `.memory/`-only commits and legacy-note import.
- `templates/` — post-commit hook, AGENTS block, CLAUDE.md and `.memory/README.md` written by `memo init`.
- `test/` — `node:test` suites; run `npm test`.
