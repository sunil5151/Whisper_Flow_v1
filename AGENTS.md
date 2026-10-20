Read .memory/BRIEF.md before starting.

memo is a zero-dependency Node.js CLI that gives a git repo a memory.
- `bin/memo.js` is the CLI entry (init | note | hook | brief).
- `src/` holds the implementation (paths, git wrappers, init, note, hook, brief, redact).
- `.memory/` in a target repo holds progress, decisions, errors, next steps, and the generated BRIEF.md.
