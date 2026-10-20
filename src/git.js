'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

function run(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repoRoot(cwd) {
  try {
    return run(['rev-parse', '--show-toplevel'], cwd);
  } catch (err) {
    throw new Error('Not inside a git repo');
  }
}

function hooksDir(root) {
  const p = run(['rev-parse', '--git-path', 'hooks'], root);
  return path.resolve(root, p);
}

function lastCommit(root) {
  const output = run(['log', '-1', '--format=%h%x1f%s'], root);
  const separator = output.indexOf('\x1f');
  if (separator === -1) throw new Error('Unable to read last commit');
  return { hash: output.slice(0, separator), subject: output.slice(separator + 1) };
}

function changedFiles(root) {
  const output = run([
    'diff-tree', '--root', '--no-commit-id', '--numstat', '-r', 'HEAD'
  ], root);
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split('\t');
    if (parts.length < 3) return null;
    return { added: parts[0], deleted: parts[1], file: parts.slice(2).join('\t') };
  }).filter(Boolean);
}

module.exports = { run, repoRoot, hooksDir, lastCommit, changedFiles };
