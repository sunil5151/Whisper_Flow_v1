'use strict';

// Provider HTTP behaviour with an injected fetch. No network, no key, no waiting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every log line and rate-limit state file from these tests goes to a throwaway home,
// never to the real ~/.memo (it used to inflate the failure counts in `memo status`).
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-provider-home-'));
process.env.MEMO_HOME = ISOLATED_HOME;
process.on('exit', () => { try { fs.rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

const provider = require('../src/llm/provider');
const anthropic = require('../src/llm/anthropic');
const openai = require('../src/llm/openai');
const config = require('../src/config');

const KEY = 'sk-ant-test-0000000000000000000000000000';

function cfg(extra) {
  return { ...config.defaults(), ...extra };
}

// Minimal Response stand-in: only what the providers read.
function reply(status, body, headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    headers: { get: (name) => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

function fakeFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next();
    return next;
  };
  fn.calls = calls;
  return fn;
}

function opts(fetchImpl, extra = {}) {
  const slept = [];
  return {
    impl: { fetchImpl, apiKey: KEY, sleep: (ms) => slept.push(ms), backoff: [1, 2, 3], ...extra },
    slept
  };
}

const ANTHROPIC_OK = {
  id: 'msg_01abc',
  model: 'claude-haiku-5-5',
  stop_reason: 'end_turn',
  // Current models think by default and return an empty thinking block first.
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"schema":1,' }, { type: 'text', text: '"items":[]}' }],
  usage: { input_tokens: 4321, output_tokens: 123 }
};

test('anthropic: request shape, headers and response parsing', async () => {
  const fetchImpl = fakeFetch([reply(200, ANTHROPIC_OK, { 'request-id': 'req_1' })]);
  const { impl } = opts(fetchImpl);
  const p = anthropic.create(cfg({ provider: 'anthropic', model: 'claude-haiku-5-5' }), impl);
  const out = await p.complete({ system: 'SYS', user: 'USER', maxTokens: 2000 });

  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-api-key'], KEY);
  assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.init.headers['content-type'], 'application/json');
  assert.equal(call.body.model, 'claude-haiku-5-5');
  assert.equal(call.body.max_tokens, 2000);
  assert.equal(call.body.system, 'SYS');
  assert.deepEqual(call.body.messages, [{ role: 'user', content: 'USER' }]);

  // All text blocks joined, thinking block ignored.
  assert.equal(out.text, '{"schema":1,"items":[]}');
  assert.deepEqual(out.usage, { input: 4321, output: 123 });
  assert.equal(out.model, 'claude-haiku-5-5');
  assert.equal(out.requestId, 'msg_01abc');
});

test('anthropic: 429 is retried honouring retry-after, then succeeds', async () => {
  const fetchImpl = fakeFetch([
    reply(429, { error: { message: 'rate limited' } }, { 'retry-after': '1' }),
    reply(200, ANTHROPIC_OK)
  ]);
  const { impl, slept } = opts(fetchImpl);
  const out = await anthropic.create(cfg({ provider: 'anthropic', model: 'claude-haiku-5-5' }), impl).complete({ system: 's', user: 'u' });
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(slept, [1000], 'retry-after seconds win over the backoff table');
  assert.equal(out.usage.input, 4321);
});

test('anthropic: 401 is auth and is not retried', async () => {
  const fetchImpl = fakeFetch([reply(401, { error: { message: 'invalid x-api-key' } })]);
  const { impl, slept } = opts(fetchImpl);
  await assert.rejects(
    () => anthropic.create(cfg({ provider: 'anthropic', model: 'claude-haiku-5-5' }), impl).complete({ system: 's', user: 'u' }),
    (err) => {
      assert.equal(err.name, 'ProviderError');
      assert.equal(err.kind, 'auth');
      assert.equal(err.status, 401);
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(slept, []);
});

test('anthropic: 500 is retried three times then throws retryable', async () => {
  const fetchImpl = fakeFetch([reply(500, 'upstream boom')]);
  const { impl, slept } = opts(fetchImpl);
  await assert.rejects(
    () => anthropic.create(cfg({ provider: 'anthropic', model: 'claude-haiku-5-5' }), impl).complete({ system: 's', user: 'u' }),
    (err) => err.kind === 'retryable' && err.status === 500
  );
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(slept, [1, 2]);
});

test('anthropic: 400 is bad_request, credit-balance 400 is quota', async () => {
  const bad = fakeFetch([reply(400, { error: { message: 'max_tokens too large' } })]);
  await assert.rejects(
    () => anthropic.create(cfg({ provider: 'anthropic', model: 'claude-haiku-5-5' }), opts(bad).impl).complete({ system: 's', user: 'u' }),
    (err) => err.kind === 'bad_request'
  );
  assert.equal(bad.calls.length, 1);

  const quota = fakeFetch([reply(400, { error: { message: 'Your credit balance is too low to access the API' } })]);
  await assert.rejects(
    () => anthropic.create(cfg({ provider: 'anthropic', model: 'claude-haiku-5-5' }), opts(quota).impl).complete({ system: 's', user: 'u' }),
    (err) => err.kind === 'quota'
  );
  assert.equal(quota.calls.length, 1);
});

test('anthropic: a refusal stop_reason is not treated as a usable answer', async () => {
  const fetchImpl = fakeFetch([reply(200, { ...ANTHROPIC_OK, stop_reason: 'refusal', content: [] })]);
  await assert.rejects(
    () => anthropic.create(cfg({ provider: 'anthropic', model: 'claude-haiku-5-5' }), opts(fetchImpl).impl).complete({ system: 's', user: 'u' }),
    (err) => err.kind === 'bad_request' && /refusal/.test(err.message)
  );
});

test('an aborted request is retryable and reports a timeout', async () => {
  const abort = () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; };
  const fetchImpl = fakeFetch([abort]);
  const { impl } = opts(fetchImpl);
  await assert.rejects(
    () => anthropic.create(cfg({ provider: 'anthropic', model: 'claude-haiku-5-5' }), impl).complete({ system: 's', user: 'u' }),
    (err) => err.kind === 'retryable' && /timed out|abort/i.test(err.message)
  );
  assert.equal(fetchImpl.calls.length, 3);
});

test('a broken JSON envelope is retryable, not a validation problem', async () => {
  const fetchImpl = fakeFetch([reply(200, 'not json at all')]);
  await assert.rejects(
    () => anthropic.create(cfg({ provider: 'anthropic', model: 'claude-haiku-5-5' }), opts(fetchImpl).impl).complete({ system: 's', user: 'u' }),
    (err) => err.kind === 'retryable' && /invalid JSON envelope/.test(err.message)
  );
});

test('no key → auth error without touching the network', async () => {
  const fetchImpl = fakeFetch([reply(200, ANTHROPIC_OK)]);
  const p = anthropic.create(cfg({ apiKeyEnv: 'MEMO_KEY_THAT_IS_UNSET' }), { fetchImpl, apiKey: '' });
  await assert.rejects(() => p.complete({ system: 's', user: 'u' }), (err) => err.kind === 'auth');
  assert.equal(fetchImpl.calls.length, 0);
});

test('openai: chat/completions with json_object response_format', async () => {
  const fetchImpl = fakeFetch([reply(200, {
    id: 'chatcmpl-1',
    model: 'gpt-6-luna',
    choices: [{ message: { role: 'assistant', content: '{"schema":1,"items":[]}' } }],
    usage: { prompt_tokens: 900, completion_tokens: 80 }
  }, { 'x-request-id': 'req_oa' })]);
  const { impl } = opts(fetchImpl);
  const out = await openai.create(cfg({ provider: 'openai', model: 'gpt-6-luna' }), impl)
    .complete({ system: 'SYS', user: 'USER', maxTokens: 1500 });

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.init.headers.authorization, 'Bearer ' + KEY);
  assert.deepEqual(call.body.response_format, { type: 'json_object' });
  assert.equal(call.body.max_completion_tokens, 1500);
  assert.deepEqual(call.body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }]);
  assert.equal(out.text, '{"schema":1,"items":[]}');
  assert.deepEqual(out.usage, { input: 900, output: 80 });
  assert.equal(out.model, 'gpt-6-luna');
});

test('openai: baseUrl points the same wire format at a compatible host', async () => {
  const fetchImpl = fakeFetch([reply(200, {
    id: 'chatcmpl-2',
    model: 'gemini-2.5-flash-lite',
    choices: [{ message: { role: 'assistant', content: '{"schema":1,"items":[]}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 10 }
  })]);
  const { impl } = opts(fetchImpl);
  await openai.create(cfg({
    provider: 'openai',
    model: 'gemini-2.5-flash-lite',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/'
  }), impl).complete({ system: 's', user: 'u' });
  assert.equal(fetchImpl.calls[0].url,
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
});

test('openrouter is the default: GLM 5.3 Flash, max_tokens, strict schema, hidden reasoning', async () => {
  const fetchImpl = fakeFetch([reply(200, {
    id: 'gen-1',
    model: 'z-ai/glm-5.3-flash',
    choices: [{ message: { role: 'assistant', content: '{"items":[]}' } }],
    usage: { prompt_tokens: 50, completion_tokens: 5 }
  })]);
  const { impl } = opts(fetchImpl);
  const schema = { name: 'records', schema: { type: 'object', properties: {}, additionalProperties: false } };
  const out = await provider.create(cfg(), impl).complete({ system: 's', user: 'u', maxTokens: 700, schema });

  const call = fetchImpl.calls[0];
  assert.equal(config.defaults().provider, 'openrouter');
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(call.body.model, 'z-ai/glm-5.3-flash');
  assert.equal(call.body.max_tokens, 700);
  assert.equal(call.body.max_completion_tokens, undefined);
  assert.equal(call.body.response_format.type, 'json_schema');
  assert.deepEqual(call.body.reasoning, { effort: 'low', exclude: true });
  assert.ok(config.priceFor(config.defaults(), 'z-ai/glm-5.3-flash'));
  assert.equal(out.text, '{"items":[]}');
});

test('openrouter key is read from OPEN_ROUTER_API_KEY or OPENROUTER_API_KEY', (t) => {
  const saved = { a: process.env.OPEN_ROUTER_API_KEY, b: process.env.OPENROUTER_API_KEY };
  t.after(() => {
    for (const [k, v] of [['OPEN_ROUTER_API_KEY', saved.a], ['OPENROUTER_API_KEY', saved.b]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  delete process.env.OPEN_ROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test-b';
  assert.equal(config.apiKey(cfg()), 'sk-or-test-b');
  process.env.OPEN_ROUTER_API_KEY = 'sk-or-test-a';
  assert.equal(config.apiKey(cfg()), 'sk-or-test-a');
});

test('openai: insufficient_quota is quota, 429 retries', async () => {
  const q = fakeFetch([reply(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } })]);
  await assert.rejects(
    () => openai.create(cfg({ provider: 'openai' }), opts(q).impl).complete({ system: 's', user: 'u' }),
    (err) => err.kind === 'quota'
  );
  assert.equal(q.calls.length, 1, 'quota must not be retried');

  const rate = fakeFetch([reply(429, { error: { message: 'Rate limit reached' } }), reply(200, {
    id: 'c', model: 'gpt-6-luna', choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 }
  })]);
  const out = await openai.create(cfg({ provider: 'openai' }), opts(rate).impl).complete({ system: 's', user: 'u' });
  assert.equal(rate.calls.length, 2);
  assert.equal(out.text, '{}');
});

test('the key never reaches the provider log', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-prov-log-'));
  const previous = process.env.MEMO_HOME;
  process.env.MEMO_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.MEMO_HOME;
    else process.env.MEMO_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const fetchImpl = fakeFetch([reply(401, { error: { message: 'invalid x-api-key' } })]);
  await assert.rejects(() => anthropic.create(cfg({ provider: 'anthropic', model: 'claude-haiku-5-5' }), opts(fetchImpl).impl).complete({ system: 's', user: 'SECRET-USER-TEXT' }));
  const log = fs.readFileSync(path.join(home, 'logs', 'provider.jsonl'), 'utf8');
  assert.ok(!log.includes(KEY), 'api key in log');
  assert.ok(!log.includes('SECRET-USER-TEXT'), 'prompt body in log');
  assert.match(log, /"status":401/);
  assert.match(log, /"kind":"auth"/);
});

test('status classification matches the plan', () => {
  assert.equal(provider.kindForStatus(401), 'auth');
  assert.equal(provider.kindForStatus(403), 'auth');
  assert.equal(provider.kindForStatus(429), 'retryable');
  assert.equal(provider.kindForStatus(500), 'retryable');
  assert.equal(provider.kindForStatus(503), 'retryable');
  assert.equal(provider.kindForStatus(400), 'bad_request');
  assert.equal(provider.kindForStatus(404), 'bad_request');
  assert.deepEqual(provider.BACKOFF_MS, [2000, 8000, 30000]);
  assert.equal(provider.ATTEMPTS, 3);
  assert.equal(provider.TIMEOUT_MS, 60000);
});

test('the factory picks the configured provider', () => {
  assert.equal(provider.create(cfg({ provider: 'anthropic' }), { apiKey: KEY }).name, 'anthropic');
  assert.equal(provider.create(cfg({ provider: 'openai' }), { apiKey: KEY }).name, 'openai');
  assert.equal(provider.create(cfg({ provider: 'mock' })).name, 'mock');
  assert.throws(() => provider.create({ provider: 'telepathy' }), /unknown provider/);
});
