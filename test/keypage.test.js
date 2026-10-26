'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectKey } = require('../src/ui/keypage');

function run(submit) {
  let url = '';
  const done = collectKey({
    provider: 'openrouter', label: 'OpenRouter', keyUrl: 'https://openrouter.ai/keys',
    submit, timeoutMs: 1500, open: () => true, onUrl: (u) => { url = u; }
  });
  return { done, url: () => url };
}

async function waitUrl(h) {
  while (!h.url()) await new Promise((r) => setTimeout(r, 10));
  return h.url();
}

test('key page serves the form and accepts a key with the page token', async () => {
  let got = null;
  const h = run(async (key) => { got = key; return { ok: true }; });
  const url = await waitUrl(h);
  const html = await (await fetch(url)).text();
  assert.match(html, /Connect MEMO/);
  const token = /'x-memo-token':'([0-9a-f]+)'/.exec(html)[1];
  const res = await fetch(url + 'key', { method: 'POST', headers: { 'x-memo-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ key: ' sk-or-v1-abcdef ' }) });
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(await h.done, true);
  assert.equal(got, 'sk-or-v1-abcdef');
});

test('key page refuses a post without the token and reports a rejected key', async () => {
  const h = run(async () => ({ ok: false, error: 'nope' }));
  const url = await waitUrl(h);
  const html = await (await fetch(url)).text();
  const token = /'x-memo-token':'([0-9a-f]+)'/.exec(html)[1];
  assert.equal((await fetch(url + 'key', { method: 'POST', body: '{}' })).status, 404);
  const res = await fetch(url + 'key', { method: 'POST', headers: { 'x-memo-token': token }, body: JSON.stringify({ key: 'x' }) });
  assert.deepEqual(await res.json(), { ok: false, error: 'nope' });
});
