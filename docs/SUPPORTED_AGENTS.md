# Supported agents

MEMO **reads context into** every agent below, and **captures** Claude Code, GitHub Copilot
agent and Gemini (Google Antigravity) sessions today.

Sync on open: Claude Code's SessionStart starts a background `memo cycle` (skipped if one ran in
the last 5 minutes; `MEMO_AUTO_CYCLE=0` turns it off), and `memo init` adds a
`MEMO: sync conversations` task to `.vscode/tasks.json` that VS Code-based editors (VS Code,
Antigravity) run on folder open. Allow it once with **Tasks: Manage Automatic Tasks → Allow**.
Either way every agent's new conversations are saved, summarised and the agent files refreshed.
Fill the "verified on" rows during the P6 end-to-end run.

## Reading the memory (every agent)

`memo init` writes one `<!-- memo:start -->…<!-- memo:end -->` block into each file below. The
block holds a pointer to `.memory/` plus a snapshot of open errors, tasks, decisions and the last
three sessions, because these agents run no hook and often never open a file they are only
pointed at. Each cycle and `memo report` refresh the block; the cycle commits a file only when its
change is inside the block, so your own edits to these files are never committed for you. When
processing is more than a day behind the captured sessions, the snapshot says it is stale.

| Agent | File it loads by itself |
|---|---|
| Claude Code | `CLAUDE.md` (`@AGENTS.md`) + the SessionStart hook (`memo context`) |
| GitHub Copilot (VS Code chat, coding agent) | `.github/copilot-instructions.md` |
| Codex CLI, Cursor, Windsurf, Copilot agent mode | `AGENTS.md` |
| Gemini CLI / Code Assist | `GEMINI.md` |

Put project rules that every agent should follow in `AGENTS.md` outside the block; Copilot and
Gemini see only the block, which points back to `AGENTS.md`. Delete the block from a file to stop
MEMO from updating that file.

## Claude Code

| Item | Value |
|---|---|
| Capture method | hooks in `~/.claude/settings.json` → `memo capture` reads the session transcript |
| Hook events used | `SessionStart` (also prints the project context), `Stop`, `PreCompact`, `SessionEnd` |
| Transcript format | JSONL, one message per line, read incrementally by byte offset |
| Installed by | `memo setup claude` (backs the settings file up first, idempotent) |
| Removed by | `memo setup claude --remove` |
| Version verified | _fill in: `claude --version` output used for the P6 run_ |
| Terminal (PowerShell) | _fill in: pass / fail_ |
| Terminal (Git Bash) | _fill in: pass / fail_ |
| VS Code extension | _fill in: pass / fail_ |

### How it works

1. A session starts → `SessionStart` fires → MEMO records the transcript path in
   `~/.memo/state/<repoId>/cursors.json` and prints `memo context` to stdout, which
   Claude Code adds to the session context.
2. Each turn end (`Stop`), each compaction (`PreCompact`) and the session end
   (`SessionEnd`) fire → MEMO reads only the bytes after the stored offset, normalizes
   them into event envelopes, redacts them and appends to
   `.memory/sessions/YYYY/MM/DD/<sid>.jsonl`.
3. Every 15 minutes `memo cycle` sweeps anything the hooks missed, extracts records and
   commits `.memory/`.

### Known limits

- **Two sessions in the same repo at once** — both are captured, but their events
  interleave in separate files; cross-session consolidation is P7/P8 work.
- **Resumed or forked sessions** reuse the same session id: capture continues from the
  stored offset, so a fork may be recorded under the parent id.
- **Compaction rewrite** — if Claude Code rewrites the transcript file shorter than the
  stored offset, MEMO logs `transcript_rewritten`, resets the offset to 0 and re-reads;
  event ids make the re-read idempotent.
- **Subagent transcripts** are not captured (P8).
- **Worktrees and branch switches** — the repo root is resolved per hook call; a second
  worktree of the same repo is a separate root and needs its own `memo init`.
- **Transcript retention** — if Claude Code deletes old transcripts
  (`cleanupPeriodDays`) before a sweep runs, those events are lost; the hooks normally
  capture them long before that.
- **Hook failures are silent by design**: `memo capture` always exits 0 and logs to
  `~/.memo/logs/capture.jsonl`, so a MEMO problem never breaks your session.

## GitHub Copilot (agent sessions)

| Item | Value |
|---|---|
| Capture method | the `memo cycle` sweep reads `<COPILOT_HOME or ~/.copilot>/session-state/<sid>/events.jsonl` |
| Which sessions | those whose `workspace.yaml` `git_root` (or `cwd`) is the repo root |
| Kept | `user.message`, `assistant.message` text, `tool.execution_start` / `_complete` (same limits and redaction as Claude Code) |
| Dropped | `view` results (file contents), reasoning and encrypted blobs, usage and session bookkeeping |
| Hooks | none — new Copilot sessions appear in `.memory/` after the next cycle (≤ 15 min) |
| Verified on | Copilot `1.0.100-1`, producer `copilot-agent`, client `vscode-agent-host` (26 Oct 2026) |

## Gemini in Google Antigravity

| Item | Value |
|---|---|
| Capture method | the sweep reads `<ANTIGRAVITY_HOME or ~/.gemini/antigravity>/brain/<id>/.system_generated/logs/transcript.jsonl` |
| Which sessions | the transcript names no workspace: a conversation belongs to the repo holding the first absolute path in its tool calls |
| Kept | `USER_INPUT` (the `<USER_REQUEST>` text), `PLANNER_RESPONSE` text and tool calls, `GENERIC` tool results paired with their calls in order |
| Dropped | thinking, file-read results, request metadata and settings notices |
| Verified on | Antigravity transcripts of 26 Oct 2026 (Gemini 3.8 Flash) |

A conversation that never touches a file of the repo is not matched; Gemini CLI (`~/.gemini/tmp`) is not read yet.

## Not supported yet

| Agent | Status |
|---|---|
| Codex CLI | planned, P9 — needs an adapter in `src/capture/codex.js` |
| Copilot Chat panel sessions stored only in VS Code `workspaceStorage` | not read; the agent host above is |
| claude.ai / Claude Desktop chats | kept on Anthropic's servers, no local transcript to read |
| Cursor / Windsurf | no stable local transcript + hook contract checked yet |
| Plain `git` usage without an agent | partially: the post-commit hook writes `.memory/progress.md` |

## Adding another agent

1. Write `src/capture/<agent>.js` with a `normalize(line, ctx) → envelope[]` function
   that produces the §6.1 envelope (`type`, `id`, `seq`, `ts`, `agent`, `text`, `ok`).
2. Reuse `src/capture/capture.js` for cursors, locking, dedup and session files.
3. Add redacted fixture transcripts under `test/fixtures/<agent>/` and a
   `test/capture-<agent>.test.js` that runs offline.
4. Add the install path (hooks, wrapper or polling) and document it here.
