'use strict';

// `memo clear` — plan and apply deletion of captured data (P5).
// Dry run by default: nothing is touched until applyDelete runs.
// Deletion is honest: current files lose the data, older Git commits still hold it.

const fs = require('node:fs');
const path = require('node:path');

const { memoryDir, sessionsDir, stateDir } = require('./paths');
const sessions = require('./store/sessions');
const records = require('./store/records');
const repos = require('./repos');
const brief = require('./brief');
const memoryCommit = require('./gitops/memory-commit');
const { fwd, readJson, writeJsonAtomic, writeFileAtomic, isoLocal } = require('./util');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_ID_RE = /^e-[0-9a-f]{8}$/;
const HISTORY_NOTE =
  'Removed from current files and committed. Older Git commits still contain this data. ' +
  'Copies on GitHub/other clones are not affected. Full erasure needs history rewriting (not done by MEMO).';

function statBytes(file) {
  try { return fs.statSync(file).size; } catch (_) { return null; }
}

function fileEntry(root, abs) {
  const bytes = statBytes(abs);
  if (bytes === null) return null;
  return { path: abs, rel: fwd(path.relative(root, abs)), bytes };
}

function labelOf(rec) {
  const text = String((rec.type === 'task' && rec.title) || rec.statement || '').replace(/\s+/g, ' ').trim();
  return text.length > 90 ? text.slice(0, 89) + '…' : text;
}

// Evidence entries that are captured events (record ids may also appear there).
function eventEvidence(rec) {
  return (Array.isArray(rec.evidence) ? rec.evidence : []).filter((id) => EVENT_ID_RE.test(String(id)));
}

// Split records into "only this target produced it" and "also knows other sources".
function classifyRecords(root, { sids, eventIds }) {
  const sidSet = new Set(sids);
  const only = [];
  const mixed = [];
  for (const rec of records.foldAll(root)) {
    const evHits = eventEvidence(rec).filter((id) => eventIds.has(id));
    const sidHits = (Array.isArray(rec.sessions) ? rec.sessions : []).filter((s) => sidSet.has(s));
    if (evHits.length === 0 && sidHits.length === 0) continue;
    const otherEvidence = eventEvidence(rec).some((id) => !eventIds.has(id));
    const otherSessions = (Array.isArray(rec.sessions) ? rec.sessions : []).some((s) => !sidSet.has(s));
    const entry = { id: rec.id, type: rec.type, label: labelOf(rec), evidence: evHits, sessions: sidHits };
    if (otherEvidence || otherSessions) mixed.push(entry);
    else only.push(entry);
  }
  return { only, mixed };
}

function emptyPlan(scope, target) {
  return {
    scope, target, sids: [], files: [], eventIds: new Set(),
    remove: [], strip: [], warnings: [], bytes: 0, withDerived: false, error: null
  };
}

function addSession(root, plan, entry) {
  plan.sids.push(entry.sid);
  for (const abs of [sessions.sessionFile(root, entry.date, entry.sid), sessions.summaryFile(root, entry.date, entry.sid)]) {
    const f = fileEntry(root, abs);
    if (f) { plan.files.push(f); plan.bytes += f.bytes; }
  }
  for (const id of sessions.readEventIds(sessions.sessionFile(root, entry.date, entry.sid))) plan.eventIds.add(id);
}

/**
 * Build a deletion plan. Nothing is written.
 * @param {string} root repo root
 * @param {object} opts {scope, value, withDerived}
 */
function planDelete(root, { scope, value, withDerived = false } = {}) {
  const plan = emptyPlan(scope, value);
  plan.withDerived = Boolean(withDerived);

  if (scope === 'session') {
    const found = sessions.resolveSid(root, String(value || ''));
    if (found.error) { plan.error = found.error; return plan; }
    plan.target = found.entry.sid;
    addSession(root, plan, found.entry);
  } else if (scope === 'date') {
    if (!DATE_RE.test(String(value || ''))) { plan.error = 'date must be YYYY-MM-DD'; return plan; }
    const list = sessions.liveEntries(root).filter((e) => e.date === value);
    if (list.length === 0) { plan.error = 'no sessions on ' + value; return plan; }
    for (const entry of list) addSession(root, plan, entry);
  } else if (scope === 'record') {
    const rec = records.byId(root).get(String(value || ''));
    if (!rec) { plan.error = 'no record with id ' + value; return plan; }
    plan.remove.push({ id: rec.id, type: rec.type, label: labelOf(rec), evidence: [], sessions: [] });
    plan.withDerived = true;
    return plan;
  } else if (scope === 'all-repo-data') {
    for (const entry of sessions.liveEntries(root)) addSession(root, plan, entry);
    for (const type of records.TYPE_NAMES) {
      const f = fileEntry(root, records.filePath(root, type));
      if (f) { plan.files.push(f); plan.bytes += f.bytes; }
    }
    const idx = fileEntry(root, sessions.indexPath(root));
    if (idx) { plan.files.push(idx); plan.bytes += idx.bytes; }
    plan.remove = records.foldAll(root).map((r) => ({ id: r.id, type: r.type, label: labelOf(r), evidence: [], sessions: [] }));
    plan.withDerived = true;
    plan.warnings.push('legacy/ notes and progress.md are kept');
    return plan;
  } else {
    plan.error = 'unknown scope: ' + scope;
    return plan;
  }

  const { only, mixed } = classifyRecords(root, { sids: plan.sids, eventIds: plan.eventIds });
  if (plan.withDerived) {
    plan.remove = only;
    plan.strip = mixed;
  } else {
    plan.strip = only.concat(mixed);
    if (only.length > 0) plan.warnings.push(only.length + ' record(s) come only from this data — add --with-derived to delete them too');
  }
  if (plan.files.length === 0) plan.warnings.push('no session files found on disk (index entry only)');
  return plan;
}

function renderPlan(plan) {
  const lines = ['clear ' + plan.scope + ' ' + (plan.target || '') + (plan.withDerived ? '  --with-derived' : '')];
  if (plan.error) return lines.concat(['! ' + plan.error]).join('\n') + '\n';
  lines.push('sessions  ' + (plan.sids.length ? plan.sids.map((s) => s.slice(0, 8)).join(', ') : '(none)'));
  lines.push('files     ' + plan.files.length + ' · ' + Math.round(plan.bytes / 1024) + ' KB');
  for (const f of plan.files.slice(0, 20)) lines.push('  - ' + f.rel + '  (' + f.bytes + ' B)');
  if (plan.files.length > 20) lines.push('  … ' + (plan.files.length - 20) + ' more');
  lines.push('records deleted  ' + plan.remove.length);
  for (const r of plan.remove.slice(0, 20)) lines.push('  - ' + r.id + ' ' + r.type + ' · ' + r.label);
  if (plan.remove.length > 20) lines.push('  … ' + (plan.remove.length - 20) + ' more');
  lines.push('records kept, evidence stripped  ' + plan.strip.length);
  for (const r of plan.strip.slice(0, 20)) {
    lines.push('  - ' + r.id + ' ' + r.type + ' · ' + r.label +
      (r.evidence.length ? ' · drops ' + r.evidence.join(', ') : ''));
  }
  if (plan.strip.length > 20) lines.push('  … ' + (plan.strip.length - 20) + ' more');
  for (const w of plan.warnings) lines.push('note: ' + w);
  return lines.join('\n') + '\n';
}

// Rewrite one record op-log without the removed ids and without the dropped evidence.
function rewriteRecordFile(root, type, { removeIds, stripIds, eventIds, sids }) {
  const file = records.filePath(root, type);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  const out = [];
  let changed = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { out.push(line); continue; }
    if (obj && removeIds.has(obj.id)) { changed++; continue; }
    if (obj && stripIds.has(obj.id)) {
      let touched = false;
      for (const field of ['evidence', 'completion_evidence']) {
        if (!Array.isArray(obj[field])) continue;
        const kept = obj[field].filter((id) => !eventIds.has(id));
        if (kept.length !== obj[field].length) { obj[field] = kept; touched = true; }
      }
      if (Array.isArray(obj.sessions)) {
        const kept = obj.sessions.filter((s) => !sids.has(s));
        if (kept.length !== obj.sessions.length) { obj.sessions = kept; touched = true; }
      }
      if (touched) { obj.source_deleted = true; changed++; }
      out.push(JSON.stringify(obj));
      continue;
    }
    out.push(line);
  }
  if (changed === 0) return 0;
  writeFileAtomic(file, out.length ? out.join('\n') + '\n' : '');
  return changed;
}

function dropCursors(root, sids, { all = false } = {}) {
  const repo = repos.find(root);
  if (!repo) return 0;
  const file = path.join(stateDir(repo.id), 'cursors.json');
  if (all) {
    // The index is gone, so nothing would stop a sweep from re-importing every transcript.
    try { fs.rmSync(file, { force: true }); } catch (_) { /* nothing to drop */ }
    return -1;
  }
  let cursors;
  try { cursors = readJson(file, null); } catch (_) { return 0; }
  if (!cursors || typeof cursors !== 'object') return 0;
  let dropped = 0;
  for (const sid of sids) {
    if (cursors[sid]) { delete cursors[sid]; dropped++; }
  }
  if (dropped > 0) writeJsonAtomic(file, cursors);
  return dropped;
}

function rmDirIfEmpty(dir, stopAt) {
  let cur = dir;
  while (cur.startsWith(stopAt) && cur !== stopAt) {
    try {
      if (fs.readdirSync(cur).length > 0) return;
      fs.rmdirSync(cur);
    } catch (_) { return; }
    cur = path.dirname(cur);
  }
}

/**
 * Apply a plan: delete files, tombstone sessions, rewrite records, re-render, commit.
 * @returns {{filesDeleted, recordsDeleted, recordsStripped, commit, note}}
 */
function applyDelete(root, plan, { commit = true, cfg } = {}) {
  if (plan.error) throw new Error(plan.error);
  const when = isoLocal();
  const result = { filesDeleted: 0, recordsDeleted: 0, recordsStripped: 0, commit: null, note: HISTORY_NOTE };

  if (plan.scope === 'all-repo-data') {
    for (const dir of [sessionsDir(root), records.recordsDir(root)]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(sessionsDir(root), { recursive: true });
    sessions.saveIndex(root, []);
    records.ensureDir(root);
    result.filesDeleted = plan.files.length;
    result.recordsDeleted = plan.remove.length;
    dropCursors(root, plan.sids, { all: true });
  } else {
    for (const f of plan.files) {
      try {
        fs.unlinkSync(f.path);
        result.filesDeleted++;
        rmDirIfEmpty(path.dirname(f.path), sessionsDir(root));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    for (const sid of plan.sids) sessions.tombstone(root, sid, when);
    dropCursors(root, plan.sids);

    const removeIds = new Set(plan.remove.map((r) => r.id));
    const stripIds = new Set(plan.strip.map((r) => r.id));
    const types = new Set([...plan.remove, ...plan.strip].map((r) => r.type));
    for (const type of types) {
      rewriteRecordFile(root, type, { removeIds, stripIds, eventIds: plan.eventIds, sids: new Set(plan.sids) });
    }
    result.recordsDeleted = removeIds.size;
    result.recordsStripped = stripIds.size;
  }

  brief.report(root);

  if (commit) {
    const scopeText = plan.scope === 'session' ? 'session ' + String(plan.target).slice(0, 8)
      : plan.scope === 'date' ? String(plan.target)
        : plan.scope === 'record' ? 'record ' + plan.target
          : 'this repo';
    result.commit = memoryCommit.commitMemory(root, {
      ...(cfg ? { cfg } : {}),
      message: 'memo: remove captured session data for ' + scopeText
    });
  }
  return result;
}

const USAGE = 'usage: memo clear --session <sid> | --date <YYYY-MM-DD> | --record <id> | --all-repo-data\n' +
  '                  [--with-derived] [--yes] [--repo <path>] [--no-commit]\n' +
  '       without --yes it is a dry run and nothing changes\n';

function parseArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] || '' : null;
  };
  const scopes = [['--session', 'session'], ['--date', 'date'], ['--record', 'record']]
    .filter(([flag]) => argv.includes(flag));
  if (argv.includes('--all-repo-data')) scopes.push(['--all-repo-data', 'all-repo-data']);
  if (scopes.length !== 1) return { error: USAGE };
  const [flag, scope] = scopes[0];
  return {
    scope,
    value: scope === 'all-repo-data' ? null : value(flag),
    withDerived: argv.includes('--with-derived'),
    yes: argv.includes('--yes'),
    commit: !argv.includes('--no-commit'),
    confirm: value('--confirm'),
    repo: value('--repo')
  };
}

function command(argv = []) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(args.error);
    process.exitCode = 1;
    return null;
  }
  const { repoRoot } = require('./git');
  const root = repoRoot(args.repo ? path.resolve(args.repo) : process.cwd());
  const plan = planDelete(root, { scope: args.scope, value: args.value, withDerived: args.withDerived });
  process.stdout.write(renderPlan(plan));
  if (plan.error) {
    process.exitCode = 1;
    return plan;
  }
  if (!args.yes) {
    process.stdout.write('\ndry run — nothing was deleted. Add --yes to apply.\nWhen applied: ' + HISTORY_NOTE + '\n');
    return plan;
  }
  if (args.scope === 'all-repo-data' && args.confirm !== 'DELETE-ALL-MEMO-DATA') {
    process.stderr.write('\nrefusing: add --confirm DELETE-ALL-MEMO-DATA to wipe sessions and records\n');
    process.exitCode = 1;
    return plan;
  }
  if (args.scope === 'date' && args.confirm !== args.value) {
    process.stderr.write('\nrefusing: a whole date needs --confirm ' + args.value + '\n');
    process.exitCode = 1;
    return plan;
  }
  const res = applyDelete(root, plan, { commit: args.commit });
  process.stdout.write('\ndeleted ' + res.filesDeleted + ' file(s), ' + res.recordsDeleted + ' record(s), ' +
    res.recordsStripped + ' record(s) kept with evidence stripped\n');
  if (res.commit) {
    process.stdout.write('commit: ' + res.commit.status + (res.commit.hash ? ' ' + res.commit.hash : '') + '\n');
  }
  process.stdout.write(res.note + '\n');
  return res;
}

module.exports = {
  planDelete, renderPlan, applyDelete, classifyRecords, rewriteRecordFile, command, parseArgs,
  HISTORY_NOTE, DATE_RE, USAGE
};
