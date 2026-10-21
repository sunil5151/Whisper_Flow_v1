# MEMO — Implementation Plan v2 (automatic capture → AI extraction → Git memory)

**Date:** 2026-10-20 · **Owner:** Sunil · **Deadline:** hackathon submission closes **Fri 30 Oct 2026** (MVP must be demo-ready by **Thu 29 Oct**).
**Inputs read:** `MEMO_BUILD_PLAN.md` (old plan), `MEMO_AUTOMATION_REQUIREMENTS_AND_GAP_ANALYSIS.md` (Rev 2, authoritative), repo zip `whisper_flow_hackathon` (commit `1df6aeb`).
**Decisions fixed by Sunil (20 Oct):** first agent = **Claude Code**; MVP by 30 Oct, rest after; patches generated **via pay-per-token API**.

This file is written for two readers:
- **Builder AI** (the model that writes patches): read §0, §6, §7, then only the phase you are asked to build.
- **Sunil**: read §1–§4, the "Sunil checks" of each phase, §10 (cost) and §12 (patch workflow).

---

## 0. How the builder AI must work (read first, every phase)

1. Build **one phase per request**. Output **one unified diff** (`git diff` format, paths `a/…` `b/…`) against the files you were given. Nothing else in the code block.
2. The patch must pass `git apply --check` on a clean checkout. Use LF line endings (except `*.bat` = CRLF, see P0).
3. **Zero npm dependencies.** Node.js built-ins only (`fs`, `path`, `os`, `crypto`, `child_process`, `readline`, global `fetch`, `node:test`, `node:assert`). CommonJS.
4. Every new module gets tests in `test/`. Tests must not need an API key or network. Use the mock provider.
5. Never `git commit`/`git push` in the patch or tests except inside temp repos created under `os.tmpdir()`.
6. Do not touch: `.specstory/`, `.vscode/`, files not listed in the phase, unless the phase says so.
7. If something in this plan is wrong or impossible, **say so above the patch** in max 10 lines. Do not silently deviate.
8. After the patch, list: files changed, new commands, how to test, known gaps.
9. Stop at the phase gate. Do not start the next phase.

---

## 1. Verified current state (audited 20 Oct from the zip, not from old claims)

| Area | State | Evidence |
|---|---|---|
| CLI `init/note/hook/brief/--help` | Implemented | `bin/memo.js`, `src/*.js` (620 LOC incl. tests) |
| Unit tests | 15 pass with `node --test test/*.test.js` | Ran on Node 22 Linux |
| `npm test` | **Broken** — `node --test test/` fails to resolve the dir | Ran: 1 fail |
| Post-commit hook | Logic works **only after line-ending fix** | Installed hook was CRLF → `fatal: cannot exec post-commit` on Linux. After `sed 's/\r$//'`: entry written, memory-only commit skipped, 0.16 s |
| Root cause of hook bug | `templates/post-commit`, `src/init.js`, `src/paths.js`, `bin/memo.js`, `AGENTS.md`, `README.md` are CRLF in working tree (index is LF). `init.js` copies template bytes as-is | `git ls-files --eol` → `i/lf w/crlf` |
| Windows Gate A/B (Git Bash, PowerShell, VS Code commit) | **Unverified** | No evidence in repo |
| Redaction | Implemented, regex only | `src/redact.js`, tests |
| Personal note | Works, **no dedup** (BRIEF shows same line twice) | `.memory/BRIEF.md` |
| AI-session capture | **Not implemented** | — |
| LLM API client / extraction | **Not implemented** | — |
| 15-min worker, logon start, lock | **Not implemented** | — |
| Memory-only auto-commit | **Not implemented** | — |
| Project-state report, task registry | **Not implemented** (BRIEF = string formatting) | — |
| Browse/clear data UI | **Not implemented** | — |

**Hygiene problems found:**
- 6 `*.patch` files committed in repo root.
- `git_committer.bat` does `git add .` + `git push` with a hardcoded remote — dangerous to reuse. `init_repo.bat` also hardcodes the remote.
- `CLAUDE.md` + `memory/` folder (from an earlier Claude Haiku session) point agents to `memory/MEMORY.md` with an absolute `C:\Users\sunil\...` path. Conflicts with `.memory/`.
- `.gitattributes` forces `eol=lf` on `.bat` files too — batch files with LF endings can break `goto`/labels.
- `.memory/BRIEF.md` is gitignored, but Rev 2 needs the state report tracked.
- Out of scope but flagged: `.specstory/history/*.md` (≈2,100 lines of session transcripts) is committed, and `.vscode/settings.json` sets SpecStory cloud sync "always". `memory/user_preferences.md` contains your email. Decide yourself before pushing a public repo.

---

## 2. Old rules: what is superseded, what stays

| Old rule (MEMO_BUILD_PLAN.md) | Now | Consequence |
|---|---|---|
| No LLM / no API key / no network | **Superseded** | Network calls to one configured provider only. Costs money. Data leaves the machine → redaction before send is mandatory |
| Do not read Claude Code session logs | **Superseded** | We read `transcript_path` given by official hooks. Transcript line format is not a documented contract → adapter must be tolerant and fixture-tested |
| Manual `memo note -t …` is the main loop | **Superseded** | Kept only as manual correction |
| Git commit metadata = main memory | **Superseded** | Kept as supporting evidence (`progress.md`) |
| BRIEF.md gitignored | **Superseded** | `PROJECT_STATE.md` is tracked |
| Agent must not commit | **Changed** | MEMO itself commits **only `.memory/`** paths. Builder AI still never commits |
| No push | **Stays** | No automatic push, ever, by default |
| Zero npm deps, Node, Windows-first | **Stays** | |
| Hook failure must never block a commit | **Stays**, extended to Claude Code sessions | |
| No web UI / GitHub Pages / npm publish | **Stays** | |

---

## 3. Architecture decisions (answers to Rev 2 §46)

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | First agent | **Claude Code** (terminal + VS Code extension both run the same hooks) | Official hooks with `session_id`, `transcript_path`, `cwd` on stdin |
| 2 | Capture mechanism | **User-level hooks** in `~/.claude/settings.json`: `SessionStart`, `Stop` (async), `PreCompact` (async), `SessionEnd`. Each calls `memo capture`, which reads new bytes of `transcript_path` from a stored byte offset | One-time per machine, not per repo. Hook copies data within seconds, so a deleted/rotated transcript later does not lose data |
| 3 | When to process | Capture: on every hook (cheap, local). Interpretation + commit: **every 15 min** by the worker, **only if new events exist** | No API cost on idle ticks; 15-min cadence as required |
| 4 | Raw storage | **Normalized, redacted, truncated** events as JSONL per session per date in `.memory/sessions/YYYY/MM/DD/` | Full transcripts contain whole file contents + thinking blocks → large and sensitive. Full transcript stays in Claude Code's own folder. *This is a deliberate deviation from "raw in Git" — see Risk R4* |
| 5 | Structured memory | Append-only JSONL op-log per record type, folded by `id` (last op wins). Markdown reports generated from it | Smallest thing that supports stable IDs, updates, supersede, delete. No database |
| 6 | Provider | **Anthropic default, OpenAI supported**, behind one small interface. Default extraction model = cheapest tier (Claude Haiku 5.5 or gpt-6-luna, same price); optional stronger model for a daily consolidation call | Cost ≈ $1–3/month per repo at 3 h/day (see §10). Model chosen in P0 after a 5-fixture quality test |
| 7 | Context delivery | `SessionStart` hook prints a compact state (≤ 8,000 chars) to stdout → Claude Code adds it to context. Fallback: `AGENTS.md` line + `CLAUDE.md` containing `@AGENTS.md` | Documented: SessionStart plain stdout is added to context |
| 8 | Incremental processing | Per session: byte offset (local) + `processedThrough` event index (tracked). Job id = `sha1(sid:from:to)`; every record line carries `job` → replay is skipped | Idempotent, crash-safe |
| 9 | Quality controls | Model returns JSON → code validates → code **downgrades** unsupported claims (e.g. `verified` without a passing tool result → `implemented_unverified`) | Model cannot turn guesses into facts |
| 10 | Privacy defaults | Redact before writing to disk *and* before API; drop thinking blocks; never store `Read` file contents; denylisted paths dropped; full repo never sent | |
| 11 | Migration | Keep folder name **`.memory/`** (Rev 2 §25.2 allows it). Old `decisions.md/errors.md/next.md` moved to `.memory/legacy/` by `git mv` and imported as records `source: legacy` | No parallel stores |
| 12 | Windows scheduling | Task Scheduler task "MEMO Background Processor", every 15 min, `StartWhenAvailable`, `MultipleInstances=IgnoreNew`, hidden window; logon run via AtLogOn trigger **or** Startup-folder shortcut if AtLogOn needs admin (P0 spike decides) | Admin-free if possible |
| 13 | Runtime | **Keep Node.js** (≥20). Installer checks it, prints `winget install OpenJS.NodeJS.LTS` if missing | 620 LOC + tests exist; built-in `fetch`; rewrite = days lost before deadline |
| 14 | Commit | `git add -A -- .memory` then `git commit --no-verify --only -m "<msg>" -- .memory` with `MEMO_INTERNAL_COMMIT=1` | Verified 20 Oct: other staged files stay staged and are not committed; unstaged/untracked untouched |
| 15 | Machine state | All machine-specific state (cursors, locks, logs, absolute paths, config) in `~/.memo/`, **never** in the repo | Zip/clone stays portable, no secrets |
| 16 | Deferred | Cross-session semantic consolidation beyond "update existing id", Codex adapter, task auto-execution, packaging, DPAPI key storage | After 30 Oct |

---

## 4. End-to-end flow (the one-paragraph answer)

Sunil runs `install_memo.bat` once (checks Node/Git, writes `~/.memo/config.json`, merges MEMO hooks into `~/.claude/settings.json`, asks for API key → user env var, registers the 15-min task) and `memo init` once per repo. He opens Claude Code in the repo. **`SessionStart`** hook → `memo capture` registers the session and prints `PROJECT_STATE` summary into Claude's context. After every assistant turn **`Stop`** (async) → `memo capture` reads the new transcript bytes, normalizes + redacts them, appends to `.memory/sessions/2026/10/22/<sid>.jsonl`. Every 15 min the **worker** (`memo cycle`) takes a lock, sweeps all known sessions for missed bytes, sends only *new* events (+ the list of open records) to the API, validates the JSON, appends records to `.memory/records/*.jsonl`, writes the session summary, re-renders `PROJECT_STATE.md` and `TASKS.md`, and commits **only `.memory/`**. If the API fails, events stay on disk, the job stays pending, the next cycle retries. If the hook fails, Claude Code continues (async, exit 0). Next day, a new Claude Code session gets the state injected automatically; any other agent reads `AGENTS.md` → `.memory/PROJECT_STATE.md`.

```
Claude Code ──hooks(stdin JSON)──► memo capture ──► .memory/sessions/…/<sid>.jsonl   (local, seconds)
                                         ▲
Task Scheduler (15 min) ──► memo cycle ──┼─► sweep capture
                                         ├─► LLM API (new events only) ──► validate ──► .memory/records/*.jsonl
                                         ├─► render PROJECT_STATE.md, TASKS.md, session summary .md
                                         └─► git commit --only -- .memory        (no push)
New session ──SessionStart──► memo capture --context ──stdout──► Claude context
```

---

## 5. File layout (target after P5)

### 5.1 MEMO source repo
```
bin/memo.js                    CLI router
src/
  paths.js  git.js  redact.js  (existing, extended)
  init.js  note.js  hook.js  brief.js  (existing; brief.js → thin alias of report)
  config.js                    ~/.memo/config.json load/defaults/validate
  repos.js                     ~/.memo/repos.json registry, repoId
  lock.js                      exclusive lock files with stale recovery
  log.js                       ~/.memo/logs/*.jsonl, rotation 1 MB
  capture/claude.js            transcript line → event envelopes
  capture/capture.js           `memo capture` (hook entry + sweep)
  capture/install-claude.js    merge hooks into ~/.claude/settings.json (backup first)
  store/sessions.js            session files + .memory/sessions/index.json
  store/records.js             append/fold/delete records
  llm/provider.js              interface + factory
  llm/anthropic.js  llm/openai.js  llm/mock.js
  extract/prompt.js            build request
  extract/validate.js          strict validator + downgrade rules
  extract/process.js           `memo process` (jobs, retries, idempotency)
  usage.js                     token + cost log, monthly budget
  report/state.js              PROJECT_STATE.md
  report/tasks.js              TASKS.md
  report/session-summary.js    sessions/…/<sid>.md
  context.js                   compact text for SessionStart
  gitops/memory-commit.js      allowlisted commit
  cycle.js                     `memo cycle`
  status.js                    `memo status`, `memo doctor`
  migrate.js                   `memo migrate`
  delete.js                    plan/apply deletion
  ui/menu.js                   `memo console`
templates/post-commit  templates/AGENTS.block.md  templates/CLAUDE.md
scripts/windows/install_memo.bat  uninstall_memo.bat  memo_status.bat  memo_console.bat
scripts/windows/register-task.ps1  run-hidden.vbs (only if P0 picks it)
scripts/spike-hook.js          P0 only: dump hook stdin
test/fixtures/claude/*.jsonl   redacted real transcript samples (from P0)
test/*.test.js
docs/PHASE0_FINDINGS.md  docs/SECURITY.md  docs/SUPPORTED_AGENTS.md
patches/                       gitignored
```

### 5.2 Per target repo (tracked in Git)
```
.memory/
  README.md                         how to read this folder (for any AI / zip reader)
  PROJECT_STATE.md                  canonical current state
  TASKS.md                          generated from records/tasks
  progress.md                       commit log (existing hook)
  sessions/index.json               [{sid, agent, date, start, end, events, processedThrough, summary, status}]
  sessions/YYYY/MM/DD/<sid>.jsonl   normalized events
  sessions/YYYY/MM/DD/<sid>.md      session summary
  records/decisions.jsonl  errors.jsonl  learnings.jsonl  facts.jsonl
  records/tasks.jsonl  questions.jsonl  intent.jsonl
  legacy/decisions.md  errors.md  next.md   (migrated, read-only)
```
`.gitignore` gets nothing new inside `.memory/` (no machine state lives there). The old line `.memory/BRIEF.md` stays so a stale BRIEF.md is never committed.

### 5.3 Per machine (`~/.memo/`, never in Git)
```
config.json        non-secret settings (see §6.4)
repos.json         [{id, root, addedAt, enabled}]
personal.md        existing
state/<repoId>/cursors.json   {sid: {transcriptPath, offset, partial, fileSize, lastEventId}}
state/<repoId>/jobs.json      {jobId: {sid, from, to, status, attempts, lastError, ts}}
logs/cycles.jsonl  logs/capture.jsonl  logs/usage.jsonl  hook-errors.log
cycle.lock  state/<repoId>/capture.lock
spike/             P0 only
```

---

## 6. Data contracts

### 6.1 Event envelope (one line in `<sid>.jsonl`)
```json
{"v":1,"id":"e-3f2a9c1d","sid":"8c1e…","seq":42,"ts":"2026-10-22T14:03:11.120+05:30",
 "agent":"claude-code","type":"tool_result","tool":"Bash",
 "text":"npm test … # pass 15 # fail 0","ok":true,"truncated":true,"src":{"line":118,"uuid":"…"}}
```
- `type` ∈ `user_prompt | assistant_text | tool_call | tool_result | system | git_commit`
- `id` = `e-` + first 8 hex of `sha1(sid + (uuid || line text) + blockIndex)`. Dedup key.
- `seq` = monotonic per session (assigned at append time).
- `text` limits: user_prompt 4,000 chars; assistant_text 3,000; tool_call 300 (Bash command / file path only); tool_result 800 (first 500 + last 300). `truncated:true` if cut.
- `ok` for tool_result: `false` if transcript marks error, else `true`; unknown → omit.
- **Dropped entirely:** thinking blocks, `Read` results (keep only `tool_call` with path), `Write`/`Edit` content (keep path + line counts), anything touching denylisted paths (§6.5), image blocks.
- File paths stored **relative to repo root**; paths outside repo → `"<outside-repo>"`.

### 6.2 Record line (`records/<type>.jsonl`, append-only op-log)
```json
{"op":"create","id":"D-7a1c09e2","type":"decision","ts":"2026-10-22T14:15:00+05:30","job":"j-5d0e…",
 "statement":"Keep .memory/ as canonical folder","rationale":"avoids migration","status":"active",
 "confidence":"high","evidence":["e-3f2a9c1d","e-91bc0a11"],"sessions":["8c1e…"],"files":["src/init.js"]}
```
- `op` ∈ `create | update | delete` (delete only from `memo clear`).
- Types and allowed `status`:

| type | statuses |
|---|---|
| decision | `proposed, active, superseded, rejected` |
| error | `observed, investigating, attempted, resolved_unverified, verified, reopened` |
| learning / fact | `active, unverified, superseded` |
| task | `open, in_progress, blocked, implemented_unverified, verified, done, cancelled, superseded` |
| question | `open, answered` |
| intent | `active, historical` |

- Task-only fields: `title, priority (high|normal|low|unranked), effort_estimate ("30-60m"), effort_basis:"estimated", capability (low|medium|high), capability_reason, blockers[], completion_evidence[], auto_exec:false`.
- Optional: `supersedes`, `related[]`, `conflict_with[]`, `downgraded:true` (code changed the model's status), `source:"legacy"|"manual"|"llm"`.
- Current state = fold lines by `id` in file order; `delete` removes.
- ID = type prefix (`D E L F T Q I`) + `-` + 8 hex of `sha1(type + normalized statement + first evidence id)`.

### 6.3 LLM extraction contract
**Request** (built by `extract/prompt.js`):
- `system`: rules (≤ 1,500 tokens, fixed text, cache-friendly): extract only what evidence supports; never mark verified without a passing tool result; rejected options are `rejected`, not decisions; no invented deadlines/owners; reuse existing ids for the same issue; output JSON only.
- `user`: `{"repo":"<folder name>","open_records":[{id,type,status,statement}] (≤ 60, newest first), "events":[envelopes…]}`.
- Input cap: `config.maxInputTokensPerCall` (default 12,000; estimate tokens = chars/4). Larger batches split by `seq`, in order.

**Response** (validated by `extract/validate.js`):
```json
{"schema":1,
 "session_summary":"≤ 600 chars, what happened in these events",
 "items":[
   {"op":"create","type":"error","statement":"…","status":"observed","confidence":"medium","evidence":["e-…"],"files":["src/x.js"]},
   {"op":"update","id":"T-1b2c3d4e","status":"implemented_unverified","evidence":["e-…"]},
   {"op":"create","type":"task","title":"…","statement":"…","priority":"normal","effort_estimate":"1-2h","capability":"medium","capability_reason":"touches 3 modules","evidence":["e-…"]}
 ],
 "gaps":["tool output truncated for e-…"]}
```
**Validator rules (code, not model):**
1. JSON parse; on failure → 1 repair retry with the parse error; then job `failed_permanent`.
2. Unknown fields dropped; enums enforced; strings ≤ 500 chars; ≤ 25 items.
3. Every `evidence` id must exist in this batch or be an existing record id; otherwise item dropped and logged.
4. `update.id` must exist and `type` must match.
5. `verified`/`done` require ≥1 evidence event of type `tool_result` with `ok:true` → else downgraded to `resolved_unverified` / `implemented_unverified`, `downgraded:true`.
6. `intent` create/update requires evidence of type `user_prompt`.
7. `files` must be relative, no `..`, no drive letter, no leading `/`; else dropped.
8. Model output is never executed, never used as a path outside `.memory/`, never changes config.

### 6.4 `~/.memo/config.json` (defaults)
```json
{"v":1,"provider":"anthropic","model":"<set in P0>","consolidationModel":null,
 "apiKeyEnv":"MEMO_API_KEY","apiEnabled":true,"paused":false,
 "intervalMinutes":15,"maxInputTokensPerCall":12000,"maxCallsPerCycle":6,
 "monthlyBudgetUsd":5,"summaryLanguage":"en",
 "prices":{"<model>":{"inPerM":0.10,"outPerM":0.50}},
 "denyPaths":[".env",".env.*","*.pem","*.key","id_rsa*","credentials*.json","secrets/**"],
 "autoCommit":true,"commitIdentity":null}
```
API key: read from env var named by `apiKeyEnv` (fallback `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). Never printed; `memo doctor` shows only `set (sk-…last4)`.

### 6.5 Redaction (extend `src/redact.js`)
Keep existing patterns. Add: `sk-ant-[A-Za-z0-9_-]{20,}`, `sk-proj-[A-Za-z0-9_-]{20,}`, connection strings `\b\w+://[^\s:@/]+:[^\s@/]+@` (keep scheme, redact credentials), `.env`-style lines `^[A-Z][A-Z0-9_]{2,}=\S{8,}$` (multiline), high-entropy 40+ char base64/hex tokens next to words key/secret/token. Add `redactPath(relPath, denyPaths) → boolean drop`. Order: redact at capture (disk) **and** again in `prompt.js` (defence in depth).

---

## 7. Global engineering rules (all phases)

- Node ≥ 20. `package.json` `"test": "node --test"` (auto-discovers `test/**/*.test.js` on all OSes).
- Every write of a whole file: write `file.tmp` → `fs.renameSync` (atomic). JSONL: one complete line per `appendFileSync`.
- Every `git` call: `execFileSync('git', args, {cwd, encoding:'utf8', windowsHide:true})`. Never through a shell string.
- Every spawned process: `windowsHide: true`.
- Times: store ISO 8601 with offset; display local `YYYY-MM-DD HH:MM`.
- Paths: `path.join` everywhere; when writing into hook files/settings, use forward slashes.
- Hooks and worker: catch everything, log to `~/.memo/logs`, exit 0.
- No timestamps change in tracked files unless content changed (prevents empty-diff commits).
- `MEMO_HOME` env overrides `~/.memo` (tests). `MEMO_CLAUDE_SETTINGS` overrides `~/.claude/settings.json` path (tests).

---

# MVP PHASES (P0–P6) — target 29 Oct

Effort = Sunil's hands-on hours (prompting, reviewing, applying, testing). Builder calls = expected API requests incl. fix rounds.

| Phase | Name | Deadline | Sunil effort | Builder calls | Usable outcome |
|---|---|---|---|---|---|
| P0 | Baseline fix + feasibility spike | **Wed 21 Oct** | 3–4 h | 2 | `npm test` green, hook works, real hook payloads + transcript fixtures captured, model chosen |
| P1 | Claude Code capture | **Thu 22 Oct** | 5–6 h | 3–4 | Every Claude Code turn lands in `.memory/sessions/…` automatically |
| P2 | API extraction | **Sat 24 Oct** | 8–10 h | 4–5 | `memo process` turns captured events into decisions/errors/tasks with evidence |
| P3 | State report + context + auto-commit + migration | **Mon 26 Oct** | 6–8 h | 3–4 | `PROJECT_STATE.md` auto-updates, new session receives it, memory-only commits |
| P4 | 15-min worker + Windows installer + status | **Tue 27 Oct** | 5–6 h | 3 | Install once → runs by itself every 15 min after logon |
| P5 | Browse + clear data | **Wed 28 Oct** | 4–5 h | 2–3 | Terminal menu lists dates/sessions, previews and deletes |
| P6 | Windows E2E, measurements, README, demo | **Thu 29 Oct** | 5 h | 1–2 | Submission-ready repo + demo video |
| — | Buffer / submit | **Fri 30 Oct** | — | — | Submit before close |
| **Total** | | | **36–44 h** (~4.5 h/day for 9 days) | **18–23** | |

**If you get fewer hours:** cut in this order: P5 → only `memo clear --session` (no menu); P4 → manual `memo cycle` + documented schtasks command instead of full installer; P3 migration → skip. Never cut P1–P3 core: that is the product.

---

## P0 — Baseline fix + feasibility spike  · Deadline Wed 21 Oct

### Goal
Make the existing foundation actually correct, clean the repo, and collect **real evidence** (hook payloads, transcript lines, Task Scheduler behaviour, model quality) that P1–P4 depend on.

### P0-A Patch (builder AI)
Files: `package.json`, `.gitattributes`, `.gitignore`, `src/init.js`, `src/hook.js`, `src/note.js`, `AGENTS.md`, `CLAUDE.md`, new `scripts/spike-hook.js`, new `test/init.test.js`, new `docs/PHASE0_FINDINGS.md` (template).

1. `package.json`: `"test": "node --test"`, `"engines": {"node": ">=20"}`, version `0.2.0`.
2. `.gitattributes`: keep `* text=auto eol=lf`; add `*.bat text eol=crlf`, `*.cmd text eol=crlf`, `*.ps1 text eol=crlf`.
3. `src/init.js` `hookContent()`: normalize template to LF (`.replace(/\r\n?/g, '\n')`) before writing; when appending to an existing hook also LF.
4. `src/hook.js`: return immediately if `process.env.MEMO_INTERNAL_COMMIT === '1'`.
5. `src/note.js` personal: skip append if identical `- <text>` line already exists; print `Already saved`.
6. `.gitignore`: add `patches/`.
7. `AGENTS.md`: replace with short, current text (see `templates/AGENTS.block.md` in P3; for now: what MEMO is, where memory lives, "read `.memory/PROJECT_STATE.md` if it exists, else `.memory/BRIEF.md`").
8. `CLAUDE.md`: replace with one line `@AGENTS.md` + 5 short working rules from the old file (confirm before push/delete; concise replies; no unnecessary comments). **No absolute paths.**
9. `scripts/spike-hook.js`: reads all stdin, writes `~/.memo/spike/<event>-<timestamp>.json` (pretty JSON), also copies the last 50 lines of `transcript_path` to `~/.memo/spike/transcript-<sid>.jsonl`, exits 0. ≤ 40 lines.
10. `test/init.test.js`: temp repo → `memo init` → hook file has no `\r` → commit a file → `progress.md` has entry → memory-only commit adds no entry → `MEMO_INTERNAL_COMMIT=1` commit adds no entry. Skip the commit part with `t.skip` if `git` missing.
11. `docs/PHASE0_FINDINGS.md`: template with headings from P0-B below.

**Repo cleanup (Sunil, by hand, not in patch):** `git mv *.patch patches/` (or delete them), delete `git_committer.bat` and `init_repo.bat` (or move to `tools/legacy/` and never run them in scheduled context), `git mv memory .memory/legacy/memory-bank`.

### P0-B Spike (Sunil, no product code) — results go into `docs/PHASE0_FINDINGS.md`
1. Versions: `node -v` (need ≥20), `git --version`, `claude --version`.
2. Hook payloads: add to `~/.claude/settings.json` (back it up first):
   ```json
   {"hooks":{
     "SessionStart":[{"hooks":[{"type":"command","command":"node","args":["C:/path/to/memo/scripts/spike-hook.js"]}]}],
     "Stop":[{"hooks":[{"type":"command","command":"node","args":["C:/path/to/memo/scripts/spike-hook.js"],"async":true}]}],
     "PreCompact":[{"hooks":[{"type":"command","command":"node","args":["C:/path/to/memo/scripts/spike-hook.js"],"async":true}]}],
     "SessionEnd":[{"hooks":[{"type":"command","command":"node","args":["C:/path/to/memo/scripts/spike-hook.js"]}]}]}}
   ```
   If `args` is rejected by your Claude Code version, use shell form: `"command": "node \"C:/path/to/memo/scripts/spike-hook.js\""`.
   Run a 10-minute Claude Code session in a test repo: one question, one file edit, one failing command, one passing `npm test`, `/compact`, exit. Then **once more from the VS Code extension**.
   Record: which events fired, exact stdin fields, `transcript_path` location, does it work from VS Code too.
3. Transcript format: open the transcript `.jsonl`. Record line `type` values, where user text, assistant text, `tool_use`, `tool_result`, error flag, `uuid`, `timestamp`, `cwd` live. Check whether `/compact` rewrites or appends. Redact and save 3 samples into `test/fixtures/claude/` (small: ≤ 200 lines each): `basic.jsonl`, `error-then-fix.jsonl`, `compact.jsonl`.
4. Transcript retention: check `cleanupPeriodDays` in Claude Code settings docs (default believed 30 days — verify).
5. Task Scheduler (non-admin PowerShell):
   - `schtasks /create /tn "MEMO Spike" /sc minute /mo 15 /tr "cmd /c echo %time% >> %USERPROFILE%\memo-spike.txt" /f` → works without admin?
   - Same with `/sc onlogon` → works without admin? (Known to often need admin → then Startup-folder shortcut for logon.)
   - Hidden window test: which of these shows no window: `conhost.exe --headless node x.js`, `wscript.exe run-hidden.vbs`, `powershell -WindowStyle Hidden …`. Pick one.
   - Delete: `schtasks /delete /tn "MEMO Spike" /f`.
6. API: create key (Anthropic Console or OpenAI Platform; **a ChatGPT/Claude.ai subscription does not include API credits**). Put it in `setx MEMO_API_KEY "<key>"`, open a new terminal. Check the provider's current data-retention / training policy page for API usage and write the link + date in findings.
7. Model choice: in the provider's web console/playground (Anthropic Console Workbench or OpenAI Playground), paste fixture `error-then-fix` with the §6.3 system prompt into Haiku 5.5 / gpt-6-luna and Sonnet 5.5 / gpt-6.1-sol. Pick the cheapest one that (a) returns valid JSON, (b) does not mark the fix verified when no test passed. Write model ID into findings.

### Tests
`npm test` → all old 15 + new init tests pass on Windows (PowerShell) and Git Bash.

### Sunil checks (Hinglish)
1. `npm test` PowerShell aur Git Bash dono mein green.
2. Naya test repo → `memo init` → commit Git Bash, PowerShell, VS Code se → teeno mein `progress.md` entry. (Old Gate B ka pending test.)
3. `~/.memo/spike/` mein SessionStart/Stop/SessionEnd JSON files aaye. VS Code extension se bhi.
4. `test/fixtures/claude/` mein 3 redacted samples. **Commit karne se pehle khud padh lo** — key, token, personal data na ho.
5. `docs/PHASE0_FINDINGS.md` bhara hua.

### Acceptance
Findings file answers: hook events fired (terminal + VS Code), fields present, transcript line schema, compact behaviour, schtasks non-admin result, hidden-window method, chosen model + price, retention policy link.

### Risks
- Hooks don't fire in VS Code extension → MVP supports terminal Claude Code only; document it.
- `args` field unsupported → use shell form with quoted paths.
- Transcript schema differs from what P1 assumes → P1 spec adapts to the fixtures (fixtures are the contract).

### Rollback
`git revert` the P0 commit; restore `~/.claude/settings.json` from backup.

---

## P1 — Claude Code capture  · Deadline Thu 22 Oct

### Goal / user-visible result
After `memo setup claude` (once per machine) and `memo init` (once per repo), every Claude Code session in that repo is written to `.memory/sessions/YYYY/MM/DD/<sid>.jsonl` within seconds of each turn, redacted, without any manual step. No API yet.

### Send to builder
This plan §0, §5, §6.1, §6.5, §7, P1; files `bin/memo.js`, `src/paths.js`, `src/git.js`, `src/redact.js`, `src/init.js`, `package.json`; `docs/PHASE0_FINDINGS.md`; the 3 fixtures.

### Files
New: `src/repos.js`, `src/lock.js`, `src/log.js`, `src/capture/claude.js`, `src/capture/capture.js`, `src/capture/install-claude.js`, `src/store/sessions.js`, tests `test/capture-normalize.test.js`, `test/capture-incremental.test.js`, `test/install-claude.test.js`, `test/redact.test.js` (extend).
Changed: `bin/memo.js`, `src/paths.js`, `src/redact.js`, `src/init.js` (register repo in `repos.json`, create `.memory/sessions/`).

### Spec
**Commands**
- `memo setup claude [--dry-run]`: back up `~/.claude/settings.json` → `settings.json.memo-backup-<ts>`; merge MEMO hook entries for `SessionStart` (sync, timeout 10), `Stop` (async), `PreCompact` (async), `SessionEnd` (sync, timeout 5). Command = absolute `process.execPath`, args = [absolute `bin/memo.js`, `capture`] (forward slashes). Mark entries so they're recognisable (e.g. args contains `memo.js` + `capture`). Idempotent: second run reports `skipped`. Never removes other hooks. Invalid existing JSON → abort with message, change nothing.
- `memo setup claude --remove`: removes only MEMO entries.
- `memo capture`: hook entry. Reads stdin JSON (max 1 MB, 2 s timeout). Fields used: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source` (SessionStart), `reason` if present (SessionEnd).
- `memo capture --sweep`: for every registered repo and every cursor, catch up (used by worker in P4).

**`memo capture` algorithm**
1. Resolve repo root from `cwd` via `git rev-parse --show-toplevel`. Not registered or `enabled:false` → log `skip unregistered`, exit 0.
2. Acquire `~/.memo/state/<repoId>/capture.lock` (create exclusive; stale if older than 60 s → take over, log it). Busy → exit 0 (sweep will catch up).
3. Load cursor for `sid`. New session → create cursor `{offset:0}`, add to `index.json` with `date` = local date of first event ts, `agent:"claude-code"`, `start`.
4. `stat` transcript. Missing → log `transcript_missing`, mark gap in index, exit 0. `size < offset` → transcript rewritten → set `offset:0`, rely on event-id dedup, log `transcript_rewritten`.
5. Read bytes `[offset, size)`. Prepend stored `partial`. Split on `\n`; the last piece without `\n` becomes the new `partial`.
6. Each complete line → `JSON.parse` (bad line → log `bad_line` with line number, skip) → `normalize(line, ctx)` from `capture/claude.js` → 0..n envelopes.
7. Drop envelopes whose `id` already exists in the session file (keep a Set loaded from the last 2,000 ids of the file).
8. Redact `text`. Drop denylisted paths. Append lines. `fsync`. Then save cursor (atomic). Update `index.json` (`events`, `end` = last ts, `status`).
9. `SessionEnd` → mark session `ended` in index. `SessionStart` with `source:"resume"` → same sid continues same file.
10. Total budget: must finish < 1 s for 1 MB of new transcript.

**`capture/claude.js` normalize** — mapping defined by the P0 fixtures. Expected shape (verify against fixtures, fixtures win): line `type:"user"` with string content → `user_prompt`; user content array item `tool_result` → `tool_result` (`ok:false` if `is_error`); line `type:"assistant"` content items: `text` → `assistant_text`, `tool_use` → `tool_call` (tool name + summary per §6.1), `thinking` → dropped; other line types → dropped unless they carry a summary/compaction marker → `system` ("context compacted").

### Tests
- Normalize each fixture → expected envelope types/counts (snapshot as small JSON in test).
- Thinking blocks, Read contents, Write content never appear in output.
- Incremental: capture half file, then rest → no duplicate ids, `seq` continuous.
- Partial last line handled.
- Rewritten (shorter) file → no duplicates.
- Unregistered repo → nothing written.
- Secrets in prompt/tool output → `[REDACTED]` on disk.
- `install-claude`: empty settings, settings with other hooks, run twice, `--remove`, invalid JSON.
- Path with spaces and non-ASCII (`C:/Users/sunil/My Projects/मेमो`) in temp dirs.

### Sunil checks
1. `memo setup claude` → `~/.claude/settings.json` mein MEMO hooks, purane hooks safe; backup file bana.
2. Test repo mein `memo init`, Claude Code kholo, 3–4 baat karo, ek command chalwao.
3. `.memory/sessions/2026/10/22/` mein `<sid>.jsonl` — har turn ke baad lines badhti hain.
4. File kholo: thinking nahi, file contents nahi, secret `[REDACTED]`.
5. Same session `claude --resume` → same file mein append, naya file nahi. Naya session → naya file.
6. Ek aur repo jo `memo init` nahi hua → wahan kuch nahi likha gaya.

### Acceptance
Real session captured from terminal (and VS Code if P0 confirmed) with zero manual steps; replay/resume creates no duplicates; Claude Code never shows a hook error.

### Risks / unsupported
Transcript format change on Claude Code update → `bad_line`/unknown-type counts visible in `memo status` (P4). Sessions started outside registered repos are ignored by design. Subagent transcripts: not captured in MVP.

### Rollback
`memo setup claude --remove`; revert commit.

---

## P2 — API extraction  · Deadline Sat 24 Oct

### Goal / user-visible result
`memo process` sends only new captured events to the configured model and writes structured, evidence-linked records + a session summary. Works with the mock provider offline; with a real key on demand.

### Send to builder
§0, §5, §6 (all), §7, P2; files from P1 (`src/store/sessions.js`, `src/capture/*`, `src/repos.js`, `src/log.js`, `src/redact.js`, `bin/memo.js`); fixtures; chosen provider/model from findings.

### Files
New: `src/config.js`, `src/llm/provider.js`, `src/llm/anthropic.js`, `src/llm/openai.js`, `src/llm/mock.js`, `src/extract/prompt.js`, `src/extract/validate.js`, `src/extract/process.js`, `src/store/records.js`, `src/usage.js`, `src/report/session-summary.js`, `scripts/try-extract.js` (live opt-in), tests `test/validate.test.js`, `test/process.test.js`, `test/records.test.js`, `test/provider-http.test.js`, `test/fixtures/llm/*.json` (canned model responses).
Changed: `bin/memo.js`.

### Spec
**Commands**
- `memo config` → print config (no secret). `memo config set <key> <value>`.
- `memo process [--repo <path>] [--dry-run] [--retry-failed]`
  - `--dry-run`: build batches, print event count, estimated input tokens and estimated cost; no API call.
- `node scripts/try-extract.js <fixture>` → one live call, prints validated result + usage. Requires `MEMO_LIVE=1`. Not part of `npm test`.

**Provider interface** (`llm/provider.js`):
`complete({system, user, maxTokens, jsonSchema?}) → {text, usage:{input, output}, model, requestId}`; throws `ProviderError{kind: 'retryable'|'auth'|'bad_request'|'quota', status, retryAfterMs}`.
- `anthropic.js`: `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`; body `{model, max_tokens, system, messages:[{role:'user', content:user}]}`; use the provider's structured-output/JSON mode **only if** P0 verified it in current docs; else plain text + validator.
- `openai.js`: `POST https://api.openai.com/v1/chat/completions` with `response_format:{type:'json_object'}` (or Responses API if current docs require — builder must check current docs and state which it used).
- Both: `fetch` + `AbortController` 60 s; retries on network/429/5xx: 3 attempts, backoff 2 s / 8 s / 30 s, honour `retry-after`; 401/403 → `auth` (no retry); 400 → `bad_request`; insufficient-credit/quota errors → `quota`. Never log headers or bodies; log status, requestId, attempt.
- `mock.js`: returns responses from `test/fixtures/llm/` by key; can simulate 429, timeout, malformed JSON.

**Process algorithm** (per repo, per session with `events > processedThrough`)
1. Budget: sum `usage.jsonl` cost for current month ≥ `monthlyBudgetUsd` → stop, status `budget_reached`.
2. `apiEnabled:false` or `paused` → stop, status `api_disabled`.
3. Batch = events `(processedThrough, …]` until token estimate hits cap. Job id = `j-` + sha1(`sid:from:to`) 10 hex.
4. If any record line already has this `job` → job already applied → just advance `processedThrough` (crash recovery).
5. Build prompt (§6.3) with open records (folded state, status not in terminal states, newest 60).
6. Call provider. Log usage line `{ts, repoId, job, model, in, out, costEst}` (cost from `config.prices`; unknown → `null`).
7. Validate (§6.3 rules). Invalid JSON → 1 repair call (`"Your previous output was not valid JSON: <error>. Return only the JSON."`) → still invalid → job `failed_permanent`, stop this session.
8. Assign ids to creates (§6.2). Same id already exists → convert to `update`.
9. Append records (each line has `job`). Write session summary `.md` (append the new summary paragraph under a timestamp; header = sid, date, agent, model, events). Advance `processedThrough` in `index.json` atomically **last**.
10. Retryable error → job `pending` with attempts++; next cycle retries; after 5 attempts → `failed_retryable` (still retried by `--retry-failed`).
11. Max `maxCallsPerCycle` calls per run across all repos; leftover backlog reported.

### Tests (mock only)
- Decision fixture → 1 `decision` with rationale + evidence.
- Error-then-fix with passing test → `error` + update to `verified` allowed.
- Same but model claims verified without passing test → stored as `resolved_unverified`, `downgraded:true`.
- Rejected option → `decision` with `status:rejected` (not active).
- Unknown evidence id → item dropped.
- Update with nonexistent id → dropped.
- Malformed JSON → repair → success; double malformed → `failed_permanent`, events untouched.
- 429 then success → one set of records (no duplicates); 401 → `auth`, no retry.
- Crash simulation: records written, `processedThrough` not advanced → rerun applies nothing new.
- Budget reached → no call.
- `--dry-run` makes zero provider calls.
- Prompt never contains a string matching redact patterns (feed secret-bearing events).

### Sunil checks
1. `memo process --dry-run` → events, tokens, ₹/$ estimate dikhe.
2. Real run (key set): `.memory/records/*.jsonl` mein entries; har entry mein `evidence` ids jo session file mein milte hain.
3. Session `.md` summary padho — sahi hai? Galat "verified" toh nahi?
4. Wapas `memo process` → "no new events", koi naya record nahi, koi API call nahi (`usage.jsonl` same).
5. Internet band karke `memo process` → error logged, kuch delete nahi hua; internet on → next run process karta hai.

### Acceptance
Rev 2 §43.3 bullets pass on fixtures + one real session; normal test suite needs no key.

### Risks
Model quality (false decisions) → validator + downgrade + you review first real outputs; switch model via config. API shape changed since this plan → builder must cite the current doc page it used.

### Rollback
`memo config set apiEnabled false`; records are plain files — delete `.memory/records/` to reset.

---

## P3 — Project state, context delivery, memory-only commits, migration  · Deadline Mon 26 Oct

### Goal / user-visible result
`PROJECT_STATE.md` and `TASKS.md` regenerate from records; a new Claude Code session automatically starts with the current state in context; `memo commit` commits only `.memory/`; old notes migrated.

### Send to builder
§0, §5, §6.2, §7, P3; files `src/store/*`, `src/extract/process.js`, `src/init.js`, `src/brief.js`, `src/hook.js`, `src/git.js`, `src/capture/capture.js`, `bin/memo.js`, `AGENTS.md`, `CLAUDE.md`.

### Files
New: `src/report/state.js`, `src/report/tasks.js`, `src/context.js`, `src/gitops/memory-commit.js`, `src/migrate.js`, `templates/AGENTS.block.md`, `templates/CLAUDE.md`, `templates/memory-README.md`, tests `test/state.test.js`, `test/context.test.js`, `test/memory-commit.test.js`, `test/migrate.test.js`.
Changed: `src/init.js` (new layout, write `.memory/README.md`, AGENTS block, CLAUDE.md if absent), `src/brief.js` (becomes alias → `report`), `src/capture/capture.js` (SessionStart prints context), `bin/memo.js`, `src/note.js` (manual notes now write records with `source:"manual"`).

### Spec
**`PROJECT_STATE.md`** (deterministic, ≤ 250 lines, newest first, each claim with record id + session link):
```
# Project state — <repo>
Generated: <local ts> · Last processed event: <ts> · Unprocessed events: <n> · Last cycle: <ok|failed ts>
> Generated by MEMO from .memory/records. Do not edit; corrections: `memo note` or `memo clear --record`.
## Intent                 (active intent records)
## Status                 (last 5 session summaries: date · sid8 · 1–2 lines · link)
## Open tasks             (priority → age; title · status · effort · capability · id)
## Blockers & open errors
## Active decisions       (statement — rationale · id)
## Verified fixes         (with evidence event ids)
## Implemented, not verified
## Learnings & constraints
## Open questions
## Recently completed (14 days)
## Sessions               (date · sid8 · events · summary link)
## How to read this folder → .memory/README.md
```
Body hash: if unchanged, keep previous `Generated` line (no noise diffs).

**`TASKS.md`**: open/blocked/in-progress table, then completed (last 30). Fields from §6.2.

**`memo context`** (and SessionStart path of `memo capture`): ≤ 8,000 chars, factual wording (no imperatives — docs warn they can trigger prompt-injection defences): header line, Intent, top 10 open tasks, open errors, 10 active decisions, last 3 session summaries, "Full detail: .memory/PROJECT_STATE.md". Repo not registered → print nothing.

**`memo commit [--repo]`** (`gitops/memory-commit.js`):
1. Skip if `autoCommit:false`.
2. Abort (log `git_busy`) if `.git/index.lock`, `MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD` exist.
3. `git status --porcelain -- .memory` empty → `no_changes`, return.
4. `git config user.name` / `user.email` missing → `no_identity` error (never set it).
5. `git add -A -- .memory`
6. `git commit --no-verify --only -m "<msg>" -- .memory` with env `MEMO_INTERNAL_COMMIT=1`.
7. Message: `memo: archive <n> session(s), <m> record change(s) — <YYYY-MM-DD>` (single session → add `sid8`). No transcript text in message.
8. Never: `git add .`, `reset`, `checkout`, `restore`, `stash`, `push`.

**`memo migrate`**: if `.memory/decisions.md|errors.md|next.md|BRIEF.md` exist → parse entries (reuse `brief.js` parsers) → write records `source:"legacy"` (decision→active, error→observed, next open→task open, `[x]`→done) → `git mv` md files to `.memory/legacy/` (fall back to `fs.rename` if not tracked) → render reports. Idempotent (job id `legacy-import`).

**`memo init`** (updated, idempotent): register repo; create `.memory/{sessions,records}`, `.memory/README.md`, initial empty `PROJECT_STATE.md`; AGENTS.md gets marked block `<!-- memo:start --> … <!-- memo:end -->` (replace on rerun, never duplicate); `CLAUDE.md` created with `@AGENTS.md` only if absent (if present and lacks `@AGENTS.md`, print a hint, don't edit); post-commit hook as before; if legacy files exist, print `run memo migrate`.

**Process integration:** after a successful `memo process`, render reports. (Commit is done by the worker in P4; `memo process --commit` for manual use.)

### Tests
- Render from fixed records → exact expected markdown (golden file); unchanged input → byte-identical output.
- Downgraded items appear under "Implemented, not verified".
- Context ≤ 8,000 chars with 200 records.
- Commit: temp repo with staged `src.js`, unstaged `b.js`, untracked `c.js`, changed `.memory/x` → commit contains only `.memory/x`; `src.js` still staged; second call → `no_changes`, no new commit; `MEMO_INTERNAL_COMMIT` hook skip verified; missing identity → error, no commit; repo path with spaces.
- Deleted file under `.memory` is committed as deletion.
- Migrate: sample legacy files → records + files moved; rerun → no change.

### Sunil checks
1. Is repo (memo hi) mein `memo migrate` → purane notes `legacy/` mein, records mein bhi.
2. `memo report` → `PROJECT_STATE.md` padho. Galat cheez "Verified" mein toh nahi?
3. Naya Claude Code session kholo, poocho "kal kya hua aur kya baaki hai?" — bina file khole sahi jawab. Screenshot (hackathon demo ke liye).
4. Kuch source file stage karke `memo commit` → `git show --stat HEAD` mein sirf `.memory/`; tumhari staged file abhi bhi staged.
5. Dobara `memo commit` → "no changes", koi commit nahi.

### Acceptance
Rev 2 §43.4 and §43.5 (except scheduled part) pass.

### Risks
Context injection silently ignored by a Claude Code version → AGENTS.md/CLAUDE.md fallback still points to the file; verify in check 3.

### Rollback
Revert commit; legacy files restorable with `git mv` back (history intact).

---

## P4 — 15-minute worker, Windows installer, status  · Deadline Tue 27 Oct

### Goal / user-visible result
Run `install_memo.bat` once → MEMO runs hidden every 15 min and after logon, processes new data, commits memory, and `memo status` shows what happened.

### Send to builder
§0, §5, §7, P4; `docs/PHASE0_FINDINGS.md` (schtasks + hidden-window results); files `bin/memo.js`, `src/capture/capture.js`, `src/extract/process.js`, `src/report/*`, `src/gitops/memory-commit.js`, `src/config.js`, `src/lock.js`, `src/log.js`, `src/repos.js`.

### Files
New: `src/cycle.js`, `src/status.js`, `scripts/windows/install_memo.bat`, `scripts/windows/uninstall_memo.bat`, `scripts/windows/memo_status.bat`, `scripts/windows/memo_console.bat`, `scripts/windows/register-task.ps1`, `scripts/windows/run-hidden.vbs` (only if P0 chose it), tests `test/cycle.test.js`, `test/lock.test.js`, `test/status.test.js`.
Changed: `bin/memo.js`, `src/lock.js`.

### Spec
**`memo cycle`** (what the task runs):
1. Lock `~/.memo/cycle.lock` `{pid, startedAt}`. Exists and pid alive and < 20 min old → log `overlap_skip`, exit 0. Else stale → take over, log `stale_lock_recovered`.
2. Log `cycle_start`. `paused` → log `paused`, exit.
3. For each enabled repo: `capture --sweep` → `process` (respect budget/max calls) → render reports → `commit`. Per-repo try/catch: one repo failing doesn't stop others.
4. Log one line per repo: `{ts, repo, newEvents, jobs, calls, in, out, costEst, committed:sha|null, status, ms}` where status ∈ `ok | no_new_data | api_failed | budget_reached | git_busy | no_identity | capture_gap | error`.
5. Write `~/.memo/status.json` `{lastCycle, lastOk, lastFailed, nextExpected}`. Release lock. Exit 0 always.
6. Must exit in < 2 s when no new data. No API call when no new data.

**`memo status`** (≤ 20 lines):
```
MEMO  Running (task registered, next ≈ 14:45)   API: anthropic/<model> key set   Paused: no
Last cycle 14:30 ok · last failure 2026-10-26 22:15 api_failed (timeout)
This month: 41 calls · 0.31M in / 0.05M out · ≈ $0.06 of $5 budget
Repos:
  whisper_flow_hackathon  sessions 7 · unprocessed 0 · last commit 14:30 · state fresh
Logs: C:/Users/<you>/.memo/logs/cycles.jsonl
```
**`memo doctor`**: check Node ≥20, git in PATH, git identity per repo, `~/.claude/settings.json` has MEMO hooks, API key env set (masked), one cheap API ping only with `--live`, scheduled task exists (`schtasks /query /tn "MEMO Background Processor"`), last cycle age < 30 min, writable dirs. Each line `PASS/FAIL + fix hint`.
**`memo pause` / `memo resume`**: flip `config.paused` (task stays registered).

**`install_memo.bat`** (CRLF, idempotent, no admin unless P0 proved needed):
1. Check `git --version`, `node -v` ≥ 20 → else print winget command, exit.
2. `node "%~dp0..\..\bin\memo.js" install` → creates `~/.memo`, default config, runs `setup claude`, prints privacy notice (what is captured, what is sent, where it goes, how to disable), asks provider + model (default from findings).
3. API key: if `MEMO_API_KEY` not set → `set /p` prompt → `setx MEMO_API_KEY "<value>"` (warn: visible in user env; DPAPI later). Never echo the key.
4. Register task via `powershell -NoProfile -ExecutionPolicy Bypass -File register-task.ps1`: action = hidden launcher → `"<node.exe>" "<memo.js>" cycle`; trigger every 15 min indefinitely; `StartWhenAvailable`; `MultipleInstances IgnoreNew`; `ExecutionTimeLimit 10 min`; plus logon (AtLogOn trigger if allowed, else shortcut in `shell:startup` running one cycle). Re-run → updates, never duplicates.
5. Optional: `npm link` so `memo` works in any terminal.
6. Self-test: `memo doctor`, then `memo cycle` once, show `memo status`.
7. Print what was created/updated/skipped.

**`uninstall_memo.bat`**: remove task + startup shortcut, `memo setup claude --remove`; **does not** delete `~/.memo` or any `.memory/` unless user types `DELETE-ALL-MEMO-DATA`.

### Tests
- Lock: live lock → skip; stale (dead pid or > 20 min) → recovered.
- No-data cycle → zero provider calls, no commit, `no_new_data` logged.
- Two repos, one throws → other still committed.
- Paused → nothing runs.
- Budget reached → capture + commit still run (raw events committed), no API.
- Status renders from fixture logs.
- `.bat` files have CRLF (test reads bytes).

### Sunil checks
1. `install_memo.bat` double-click / PowerShell se. Dobara chalao → duplicate task nahi.
2. Task Scheduler mein "MEMO Background Processor" dikhe; 15 min baad `memo status` mein naya cycle. Koi black window flash nahi.
3. Laptop restart → login → 1–2 min mein cycle chala (status).
4. Claude Code mein 20 min kaam karo, haath mat lagao → `git log` mein `memo: …` commit, sirf `.memory/`.
5. `memo pause` → next cycle `paused`. `memo resume`.
6. Task Manager se cycle ke time RAM dekho (target < 100 MB).

### Acceptance
Rev 2 §43.1 and scheduled part of §43.5 pass on your laptop.

### Risks
AtLogOn requires admin → Startup-folder fallback. Hidden-window method may flash → choose per P0. `setx` key in plain user env → documented, DPAPI in P11. Laptop sleep → cycles resume after wake (`StartWhenAvailable`); no processing while off — expected.

### Rollback
`uninstall_memo.bat`; data untouched.

---

## P5 — Browse and clear data  · Deadline Wed 28 Oct

### Goal / user-visible result
`memo console` (or `memo_console.bat`): numbered terminal menu to see status, dates, sessions, tasks; preview and delete one session, one date, or one record; deletion committed; honest Git-history message.

### Files
New: `src/delete.js`, `src/ui/menu.js`, tests `test/delete.test.js`, `test/menu.test.js` (pure functions only).
Changed: `bin/memo.js`, `src/store/sessions.js` (tombstones), `src/capture/capture.js` (skip tombstoned sids).

### Spec
**Non-interactive commands** (menu calls the same functions):
- `memo sessions [--date YYYY-MM-DD]` → dates with session counts + size; or sessions of a date `time · sid8 · agent · events · processed · summary(60 chars)`.
- `memo show <sid8|sid>` → summary md + file paths + record ids derived from it.
- `memo tasks [--all]` → TASKS view in terminal.
- `memo clear --session <sid> | --date <YYYY-MM-DD> | --record <id> [--with-derived] [--yes]`
  - Default = **dry run**: prints files, sizes, record ids affected, which derived records are *only* sourced from the target (deleted with `--with-derived`) and which have mixed sources (kept, target evidence ids removed, `source_deleted:true`).
  - Real run needs `--yes` (CLI) or typed `DELETE` (menu); date-wide needs typed date.
  - Actions: delete session `.jsonl` + `.md`; append `delete` ops / rewrite record files without them; add tombstone `{sid, deletedAt}` in `index.json` so capture never re-imports it from the Claude transcript; re-render reports; `memo commit` with message `memo: remove captured session data for <scope>`.
  - Always print: "Removed from current files and committed. Older Git commits still contain this data. Copies on GitHub/other clones are not affected. Full erasure needs history rewriting (not done by MEMO)."
- `memo clear --all-repo-data` → typed `DELETE-ALL-MEMO-DATA`, removes `.memory/sessions` + `.memory/records`, keeps `legacy/`.

**Menu** (`readline`, no deps): `1 Status · 2 Browse by date · 3 Tasks · 4 Clear data · 5 Pause/Resume · 6 Run cycle now · 0 Exit`. Each screen ≤ 25 lines.

History purge (`git filter-repo`) is **not implemented**; menu explains it.

### Tests
Delete session → only its files gone, other sessions intact; derived-only records removed with `--with-derived`, mixed kept + evidence stripped; reports no longer mention deleted items; tombstone prevents re-capture on sweep; dry run changes nothing; path traversal in sid (`../`) rejected; commit contains only `.memory/`.

### Sunil checks
1. `memo_console.bat` → 2 → kal ki date → session list.
2. 4 → ek session select → preview mein exact files + records dikhe.
3. `DELETE` type → `git log -1 --stat` mein sirf `.memory/`; `PROJECT_STATE.md` se woh cheez gayab.
4. 15 min baad: deleted session wapas nahi aaya.

### Acceptance
Rev 2 §43.6 passes.

### Rollback
Deletion commit is revertable with `git revert` (data is still in history — that is the point of the warning).

---

## P6 — Windows E2E, measurements, docs, demo  · Deadline Thu 29 Oct

### Patch (builder)
`README.md` skeleton only if you want (you said you dictate it), `docs/SECURITY.md` (what is captured, sent, stored, retention link, redaction limits, key storage), `docs/SUPPORTED_AGENTS.md` (Claude Code version tested, terminal/VS Code result, unsupported cases), bug fixes from the checklist.

### Sunil E2E checklist (fresh test repo, PowerShell + Git Bash)
1. `uninstall_memo.bat` → `install_memo.bat` clean.
2. Repo path with spaces + Hindi folder name works.
3. Real 45-min Claude Code session with one bug fixed + one decision + one TODO.
4. Wait 2 cycles. Check session file, records, `PROJECT_STATE.md`, `TASKS.md`, 1–2 memory commits, `memo status`.
5. New session → asks "kya baaki hai?" → correct.
6. Wi-Fi off during a cycle → `api_failed`, next cycle recovers, no duplicates.
7. `memo clear --session` flow.
8. Measure and write into `docs/PHASE0_FINDINGS.md` → "Measurements": cycle RAM peak, no-op cycle ms, normal cycle ms, `.memory/` size per day, tokens per cycle, actual $ for the day (`memo status`).
9. Read every committed `.memory/` file once before `git push` — regex redaction is not a guarantee.

### Hackathon deliverables
README dictated via Wispr; 2–3 min demo: install → Claude Code session → wait/force `memo cycle` → state file → new session remembers → clear data. Note Wispr word count.

---

# POST-HACKATHON PHASES (after 30 Oct)

| Phase | Name | Target | Effort | Outcome |
|---|---|---|---|---|
| P7 | Memory quality | 2–8 Nov | 8–10 h | Daily report `.memory/daily/YYYY-MM-DD.md`; nightly consolidation call (stronger model, can use Batch API −50%) that merges duplicates, marks superseded/conflicts across sessions; git commits as evidence events (`git_commit`) so "file changed" supports `implemented_unverified`; `summaryLanguage: hinglish` |
| P8 | Robustness | 9–15 Nov | 6–8 h | Two concurrent sessions in same repo, resume/fork, compaction rewrite, subagent transcripts, worktrees/branch switch, log rotation, crash-injection tests |
| P9 | Second agent: Codex CLI | 16–22 Nov | 8–10 h | `capture/codex.js` adapter from Codex's documented session files/hooks (verify current docs first); same envelope; `SUPPORTED_AGENTS.md` updated |
| P10 | Optional task executor | 23 Nov–6 Dec | 12–16 h | Picks `ready` + `auto_exec:true` + `capability:low` tasks; runs agent headless in a **separate git worktree**; runs tests; separate source commit vs memory commit; never pushes; high-capability tasks flagged only |
| P11 | Packaging + secrets | Dec | 8–12 h | DPAPI-encrypted key file (PowerShell `ConvertFrom-SecureString`) instead of `setx`; evaluate bundled Node vs single binary; clean-machine install test; upgrade/uninstall docs |

Each post-MVP phase follows the same template (goal, files, spec, tests, Sunil checks, acceptance, rollback). Ask the planner to expand one phase at a time when you reach it.

---

## 10. API cost

### 10.1 Prices used (verified 20 Oct 2026, USD per 1M tokens, standard tier)
| Model | Input | Output | Notes |
|---|---|---|---|
| Claude Haiku 5.5 | $0.10 | $0.50 | prompts ≤100K tokens |
| Claude Sonnet 5.5 | $2 | $10 | |
| Claude Opus 5.5 | $4 | $20 | |
| OpenAI gpt-6-luna | $0.10 | $0.50 | |
| OpenAI gpt-6.1-sol | $2 | $10 | |
| OpenAI gpt-6-astra | $10 | $50 | |
| OpenAI gpt-5.3-codex | $1.75 | $14 | coding model |
Batch API (both providers): ~50% off but results can take hours → only for the nightly P7 call, not the 15-min cycle. Prompt caching barely helps: Anthropic's default cache lives 5 min, our calls are 15 min apart.

### 10.2 Runtime cost — one repo, 3 h of Claude Code per day, 30 days
**Assumptions (estimates, to be replaced by P6 measurements):**
- After filtering (§6.1: no thinking, no file contents, tool output ≤ 800 chars) ≈ **17k tokens of new events per hour** (≈15 prompts, 15 replies, 60 tool calls/results).
- 3 h → 12 cycles with data/day. Per call: ~1.5k system + ~3k open records + ~4.2k events ≈ **9–10k input**, ~1.5k output.
- Per day ≈ 120k in + 18k out (+ optional 1 daily consolidation call 20k in / 4k out). Idle cycles cost $0.

| Setup | Expected / month | Heavy usage (×3) |
|---|---|---|
| **Haiku 5.5 or gpt-6-luna only** | **≈ $0.70** | ≈ $2 |
| **Recommended: Haiku/luna per cycle + Sonnet/sol daily consolidation** | **≈ $3** | ≈ $9 |
| Sonnet 5.5 or gpt-6.1-sol for everything | ≈ $15 | ≈ $45 |
| Opus 5.5 for everything | ≈ $30 | ≈ $90 |
| gpt-6-astra for everything | ≈ $75 | ≈ $225 |
Math (expected, per month): cycles 3.6M in + 0.54M out; consolidation 0.6M in + 0.12M out. Haiku cycles: 3.6×0.10 + 0.54×0.50 = $0.63. Sonnet consolidation: 0.6×2 + 0.12×10 = $2.40 → recommended ≈ $3.03. Sonnet everywhere: 12.6 + 2.4 = $15. Opus everywhere: 25.2 + 4.8 = $30. "Everything" rows include the consolidation call. In INR at an assumed ₹88/$: recommended ≈ ₹260/month; Sonnet-only ≈ ₹1,300.
Per extra repo with the same 3 h/day: add the same amount (cost scales with hours of AI work, not with number of repos).

### 10.3 Build cost — generating the patches via API
Assumption: ~21 requests (7 phases × ~3 rounds), avg ~25k input (plan section + current source) and ~20k output (patch + reasoning).
| Builder model | Estimate | With 2× rework |
|---|---|---|
| Claude Sonnet 5.5 / gpt-6.1-sol | ≈ $5 | ≈ $10 |
| Claude Opus 5.5 | ≈ $10 | ≈ $20 |
| gpt-5.3-codex | ≈ $7 | ≈ $14 |
| gpt-6-astra | ≈ $26 | ≈ $52 |
Warning: running an *agentic* coding tool on a pay-per-token key (it re-reads files every turn) typically costs 5–10× more than single patch requests. Set a hard spend limit in the provider console (e.g. $25) before starting.

### 10.4 Cost controls built in
`monthlyBudgetUsd` hard stop (default $5) · no call on no-new-data · token cap per call and calls per cycle · `memo process --dry-run` estimate · `usage.jsonl` with real provider token counts · `memo status` month total.

---

## 11. Risk register (after MVP)

| # | Risk | Impact | Mitigation | Residual |
|---|---|---|---|---|
| R1 | Claude Code changes transcript format | Capture breaks silently | Fixture tests, `bad_line`/unknown-type counters in status | Medium — needs fixture refresh per CC update |
| R2 | Hooks don't run from VS Code extension / some versions | No capture there | P0 verifies; documented | Low–Medium |
| R3 | Model invents/overclaims | Wrong memory misleads next agent | Validator, evidence required, auto-downgrade, review first outputs | Medium |
| R4 | Normalized events ≠ full raw transcript | Some detail not in Git | Deliberate (privacy/size); full transcript remains in `~/.claude` for its retention period | Accepted |
| R5 | Secrets in sessions | Leak to Git / API | Two-stage redaction, denylist, no file contents, read before push | Medium — regex can't catch everything |
| R6 | API key in plain user env (`setx`) | Readable by local processes | Documented; DPAPI in P11 | Medium |
| R7 | Memory commits clutter history (up to ~12/day) | Noisy `git log` | Commit only on real change; `git log --invert-grep --grep='^memo:'` to filter | Low |
| R8 | Git history keeps deleted data | Privacy | Honest UI message; no auto-push | Accepted |
| R9 | Task Scheduler non-admin limits / window flash | Worker not starting / annoying | P0 spike, Startup fallback | Low |
| R10 | Deadline slip | No submission | Cut list in MVP table; P1–P3 are the product | Medium — needs ~4.5 h/day |
| R11 | Provider API shape changed after this plan | P2 rework | Builder must check and cite current docs | Low |

---

## 12. Patch workflow (Sunil)

**One time:** `mkdir patches` (gitignored). Set provider spend limit. Work on a branch: `git switch -c memo-v2`.

**Per phase:**
1. `git status` → clean. `git switch memo-v2`.
2. Send the builder: the prompt below + this plan's §0, §5, §6, §7 and the phase section + the files listed under "Send to builder" (full current content) + `docs/PHASE0_FINDINGS.md` + relevant fixtures.
3. Save reply diff as `patches/P1-v1.patch`.
4. `git apply --check patches/P1-v1.patch` → errors? Send the error + the file back to the builder ("regenerate against this exact file").
5. `git apply patches/P1-v1.patch` → `npm test`.
6. Failing test → send failure output + changed files back → `P1-v2.patch`. Max 3 rounds, then ask for a smaller patch (split the phase).
7. Do the "Sunil checks". Pass → dictate commit message → `git add -A` (only after reviewing `git status`) → commit. **You** commit code; MEMO only ever commits `.memory/`.
8. Run `memo note -t decision …` only if something important isn't in a Claude Code session (e.g. a decision made on paper).

**Builder prompt template**
```
You are implementing phase <P#> of MEMO. Follow §0 "How the builder AI must work" exactly.
Context: plan sections §0 §5 §6 §7 and <P#> below; current source files below (full content, these are the only truth).
Output, in this order:
1. Up to 10 lines: problems or deviations from the plan (or "none").
2. One ```diff block: a single unified diff applying cleanly with `git apply` to the files given. LF endings (CRLF only for *.bat/*.cmd/*.ps1). No other code blocks.
3. Files changed · new commands · how to test · known gaps.
Do not implement anything from later phases. Zero npm dependencies.
--- PLAN ---
<paste>
--- FILES ---
<path>
<content>
...
```

---

## 13. Phase gate checklist (every phase)
- [ ] `git apply --check` clean, `npm test` green on Windows PowerShell + Git Bash
- [ ] All "Sunil checks" done; result written as one line in `docs/PHASE0_FINDINGS.md` → "Phase log"
- [ ] Nothing outside the phase's file list changed (`git diff --stat`)
- [ ] No secret in `git diff` (`git diff | findstr /i "sk- key token password"`)
- [ ] Unsupported cases of the phase written in `docs/SUPPORTED_AGENTS.md`
- [ ] Commit by Sunil, no push until P6

---

## Sources (checked 20 Oct 2026)
- Claude Code hooks reference — events, stdin fields (`session_id`, `transcript_path`, `cwd`, `hook_event_name`), SessionStart stdout/`additionalContext` (10,000-char limit), `async`, `args` exec form, Windows Git Bash/PowerShell notes, SessionEnd 1.5 s budget: https://code.claude.com/docs/en/hooks
- Claude Code memory / CLAUDE.md, `@` imports, AGENTS.md: https://code.claude.com/docs/en/memory
- Claude API pricing: https://platform.claude.com/docs/en/about-claude/pricing
- OpenAI API pricing: https://developers.openai.com/api/docs/pricing
- Git `commit --only` behaviour: verified locally on git 2.43 (20 Oct) — staged non-memory file remained staged and excluded.
