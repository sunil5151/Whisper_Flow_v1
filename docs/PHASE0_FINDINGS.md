# Phase 0 Findings

**Date:** YYYY-MM-DD · **Machine:** Windows __ · **Tester:** Sunil

> Fill every section. Write "not tested" instead of leaving blanks. Do not paste keys, tokens or personal data.

## 1. Versions
| Tool | Version |
|---|---|
| `node -v` (need ≥ 20) | |
| `git --version` | |
| `claude --version` | |

## 2. Hook payloads
| Event | Fired (terminal) | Fired (VS Code ext.) | Notes |
|---|---|---|---|
| SessionStart | | | |
| Stop | | | |
| PreCompact | | | |
| SessionEnd | | | |

- `args` field accepted? (yes / no → shell form used):
- Exact stdin fields seen (per event):
- `transcript_path` location (pattern, not full personal path):
- Sample payload file names in `~/.memo/spike/`:

## 3. Transcript format
- Line `type` values seen:
- User text lives at:
- Assistant text lives at:
- `tool_use` lives at:
- `tool_result` lives at; error flag field:
- `uuid` / `timestamp` / `cwd` fields:
- `/compact` behaviour (rewrites file / appends / new file):
- Fixtures saved (redacted, ≤ 200 lines each, reviewed by hand):
  - [ ] `test/fixtures/claude/basic.jsonl`
  - [ ] `test/fixtures/claude/error-then-fix.jsonl`
  - [ ] `test/fixtures/claude/compact.jsonl`

## 4. Transcript retention
- `cleanupPeriodDays` default (verified from docs):
- Source link + date checked:

## 5. Task Scheduler (non-admin PowerShell)
| Test | Works without admin? | Notes |
|---|---|---|
| `/sc minute /mo 15` | | |
| `/sc onlogon` | | |
| Startup-folder shortcut (fallback) | | |

- Hidden-window method chosen (`conhost --headless` / `wscript run-hidden.vbs` / `powershell -WindowStyle Hidden`):
- Window flashed for others?:
- Spike task deleted (`schtasks /delete /tn "MEMO Spike" /f`): [ ]

## 6. API
- Provider:
- Key stored in user env var `MEMO_API_KEY` (never pasted here): [ ]
- Data-retention / training policy link + date checked:

## 7. Model choice
| Model | Valid JSON? | Marked fix "verified" without passing test? | Price in / out per 1M | Notes |
|---|---|---|---|---|
| | | | | |
| | | | | |

- **Chosen model ID:**
- Price used in `~/.memo/config.json`:

## 8. Gate results
- [ ] `npm test` green in PowerShell
- [ ] `npm test` green in Git Bash
- [ ] `memo init` test repo → commit from Git Bash → `progress.md` entry
- [ ] … from PowerShell
- [ ] … from VS Code Source Control

## 9. Surprises / plan changes for P1–P4
-
