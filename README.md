# MEMO — a memory for your AI coding agents, stored in your Git repo

AI coding agents (Claude Code, GitHub Copilot, Gemini in Antigravity) forget everything when a chat ends.
Tomorrow you start a new chat and have to explain again what you built, which bug you fixed, why you
rejected an approach, and what is still left to do.

MEMO fixes that. It quietly records your agent conversations, asks a small, cheap AI model to pull out
the parts worth keeping, and writes them as plain files inside your project. The next time any agent opens
the project, it reads those files and already knows where you left off.

Zero dependencies: plain Node.js, no `npm install`.

## Contents
- [The problem it solves](#the-problem-it-solves)
- [How it works](#how-it-works)
- [How the AI API call works](#how-the-ai-api-call-works)
- [Why the memory is stored in Git](#why-the-memory-is-stored-in-git)
- [What you get in `.memory/`](#what-you-get-in-memory)
- [Setup](#setup)
- [Daily use](#daily-use)
- [Cost control](#cost-control)
- [Privacy and safety](#privacy-and-safety)
- [Command cheat sheet](#command-cheat-sheet)
- [Troubleshooting](#troubleshooting)
- [More docs](#more-docs)

## The problem it solves

| Without MEMO | With MEMO |
|---|---|
| Every new chat starts from zero | The agent starts with a summary of the project: open tasks, open bugs, decisions |
| You re-explain "we tried X and it failed" | Rejected options are stored as `rejected` decisions |
| Switching between Claude, Copilot and Gemini loses context | All three write to and read from the same `.memory/` folder |
| A teammate has no idea what the AI did last week | Session summaries are committed next to the code |
| "Was that bug actually fixed?" | Nothing is marked `verified` or `done` unless a command or test really passed |

## How it works

```
 you chat with an agent            (Claude Code / Copilot / Gemini)
          |
          v
 1. CAPTURE   hooks and a background sweep read the new part of the chat transcript.
              Secrets are redacted, file contents and "thinking" are dropped.
          |
          v
 2. EXTRACT   the new events are sent to a small AI model (default: GLM 5.3 Flash
              through OpenRouter). It returns decisions, errors, tasks, facts, summaries.
          |
          v
 3. VALIDATE  MEMO's own code checks the model's answer: every item must point to real
              evidence from the chat. Bad items are dropped, unproven "done" is downgraded.
          |
          v
 4. WRITE     files are written to .memory/ in your repo and committed
              (only .memory/ is committed, never your source code, and never pushed).
          |
          v
 5. READ      the next session gets PROJECT_STATE.md as context automatically.
```

Step by step:

1. **Capture.** In a repo where you ran `memo init`, Claude Code calls MEMO at session start, after each
   reply, before compaction and at session end. Copilot and Gemini (Antigravity) have no hooks, so a
   background run (`memo cycle`, every 15 minutes on Windows) reads their transcript files instead.
   Only the new part of each transcript is read.
2. **Extract.** `memo process` sends the new events, in small batches, to your configured AI provider.
   Nothing is sent when there is nothing new.
3. **Validate.** The model proposes, MEMO's code decides (`src/extract/validate.js`).
4. **Write and commit.** Records, session summaries and reports go into `.memory/`, then MEMO commits
   that folder only.
5. **Read.** `memo init` adds a short snapshot block to `CLAUDE.md`/`AGENTS.md`,
   `.github/copilot-instructions.md` and `GEMINI.md`, and Claude Code also gets `memo context` printed at
   session start. Each agent therefore sees the current state without you pasting anything.

## How the AI API call works

MEMO itself is not an AI. It uses an AI model through an API only for step 2 (turning a raw chat into
tidy notes). It talks to the provider with plain `fetch`, no SDK.

**Default provider: OpenRouter with `z-ai/glm-5.3-flash` (GLM 5.3 Flash).** It was picked for low cost
(about $0.15 per million input tokens and $0.50 per million output tokens) and no per-minute cap.
You can switch to Groq, Anthropic, OpenAI or any OpenAI-compatible endpoint (`baseUrl`), or `mock` for
offline fixtures that never touch the network.

What one call looks like (`src/llm/openai.js`, `src/extract/prompt.js`):

1. **Request** — `POST https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer <your key>`.
   The body holds:
   - a fixed system prompt that tells the model what to extract (decisions, errors, learnings, facts, tasks,
     questions, intents) and the rules it must follow;
   - the repo folder name (not its path), up to 60 already-open records, and one batch of redacted events,
     capped at 4,500 tokens by default;
   - a JSON schema, so the model must answer in a strict JSON shape (falls back to plain JSON mode on
     providers without schema support).
2. **Reply** — JSON such as `{"session_summary": "...", "items": [{"op": "create", "type": "decision", "statement": "...", "evidence": ["e-..."]}]}`.
3. **Validation** — unknown fields dropped, enums enforced, strings capped, every `evidence` id must exist,
   and `verified`/`done` is accepted only if the evidence is a tool result that succeeded. The model's
   output is never executed and never decides a file path outside `.memory/`.
4. **Retries** — up to 3 attempts with 2 s / 8 s / 30 s backoff, honouring `retry-after`. Long rate limits
   or exhausted credits are deferred, not retried in a loop; the work stays queued for the next run.
5. **Idempotency** — a crashed run never produces duplicates; the next run continues from a stored cursor.

Your API key is stored once per machine, outside any repo: encrypted with Windows DPAPI on Windows, or in a
file readable only by you (`~/.memo/secrets/`) on macOS/Linux. It is never written to a log or printed
(only `set (…last4)`).

## Why the memory is stored in Git

`.memory/` is a normal folder of Markdown and JSONL files, committed with your code.

- **It travels with the repo.** Clone on another machine or hand the repo to a teammate and the memory
  comes along. No server, no account, no database.
- **It is versioned.** `git log .memory` shows how the project's knowledge changed; `git revert` undoes a bad note.
- **It is reviewable.** Plain text diffs in a pull request; you can read and correct everything the AI wrote.
- **It is agent-neutral.** Any agent that can read a file can use it.
- **It stays in step with the code.** The memory of a feature lives in the same commit history as the feature.
- **You stay in control.** MEMO commits only `.memory/` and never pushes. You decide what leaves your machine.

Per-machine data (settings, logs, cursors, your key, personal notes) lives in `~/.memo/` and is never in Git.

## What you get in `.memory/`

| Path | What it is |
|---|---|
| `PROJECT_STATE.md` | **Start here.** Current intent, open tasks, errors, decisions, recent sessions. |
| `TASKS.md` | Task table with priority and effort estimate. |
| `progress.md` | One entry per Git commit (written by a post-commit hook). |
| `records/*.jsonl` | The structured memory: decisions, errors, tasks, learnings, facts, questions, intents. |
| `sessions/YYYY/MM/DD/<sid>.md` | A summary of each chat session. |
| `sessions/YYYY/MM/DD/<sid>.jsonl` | The redacted events of that session (the evidence). |

Generated files should not be edited by hand. To correct something, add a note:
`memo note -t decision|error|next "text"`.

## Setup

### Requirements
- **Node.js 20 or newer** and **Git**.
- An API key for one provider (default: an [OpenRouter key](https://openrouter.ai/keys)). Not needed for the `mock` provider.
- Claude Code, Copilot or Antigravity, depending on what you use.

### 1. Get MEMO
MEMO is not on npm. Clone it:

```
git clone https://github.com/sunil5151/Whisper_Flow_v1.git
cd Whisper_Flow_v1
```

No `npm install` is needed.

### 2. Install it on your machine

**Windows 10/11 (recommended path):** double-click or run `setup_memo.bat`. It checks Git and Node (offers
to install them with winget), optionally installs Claude Code, then runs `memo install`, then `memo doctor`.
It is safe to rerun at any time; rerunning repairs a broken setup and keeps your settings.

**Any OS, directly:**

```
node bin/memo.js install
```

The installer asks for the provider and model (Enter keeps the default), asks for your API key (input hidden),
installs the Claude Code hooks (your `~/.claude/settings.json` is backed up first), registers the background
task (Windows), and finally sends one tiny real request so a bad key shows up now. Useful flags:
`--provider openrouter|groq|anthropic|openai|mock`, `--model <id>`, `--yes` (no questions), `--skip-live`.

### 3. Get the `memo` command

| OS | What happens |
|---|---|
| Windows | The installer creates `memo.cmd` in `%LOCALAPPDATA%\MEMO\bin` and adds that folder to your **user** PATH (no admin). **Open a new terminal** afterwards. |
| macOS / Linux | No command is installed automatically. Run `npm link` inside the MEMO folder to get a global `memo`, or call `node /path/to/Whisper_Flow_v1/bin/memo.js` instead of `memo`. |

### 4. Verify

```
memo --version
memo status          # is capture working, what is pending, API calls and limits
memo doctor          # checks every piece
memo doctor --live   # also sends one tiny real request to your provider
```

### 5. Turn it on in a project

```
cd your-project      # any Git repo
memo init
```

`memo init` creates `.memory/`, adds the post-commit hook, writes the memory block into `AGENTS.md`,
`CLAUDE.md`, `.github/copilot-instructions.md` and `GEMINI.md`, and adds a VS Code task that syncs on folder
open (allow it once via **Tasks: Manage Automatic Tasks > Allow**). Nothing is captured in repos where you
have not run `memo init`.

### Platform notes
- The 15-minute background task is **Windows-only** (Task Scheduler). On macOS/Linux run `memo cycle`
  yourself, or put it in cron. Claude Code's SessionStart hook also starts a background cycle.
- Copilot and Gemini conversations are picked up by that sweep, so they appear after the next cycle.

## Daily use

You mostly do nothing: work with your agent as usual.

1. Start a session. The agent receives the project state automatically.
2. Work. MEMO captures in the background.
3. Read `.memory/PROJECT_STATE.md` any time, or run `memo tasks`, `memo sessions`, `memo show <sid8>`.
4. To force a sync now: `memo cycle`. To only regenerate reports: `memo report`.
5. Add things the AI missed: `memo note -t decision "Use SQLite, not Postgres"`.

## Cost control

- No new events means no API call at all.
- `memo process --dry-run` prints the event count and estimated cost without calling anything.
- `monthlyBudgetUsd` (default $5), `dailyTokenBudget`, `maxInputTokensPerCall` (4,500) and
  `maxCallsPerCycle` (6) cap spending. Change with `memo config set <key> <value>`; see `memo usage`.
- `memo pause` stops API calls while capture keeps running; `memo resume` restarts them.

## Privacy and safety

- Captured: your prompts, the agent's replies, tool names, file paths and trimmed tool output.
- Dropped before disk: thinking blocks, file contents, images, and anything matching `denyPaths`
  (`.env`, `*.pem`, `*.key`, `secrets/**`, ...).
- Secrets are redacted twice: on capture and again just before the API call.
- Sent to the provider: redacted events and record summaries only. Not your source files.
- **Redaction is regex-based, a safety net, not a guarantee.** Read `.memory/` once before you push a repo publicly.
- Delete data with `memo clear` (dry run by default). Old Git commits keep old copies; full erasure needs history rewriting.
- Stop everything with `memo pause` or `memo uninstall` (your memory data is kept).

Details: [docs/SECURITY.md](docs/SECURITY.md).

## Command cheat sheet

| Command | Purpose |
|---|---|
| `memo install` | One-time machine setup (rerun = repair) |
| `memo init` | Activate MEMO in the current repo |
| `memo status` / `memo doctor [--live]` | Health checks |
| `memo cycle` | Capture, extract, report and commit now |
| `memo process [--dry-run]` | Extraction only |
| `memo report` | Regenerate `PROJECT_STATE.md` and `TASKS.md` |
| `memo tasks`, `memo sessions`, `memo show <sid8>` | Read the memory |
| `memo note -t decision\|error\|next "text"` | Add a note by hand |
| `memo key set\|status\|remove` | Manage the API key |
| `memo config`, `memo config set <k> <v>`, `memo usage` | Settings and spend |
| `memo pause` / `memo resume` | Stop / start API calls |
| `memo clear ...` | Delete captured data |
| `memo console` | Numbered menu over the above |
| `memo uninstall` | Remove task and hooks, keep data |

Run `memo` with no arguments for the full list.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `memo: command not found` | Windows: open a new terminal, or rerun `setup_memo.bat`. macOS/Linux: `npm link` in the MEMO folder, or use `node bin/memo.js`. |
| `memo status` says capture gap / `PROJECT_STATE.md` is stale | Run `memo cycle`. Check `memo doctor --live` for key or provider errors. |
| Provider test fails with 401 / auth | Wrong or expired key: `memo key set`, then `memo doctor --live`. |
| Rate limited or out of credits | Work is kept and retried next run. Check `memo usage`, add credits or switch provider with `memo config set provider groq`. |
| Nothing is captured | Did you run `memo init` in that repo? Run `memo doctor`. |
| Want to try without a key | `memo install --provider mock` (canned results, not real AI output). |

## More docs
- [Security and privacy](docs/SECURITY.md)
- [Supported agents](docs/SUPPORTED_AGENTS.md)
- [API extraction in detail](docs/PHASE2_API_EXTRACTION.md)

## Tests
```
npm test
```

## License
MIT — see [LICENSE](LICENSE).
