'use strict';

// What the provider says about its own limits, and when MEMO must not call it.
//
//   ~/.memo/state/limits.json    last rate-limit headers seen per provider/model
//   ~/.memo/state/cooldown.json  {until, reason, kind} — no API call before `until`
//
// Nothing here assumes a quota. Limits are only what the provider reported, with a timestamp.
// Groq documents x-ratelimit-limit-requests (per day), x-ratelimit-limit-tokens (per minute),
// the matching -remaining-/-reset- headers, and retry-after on 429
// (console.groq.com/docs/rate-limits, read 22 Oct 2026). OpenAI uses the same names.

const path = require('node:path');
const { memoHome } = require('../paths');
const { readJson, writeJsonAtomic, isoLocal } = require('../util');

// Waiting longer than this inside one run is not worth it: defer to a later cycle instead.
const MAX_INLINE_WAIT_MS = 65000;
// No reset time given (credits exhausted, auth): look again after this long.
const DEFAULT_COOLDOWN_MS = { quota: 60 * 60000, auth: 60 * 60000, rate_limited: 15 * 60000 };

function limitsPath() {
  return path.join(memoHome(), 'state', 'limits.json');
}

function cooldownPath() {
  return path.join(memoHome(), 'state', 'cooldown.json');
}

function safeRead(file, fallback) {
  try { return readJson(file, fallback) || fallback; } catch (_) { return fallback; }
}

// "7.66s", "2m59.56s", "1h2m3s", "120ms", "30" (seconds) → ms, or null.
function parseDuration(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(text)) !== null) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3600000 : m[2] === 'm' ? n * 60000 : m[2] === 's' ? n * 1000 : n;
  }
  return matched ? Math.round(total) : null;
}

function num(v) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
}

// Rate-limit headers → plain object (only fields the provider actually sent).
function fromHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const get = (name) => headers.get(name);
  const out = {
    limitRequests: num(get('x-ratelimit-limit-requests')),
    remainingRequests: num(get('x-ratelimit-remaining-requests')),
    resetRequestsMs: parseDuration(get('x-ratelimit-reset-requests')),
    limitTokens: num(get('x-ratelimit-limit-tokens')),
    remainingTokens: num(get('x-ratelimit-remaining-tokens')),
    resetTokensMs: parseDuration(get('x-ratelimit-reset-tokens'))
  };
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return Object.keys(out).length > 0 ? out : null;
}

// "Please try again in 7m12.5s" in an error message → ms.
function retryHintMs(message) {
  const m = String(message || '').match(/try again in\s+([0-9hms.]+)/i);
  return m ? parseDuration(m[1]) : null;
}

// "Limit 8000, Requested 9512" in a too-large / TPM message → 8000.
function limitFromMessage(message) {
  const m = String(message || '').match(/\bLimit\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

function key(provider, model) {
  return String(provider) + '/' + String(model);
}

function record(provider, model, info) {
  if (!info) return null;
  const all = safeRead(limitsPath(), {});
  const entry = { ...(all[key(provider, model)] || {}), ...info, ts: isoLocal() };
  all[key(provider, model)] = entry;
  try { writeJsonAtomic(limitsPath(), all); } catch (_) { /* advisory */ }
  return entry;
}

function get(provider, model) {
  return safeRead(limitsPath(), {})[key(provider, model)] || null;
}

function cooldown(now = Date.now()) {
  const c = safeRead(cooldownPath(), null);
  if (!c || !c.until) return null;
  const until = Date.parse(c.until);
  if (!Number.isFinite(until) || until <= now) return null;
  return { ...c, ms: until - now };
}

function setCooldown(kind, ms, reason) {
  const wait = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_COOLDOWN_MS[kind] || DEFAULT_COOLDOWN_MS.rate_limited;
  const value = { kind, until: isoLocal(Date.now() + wait), reason: String(reason || kind).slice(0, 300), set: isoLocal() };
  try { writeJsonAtomic(cooldownPath(), value); } catch (_) { /* advisory */ }
  return value;
}

function clearCooldown() {
  try { require('node:fs').unlinkSync(cooldownPath()); return true; } catch (_) { return false; }
}

/**
 * Largest input budget for one call: the configured cap, lowered so that input + output
 * fits a tokens-per-minute limit the provider reported (headers or a 413 message).
 */
function inputCap(cfg, provider = cfg.provider, model = cfg.model) {
  const configured = Number(cfg.maxInputTokensPerCall);
  const seen = get(provider, model);
  const tpm = seen && (seen.learnedTokenLimit || seen.limitTokens);
  if (!tpm) return configured;
  const room = Math.floor(tpm * 0.85) - Number(cfg.maxOutputTokens || 0);
  return Math.max(1000, Math.min(configured, room));
}

/**
 * Before one call: go, wait a little, or defer to a later cycle.
 * @returns {{go: true} | {waitMs: number} | {deferMs: number, reason: string}}
 */
function gate(provider, model, needTokens, now = Date.now()) {
  const seen = get(provider, model);
  if (!seen || !seen.ts) return { go: true };
  const age = now - Date.parse(seen.ts);
  if (!Number.isFinite(age)) return { go: true };
  if (seen.remainingRequests === 0 && Number.isFinite(seen.resetRequestsMs) && age < seen.resetRequestsMs) {
    return { deferMs: seen.resetRequestsMs - age, reason: 'provider request limit reached (reported ' + seen.limitRequests + ')' };
  }
  if (Number.isFinite(seen.remainingTokens) && seen.remainingTokens < needTokens &&
      Number.isFinite(seen.resetTokensMs) && age < seen.resetTokensMs) {
    const wait = seen.resetTokensMs - age + 250;
    return wait <= MAX_INLINE_WAIT_MS ? { waitMs: wait }
      : { deferMs: wait, reason: 'provider token limit reached (reported ' + seen.limitTokens + ')' };
  }
  return { go: true };
}

module.exports = {
  MAX_INLINE_WAIT_MS, DEFAULT_COOLDOWN_MS, limitsPath, cooldownPath,
  parseDuration, fromHeaders, retryHintMs, limitFromMessage, record, get,
  cooldown, setCooldown, clearCooldown, inputCap, gate
};
