'use strict';

const fs = require('fs');
const path = require('path');
const { repoRoot } = require('./git');
const { memoryDir, memoHome } = require('./paths');

const MAX_LINES = 150;

function pad(n) {
  return String(n).padStart(2, '0');
}

function getLocalTimestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split(/(?=^## )/gm)
    .map(p => p.trim())
    .filter(p => p.startsWith('## '))
    .reverse();
}

function readAboutMe() {
  const personalPath = path.join(memoHome(), 'personal.md');
  if (!fs.existsSync(personalPath)) return [];
  return fs.readFileSync(personalPath, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '' && !l.startsWith('# '))
    .slice(0, 20);
}

function readOpenNext(memDir) {
  const nextPath = path.join(memDir, 'next.md');
  if (!fs.existsSync(nextPath)) return [];
  return fs.readFileSync(nextPath, 'utf8')
    .split('\n')
    .filter(l => l.startsWith('- [ ] '));
}

function buildBrief(root) {
  const memDir = memoryDir(root);
  const repoName = path.basename(root);
  const timestamp = getLocalTimestamp();
  const aboutMe = readAboutMe();

  const commits = parseEntries(path.join(memDir, 'progress.md')).slice(0, 10);
  const decisions = parseEntries(path.join(memDir, 'decisions.md')).slice(0, 10);
  const errors = parseEntries(path.join(memDir, 'errors.md')).slice(0, 5);
  const next = readOpenNext(memDir);

  function section(title, items, sep) {
    return [`## ${title}`, items.length > 0 ? items.join(sep) : '(none yet)', ''];
  }

  function assemble() {
    const lines = [
      `# BRIEF — ${repoName}`,
      `Generated ${timestamp} by memo. Do not edit; run \`memo brief\`.`,
      '',
    ];
    if (aboutMe.length > 0) lines.push('## About me', ...aboutMe, '');
    lines.push(...section('Open next steps', next, '\n'));
    lines.push(...section('Recent decisions (last 10)', decisions, '\n\n'));
    lines.push(...section('Recent errors (last 5)', errors, '\n\n'));
    lines.push(...section('Recent commits (last 10)', commits, '\n\n'));
    return lines.join('\n').trimEnd() + '\n';
  }

  let text = assemble();
  while (text.split('\n').length - 1 > MAX_LINES) {
    if (commits.length > 0) commits.pop();
    else if (decisions.length > 0) decisions.pop();
    else if (errors.length > 0) errors.pop();
    else if (next.length > 1) next.pop();
    else if (next.length === 1 && next[0] !== '…truncated in next.md') next[0] = '…truncated in next.md';
    else break;
    text = assemble();
  }
  return text;
}

function command() {
  let root;
  try {
    root = repoRoot(process.cwd());
  } catch (err) {
    console.error('Error: Run "memo init" first');
    process.exit(1);
  }

  const memDir = memoryDir(root);
  if (!fs.existsSync(memDir)) {
    console.error('Error: Run "memo init" first');
    process.exit(1);
  }

  const content = buildBrief(root);
  fs.writeFileSync(path.join(memDir, 'BRIEF.md'), content, 'utf8');
  console.log(`BRIEF.md written (${content.split('\n').length - 1} lines)`);
}

module.exports = { buildBrief, command };
