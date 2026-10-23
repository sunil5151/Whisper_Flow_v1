<!-- codebase-summary base=5089d98861779d49b3e88a4b0b211bf639c84516 model=gpt-6-luna at=2026-10-23T01:27:23.899Z -->
# Codebase summary

## Changes since last run

- Added untracked `scripts/codebase-summary.js`, an OpenAI-backed utility for creating or incrementally updating `codebase_summary.md`. It redacts file contents and diffs before sending them to the model.
- No commits or tracked-file changes were provided.
- Newly pending: run the script and review its generated summary; no generated `codebase_summary.md` is included in the changes.
- No fixes to the existing extraction-cycle or documentation issues are shown.

## Overview
MEMO is a zero-dependency Node.js CLI that gives Git repositories persistent memory for AI coding sessions.
It captures Claude Code transcripts, redacts and normalizes events, and can use an LLM provider to extract evidence-linked records.
It stores project memory in tracked `.memory/` files and machine-specific configuration, cursors, logs, and credentials under `~/.memo/`.
It also provides generated reports, session context, memory-only commits, Windows installation and scheduling, and commands to browse or delete stored data.

## Structure
```text
.
├── bin/                  CLI entry point
├── src/                  Capture, extraction, storage, reporting, Git, install, and UI modules
│   ├── capture/          Claude Code hooks, transcript normalization, and capture
│   ├── extract/          Prompt construction, validation, and processing
│   ├── gitops/           Memory-only Git operations
│   ├── llm/              Provider clients, retries, and provider limits
│   ├── report/           Project-state, task, and session-summary rendering
│   ├── store/            Session and record JSONL storage
│   └── ui/               Interactive console
├── scripts/              Utilities, codebase-summary generation, and Windows launcher/scheduler scripts
│   └── windows/          Installer wrappers, Task Scheduler registration, hidden launcher
├── templates/            Files written by `memo init`
├── docs/                 Security, supported-agent, phase, and implementation documentation
├── test/                 Node.js test suites and test isolation support
│   └── fixtures/         Claude transcript, LLM response, and report fixtures
└── .memory/              Tracked project state, tasks, decisions, and session history
```

## Main files
| file | role |
|---|---|
| `bin/memo.js` | CLI command router and help text |
| `package.json` | Package metadata, Node.js ≥20 requirement, and `npm test` script |
| `scripts/codebase-summary.js` | Full or incremental OpenAI-backed summary generation; redacts inputs and writes `codebase_summary.md` |
| `src/capture/capture.js` | `memo capture` hook entry point and `--sweep` transcript catch-up |
| `src/capture/claude.js` | Converts Claude Code transcript lines into redacted event envelopes |
| `src/extract/process.js` | Batches pending events, calls a provider, validates results, and advances processing state |
| `src/extract/prompt.js` | Builds and redacts extraction requests; splits events into batches |
| `src/extract/validate.js` | Validates model output, enforces evidence rules, and downgrades unsupported completion claims |
| `src/store/sessions.js` | Session index, event-file paths, event append, and session tombstones |
| `src/store/records.js` | Append-only record logs, ID generation, folding, and job checks |
| `src/report/state.js` | Renders `.memory/PROJECT_STATE.md` |
| `src/report/tasks.js` | Renders `.memory/TASKS.md` |
| `src/cycle.js` | Coordinates sweep, extraction, report generation, and memory-only commit |
| `src/gitops/memory-commit.js` | Commits only `.memory/` changes and blocks commits containing recognized credentials |
| `src/install.js` | Machine setup and uninstall flows |
| `src/schedule.js` | Windows scheduled-task management and non-Windows cron guidance |
| `src/secrets.js` | Stores API keys using Windows DPAPI or a restricted-permission file backend |
| `src/delete.js` | Plans and applies session, date, record, or repository-data deletion |
| `src/browse.js`, `src/ui/menu.js` | Session/task browsing and the interactive `memo console` |
| `setup_memo.bat`, `uninstall_memo.bat` | Root Windows setup and uninstall launchers |
| `MEMO_IMPLEMENTATION_PLAN.md` | Detailed phased implementation and acceptance plan |
| `docs/SECURITY.md`, `docs/SUPPORTED_AGENTS.md` | Data handling, privacy limits, and supported-agent documentation |
| `.memory/PROJECT_STATE.md`, `.memory/TASKS.md` | Generated project status and task registry |

## Current status
- The codebase contains an end-to-end implementation for Claude Code capture, mock and HTTP-backed LLM extraction, record validation, generated reports, SessionStart context, memory-only commits, scheduling, status/doctor checks, browsing, and deletion.
- `scripts/codebase-summary.js` adds a separate utility that uses `src/llm/openai` and `src/redact` to generate a full or incremental codebase summary. Its default model is `gpt-6-luna`, overridable with `MEMO_SUMMARY_MODEL`; it reads credentials from `OPENAI_API_KEY` or line 2 of `groq_key.md`.
- The summary utility has not been shown running, and no generated `codebase_summary.md` is included in the provided changes.
- `npm test` uses Node’s built-in test runner and `test/support/isolate.js` to isolate test state. The memory files report successful test runs for P4, status, and Windows-script checks after patches, but they also retain a failed extraction-cycle test blocker; see **Known issues / bugs**.
- The tracked project state reports **489 unprocessed events** and a last cycle marked failed as of 2026-10-23. This is the state recorded in `.memory/PROJECT_STATE.md`, not a guarantee of the current runtime state.
- Windows is the primary installation and scheduling target. Other platforms receive cron guidance from `src/schedule.js`; the supplied docs do not claim that the full Windows end-to-end workflow has been verified.
- `README.md` remains a placeholder, and `docs/PHASE0_FINDINGS.md` and the verification rows in `docs/SUPPORTED_AGENTS.md` are unfilled.

## Completed
- Implemented Claude Code hook setup and incremental transcript capture, including session files, event normalization, redaction, deduplication, and capture sweeps.
- Implemented extraction plumbing: mock, Anthropic, and OpenAI-compatible/Groq provider modules; batching; retries and rate-limit handling; usage accounting; and output validation.
- Implemented append-only record storage, task and project-state reports, session summaries, and compact context output for new Claude Code sessions.
- Implemented `.memory/`-only commits, legacy-note migration, and `memo clear` flows with dry-run defaults and session tombstones.
- Implemented Windows setup/uninstall flows, per-user Task Scheduler registration, status/doctor, pause/resume, key management, session/task browsing, and the interactive console.
- Added offline tests and fixtures for capture, validation, providers, reports, commits, deletion, status, and Windows scripts.
- Added `scripts/codebase-summary.js` for redacted, full or incremental summary generation. The utility’s execution and generated output are not verified by the provided changes.
- The memory records mark live extraction and Phase 2 implementation as verified, and report that automated P4, status, and Windows-script tests passed after patches. These claims conflict with other status records and documentation noted below.

## Pending
- Run `scripts/codebase-summary.js` in the intended environment and review its generated `codebase_summary.md`.
- Complete the P6 Windows end-to-end run, measurements, README, and demo described in `MEMO_IMPLEMENTATION_PLAN.md`.
- Fill in `docs/PHASE0_FINDINGS.md` with actual hook, transcript-retention, Task Scheduler, provider-policy, and model-verification results; update the unverified rows in `docs/SUPPORTED_AGENTS.md`.
- Resolve or reconcile the extraction-cycle test failure recorded in `.memory/PROJECT_STATE.md` and `.memory/records/errors.jsonl` against the later test-pass notes.
- Resolve `.memory/next.md`’s outstanding `Fix memo_phase_3.patch` item and clarify the status of the `implemented_unverified` Phase 2 task in `.memory/TASKS.md`.
- Verify Windows installation, scheduled execution, and real-provider behavior on the target environment; the provided findings template does not contain those results.

## Known issues / bugs
- **Conflicting test and cycle status:** `.memory/PROJECT_STATE.md` records blocker `E-7bfef16e`, “expected more than one batch, got 1,” and a failed last cycle. The same state file also summarizes later test runs as green after patches to `cycle.test.js`. The supplied files do not establish whether the blocker was fully resolved or whether the current cycle succeeds.
- **Phase 2 documentation is stale or contradictory:** `docs/PHASE2_API_EXTRACTION.md` says “Status: not executed” and says no test suite or API call was run. `.memory/PROJECT_STATE.md` and `.memory/TASKS.md` later mark live extraction and Phase 2 complete/verified. Reconcile the documentation with the recorded evidence and current code.
- **Phase 2 task status disagrees across memory files:** `.memory/TASKS.md` lists “Implement Phase 2 features” as `implemented_unverified`, while `.memory/PROJECT_STATE.md` lists Phase 2 as verified.
- **README is unfinished:** `README.md` contains only a title and “README to be dictated by Sunil,” leaving the project without user-facing setup and usage documentation at the repository root.
- **Phase 0 and support verification are incomplete:** `docs/PHASE0_FINDINGS.md` is still a blank template, and `docs/SUPPORTED_AGENTS.md` leaves the Claude Code version and platform verification rows unfilled.
- **Summary utility full mode omits untracked files:** `scripts/codebase-summary.js` builds its full-mode file list with `git ls-files`, so untracked files are not included in a full summary. Incremental mode separately collects untracked files with `git ls-files --others`.
- **Dangerous repository helper scripts remain:** `git_committer.bat` runs `git add .`, resets the origin URL to a hardcoded repository, and pushes. `init_repo.bat` also configures that hardcoded origin. These scripts can stage unrelated files or alter a user’s remote; they are not part of MEMO’s memory-only commit path.
- **Installer repository URL is hardcoded:** `setup_memo.bat` defaults to `https://github.com/sunil5151/Whisper_Flow_v1.git` (overridable with `MEMO_REPO_URL`) when downloading the managed copy. Confirm this is the intended distribution source before reuse elsewhere.
