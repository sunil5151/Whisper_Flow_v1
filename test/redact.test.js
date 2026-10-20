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

test('redacts all planned GitHub token prefixes', () => {
  for (const token of [
    'ghp_' + 'a'.repeat(30), 'gho_' + 'a'.repeat(30),
    'ghu_' + 'a'.repeat(30), 'ghs_' + 'a'.repeat(30),
    'ghr_' + 'a'.repeat(30), 'github_pat_' + 'a'.repeat(30)
  ]) {
    const res = redact(token);
    assert.strictEqual(res.text, '[REDACTED]', token.slice(0, 10));
    assert.strictEqual(res.count, 1);
  }
});

const { redactPath } = require('../src/redact');

test('redacts Anthropic and OpenAI project keys', () => {
  assert.strictEqual(redact('a sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV b').text, 'a [REDACTED] b');
  assert.strictEqual(redact('a sk-proj-ABCDEFGHIJKLMNOPQRSTUV b').text, 'a [REDACTED] b');
});

test('redacts connection string credentials, keeps scheme and host', () => {
  const res = redact('DB at postgres://admin:s3cret@db.local:5432/app now');
  assert.strictEqual(res.text, 'DB at postgres://[REDACTED]@db.local:5432/app now');
});

test('redacts .env style lines (multiline)', () => {
  const res = redact('line\nSTRIPE_LIVE=abcd1234efgh\nSHORT=abc\n');
  assert.strictEqual(res.text, 'line\nSTRIPE_LIVE=[REDACTED]\nSHORT=abc\n');
});

test('redacts long tokens near key/secret/token words', () => {
  const res = redact('the session token is 0123456789abcdef0123456789abcdef01234567 ok');
  assert.strictEqual(res.text, 'the session token is [REDACTED] ok');
});

test('redaction is idempotent', () => {
  const once = redact('password=hunter2 TOKEN_X=abcdefghijk postgres://u:p@h/x').text;
  assert.strictEqual(redact(once).text, once);
});

test('redactPath matches denylist', () => {
  for (const p of ['.env', 'config/.env', '.env.local', 'certs/server.pem', 'a/b.key', 'id_rsa', 'id_rsa.pub', 'credentials-prod.json', 'secrets/a/b.txt', 'app/secrets/x']) {
    assert.strictEqual(redactPath(p), true, p);
  }
  for (const p of ['src/env.js', 'README.md', 'src/keys.js', 'secrets.md', '<outside-repo>', '']) {
    assert.strictEqual(redactPath(p), false, p);
  }
});
