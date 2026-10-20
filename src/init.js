'use strict';

const fs = require('fs');
const path = require('path');
const { repoRoot, hooksDir } = require('./git');
const { memoryDir, memoBin } = require('./paths');

const MEMORY_FILES = {
  'progress.md': '# Progress\n\n(auto-written by the post-commit hook)\n',
  'decisions.md': '# Decisions\n',
  'errors.md': '# Errors\n',
  'next.md': '# Next\n'
};

const AGENTS_LINE = 'Read .memory/BRIEF.md before starting.';
const GITIGNORE_LINE = '.memory/BRIEF.md';
const HOOK_MARK = '# memo-hook';

function createOnly(filePath, content) {
  if (fs.existsSync(filePath)) return 'skipped';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return 'created';
}

function appendLineIfAbsent(filePath, line) {
  let existing = '';
  if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf8');
  if (existing.split(/\r?\n/).includes(line)) return 'skipped';
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, prefix + line + '\n', 'utf8');
  return 'created';
}

function hookContent() {
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'post-commit'),
    'utf8'
  );
  const fwd = (p) => p.replace(/\\/g, '/');
  return template
    .replace(/\r\n?/g, '\n')
    .replace('{{NODE}}', fwd(process.execPath))
    .replace('{{MEMO}}', fwd(memoBin()));
}

function installHook(root) {
  const hookPath = path.join(hooksDir(root), 'post-commit');
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (existing.includes(HOOK_MARK)) return 'skipped';
    const normalized = existing.replace(/\r\n?/g, '\n');
    const sep = normalized.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(hookPath, normalized + sep + hookContent(), 'utf8');
    return 'created';
  }
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, hookContent(), { encoding: 'utf8', mode: 0o755 });
  return 'created';
}

function init() {
  const root = repoRoot(process.cwd());
  const report = [];

  for (const [name, content] of Object.entries(MEMORY_FILES)) {
    const status = createOnly(path.join(memoryDir(root), name), content);
    report.push([status, `.memory/${name}`]);
  }

  const agentsPath = path.join(root, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, AGENTS_LINE + '\n', 'utf8');
    report.push(['created', 'AGENTS.md']);
  } else {
    report.push([appendLineIfAbsent(agentsPath, AGENTS_LINE), 'AGENTS.md']);
  }

  report.push([appendLineIfAbsent(path.join(root, '.gitignore'), GITIGNORE_LINE), '.gitignore']);

  report.push([installHook(root), 'post-commit hook']);

  for (const [status, name] of report) {
    console.log(`${status}  ${name}`);
  }
}

module.exports = init;
