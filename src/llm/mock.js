'use strict';

// Offline provider: replays canned responses from test/fixtures/llm/ and simulates failures.
// Used by `npm test` (no key, no network) and by `memo config set provider mock`.
//
// Script comes from MEMO_MOCK_LLM (comma-separated steps, one per complete() call) or
// setScript([...]). A step is either a fixture name under MEMO_MOCK_LLM_DIR or one of:
//   429 | 500 | timeout | auth | quota | bad_request | empty
// A fixture file is {"response": <object|string>, "usage": {input, output}, "model": "..."}.
// The last step repeats if more calls are made than the script has steps.

const fs = require('node:fs');
const path = require('node:path');
const { ProviderError, withRetries } = require('./provider');

const FAILURES = {
  429: () => new ProviderError('mock 429 rate limited', { kind: 'retryable', status: 429, retryAfterMs: 0 }),
  500: () => new ProviderError('mock 500 server error', { kind: 'retryable', status: 500, retryAfterMs: 0 }),
  timeout: () => new ProviderError('mock request timed out', { kind: 'retryable', status: null, retryAfterMs: 0 }),
  auth: () => new ProviderError('mock 401 invalid key', { kind: 'auth', status: 401 }),
  quota: () => new ProviderError('mock credit balance too low', { kind: 'quota', status: 400 }),
  bad_request: () => new ProviderError('mock 400 bad request', { kind: 'bad_request', status: 400 })
};

let script = null;
let calls = [];

function setScript(steps) {
  script = Array.isArray(steps) ? steps.map(String) : null;
  calls = [];
}

function callLog() {
  return calls;
}

function fixturesDir() {
  return process.env.MEMO_MOCK_LLM_DIR || path.join(__dirname, '..', '..', 'test', 'fixtures', 'llm');
}

function steps() {
  if (script) return script;
  const raw = process.env.MEMO_MOCK_LLM;
  if (!raw || !raw.trim()) return ['empty'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function loadFixture(name) {
  const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '');
  const file = path.join(fixturesDir(), safe.endsWith('.json') ? safe : safe + '.json');
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  const text = typeof parsed.response === 'string' ? parsed.response : JSON.stringify(parsed.response);
  return {
    text,
    usage: {
      input: Number(parsed.usage && parsed.usage.input) || 0,
      output: Number(parsed.usage && parsed.usage.output) || 0
    },
    model: parsed.model || 'mock'
  };
}

function create(cfg, opts = {}) {
  let index = 0;
  return {
    name: 'mock',
    model: cfg.model,
    calls,
    // Same retry wrapper as the real providers, but with no waiting.
    async complete({ system, user, maxTokens = 2000, model = cfg.model }) {
      return withRetries('mock', async () => {
        const list = steps();
        const step = list[Math.min(index, list.length - 1)];
        index++;
        calls.push({ step, system, user, maxTokens, model });
        if (FAILURES[step]) throw FAILURES[step]();
        if (step === 'empty') {
          return {
            text: JSON.stringify({ schema: 1, session_summary: '', items: [], gaps: [] }),
            usage: { input: Math.ceil((system.length + user.length) / 4), output: 20 },
            model: 'mock',
            requestId: 'mock-' + index
          };
        }
        const fixture = loadFixture(step);
        return {
          text: fixture.text,
          usage: {
            input: fixture.usage.input || Math.ceil((system.length + user.length) / 4),
            output: fixture.usage.output || Math.ceil(fixture.text.length / 4)
          },
          model: fixture.model,
          requestId: 'mock-' + index
        };
      }, { backoff: [0, 0, 0], sleep: () => {}, ...opts });
    }
  };
}

module.exports = { create, setScript, callLog, loadFixture, fixturesDir, FAILURES };
