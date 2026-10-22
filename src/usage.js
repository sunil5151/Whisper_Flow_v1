'use strict';

// Token/cost accounting: ~/.memo/logs/usage.jsonl + budget checks (§6.4, §10.4).
// Tokens are what the provider reported; cost is always an estimate from config.prices.
// Mock calls are logged with mock:true and never counted as real usage.

const fs = require('node:fs');
const path = require('node:path');
const { logsDir } = require('./paths');
const { log } = require('./log');
const { priceFor } = require('./config');
const { isoLocal } = require('./util');

// Plan §6.3: estimate tokens as chars / 4.
function estimateTokens(text) {
  if (typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

// USD for one call, or null when the model has no price in config.
function costOf(cfg, model, inTokens, outTokens) {
  const price = priceFor(cfg, model);
  if (!price) return null;
  const cost = (Number(inTokens) || 0) / 1e6 * price.inPerM + (Number(outTokens) || 0) / 1e6 * price.outPerM;
  return Math.round(cost * 1e6) / 1e6;
}

function usageFile() {
  return path.join(logsDir(), 'usage.jsonl');
}

// One line per successful provider call: {ts, repoId, job, provider, model, in, out, costEst, mock?}.
function record(entry) {
  log('usage', {
    repoId: entry.repoId || null,
    job: entry.job || null,
    provider: entry.provider || null,
    ...(entry.mock ? { mock: true } : {}),
    model: entry.model || null,
    in: Number(entry.in) || 0,
    out: Number(entry.out) || 0,
    costEst: entry.costEst === null || entry.costEst === undefined ? null : Number(entry.costEst)
  });
}

function readLog(name) {
  const out = [];
  // log.js rotates to <file>.1 at 1 MB; read it too so a month total is not cut short.
  const file = path.join(logsDir(), name + '.jsonl');
  for (const f of [file + '.1', file]) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* torn line ignored */ }
    }
  }
  return out;
}

function isMock(line) {
  return line.mock === true || line.provider === 'mock' || line.model === 'mock';
}

function currentMonth() {
  return isoLocal().slice(0, 7);
}

function today() {
  return isoLocal().slice(0, 10);
}

// Real calls whose local timestamp starts with prefix (YYYY-MM or YYYY-MM-DD).
// costKnown is false if any call had no price.
function totals(prefix) {
  const out = { period: prefix, calls: 0, input: 0, output: 0, costUsd: 0, costKnown: true, mockCalls: 0, lastTs: null };
  for (const line of readLog('usage')) {
    if (typeof line.ts !== 'string' || !line.ts.startsWith(prefix)) continue;
    if (line.model === undefined && line.in === undefined) continue;
    if (isMock(line)) { out.mockCalls++; continue; }
    out.calls++;
    out.lastTs = line.ts;
    out.input += Number(line.in) || 0;
    out.output += Number(line.out) || 0;
    if (line.costEst === null || line.costEst === undefined) out.costKnown = false;
    else out.costUsd += Number(line.costEst) || 0;
  }
  out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
  return out;
}

function monthTotals(month = currentMonth()) {
  const t = totals(month);
  return { month, ...t };
}

function dayTotals(day = today()) {
  return totals(day);
}

// Plan §P2 step 1: stop before a call when this month's estimated cost, or today's
// provider-reported tokens, already reached the configured budget.
function budgetState(cfg, month = currentMonth()) {
  const t = monthTotals(month);
  const limit = Number(cfg.monthlyBudgetUsd);
  const monthly = Number.isFinite(limit) && limit >= 0 && t.costUsd >= limit;
  const daily = Number(cfg.dailyTokenBudget) || 0;
  const day = daily > 0 ? dayTotals() : null;
  const dailyReached = Boolean(day && day.input + day.output >= daily);
  let reason = null;
  if (monthly) reason = 'monthly budget of ' + limit + ' USD reached (estimated cost)';
  else if (dailyReached) reason = 'daily token budget of ' + daily + ' reached';
  return { reached: monthly || dailyReached, reason, limit, dailyTokenBudget: daily, dayTokens: day ? day.input + day.output : null, ...t };
}

// Failed provider attempts in provider.jsonl whose timestamp starts with prefix, by kind.
function failures(prefix = currentMonth()) {
  const out = { total: 0, byKind: {}, last: null };
  for (const line of readLog('provider')) {
    if (typeof line.ts !== 'string' || !line.ts.startsWith(prefix) || line.provider === 'mock') continue;
    const kind = line.kind || 'unknown';
    out.total++;
    out.byKind[kind] = (out.byKind[kind] || 0) + 1;
    out.last = line;
  }
  return out;
}

module.exports = {
  estimateTokens, costOf, record, usageFile, readLog, totals, monthTotals, dayTotals, failures,
  budgetState, currentMonth, today
};
