'use strict';

// `memo migrate` — import old decisions.md / errors.md / next.md as records (source "legacy"),
// move them to .memory/legacy/, render reports. Idempotent via job id "legacy-import".

const fs = require('node:fs');
const path = require('node:path');
const { repoRoot, run: git } = require('./git');
const { memoryDir } = require('./paths');
const records = require('./store/records');
const { parseEntries, report } = require('./brief');
const { isoLocal } = require('./util');

const JOB = 'legacy-import';
const LEGACY_FILES = ['decisions.md', 'errors.md', 'next.md'];

// "## 2026-10-20 14:03 · decision\ntext" → {ts, text}
function parseEntry(block) {
  const [head, ...rest] = block.split(/\r?\n/);
  const m = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(head);
  const d = m ? new Date(m[1].replace(' ', 'T')) : null;
  return { ts: d && !Number.isNaN(d.getTime()) ? isoLocal(d) : null, text: rest.join('\n').trim() };
}

function legacyLines(memDir, now) {
  const lines = [];
  const add = (type, text, status, ts, extra = {}) => {
    if (!text) return;
    const id = records.makeId(type, text, JOB);
    if (lines.some((l) => l.id === id)) return;
    lines.push({ op: 'create', id, type, ts: ts || now, job: JOB, statement: text, status, evidence: [], source: 'legacy', ...extra });
  };
  for (const [file, type, status] of [['decisions.md', 'decision', 'active'], ['errors.md', 'error', 'observed']]) {
    // parseEntries returns newest first; import oldest first so the op-log reads in order.
    for (const block of parseEntries(path.join(memDir, file)).reverse()) {
      const { ts, text } = parseEntry(block);
      add(type, text, status, ts);
    }
  }
  const nextPath = path.join(memDir, 'next.md');
  if (fs.existsSync(nextPath)) {
    for (const l of fs.readFileSync(nextPath, 'utf8').split(/\r?\n/)) {
      const m = /^- \[( |x|X)\] (.+)$/.exec(l);
      if (!m) continue;
      const text = m[2].trim();
      add('task', text, m[1] === ' ' ? 'open' : 'done', null, { title: text, priority: 'unranked' });
    }
  }
  return lines;
}

function isTracked(root, rel) {
  try { git(['ls-files', '--error-unmatch', '--', rel], root); return true; } catch (_) { return false; }
}

function moveToLegacy(root, name) {
  const memDir = memoryDir(root);
  const from = path.join(memDir, name);
  if (!fs.existsSync(from)) return null;
  const legacyDir = path.join(memDir, 'legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  let to = path.join(legacyDir, name);
  if (fs.existsSync(to)) to = path.join(legacyDir, name.replace(/\.md$/, `-${Date.now()}.md`));
  const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
  if (isTracked(root, rel(from))) git(['mv', '--', rel(from), rel(to)], root);
  else fs.renameSync(from, to);
  return rel(to);
}

function migrate(root, { now = isoLocal() } = {}) {
  const memDir = memoryDir(root);
  const result = { imported: 0, moved: [], skipped: false };
  const present = LEGACY_FILES.filter((f) => fs.existsSync(path.join(memDir, f)));
  if (records.hasJob(root, JOB)) result.skipped = true;
  else if (present.length > 0) {
    const lines = legacyLines(memDir, now);
    if (lines.length > 0) records.append(root, lines);
    result.imported = lines.length;
  }
  for (const f of present) {
    const to = moveToLegacy(root, f);
    if (to) result.moved.push(to);
  }
  // BRIEF.md is generated and gitignored: PROJECT_STATE.md replaces it.
  const brief = path.join(memDir, 'BRIEF.md');
  if (fs.existsSync(brief)) fs.unlinkSync(brief);
  if (result.imported > 0 || result.moved.length > 0) report(root);
  return result;
}

function hasLegacy(root) {
  return LEGACY_FILES.some((f) => fs.existsSync(path.join(memoryDir(root), f)));
}

function command() {
  const root = repoRoot(process.cwd());
  if (!fs.existsSync(memoryDir(root))) throw new Error('run `memo init` first');
  const res = migrate(root);
  if (res.imported === 0 && res.moved.length === 0) {
    console.log('nothing to migrate');
    return res;
  }
  console.log(`imported ${res.imported} record(s)${res.skipped ? ' (already imported earlier)' : ''}`);
  for (const m of res.moved) console.log('moved  ' + m);
  return res;
}

module.exports = { migrate, command, hasLegacy, legacyLines, parseEntry, JOB };
