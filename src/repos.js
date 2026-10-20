'use strict';

const path = require('node:path');
const { memoHome } = require('./paths');
const { sha1, fwd, readJson, writeJsonAtomic, isoLocal } = require('./util');

function registryPath() {
  return path.join(memoHome(), 'repos.json');
}

// Comparable form of a repo root: forward slashes, no trailing slash,
// case-insensitive for Windows drive paths.
function normRoot(root) {
  let p = fwd(path.resolve(root)).replace(/\/+$/, '');
  if (process.platform === 'win32' || /^[A-Za-z]:\//.test(p)) p = p.toLowerCase();
  return p;
}

function repoId(root) {
  const slug = path.basename(path.resolve(root)).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'repo';
  return `${slug}-${sha1(normRoot(root)).slice(0, 8)}`;
}

function load() {
  const list = readJson(registryPath(), []);
  return Array.isArray(list) ? list : [];
}

function find(root) {
  const key = normRoot(root);
  return load().find((r) => normRoot(r.root) === key) || null;
}

function register(root) {
  const list = load();
  const key = normRoot(root);
  const existing = list.find((r) => normRoot(r.root) === key);
  if (existing) return { status: 'skipped', repo: existing };
  const repo = { id: repoId(root), root: fwd(path.resolve(root)), addedAt: isoLocal(), enabled: true };
  list.push(repo);
  writeJsonAtomic(registryPath(), list);
  return { status: 'created', repo };
}

module.exports = { registryPath, normRoot, repoId, load, find, register };
