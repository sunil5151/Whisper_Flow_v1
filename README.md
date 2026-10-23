# memo

Zero-dependency Node.js CLI that gives a Git repo a persistent memory for AI coding agents.

## Requirements
- Node.js >= 20
- Git

## Install
```
node bin/memo.js install
```
On Windows, `scripts/windows/install_memo.bat` registers the background task.

## Usage
```
memo init        # set up .memory/ and the post-commit hook in a repo
memo note        # add a note
memo report      # regenerate .memory/PROJECT_STATE.md
memo status      # show state; `memo doctor` diagnoses problems
memo console     # interactive menu
```
Run `memo` with no arguments for the full command list.

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
