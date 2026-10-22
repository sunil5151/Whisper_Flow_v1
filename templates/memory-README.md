# .memory — project memory written by MEMO

This folder is the project's memory for AI coding agents and humans. It is generated; do not edit by hand.

| Path | What it is |
|---|---|
| `PROJECT_STATE.md` | Canonical current state: intent, open tasks, errors, decisions, recent sessions. Start here. |
| `TASKS.md` | Task table generated from `records/tasks.jsonl`. |
| `progress.md` | One entry per Git commit (post-commit hook). |
| `records/*.jsonl` | Append-only op-log per record type. Fold lines by `id` in file order; last op wins, `delete` removes. |
| `sessions/index.json` | One entry per captured agent session. |
| `sessions/YYYY/MM/DD/<sid>.jsonl` | Normalized, redacted events of one session. |
| `sessions/YYYY/MM/DD/<sid>.md` | Session summary. |
| `legacy/` | Old markdown notes imported by `memo migrate` (read-only). |

Record ids: `D` decision, `E` error, `L` learning, `F` fact, `T` task, `Q` question, `I` intent.
Statuses such as `implemented_unverified` mean no passing test or command output backs the claim yet.
