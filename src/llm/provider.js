'use strict';

// Provider interface + factory + shared retry logic (P2 spec).
//
//   complete({system, user, maxTokens, model}) → {text, usage:{input, output}, model, requestId}
//
// Throws ProviderError{kind: 'retryable'|'auth'|'bad_request'|'quota'}.
// Never logs headers, bodies, or the API key — only status, requestId, attempt.

const { log } = require('../log');
const { sleepMs } = require('../util');

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
  if (status >= 500) return 'retryable';
  if (status === 408 || status === 409) return 'retryable';
  if (status >= 400) return 'bad_request';
  return 'retryable';
}

function retryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(120, seconds)) * 1000;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, Math.min(120000, when - Date.now()));
  return null;
}

// Body text often carries the only signal that credits ran out.
function looksLikeQuota(status, bodyText) {
  const text = String(bodyText || '').toLowerCase();
  if (!text) return false;
  const quota = /insufficient[_ -]?(quota|credit)|credit balance|billing|exceeded your current quota|payment required/.test(text);
  return quota && (status === 400 || status === 402 || status === 403 || status === 429);
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
async function withRetries(name, call, { attempts = ATTEMPTS, backoff = BACKOFF_MS, sleep = sleepMs } = {}) {
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
      if (pe.kind !== 'retryable' || attempt === attempts) throw pe;
      const waitMs = pe.retryAfterMs !== null && pe.retryAfterMs !== undefined
        ? pe.retryAfterMs
        : backoff[Math.min(attempt - 1, backoff.length - 1)];
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
  const provider = String((cfg && cfg.provider) || 'anthropic');
  if (provider === 'anthropic') return require('./anthropic').create(cfg, opts);
  if (provider === 'openai') return require('./openai').create(cfg, opts);
  if (provider === 'mock') return require('./mock').create(cfg, opts);
  throw new Error('unknown provider: ' + provider);
}

module.exports = {
  ProviderError, create, postJson, withRetries, kindForStatus, retryAfterMs, looksLikeQuota,
  TIMEOUT_MS, BACKOFF_MS, ATTEMPTS
};
