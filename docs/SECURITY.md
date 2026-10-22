# Security and privacy

What MEMO reads, what leaves your machine, and what you can delete.
Short version: MEMO is a local tool that writes Markdown and JSONL into your repo,
and sends batches of captured events to one API provider you configure.

## 1. What is captured

Capture only happens in a repo where you ran `memo init` (the repo is then listed in
`~/.memo/repos.json`). Claude Code calls `memo capture` on SessionStart, Stop, PreCompact
and SessionEnd; MEMO reads the new bytes of that session's transcript file.

Kept (`src/capture/claude.js`, limits from the plan §6.1):

| Event | What is stored | Limit |
|---|---|---|
| `user_prompt` | your prompt text | 4,000 chars |
| `assistant_text` | the reply text | 3,000 chars |
| `tool_call` | tool name + the Bash command or the file path | 300 chars |
| `tool_result` | first 500 + last 300 chars, plus `ok: true/false` | 800 chars |
| `system`, `git_commit` | short marker lines | — |

Dropped before anything is written to disk:

- thinking blocks
- `Read` results (only the `tool_call` with the path is kept)
- `Write` / `Edit` content (path and line counts only)
- image blocks
- anything whose path matches `config.denyPaths`
  (default `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*.json`, `secrets/**`)

File paths are stored relative to the repo root. A path outside the repo becomes
`<outside-repo>`; your home directory is never written into the event text.

## 2. Redaction

`src/redact.js` runs twice: once when the event is written to disk, once again when the
prompt is built in `src/extract/prompt.js`. It removes API keys (`sk-ant-…`, `sk-proj-…`,
`AKIA…`, bearer tokens), credentials inside connection strings, `.env`-style
`NAME=value` lines and long high-entropy strings next to the words key/secret/token.

**Redaction is regex-based. It is a safety net, not a guarantee.** Read `.memory/` once
before you push a repo somewhere public. If a secret did land in a file, rotate the secret —
removing it from the current file does not remove it from older commits.

## 3. What is sent to the API

`memo process` (directly or from `memo cycle`) sends, per call:

- the fixed system prompt
- the repo folder name (not its full path)
- up to 60 open records (id, type, status, statement)
- one batch of event envelopes, capped at `maxInputTokensPerCall` (default 12,000 tokens)

Nothing else is uploaded: no file contents, no git remote, no username, no machine name.
Provider and model come from `~/.memo/config.json`. With `provider: "mock"` no network
call happens at all. With `apiEnabled: false` or `memo pause`, no call happens either.

Your provider's own retention and training policy applies to what you send — check it
and record the link in `docs/PHASE0_FINDINGS.md` §6 before using a real key.

## 4. Where data lives

| Location | Contents | In Git? |
|---|---|---|
| `.memory/sessions/YYYY/MM/DD/<sid>.jsonl` | captured events | yes |
| `.memory/sessions/<sid>.md`, `index.json` | summaries, session index + tombstones | yes |
| `.memory/records/*.jsonl` | decisions, errors, tasks, learnings, facts, questions, intent | yes |
| `.memory/PROJECT_STATE.md`, `TASKS.md`, `progress.md` | generated reports | yes |
| `~/.memo/config.json`, `repos.json`, `state/`, `logs/` | machine state, cursors, jobs, usage | never |
| `~/.memo/personal.md` | your personal notes | never |

`memo commit` only ever stages `.memory/` (`git commit --only -- .memory`), never your
source files, and never pushes.

## 5. The API key

The key is read from the environment variable named by `config.apiKeyEnv`
(default `MEMO_API_KEY`, falling back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).
It is never written into a config file, never logged, and only ever displayed as
`set (…last4)`.

`install_memo.bat` stores it with `[Environment]::SetEnvironmentVariable(…, 'User')`
after reading it with `Read-Host -AsSecureString`, so it is not echoed and not kept in
your shell history. It is still a plain user environment variable, readable by anything
running as you. DPAPI encryption is planned for P11.

## 6. Deleting data

```
memo clear --session <sid>                 # dry run: files, sizes, affected records
memo clear --session <sid> --with-derived --yes
memo clear --date 2026-10-21 --yes --confirm 2026-10-21
memo clear --record T-1b2c3d4e --yes
memo clear --all-repo-data --yes --confirm DELETE-ALL-MEMO-DATA
```

A deleted session gets a tombstone in `index.json`, so the next capture sweep does not
re-import it from the Claude transcript. The deletion itself is committed.

**Honest limit:** this removes the data from the current files only. Older Git commits
still contain it, and copies on GitHub or in other clones are unaffected. Full erasure
needs history rewriting (`git filter-repo` + force push), which MEMO does not do for you.

## 7. Turning it off

- `memo pause` — the scheduled task keeps running but does nothing
- `memo setup claude --remove` — removes the Claude Code hooks (a backup of
  `~/.claude/settings.json` is written first)
- `scripts\windows\uninstall_memo.bat` — removes the task, the logon entry and the hooks;
  it never deletes `.memory/` or `~/.memo` unless you type `DELETE-ALL-MEMO-DATA`

## 8. Trust boundaries

- The model's output is validated by `src/extract/validate.js` before anything is written:
  unknown fields are dropped, enums are enforced, `files` must be relative with no `..`.
  Model output is never executed, never used as a path outside `.memory/`, and never
  changes the config.
- `verified` / `done` are only accepted with a passing `tool_result` as evidence,
  otherwise they are downgraded and marked `downgraded: true`.
- Hooks and the scheduled task catch every error, log to `~/.memo/logs/` and exit 0,
  so a MEMO bug cannot fail your Claude Code session or your commit.
