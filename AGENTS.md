# MEMO

MEMO is a zero-dependency Node.js CLI that gives a Git repo a persistent memory for AI coding agents.

## Where memory lives
- `.memory/` (tracked): project memory — progress log, decisions, errors, next steps, and later `PROJECT_STATE.md`.
- `~/.memo/` (per machine, never in Git): personal notes, logs, local state.

## Before starting work
- Read `.memory/PROJECT_STATE.md` if it exists (`memo report` regenerates it).
- If it does not exist, read `.memory/progress.md`.

## Working rules
1. Ask for confirmation before risky actions: `git push`, deleting files, force operations.
2. Keep replies short and concise; report results, not narration.
3. Do not add unnecessary comments, features or abstractions; prefer editing existing files.
4. Review the diff and run `npm test` before proposing a commit.
5. Never write secrets or absolute machine paths into tracked files.

## Code map
- `bin/memo.js` — CLI entry (`init | note | hook | report | context | commit | migrate | setup claude | capture | config | process | cycle | status | doctor | pause | resume | install | sessions | show | tasks | clear | console`).
- `src/` — implementation (paths, git, init, note, hook, brief, redact, config, usage, lock, log, repos).
- `src/cycle.js`, `src/status.js`, `src/install.js` — the 15-minute run, `memo status`/`doctor`, first-run setup.
- `src/delete.js`, `src/browse.js`, `src/ui/menu.js` — `memo clear`, the read-only views and `memo console`.
- `scripts/windows/` — `install_memo.bat`, `uninstall_memo.bat`, `register-task.ps1`, `run-hidden.vbs` (CRLF).
- `src/capture/`, `src/store/` — Claude Code (hooks), Copilot (`copilot.js`) and Gemini/Antigravity (`gemini.js`, both found by the sweep) capture, and the session/record files.
- `templates/vscode-tasks.json` — the folder-open `memo cycle` task `memo init` adds to `.vscode/tasks.json`.
- `src/llm/`, `src/extract/` — provider clients and `memo process` extraction (see `docs/PHASE2_API_EXTRACTION.md`).
- `src/report/`, `src/context.js` — `PROJECT_STATE.md`, `TASKS.md`, the SessionStart context, and the memo block in `AGENTS.md`, `.github/copilot-instructions.md`, `GEMINI.md` (`src/report/agents.js`).
- `src/gitops/memory-commit.js`, `src/migrate.js` — `.memory/`-only commits and legacy-note import.
- `templates/` — post-commit hook, AGENTS block, CLAUDE.md and `.memory/README.md` written by `memo init`.
- `docs/SECURITY.md`, `docs/SUPPORTED_AGENTS.md` — what is captured/sent/deletable, and which agents work.
- `test/` — `node:test` suites; run `npm test`.

<!-- memo:start -->
## Project memory (MEMO)
- Project rules and code map: `AGENTS.md`. Current state: `.memory/PROJECT_STATE.md` (open tasks, errors, decisions, recent sessions).
- Task list: `.memory/TASKS.md`. How the folder works: `.memory/README.md`.
- These files are generated; corrections go through `memo note -t <decision|error|next> "text"`.
- Asked about earlier chats, previous conversations or what was discussed before: do NOT use chat or session-history tools. They hold only your own sessions, and those come back empty. Open the files listed under "Recent sessions" below (one summary each; all are in `.memory/sessions/index.json`) plus `.memory/PROJECT_STATE.md`, and answer from them.

### Snapshot (sessions processed up to 2026-10-26)
Recent sessions:
- 2026-10-26 ae3e137b: User reported that after installing git CLI, Claude still wasn't running in GitHub Actions. Diagnosis: gh 2.103.2 and git 2.49.0 are installed and gh is authen… → .memory/sessions/2026/10/26/ae3e137b-a28d-47c5-83d5-3704cc887f7d.md
- 2026-10-26 ad1fcd99: The user attempted to set up the Claude GitHub integration: the /install-github-app command was run (both runs cancelled), and they tried `claude setup-token`,… → .memory/sessions/2026/10/26/ad1fcd99-1266-4264-8533-fa2e434d33ac.md
- 2026-10-26 b01fd773: This session's events contain only a single system event recording that the /install-github-app command was invoked at 2026-10-26T14:10:32 local time. No tool … → .memory/sessions/2026/10/26/b01fd773-f369-4de9-9196-d4d02fc8311e.md
- 2026-10-26 769ddbc2: The session contains only a single system event: the /install-github-app command was invoked at 2026-10-26 09:20:50 (+05:30) in whisper_flow_hackathon. No tool… → .memory/sessions/2026/10/26/769ddbc2-f7e4-4c6d-a22b-5d23fe02586c.md
- 2026-10-26 0e5c3a78 (gemini): The user inquired about the granularity and scope of the current and past conversation history within MEMO. The system confirmed that all conversations are sav… → .memory/sessions/2026/10/26/0e5c3a78-e60c-4730-aedc-ea8095456a26.md
Intent:
- User wants the current Antigravity-platform conversation (and future ones) to be automatically saved into MEMO; they asked how to achieve this since MEMO's capture currently does not read the Antigra… (I-7aac1970)
- User asked to do the same for Gemini as was done for Copilot: when this repo opens, save all conversations, organise them, and report back. (I-87190b38)
- User wants every AI agent (Copilot, Gemini, Cursor, Codex) to have the same project context as Claude Code; provider switched to OpenRouter GLM 5.3 Flash and memo init/report now write inline context… (I-fbc13eb5)
Open tasks:
- Push README work to origin/main — blocked, high (T-3e47280d)
- Commit Gemini capture work — in_progress, high (T-d193875f)
- Verify OpenRouter switch end-to-end — open, normal (T-6172295c)
- Stale 'open' records (Groq 401 error, Anthropic credit error) appear in the snapshot and should be removed via `memo note` or `memo clear --record`. — open, normal (T-97c2cd22)
Open errors:
- Cycle 'capture_gap' status root-caused: sweep logs show 'transcript_missing' entries for old whisper_flow_hackathon sessions whose transcripts were deleted (12 of 40 sweeps); capture_gap is a display… — reopened (E-4e73258b)
- get_session_context returns empty transcripts (transcript: [], hasMoreHistory: false) for archived whisper_flow_hackathon sessions of 24 Oct ('purane conversation ka pata') and 25 Oct ('purane conver… — investigating (E-57c2fad3)
- Groq API returns 401 'Invalid API Key' on every background cycle, leaving ~970 events unprocessed and .memory/PROJECT_STATE.md stale since 2026-10-23 23:52 — a root cause of Copilot/other agents seei… — observed (E-ddfc5755)
- git push origin main rejected (non-fast-forward): origin/main had 7 newer commits (analysis workflow, cost_tracker.py, analyze_repo.py, requirements need). Later push attempts blocked: rebase conflic… — observed (E-9b1f53c8)
Active decisions:
- Capture routing in src/capture/capture.js was refactored to be common across agents so the Gemini adapter (src/capture/gemini.js) plugs in alongside the Copilot adapter. (D-e448c8a1)
- Capture is no longer Claude-only: src/capture/capture.js now routes per-agent and a Copilot adapter (src/capture/copilot.js) reads ~/.copilot/session-state/<sid>/events.jsonl transcripts, normalizing… (D-572833e3)
- Cycle/memo commit now includes tracked agent files (AGENTS.md, .github/copilot-instructions.md, GEMINI.md) only when their working-tree change is confined to the memo:start/end block (blockOnlyFiles … (D-c0efe619)
- CLAUDE.md's Working rules were moved into AGENTS.md so Copilot/Gemini/Codex can read them; CLAUDE.md now points at AGENTS.md instead of duplicating rules. (D-d57fd30d)
<!-- memo:end -->
