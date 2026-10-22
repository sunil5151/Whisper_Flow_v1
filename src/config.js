'use strict';

// ~/.memo/config.json — non-secret settings (§6.4). Machine state only, never in the repo.

const path = require('node:path');
const { memoHome } = require('./paths');
const { readJson, writeJsonAtomic } = require('./util');
const { DEFAULT_DENY_PATHS } = require('./redact');

// USD per 1M tokens, standard tier (plan §10.1, prices checked 20 Oct 2026).
const PRICES = {
  'claude-haiku-5-5': { inPerM: 0.10, outPerM: 0.50 },
  'claude-sonnet-5-5': { inPerM: 2, outPerM: 10 },
  'claude-opus-5-5': { inPerM: 4, outPerM: 20 },
  'gpt-6-luna': { inPerM: 0.10, outPerM: 0.50 },
  'gpt-6.1-sol': { inPerM: 2, outPerM: 10 },
  'gpt-6-astra': { inPerM: 10, outPerM: 50 }
};

const PROVIDERS = ['anthropic', 'openai', 'mock'];

// Used when the env var named by config.apiKeyEnv is empty.
const KEY_ENV_FALLBACK = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

const DEFAULTS = {
  v: 1,
  provider: 'anthropic',
  // Cheapest tier per §3 #6. docs/PHASE0_FINDINGS.md §7 (model choice) is still a template.
  model: 'claude-haiku-5-5',
  consolidationModel: null,
  apiKeyEnv: 'MEMO_API_KEY',
  // OpenAI-compatible endpoint root (Gemini, Groq, OpenRouter, Ollama, …); null = api.openai.com.
  baseUrl: null,
  apiEnabled: true,
  paused: false,
  intervalMinutes: 15,
  maxInputTokensPerCall: 12000,
  maxCallsPerCycle: 6,
  monthlyBudgetUsd: 5,
  summaryLanguage: 'en',
  prices: PRICES,
  denyPaths: DEFAULT_DENY_PATHS,
  autoCommit: true,
  commitIdentity: null
};

const NUMERIC = {
  intervalMinutes: { min: 1, max: 1440 },
  maxInputTokensPerCall: { min: 500, max: 200000 },
  maxCallsPerCycle: { min: 1, max: 100 },
  monthlyBudgetUsd: { min: 0, max: 10000 }
};

const PRICE_KEY_RE = /^prices\.(.+)\.(inPerM|outPerM)$/;

function configPath() {
  return path.join(memoHome(), 'config.json');
}

function defaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function isPrice(p) {
  return p && typeof p === 'object' && Number.isFinite(Number(p.inPerM)) && Number.isFinite(Number(p.outPerM));
}

// Replace anything unusable with its default; a hand-edited file never throws.
function sanitize(cfg) {
  const out = { ...defaults(), ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  out.v = 1;
  if (!PROVIDERS.includes(out.provider)) out.provider = DEFAULTS.provider;
  if (typeof out.model !== 'string' || !out.model.trim()) out.model = DEFAULTS.model;
  if (out.consolidationModel !== null && (typeof out.consolidationModel !== 'string' || !out.consolidationModel.trim())) {
    out.consolidationModel = null;
  }
  if (typeof out.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(out.apiKeyEnv)) {
    out.apiKeyEnv = DEFAULTS.apiKeyEnv;
  }
  if (out.baseUrl !== null) {
    const url = typeof out.baseUrl === 'string' ? out.baseUrl.trim().replace(/\/+$/, '') : '';
    out.baseUrl = /^https:\/\/\S+$/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\S*$/.test(url) ? url : null;
  }
  for (const k of ['apiEnabled', 'paused', 'autoCommit']) {
    if (typeof out[k] !== 'boolean') out[k] = DEFAULTS[k];
  }
  for (const [k, range] of Object.entries(NUMERIC)) {
    const n = Number(out[k]);
    out[k] = Number.isFinite(n) && n >= range.min && n <= range.max ? n : DEFAULTS[k];
  }
  if (typeof out.summaryLanguage !== 'string' || !out.summaryLanguage.trim()) out.summaryLanguage = DEFAULTS.summaryLanguage;
  const prices = {};
  for (const [model, p] of Object.entries(out.prices && typeof out.prices === 'object' ? out.prices : {})) {
    if (isPrice(p)) prices[model] = { inPerM: Number(p.inPerM), outPerM: Number(p.outPerM) };
  }
  out.prices = Object.keys(prices).length > 0 ? prices : defaults().prices;
  if (!Array.isArray(out.denyPaths) || out.denyPaths.some((p) => typeof p !== 'string')) {
    out.denyPaths = defaults().denyPaths;
  }
  if (out.commitIdentity !== null && (!out.commitIdentity || typeof out.commitIdentity !== 'object')) {
    out.commitIdentity = null;
  }
  return out;
}

function load() {
  let stored = null;
  try { stored = readJson(configPath(), null); } catch (_) { stored = null; }
  return sanitize(stored);
}

function save(cfg) {
  const clean = sanitize(cfg);
  writeJsonAtomic(configPath(), clean);
  return clean;
}

// Write the default file when none exists; returns the effective config.
function ensure() {
  let stored = null;
  try { stored = readJson(configPath(), null); } catch (_) { stored = null; }
  if (stored === null) return save(defaults());
  return sanitize(stored);
}

function coerce(key, raw) {
  const ref = PRICE_KEY_RE.test(key) ? 0 : DEFAULTS[key];
  if (raw === 'null') return null;
  if (typeof ref === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(key + ' must be true or false');
  }
  if (typeof ref === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(key + ' must be a number');
    return n;
  }
  if (Array.isArray(ref)) return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return String(raw);
}

const SETTABLE = Object.keys(DEFAULTS).filter((k) => k !== 'v' && k !== 'prices');

// Backing call for `memo config set <key> <value>`. Also prices.<model>.inPerM / .outPerM.
function set(key, raw) {
  const cfg = load();
  const priceKey = key.match(PRICE_KEY_RE);
  if (priceKey) {
    const n = coerce(key, raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(key + ' must be a non-negative number');
    const current = cfg.prices[priceKey[1]] || { inPerM: 0, outPerM: 0 };
    cfg.prices[priceKey[1]] = { ...current, [priceKey[2]]: n };
    return { cfg: save(cfg), changed: current[priceKey[2]] !== n };
  }
  if (!SETTABLE.includes(key)) {
    throw new Error('unknown config key: ' + key + '\nsettable: ' + SETTABLE.join(', ') +
      ', prices.<model>.inPerM, prices.<model>.outPerM');
  }
  const value = coerce(key, raw);
  if (key === 'provider' && !PROVIDERS.includes(value)) {
    throw new Error('provider must be one of: ' + PROVIDERS.join(', '));
  }
  if (NUMERIC[key]) {
    const { min, max } = NUMERIC[key];
    if (!(value >= min && value <= max)) throw new Error(key + ' must be between ' + min + ' and ' + max);
  }
  const before = JSON.stringify(cfg[key]);
  cfg[key] = value;
  const clean = sanitize(cfg);
  if (JSON.stringify(clean[key]) !== JSON.stringify(value)) {
    throw new Error('invalid value for ' + key + ': ' + raw);
  }
  save(clean);
  return { cfg: clean, changed: before !== JSON.stringify(value) };
}

function priceFor(cfg, model) {
  const p = cfg.prices && cfg.prices[model];
  return isPrice(p) ? { inPerM: Number(p.inPerM), outPerM: Number(p.outPerM) } : null;
}

// Env var that actually holds the key (configured name first, then the provider fallback).
function keyEnvName(cfg) {
  if (process.env[cfg.apiKeyEnv]) return cfg.apiKeyEnv;
  const fb = KEY_ENV_FALLBACK[cfg.provider];
  if (fb && process.env[fb]) return fb;
  return cfg.apiKeyEnv;
}

function apiKey(cfg) {
  const value = process.env[keyEnvName(cfg)];
  return value ? String(value).trim() : '';
}

// The key is only ever shown like this; never printed or logged in full.
function maskKey(key) {
  return key ? 'set (…' + key.slice(-4) + ')' : 'not set';
}

// Printable config, secrets excluded.
function describe(cfg) {
  const lines = ['config  ' + configPath()];
  const keys = ['provider', 'model', 'baseUrl', 'consolidationModel', 'apiEnabled', 'paused', 'intervalMinutes',
    'maxInputTokensPerCall', 'maxCallsPerCycle', 'monthlyBudgetUsd', 'summaryLanguage', 'autoCommit'];
  for (const key of keys) lines.push(key.padEnd(22) + ' ' + JSON.stringify(cfg[key]));
  lines.push('apiKeyEnv'.padEnd(22) + ' ' + keyEnvName(cfg) + ' → ' + maskKey(apiKey(cfg)));
  const price = priceFor(cfg, cfg.model);
  lines.push('price (per 1M)'.padEnd(22) + ' ' +
    (price ? 'in $' + price.inPerM + ' / out $' + price.outPerM
      : 'unknown — set prices.' + cfg.model + '.inPerM / .outPerM'));
  lines.push('denyPaths'.padEnd(22) + ' ' + cfg.denyPaths.join(', '));
  return lines.join('\n') + '\n';
}

module.exports = {
  DEFAULTS, PRICES, PROVIDERS, KEY_ENV_FALLBACK, SETTABLE,
  configPath, defaults, sanitize, load, save, ensure, set,
  priceFor, keyEnvName, apiKey, maskKey, describe
};
