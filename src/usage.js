'use strict';

// Token/cost accounting: ~/.memo/logs/usage.jsonl + monthly budget check (§6.4, §10.4).

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

// One line per provider call: {ts, repoId, job, model, in, out, costEst}.
function record(entry) {
  log('usage', {
    repoId: entry.repoId || null,
    job: entry.job || null,
    model: entry.model || null,
    in: Number(entry.in) || 0,
    out: Number(entry.out) || 0,
    costEst: entry.costEst === null || entry.costEst === undefined ? null : Number(entry.costEst)
  });
}

function readLines() {
  const out = [];
  // log.js rotates to <file>.1 at 1 MB; read it too so a month total is not cut short.
  for (const file of [usageFile() + '.1', usageFile()]) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* torn line ignored */ }
    }
  }
  return out;
}

function currentMonth() {
  return isoLocal().slice(0, 7);
}

// Totals for a local YYYY-MM month. costKnown is false if any call had no price.
function monthTotals(month = currentMonth()) {
  const totals = { month, calls: 0, input: 0, output: 0, costUsd: 0, costKnown: true };
  for (const line of readLines()) {
    if (typeof line.ts !== 'string' || line.ts.slice(0, 7) !== month) continue;
    if (line.model === undefined && line.in === undefined) continue;
    totals.calls++;
    totals.input += Number(line.in) || 0;
    totals.output += Number(line.out) || 0;
    if (line.costEst === null || line.costEst === undefined) totals.costKnown = false;
    else totals.costUsd += Number(line.costEst) || 0;
  }
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  return totals;
}

// Plan §P2 step 1: stop before a call when this month already reached the budget.
function budgetState(cfg, month = currentMonth()) {
  const totals = monthTotals(month);
  const limit = Number(cfg.monthlyBudgetUsd);
  const reached = Number.isFinite(limit) && limit >= 0 && totals.costUsd >= limit;
  return { reached, limit, ...totals };
}

module.exports = { estimateTokens, costOf, record, usageFile, monthTotals, budgetState, currentMonth };
