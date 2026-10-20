'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { repoRoot } = require('./git');
const { memoryDir, memoHome } = require('./paths');
const { redact } = require('./redact');
const { buildBrief } = require('./brief');

function pad(n) { return String(n).padStart(2, '0'); }
function getLocalTimestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function refreshBrief(root) {
  const memDir = memoryDir(root);
  if (!fs.existsSync(memDir)) return;
  fs.writeFileSync(path.join(memDir, 'BRIEF.md'), buildBrief(root), 'utf8');
}

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
    try {
      const root = repoRoot(process.cwd());
      refreshBrief(root);
    } catch (_) { /* Personal notes are valid outside a Git repository. */ }
    return;
  }

  const validTypes = ['decision', 'error', 'next'];
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
  if (type === 'decision' || type === 'error') {
    const filename = `${type}s.md`;
    fs.appendFileSync(path.join(memDir, filename), `\n## ${getLocalTimestamp()} · ${type}\n${text}\n`, 'utf8');
    console.log(`Saved → .memory/${filename}`);
  } else {
    fs.appendFileSync(path.join(memDir, 'next.md'), `- [ ] ${text}\n`, 'utf8');
    console.log('Saved → .memory/next.md');
  }
  if (count > 0) console.log(`⚠ ${count} secret(s) redacted`);
  refreshBrief(root);
}

module.exports = run;
