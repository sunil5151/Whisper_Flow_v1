'use strict';

// Provider interface + factory + shared retry logic (P2 spec).
//
//   complete({system, user, maxTokens, model, json}) → {text, usage:{input, output}, model, requestId, limits}
//
// Throws ProviderError{kind}:
//   retryable     short outage / short rate limit — retried here with backoff
//   rate_limited  the provider asked for a wait longer than one run should block — defer, keep the work
//   quota         credits or billing exhausted — defer, keep the work
//   too_large     the request is bigger than the provider allows per minute — rebatch smaller
//   invalid_output the provider rejected the model's own JSON (Groq json_validate_failed) — retried
//   auth          bad or missing key
//   bad_request   anything else 4xx
// Never logs headers, bodies, or the API key — only status, requestId, attempt.

const { log } = require('../log');
const { sleepMs } = require('../util');
const limits = require('./limits');

const TIMEOUT_MS = 60000;
const BACKOFF_MS = [2000, 8000, 30000];
const ATTEMPTS = 3;

class ProviderError extends Error {
  constructor(message, { kind = 'retryable', status = null, retryAfterMs = null, requestId = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.requestId = requestId;
  }
}

// HTTP status → error kind. Quota needs the body text, so it is decided by the caller.
function kindForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'retryable';
  if (status === 413) return 'bad_request';
  if (status >= 500) return 'retryable';
  if (status === 408 || status === 409) return 'retryable';
  if (status >= 400) return 'bad_request';
  return 'retryable';
}

// retry-after in ms, uncapped: a long wait is turned into a deferral, not a long sleep.
function retryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

// Some hosts report "request bigger than the per-minute token limit" as 413.
function looksLikeRateLimit(status, bodyText) {
  if (status !== 413) return false;
  return /tokens per minute|rate limit|tpm|too large for model/i.test(String(bodyText || ''));
}

// A rate-limit message that only mentions billing in an upgrade hint is not a quota problem.
function looksLikeRateLimitMessage(bodyText) {
  return /rate limit reached|try again in|per (minute|day)|\b(tpm|tpd|rpm|rpd)\b/i.test(String(bodyText || ''));
}

// Body text often carries the only signal that credits ran out.
function looksLikeQuota(status, bodyText) {
  const text = String(bodyText || '').toLowerCase();
  if (!text) return false;
  const quota = /insufficient[_ -]?(quota|credit)|credit balance|billing|exceeded your current quota|payment required/.test(text);
  if (quota && looksLikeRateLimitMessage(text) && !/insufficient[_ -]?quota|exceeded your current quota|credit balance/.test(text)) return false;
  return quota && (status === 400 || status === 402 || status === 403 || status === 429);
}

// Groq: 400 {"error":{"code":"json_validate_failed", …, "failed_generation": …}}
function looksLikeInvalidOutput(status, bodyText) {
  if (status !== 400) return false;
  return /json_validate_failed|failed to validate json|does not match the expected schema|failed_generation/i.test(String(bodyText || ''));
}

/**
 * One non-200 reply → ProviderError. Shared by every HTTP provider.
 * @param {string} name provider name for the message
 */
function errorFor(name, res, message, requestId) {
  const text = res.text;
  const status = res.status;
  let kind = kindForStatus(status);
  let wait = retryAfterMs(res.headers);
  if (wait === null) wait = limits.retryHintMs(text);
  if (looksLikeQuota(status, text)) kind = 'quota';
  else if (looksLikeInvalidOutput(status, text)) kind = 'invalid_output';
  else if (looksLikeRateLimit(status, text)) kind = 'too_large';
  else if (status === 429 || status === 498) {
    kind = wait !== null && wait > limits.MAX_INLINE_WAIT_MS ? 'rate_limited' : 'retryable';
    if (/per day|\b(tpd|rpd)\b/i.test(String(text || ''))) kind = 'rate_limited';
  }
  const err = new ProviderError(message, { kind, status, retryAfterMs: wait, requestId });
  if (kind === 'too_large') err.limit = limits.limitFromMessage(text);
  return err;
}

async function postJson(url, { headers, body, timeoutMs = TIMEOUT_MS, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new ProviderError('fetch is not available in this Node build', { kind: 'bad_request' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
    throw new ProviderError(aborted ? 'request timed out after ' + timeoutMs + ' ms' : 'network error: ' + (err && err.message),
      { kind: 'retryable' });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

// 3 attempts with 2 s / 8 s / 30 s backoff, honouring retry-after.
async function withRetries(name, call, { attempts = ATTEMPTS, backoff = BACKOFF_MS, sleep = sleepMs, invalidOutputAttempts = ATTEMPTS } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call(attempt);
    } catch (err) {
      const pe = err instanceof ProviderError ? err
        : new ProviderError(err && err.message ? err.message : String(err), { kind: 'retryable' });
      last = pe;
      log('provider', {
        provider: name, status: pe.status, kind: pe.kind, attempt,
        requestId: pe.requestId, error: pe.message
      });
      if (pe.kind === 'invalid_output' && attempt < Math.min(attempts, invalidOutputAttempts)) continue;
      if (pe.kind === 'invalid_output') throw pe;
      if (pe.kind !== 'retryable' || attempt === attempts) throw pe;
      const waitMs = pe.retryAfterMs !== null && pe.retryAfterMs !== undefined
        ? pe.retryAfterMs
        : backoff[Math.min(attempt - 1, backoff.length - 1)];
      if (waitMs > limits.MAX_INLINE_WAIT_MS) {
        pe.kind = 'rate_limited';
        throw pe;
      }
      if (waitMs > 0) sleep(waitMs);
    }
  }
  throw last;
}

/**
 * @param {object} cfg  config.load() result
 * @param {object} opts {fetchImpl, sleep, backoff, attempts, apiKey} — injected by tests
 */
function create(cfg, opts = {}) {
  const provider = String((cfg && cfg.provider) || 'openrouter');
  if (provider === 'anthropic') return require('./anthropic').create(cfg, opts);
  if (provider === 'openai' || provider === 'groq' || provider === 'openrouter') return require('./openai').create(cfg, opts);
  if (provider === 'mock') return require('./mock').create(cfg, opts);
  throw new Error('unknown provider: ' + provider);
}

module.exports = {
  ProviderError, create, postJson, withRetries, kindForStatus, retryAfterMs, errorFor,
  looksLikeQuota, looksLikeRateLimit, looksLikeInvalidOutput, TIMEOUT_MS, BACKOFF_MS, ATTEMPTS
};
