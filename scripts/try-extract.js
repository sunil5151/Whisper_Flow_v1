#!/usr/bin/env node
'use strict';

// One live extraction call against a captured-transcript fixture. Opt-in only:
//   MEMO_LIVE=1 node scripts/try-extract.js error-then-fix
// Costs money. Not part of `npm test`, never called by the worker.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../src/config');
const { normalize } = require('../src/capture/claude');
const prompt = require('../src/extract/prompt');
const { validate } = require('../src/extract/validate');
const providerFactory = require('../src/llm/provider');
const { MAX_OUTPUT_TOKENS } = require('../src/extract/process');
const usage = require('../src/usage');

function fixturePath(name) {
  if (fs.existsSync(name)) return name;
  const file = path.join(__dirname, '..', 'test', 'fixtures', 'claude', name.endsWith('.jsonl') ? name : name + '.jsonl');
  if (!fs.existsSync(file)) throw new Error('fixture not found: ' + name);
  return file;
}

function eventsFrom(file) {
  const root = path.resolve(__dirname, '..');
  const ctx = { sid: 'live-try', root, cwd: root, home: os.homedir(), tools: {}, denyPaths: config.load().denyPaths };
  const out = [];
  let seq = 0;
  let lineNo = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    lineNo++;
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    ctx.lineNo = lineNo;
    ctx.raw = line;
    for (const env of normalize(obj, ctx)) out.push({ ...env, seq: ++seq });
  }
  return out;
}

async function main() {
  const name = process.argv[2];
  if (!name) {
    process.stderr.write('usage: MEMO_LIVE=1 node scripts/try-extract.js <fixture>\n');
    process.exit(1);
  }
  if (process.env.MEMO_LIVE !== '1') {
    process.stderr.write('refusing to call the API: set MEMO_LIVE=1 to allow one live call\n');
    process.exit(1);
  }
  const cfg = config.load();
  if (!config.apiKey(cfg)) {
    process.stderr.write('no API key in env ' + config.keyEnvName(cfg) + '\n');
    process.exit(1);
  }

  const events = eventsFrom(fixturePath(name));
  const built = prompt.build({ repo: 'memo', openRecords: [], events, denyPaths: cfg.denyPaths });
  console.log('provider ' + cfg.provider + ' · model ' + cfg.model);
  console.log('events ' + events.length + ' · estimated input tokens ' + built.inputTokens);

  const llm = providerFactory.create(cfg);
  const started = Date.now();
  const response = await llm.complete({ system: built.system, user: built.user, maxTokens: MAX_OUTPUT_TOKENS });
  const cost = usage.costOf(cfg, response.model, response.usage.input, response.usage.output);
  console.log('--- usage ---');
  console.log('model ' + response.model + ' · in ' + response.usage.input + ' · out ' + response.usage.output +
    ' · cost ' + (cost === null ? 'unknown' : '$' + cost.toFixed(6)) + ' · ' + (Date.now() - started) + ' ms');

  const checked = validate(response.text, { eventIds: built.eventIds, events: built.events, existing: new Map() });
  console.log('--- validated ---');
  console.log(JSON.stringify({
    ok: checked.ok,
    error: checked.error,
    summary: checked.summary,
    items: checked.items,
    dropped: checked.dropped,
    notes: checked.notes,
    gaps: checked.gaps
  }, null, 2));
}

main().catch((err) => {
  console.error('try-extract failed: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
