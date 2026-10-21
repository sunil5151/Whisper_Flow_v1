'use strict';

// .memory/records/<file>.jsonl — append-only op-log per record type (§6.2).
// Current state = fold lines by id in file order; `delete` removes.

const fs = require('node:fs');
const path = require('node:path');
const { memoryDir } = require('../paths');
const { sha1 } = require('../util');

// type → { prefix, file, statuses, terminal }
const TYPES = {
  decision: {
    prefix: 'D',
    file: 'decisions.jsonl',
    statuses: ['proposed', 'active', 'superseded', 'rejected'],
    terminal: ['superseded', 'rejected'],
    default: 'active'
  },
  error: {
    prefix: 'E',
    file: 'errors.jsonl',
    statuses: ['observed', 'investigating', 'attempted', 'resolved_unverified', 'verified', 'reopened'],
    terminal: ['verified'],
    default: 'observed'
  },
  learning: {
    prefix: 'L',
    file: 'learnings.jsonl',
    statuses: ['active', 'unverified', 'superseded'],
    terminal: ['superseded'],
    default: 'active'
  },
  fact: {
    prefix: 'F',
    file: 'facts.jsonl',
    statuses: ['active', 'unverified', 'superseded'],
    terminal: ['superseded'],
    default: 'active'
  },
  task: {
    prefix: 'T',
    file: 'tasks.jsonl',
    statuses: ['open', 'in_progress', 'blocked', 'implemented_unverified', 'verified', 'done', 'cancelled', 'superseded'],
    terminal: ['done', 'cancelled', 'superseded'],
    default: 'open'
  },
  question: {
    prefix: 'Q',
    file: 'questions.jsonl',
    statuses: ['open', 'answered'],
    terminal: ['answered'],
    default: 'open'
  },
  intent: {
    prefix: 'I',
    file: 'intent.jsonl',
    statuses: ['active', 'historical'],
    terminal: ['historical'],
    default: 'active'
  }
};

const TYPE_NAMES = Object.keys(TYPES);
const OPS = ['create', 'update', 'delete'];
const PRIORITIES = ['high', 'normal', 'low', 'unranked'];
const CAPABILITIES = ['low', 'medium', 'high'];
const CONFIDENCES = ['high', 'medium', 'low'];

// Fields a record line may carry (§6.2). Anything else is dropped by the validator.
const COMMON_FIELDS = ['statement', 'rationale', 'status', 'confidence', 'evidence', 'sessions', 'files',
  'supersedes', 'related', 'conflict_with', 'downgraded', 'source'];
const TASK_FIELDS = ['title', 'priority', 'effort_estimate', 'effort_basis', 'capability', 'capability_reason',
  'blockers', 'completion_evidence', 'auto_exec'];

function recordsDir(root) {
  return path.join(memoryDir(root), 'records');
}

function typeInfo(type) {
  return TYPES[type] || null;
}

function filePath(root, type) {
  const info = typeInfo(type);
  if (!info) throw new Error('unknown record type: ' + type);
  return path.join(recordsDir(root), info.file);
}

function normStatement(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ID = type prefix + "-" + 8 hex of sha1(type + normalized statement + first evidence id).
function makeId(type, statement, firstEvidence) {
  const info = typeInfo(type);
  if (!info) throw new Error('unknown record type: ' + type);
  return info.prefix + '-' + sha1(type + normStatement(statement) + String(firstEvidence || '')).slice(0, 8);
}

function readLines(root, type) {
  let raw;
  try { raw = fs.readFileSync(filePath(root, type), 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* torn line ignored */ }
  }
  return out;
}

// Fold one type's op-log into current records, in file order (last op wins).
function fold(root, type) {
  const byId = new Map();
  for (const line of readLines(root, type)) {
    if (!line || typeof line !== 'object' || typeof line.id !== 'string') continue;
    if (line.op === 'delete') { byId.delete(line.id); continue; }
    const prev = byId.get(line.id);
    const merged = prev ? { ...prev, ...line } : { ...line };
    delete merged.op;
    merged.type = line.type || (prev && prev.type) || type;
    byId.set(line.id, merged);
  }
  return byId;
}

function foldAll(root) {
  const out = [];
  for (const type of TYPE_NAMES) {
    for (const rec of fold(root, type).values()) out.push(rec);
  }
  return out;
}

function isTerminal(rec) {
  const info = typeInfo(rec && rec.type);
  if (!info) return false;
  return info.terminal.includes(rec.status);
}

// Records still worth showing to the model: non-terminal status, newest first.
function openRecords(root, limit = 60) {
  const recs = foldAll(root).filter((r) => !isTerminal(r));
  recs.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return recs.slice(0, limit);
}

// id → {type, status, statement} for every record, terminal ones included.
function byId(root) {
  const map = new Map();
  for (const rec of foldAll(root)) map.set(rec.id, rec);
  return map;
}

// True if any record line already carries this job id — the job was applied before.
function hasJob(root, job) {
  if (!job) return false;
  for (const type of TYPE_NAMES) {
    for (const line of readLines(root, type)) {
      if (line && line.job === job) return true;
    }
  }
  return false;
}

// Append complete op lines, grouped per type file, and fsync each file.
function append(root, lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!line || !typeInfo(line.type)) throw new Error('record line needs a known type');
    if (!OPS.includes(line.op)) throw new Error('record line needs op create|update|delete');
    if (!groups.has(line.type)) groups.set(line.type, []);
    groups.get(line.type).push(line);
  }
  for (const [type, group] of groups) {
    const file = filePath(root, type);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = group.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, data, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  return lines.length;
}

function ensureDir(root) {
  fs.mkdirSync(recordsDir(root), { recursive: true });
  return recordsDir(root);
}

module.exports = {
  TYPES, TYPE_NAMES, OPS, PRIORITIES, CAPABILITIES, CONFIDENCES, COMMON_FIELDS, TASK_FIELDS,
  recordsDir, typeInfo, filePath, normStatement, makeId, readLines, fold, foldAll,
  isTerminal, openRecords, byId, hasJob, append, ensureDir
};
