# Phase 2 — API extraction

What `memo process` does: takes the events Phase 1 captured, sends only the **new** ones to
the configured model, validates the reply in code, and writes evidence-linked records plus a
session summary. Phase 1 behaviour is unchanged.

**Status: not executed.** The code below was written without running the test suite and
without any API call, on request. Nothing here is a claim that it works at runtime.

## New modules

| File | Role |
|---|---|
| `src/config.js` | `~/.memo/config.json` load / sanitize / `set`; price table; API-key lookup (never prints the key) |
| `src/usage.js` | `chars/4` token estimate, cost per call, `~/.memo/logs/usage.jsonl`, monthly budget state |
| `src/store/records.js` | `.memory/records/*.jsonl` append-only op-log: ids, fold (last op wins), open records, job guard |
| `src/llm/provider.js` | interface, factory, `ProviderError{kind}`, 3 attempts with 2 s / 8 s / 30 s backoff, `retry-after`, 60 s abort |
| `src/llm/anthropic.js` | `POST /v1/messages` (`x-api-key`, `anthropic-version: 2023-06-01`) |
| `src/llm/openai.js` | `POST /v1/chat/completions` with `response_format: json_object` |
| `src/llm/mock.js` | replays `test/fixtures/llm/*.json`; simulates 429 / 500 / timeout / auth / quota / malformed |
| `src/extract/prompt.js` | fixed system rules, user payload, token-capped batching, **second redaction stage** |
| `src/extract/validate.js` | the §6.3 rules in code: enums, caps, evidence checks, downgrades |
| `src/extract/process.js` | jobs, idempotency, retries, budget, call cap, cursor advance |
| `src/report/session-summary.js` | `.memory/sessions/YYYY/MM/DD/<sid>.md` |
| `scripts/try-extract.js` | one opt-in live call (`MEMO_LIVE=1`), not part of `npm test` |

## Commands

```
memo config                        print settings (key shown only as "set (…last4)")
memo config set <key> <value>      e.g. provider, model, monthlyBudgetUsd, apiEnabled,
                                   maxInputTokensPerCall, prices.<model>.inPerM
memo process                       process new events in every registered repo
memo process --dry-run             event count + estimated input tokens + estimated cost, no API call
memo process --repo <path>         one repo only
memo process --retry-failed        retry jobs parked as failed_permanent / failed_retryable
```

## What stops a surprise bill

- No new events → no call at all (`no_new_data`).
- `--dry-run` never constructs a provider and never calls one.
- `monthlyBudgetUsd` (default $5) is checked before every call, from real provider token counts.
- `maxInputTokensPerCall` (default 12,000) caps one request; `maxCallsPerCycle` (default 6) caps a run, and the leftover backlog is reported.
- `memo config set apiEnabled false` (or `paused true`) stops processing while capture keeps running.

## Privacy

Redaction runs twice: once at capture (Phase 1, on disk) and again in `extract/prompt.js`
before anything leaves the machine. Events are sent with `id, seq, ts, type, tool, text, ok,
truncated` only — no transcript line numbers, no uuids, no absolute paths. Any event whose
text names a denylisted path (`.env`, `*.pem`, `secrets/**`, …) is dropped from the request.
The key is read from the env var named by `apiKeyEnv` (fallback `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY`), is never written to a log, and provider logs carry only status, kind,
attempt and request id.

## How the model is kept honest

The model proposes; `extract/validate.js` decides. It drops unknown fields, enforces every
enum, caps strings at 500 chars and items at 25, drops any item whose evidence id is not in
the batch or an existing record, drops updates to ids that do not exist or whose type does not
match, requires `user_prompt` evidence for `intent`, and **downgrades** `verified` / `done` to
`resolved_unverified` / `implemented_unverified` with `downgraded: true` unless an evidence
event is a `tool_result` with `ok: true`. `auto_exec` is always written as `false`.

## Idempotency

Job id = `j-` + 10 hex of `sha1(sid:from:to)`, and every record line carries its `job`. If a
run crashes after records were appended but before `processedThrough` advanced, the next run
sees the job in the record files, advances the cursor and makes no call. `processedThrough` in
`.memory/sessions/index.json` is always written last.

## How to test this by hand (nothing below has been run)

```bash
npm test                       # the offline suite: no key, no network
memo process --dry-run         # event count, token estimate, cost estimate, zero calls
```

Offline, with the mock provider (no key needed):

```bash
memo config set provider mock
MEMO_MOCK_LLM=decision memo process
cat .memory/records/decisions.jsonl
cat .memory/sessions/2026/10/21/<sid>.md
memo process                   # expect "no_new_data" and no new usage line
```

Then the real thing, once `archive/PHASE0_FINDINGS.md` §7 names a model:

```bash
memo config set provider anthropic
memo config set model claude-haiku-5-5     # confirm this is the model you picked
setx MEMO_API_KEY "<key>"                  # new terminal afterwards
memo process --dry-run                     # check the estimate first
memo process
```

Worth checking by eye on the first real run:

1. every `evidence` id in `.memory/records/*.jsonl` exists in that session's `.jsonl`;
2. nothing is marked `verified` / `done` that no passing tool result supports;
3. the session `.md` summary matches what actually happened;
4. a second `memo process` adds no records and no line to `~/.memo/logs/usage.jsonl`;
5. with the network off: an error is logged, nothing is deleted, and the next run picks up where it stopped.

One live call against a fixture, costing one request:

```bash
MEMO_LIVE=1 node scripts/try-extract.js error-then-fix
```

## Open points

- **Model id is a default, not a decision.** `archive/PHASE0_FINDINGS.md` §7 is still a template,
  so `src/config.js` defaults to `claude-haiku-5-5` (cheapest tier per plan §3 #6, $0.10/$0.50
  per 1M). Change it with `memo config set model <id>` once the spike is done.
- **Provider request shapes are unverified against live docs.** No network call was allowed for
  this work, so both providers follow the shapes written in the plan and the bundled API
  reference. The first real call is the test. For OpenAI, `max_completion_tokens` is sent and the
  Responses-API question in the plan is still open.
- **Structured-output / JSON mode is deliberately not used for Anthropic**: the plan permits it
  only if P0 verified it in current docs. Plain text plus the validator is used instead.
- Reports (`PROJECT_STATE.md`, `TASKS.md`), `memo commit`, the 15-minute worker and
  `memo clear` are Phase 3–5 and are not part of this change.
