const test = require('node:test');
const assert = require('node:assert');
const { redact } = require('../src/redact');

test('redacts OpenAI/Anthropic keys', () => {
  const res = redact('my key is sk-1234567890abcdef12345678');
  assert.strictEqual(res.text, 'my key is [REDACTED]');
  assert.strictEqual(res.count, 1);
});

test('redacts GitHub tokens', () => {
  const res = redact('token ghp_1234567890abcdefghijklmnopqrstuvwxyzAB');
  assert.strictEqual(res.text, 'token [REDACTED]');
  assert.strictEqual(res.count, 1);
});

test('redacts AWS access keys', () => {
  const res = redact('AWS AKIAIOSFODNN7EXAMPLE');
  assert.strictEqual(res.text, 'AWS [REDACTED]');
  assert.strictEqual(res.count, 1);
});

test('redacts Google keys', () => {
  const res = redact('AIzaSyD-1234567890abcdefghijklmnopqrstuvwxyzAB');
  assert.strictEqual(res.text, '[REDACTED]');
  assert.strictEqual(res.count, 1);
});

test('redacts Slack tokens', () => {
  const res = redact('xoxb-1234567890-abcdef');
  assert.strictEqual(res.text, '[REDACTED]');
  assert.strictEqual(res.count, 1);
});

test('redacts JWTs', () => {
  const res = redact('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjjUxNjIzOTAyMn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
  assert.strictEqual(res.text, '[REDACTED]');
  assert.strictEqual(res.count, 1);
});

test('redacts Bearer tokens case-insensitively', () => {
  const res = redact('bearer secrettoken123');
  assert.strictEqual(res.text, '[REDACTED]');
  assert.strictEqual(res.count, 1);
});

test('redacts key=value secrets while keeping label', () => {
  const res = redact('password=supersecret123 and api_key:mykeyval');
  assert.strictEqual(res.text, 'password=[REDACTED] and api_key:[REDACTED]');
  assert.strictEqual(res.count, 2);
});

test('redacts private key blocks', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----';
  const res = redact(`Key:\n${pem}\nDone.`);
  assert.strictEqual(res.text, 'Key:\n[REDACTED]\nDone.');
  assert.strictEqual(res.count, 1);
});

test('leaves normal sentences unchanged', () => {
  const text = 'Hello world! This is a normal sentence with 123 numbers.';
  const res = redact(text);
  assert.strictEqual(res.text, text);
  assert.strictEqual(res.count, 0);
});