'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

function run(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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

module.exports = { run, repoRoot, hooksDir };
