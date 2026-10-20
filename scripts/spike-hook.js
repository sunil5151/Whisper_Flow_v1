#!/usr/bin/env node
'use strict';
// P0 spike only: dump Claude Code hook stdin + transcript tail to ~/.memo/spike/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const raw = Buffer.concat(chunks).toString('utf8');
    const dir = path.join(process.env.MEMO_HOME || path.join(os.homedir(), '.memo'), 'spike');
    fs.mkdirSync(dir, { recursive: true });
    let data;
    try { data = JSON.parse(raw); } catch (_) { data = { _raw: raw }; }
    const event = String(data.hook_event_name || 'unknown').replace(/[^\w-]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${event}-${stamp}.json`), JSON.stringify(data, null, 2) + '\n', 'utf8');
    if (data.transcript_path && fs.existsSync(data.transcript_path)) {
      const lines = fs.readFileSync(data.transcript_path, 'utf8').split(/\r?\n/).filter(Boolean);
      const sid = String(data.session_id || 'nosid').replace(/[^\w-]/g, '_');
      fs.writeFileSync(path.join(dir, `transcript-${sid}.jsonl`), lines.slice(-50).join('\n') + '\n', 'utf8');
    }
  } catch (err) {
    try { process.stderr.write(`spike-hook: ${err.message}\n`); } catch (_) { /* ignore */ }
  }
  process.exit(0);
});
