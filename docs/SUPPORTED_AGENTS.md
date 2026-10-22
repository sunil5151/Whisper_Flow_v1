# Supported agents

MEMO captures one agent today: **Claude Code**. Everything else is either planned or
out of scope. Fill the "verified on" rows during the P6 end-to-end run.

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

## Not supported yet

| Agent | Status |
|---|---|
| Codex CLI | planned, P9 — needs an adapter in `src/capture/codex.js` |
| Cursor / Windsurf / Copilot Chat | no stable local transcript + hook contract checked yet |
| Plain `git` usage without an agent | partially: the post-commit hook writes `.memory/progress.md` |

## Adding another agent

1. Write `src/capture/<agent>.js` with a `normalize(line, ctx) → envelope[]` function
   that produces the §6.1 envelope (`type`, `id`, `seq`, `ts`, `agent`, `text`, `ok`).
2. Reuse `src/capture/capture.js` for cursors, locking, dedup and session files.
3. Add redacted fixture transcripts under `test/fixtures/<agent>/` and a
   `test/capture-<agent>.test.js` that runs offline.
4. Add the install path (hooks, wrapper or polling) and document it here.
