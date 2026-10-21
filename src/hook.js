'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { repoRoot, lastCommit, changedFiles } = require('./git');
const { memoryDir, memoHome } = require('./paths');
const { redact } = require('./redact');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isMemoryFile(file) {
  return file === '.memory' || file.startsWith('.memory/');
}

function logHookError(error) {
  try {
    const home = memoHome();
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(path.join(home, 'hook-errors.log'),
      `[${timestamp()}] ${error && error.message ? error.message : String(error)}\n`, 'utf8');
  } catch (_) {
    // Hook failures must never block a commit, including error-log failures.
  }
}

function hook() {
  if (process.env.MEMO_INTERNAL_COMMIT === '1') return;
  try {
    const root = repoRoot(process.cwd());
    const memDir = memoryDir(root);
    if (!fs.existsSync(memDir)) return;

    const commit = lastCommit(root);
    const allFiles = changedFiles(root);
    const files = allFiles.filter((item) => !isMemoryFile(item.file));
    if (allFiles.length > 0 && files.length === 0) return;

    const subject = redact(commit.subject).text;
    const fileSummary = files.length
      ? `Files: ${files.slice(0, 15).map((item) => `${item.file} (+${item.added} -${item.deleted})`).join(', ')}${files.length > 15 ? `, +${files.length - 15} more` : ''}`
      : 'Files: (merge or empty commit)';
    const entry = `\n## ${timestamp()} · commit ${commit.hash}\n${subject}\n${fileSummary}\n`;
    fs.appendFileSync(path.join(memDir, 'progress.md'), entry, 'utf8');
  } catch (error) {
    logHookError(error);
  }
}

module.exports = hook;
