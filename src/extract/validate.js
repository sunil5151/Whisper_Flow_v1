'use strict';

// Strict validator + downgrade rules (§6.3). The model proposes; this file decides.
// Nothing here executes model output, uses it as a path, or lets it change config.

const records = require('../store/records');

const MAX_ITEMS = 25;
const MAX_STRING = 500;
const MAX_SUMMARY = 600;
const MAX_LIST = 20;

// Statuses that need a passing tool_result, and what they fall back to (rule 5).
const DOWNGRADE = {
  error: { verified: 'resolved_unverified' },
  task: { verified: 'implemented_unverified', done: 'implemented_unverified' }
};

function str(value, max = MAX_STRING) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, max);
}

function strList(value, max = MAX_LIST) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const s = str(item);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// Rule 7: repo-relative, no "..", no drive letter, no leading slash.
function cleanFile(value) {
  const s = str(value, 300);
  if (!s) return null;
  const p = s.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..') || p === '<outside-repo>') return null;
  return p;
}

function cleanFiles(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const p = cleanFile(item);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

function parse(text) {
  if (typeof text !== 'string') return { ok: false, error: 'response was not text' };
  let body = text.trim();
  // Tolerate a fenced block even though the prompt forbids one.
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1].trim();
  if (!body) return { ok: false, error: 'empty response' };
  // Tolerate leading/trailing prose around a single JSON object.
  if (!body.startsWith('{')) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) return { ok: false, error: 'no JSON object in response' };
    body = body.slice(start, end + 1);
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'top level JSON must be an object' };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * @param {string|object} response  raw provider text, or an already-parsed object
 * @param {object} ctx { eventIds: Set<string>, events: object[], existing: Map<id, record> }
 * @returns {{ok, error?, summary, items, dropped, notes, gaps}}
 */
function validate(response, ctx = {}) {
  const eventIds = ctx.eventIds instanceof Set ? ctx.eventIds : new Set(ctx.eventIds || []);
  const events = new Map((ctx.events || []).map((e) => [e.id, e]));
  const existing = ctx.existing instanceof Map ? ctx.existing : new Map();

  let body = response;
  if (typeof response === 'string') {
    const parsed = parse(response);
    if (!parsed.ok) return { ok: false, error: parsed.error, summary: '', items: [], dropped: [], notes: [], gaps: [] };
    body = parsed.value;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'top level JSON must be an object', summary: '', items: [], dropped: [], notes: [], gaps: [] };
  }

  const dropped = [];
  const notes = [];
  const items = [];
  const summary = str(body.session_summary, MAX_SUMMARY) || '';
  const gaps = strList(body.gaps, 10);
  const rawItems = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  if (Array.isArray(body.items) && body.items.length > MAX_ITEMS) {
    notes.push('items truncated to ' + MAX_ITEMS);
  }

  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const drop = (reason) => dropped.push({ index: i, reason });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { drop('not an object'); continue; }

    const op = raw.op === 'update' ? 'update' : raw.op === 'create' ? 'create' : null;
    if (!op) { drop('op must be create or update'); continue; } // delete only comes from `memo clear`

    // Rule 3: evidence must point at this batch or at a known record.
    const evidence = [];
    for (const id of strList(raw.evidence, MAX_LIST)) {
      if (eventIds.has(id) || existing.has(id)) evidence.push(id);
    }
    if (evidence.length === 0) { drop('no usable evidence id'); continue; }

    let type;
    let id = null;
    if (op === 'update') {
      id = str(raw.id, 64);
      if (!id) { drop('update without id'); continue; }
      const prev = existing.get(id);
      if (!prev) { drop('update id does not exist: ' + id); continue; } // rule 4
      const claimed = str(raw.type, 40);
      if (claimed && claimed !== prev.type) { drop('update type mismatch for ' + id); continue; }
      type = prev.type;
    } else {
      type = str(raw.type, 40);
      if (!records.typeInfo(type)) { drop('unknown type: ' + raw.type); continue; }
    }
    const info = records.typeInfo(type);
    if (!info) { drop('unknown type: ' + type); continue; }

    const item = { op, type, evidence };
    if (id) item.id = id;

    // Status: enforce the enum; a create may fall back to the type default.
    let status = str(raw.status, 40);
    if (status && !info.statuses.includes(status)) {
      if (op === 'update') { drop('invalid status for ' + type + ': ' + status); continue; }
      notes.push('status "' + status + '" invalid for ' + type + ' → ' + info.default);
      status = null;
    }
    if (!status) {
      if (op === 'update') { drop('update without a usable status'); continue; }
      status = info.default;
    }

    // Rule 5: verified/done need a passing tool_result in this item's evidence.
    const proven = evidence.some((eid) => {
      const event = events.get(eid);
      return event && event.type === 'tool_result' && event.ok === true;
    });
    const fallback = DOWNGRADE[type] && DOWNGRADE[type][status];
    if (fallback && !proven) {
      status = fallback;
      item.downgraded = true;
    }
    item.status = status;

    // Rule 6: intent needs user_prompt evidence.
    if (type === 'intent') {
      const fromPrompt = evidence.some((eid) => {
        const event = events.get(eid);
        return event && event.type === 'user_prompt';
      });
      if (!fromPrompt) { drop('intent without user_prompt evidence'); continue; }
    }

    const statement = str(raw.statement) || (type === 'task' ? str(raw.title) : null);
    if (op === 'create' && !statement) { drop('create without statement'); continue; }
    if (statement) item.statement = statement;

    const rationale = str(raw.rationale);
    if (rationale) item.rationale = rationale;
    const confidence = str(raw.confidence, 20);
    if (confidence && records.CONFIDENCES.includes(confidence)) item.confidence = confidence;
    const files = cleanFiles(raw.files);
    if (files.length > 0) item.files = files;
    const supersedes = str(raw.supersedes, 64);
    if (supersedes && existing.has(supersedes)) item.supersedes = supersedes;
    for (const key of ['related', 'conflict_with']) {
      const list = strList(raw[key], MAX_LIST).filter((rid) => existing.has(rid));
      if (list.length > 0) item[key] = list;
    }

    if (type === 'task') {
      const title = str(raw.title, 200) || statement;
      if (title) item.title = title;
      const priority = str(raw.priority, 20);
      item.priority = priority && records.PRIORITIES.includes(priority) ? priority : 'unranked';
      const effort = str(raw.effort_estimate, 40);
      if (effort) {
        item.effort_estimate = effort;
        item.effort_basis = 'estimated';
      }
      const capability = str(raw.capability, 20);
      if (capability && records.CAPABILITIES.includes(capability)) item.capability = capability;
      const reason = str(raw.capability_reason);
      if (reason) item.capability_reason = reason;
      const blockers = strList(raw.blockers, 10);
      if (blockers.length > 0) item.blockers = blockers;
      const completion = strList(raw.completion_evidence, 10).filter((eid) => eventIds.has(eid) || existing.has(eid));
      if (completion.length > 0) item.completion_evidence = completion;
      // The model never gets to arm task execution.
      item.auto_exec = false;
    }

    items.push(item);
  }

  return { ok: true, summary, items, dropped, notes, gaps };
}

module.exports = { validate, parse, MAX_ITEMS, MAX_STRING, MAX_SUMMARY, DOWNGRADE, cleanFile };
