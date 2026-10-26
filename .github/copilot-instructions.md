<!-- memo:start -->
## Project memory (MEMO)
- Project rules and code map: `AGENTS.md`. Current state: `.memory/PROJECT_STATE.md` (open tasks, errors, decisions, recent sessions).
- Task list: `.memory/TASKS.md`. How the folder works: `.memory/README.md`.
- These files are generated; corrections go through `memo note -t <decision|error|next> "text"`.
- Asked about earlier chats, previous conversations or what was discussed before: do NOT use chat or session-history tools. They hold only your own sessions, and those come back empty. Open the files listed under "Recent sessions" below (one summary each; all are in `.memory/sessions/index.json`) plus `.memory/PROJECT_STATE.md`, and answer from them.

### Snapshot (sessions processed up to 2026-10-26)
Recent sessions:
- 2026-10-26 a63ad3de: The user requested a simplified and better UI for the MEMO installation process. The assistant refactored `memo install` to a single step, defaulting to OpenRo… → .memory/sessions/2026/10/26/a63ad3de-1df8-42d6-b053-69309ab1bdfd.md
- 2026-10-26 ae3e137b: User instructed merging main and push-fix together, preserving the side with more meaningful diff. After several aborted branch switches (memo hook/SpecStory k… → .memory/sessions/2026/10/26/ae3e137b-a28d-47c5-83d5-3704cc887f7d.md
- 2026-10-26 ad1fcd99: The user attempted to set up the Claude GitHub integration: the /install-github-app command was run (both runs cancelled), and they tried `claude setup-token`,… → .memory/sessions/2026/10/26/ad1fcd99-1266-4264-8533-fa2e434d33ac.md
- 2026-10-26 b01fd773: This session's events contain only a single system event recording that the /install-github-app command was invoked at 2026-10-26T14:10:32 local time. No tool … → .memory/sessions/2026/10/26/b01fd773-f369-4de9-9196-d4d02fc8311e.md
- 2026-10-26 769ddbc2: The session contains only a single system event: the /install-github-app command was invoked at 2026-10-26 09:20:50 (+05:30) in whisper_flow_hackathon. No tool… → .memory/sessions/2026/10/26/769ddbc2-f7e4-4c6d-a22b-5d23fe02586c.md
Intent:
- User wants all work done on the main branch only: commit the workflow to main and add a standing rule (in AGENTS.md) that Claude must never create other branches or work on them. (I-41c0ecf6)
- User wants the current Antigravity-platform conversation (and future ones) to be automatically saved into MEMO; they asked how to achieve this since MEMO's capture currently does not read the Antigra… (I-7aac1970)
- User asked to do the same for Gemini as was done for Copilot: when this repo opens, save all conversations, organise them, and report back. (I-87190b38)
Open tasks:
- Push README work to origin/main — blocked, high (T-3e47280d)
- Commit Gemini capture work — in_progress, high (T-d193875f)
- Verify OpenRouter switch end-to-end — open, normal (T-6172295c)
- Stale 'open' records (Groq 401 error, Anthropic credit error) appear in the snapshot and should be removed via `memo note` or `memo clear --record`. — open, normal (T-97c2cd22)
Open errors:
- A combined 'git push; git branch -d push-fix memo-v1-installer; git stash drop x3' command was denied by the Claude Code auto-mode classifier as [Irreversible Local Destruction]; push was retried sep… — observed (E-2bf51a10)
- A 'git checkout -f main' attempt was denied by the Claude Code auto-mode classifier as [Irreversible Local Destruction]; the assistant abandoned force checkout and used normal commit-then-checkout in… — observed (E-6aae7593)
- Cycle 'capture_gap' status root-caused: sweep logs show 'transcript_missing' entries for old whisper_flow_hackathon sessions whose transcripts were deleted (12 of 40 sweeps); capture_gap is a display… — reopened (E-4e73258b)
- get_session_context returns empty transcripts (transcript: [], hasMoreHistory: false) for archived whisper_flow_hackathon sessions of 24 Oct ('purane conversation ka pata') and 25 Oct ('purane conver… — investigating (E-57c2fad3)
Active decisions:
- Capture routing in src/capture/capture.js was refactored to be common across agents so the Gemini adapter (src/capture/gemini.js) plugs in alongside the Copilot adapter. (D-e448c8a1)
- Capture is no longer Claude-only: src/capture/capture.js now routes per-agent and a Copilot adapter (src/capture/copilot.js) reads ~/.copilot/session-state/<sid>/events.jsonl transcripts, normalizing… (D-572833e3)
- Cycle/memo commit now includes tracked agent files (AGENTS.md, .github/copilot-instructions.md, GEMINI.md) only when their working-tree change is confined to the memo:start/end block (blockOnlyFiles … (D-c0efe619)
- CLAUDE.md's Working rules were moved into AGENTS.md so Copilot/Gemini/Codex can read them; CLAUDE.md now points at AGENTS.md instead of duplicating rules. (D-d57fd30d)
<!-- memo:end -->
