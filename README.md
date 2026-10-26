# memo

Zero-dependency Node.js CLI that gives a Git repo a persistent memory for AI coding agents.

## What it does
MEMO watches your AI coding sessions (Claude Code, GitHub Copilot agent, Gemini in Antigravity), redacts them, and uses an AI provider to distil them into short records: decisions, errors, tasks and a session summary. These are saved in `.memory/` inside your repo, so the next session starts with `PROJECT_STATE.md` instead of from zero.

## Requirements
- Node.js >= 20 and Git
- An API key for one provider (OpenRouter by default; Groq, Anthropic and any OpenAI-compatible endpoint also work). `--provider mock` needs no key but gives canned results.
- No `npm install` is needed: MEMO has no dependencies.

## Setup (once per machine)
1. Get the code (MEMO is not published to npm):
   ```
   git clone https://github.com/sunil5151/Whisper_Flow_v1.git
   cd Whisper_Flow_v1
   ```
2. Run the installer. It asks for a provider, model and API key, stores the key encrypted, installs the Claude Code hooks, registers the background task and sends one tiny test request:
   ```
   node bin/memo.js install
   ```
   Rerunning it is safe and repairs a broken setup. On Windows you can double-click `scripts/windows/install_memo.bat` instead.
3. Make `memo` available on your PATH:
   - **Windows:** the installer does this for you (a `memo.cmd` shim in `%LOCALAPPDATA%\MEMO\bin`, added to your user PATH). Open a **new** terminal afterwards.
   - **macOS / Linux:** run `npm link` inside the cloned folder, or call `node /path/to/Whisper_Flow_v1/bin/memo.js <command>` wherever this README says `memo`.
4. Verify:
   ```
   memo --version
   memo status        # capture, pending work, API calls, limits
   memo doctor        # checks every piece; `memo doctor --live` also sends one test request
   ```

Platform notes: the 15-minute background task is Windows-only. On macOS/Linux run `memo cycle` by hand (or from your own cron job) to capture, summarise and refresh the reports. Key encryption uses Windows DPAPI; elsewhere the key is kept in a file readable only by you.

## Use it in a project
1. In the repo you want remembered:
   ```
   cd your-project
   memo init
   ```
   This creates `.memory/`, a post-commit hook, a VS Code folder-open sync task and a `memo:start/end` block in `AGENTS.md`, `.github/copilot-instructions.md` and `GEMINI.md`.
2. Work with your agent as usual. Claude Code is captured by hooks; Copilot and Gemini sessions are picked up by the periodic `memo cycle`.
3. Check progress with `memo status` and `memo sessions`. Read `.memory/PROJECT_STATE.md` for the result, or run `memo report` to regenerate it.

## Commands
```
memo init        # set up .memory/ and the post-commit hook in a repo
memo note -t decision|error|next "text"   # add a note by hand
memo report      # regenerate .memory/PROJECT_STATE.md
memo cycle       # capture, extract, report and commit .memory/ now
memo tasks       # open tasks
memo sessions    # captured sessions; `memo show <sid8>` for one
memo status      # show state; `memo doctor` diagnoses problems
memo pause       # stop API processing (`memo resume` to restart)
memo key set     # replace the stored API key
memo usage       # tokens and estimated cost
memo console     # interactive menu
```
Run `memo` with no arguments for the full list.

## Troubleshooting
- `memo: command not found` / not recognised: open a new terminal (Windows), run `npm link` (macOS/Linux), or use `node bin/memo.js`.
- `memo status` shows work pending: run `memo cycle`, then `memo doctor --live` if it stays pending (usually a bad key or model; fix with `memo key set`).
- Nothing is captured: run `memo doctor`, confirm `memo init` was run in that repo, and that `memo pause` is not on.
- Unsure what is stored: see [Security](docs/SECURITY.md). Read `.memory/` before pushing it to a public repo; redaction is regex-based.
- Remove everything: `memo uninstall` removes the task and hooks and keeps your memory data.

## Where memory lives
- `.memory/` (tracked): progress log, decisions, errors, next steps, `PROJECT_STATE.md`.
- `~/.memo/` (per machine, never in Git): personal notes, logs, local state.

## Docs
- [Security](docs/SECURITY.md) — what is captured, sent and deletable.
- [Supported agents](docs/SUPPORTED_AGENTS.md)
- [API extraction](docs/PHASE2_API_EXTRACTION.md)

## Tests
```
npm test
```

## License
MIT — see [LICENSE](LICENSE).