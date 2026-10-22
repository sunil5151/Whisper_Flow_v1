'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { repoRoot } = require('./git');
const { memoryDir, memoHome } = require('./paths');
const { redact } = require('./redact');
const { report } = require('./brief');
const records = require('./store/records');
const { isoLocal } = require('./util');

// note type → record type and initial status
const NOTE_TYPES = { decision: ['decision', 'active'], error: ['error', 'observed'], next: ['task', 'open'] };

function run(argv) {
  let type = null;
  let isPersonal = false;
  const textParts = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-t' || arg === '--type') { type = argv[i + 1]; i++; }
    else if (arg === '--personal') isPersonal = true;
    else textParts.push(arg);
  }
  const rawText = textParts.join(' ').trim();

  if (isPersonal) {
    if (!rawText) {
      console.error('Error: missing text for personal note');
      process.exitCode = 1;
      return;
    }
    const { text, count } = redact(rawText);
    const home = memoHome();
    fs.mkdirSync(home, { recursive: true });
    const personalPath = path.join(home, 'personal.md');
    if (!fs.existsSync(personalPath)) fs.writeFileSync(personalPath, '# About me\n', 'utf8');
    const line = `- ${text}`;
    const existing = fs.readFileSync(personalPath, 'utf8').split(/\r?\n/);
    if (existing.includes(line)) {
      console.log('Already saved');
      return;
    }
    fs.appendFileSync(personalPath, `${line}\n`, 'utf8');
    console.log('Saved → ~/.memo/personal.md');
    if (count > 0) console.log(`⚠ ${count} secret(s) redacted`);
    return;
  }

  const validTypes = Object.keys(NOTE_TYPES);
  if (!type || !validTypes.includes(type) || !rawText) {
    console.error('Error: usage: memo note -t <decision|error|next> <text...>');
    console.error(`Valid types: ${validTypes.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  let root;
  try { root = repoRoot(process.cwd()); }
  catch (_) {
    console.error('Error: Run "memo init" first');
    process.exitCode = 1;
    return;
  }
  const memDir = memoryDir(root);
  if (!fs.existsSync(memDir)) {
    console.error('Error: Run "memo init" first');
    process.exitCode = 1;
    return;
  }

  const { text, count } = redact(rawText);
  const [recType, status] = NOTE_TYPES[type];
  const id = records.makeId(recType, text, 'manual');
  if (records.byId(root).has(id)) {
    console.log(`Already saved (${id})`);
    return;
  }
  const line = { op: 'create', id, type: recType, ts: isoLocal(), statement: text, status, evidence: [], source: 'manual' };
  if (recType === 'task') Object.assign(line, { title: text, priority: 'unranked' });
  records.append(root, [line]);
  console.log(`Saved → .memory/records/${records.typeInfo(recType).file} (${id})`);
  if (count > 0) console.log(`⚠ ${count} secret(s) redacted`);
  report(root);
}

module.exports = run;
