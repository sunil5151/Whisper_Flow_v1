# Canned model responses

Each file is one reply from the extraction call, replayed by `src/llm/mock.js` so the test
suite needs no API key and no network.

```json
{"response": <object the model would return, or a raw string>,
 "usage": {"input": 4000, "output": 300},
 "model": "claude-haiku-5-5"}
```

The `evidence` ids refer to the synthetic session that `test/process.test.js` writes
(`e-aaaa0001` … `e-aaaa0009`, documented at the top of that file). `model` is a priced
model from `src/config.js` so the cost estimate in `usage.jsonl` is non-null.

Pick a file per call with `MEMO_MOCK_LLM=decision,repair-ok` (comma-separated, one step per
call; the last step repeats). The step names `429`, `500`, `timeout`, `auth`, `quota`,
`bad_request` and `empty` are built into the mock and need no file.
