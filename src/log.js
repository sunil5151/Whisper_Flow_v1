'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { logsDir } = require('./paths');
const { isoLocal } = require('./util');

const MAX_BYTES = 1024 * 1024;

// Append one JSON line to ~/.memo/logs/<name>.jsonl. Never throws.
function log(name, fields) {
  try {
    const dir = logsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.jsonl`);
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch (_) { /* missing file is fine */ }
    fs.appendFileSync(file, JSON.stringify({ ts: isoLocal(), ...fields }) + '\n', 'utf8');
  } catch (_) {
    // Logging must never break a hook or a commit.
  }
}

module.exports = { log, MAX_BYTES };
