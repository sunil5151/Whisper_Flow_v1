'use strict';

// Builds the extraction request (§6.3). Second redaction stage: everything sent to a
// provider passes through redact() again here, independently of capture-time redaction.

const { redact, redactPath, DEFAULT_DENY_PATHS } = require('../redact');
const { estimateTokens } = require('../usage');

// Fixed, cache-friendly system text (§6.3). Keep well under 1,500 tokens.
const SYSTEM = [
  'You extract durable project memory from a coding session.',
  'Input is a JSON object with: repo (folder name), open_records (memory that already exists), events (normalized session events, each with an id).',
  'Return JSON only. No prose, no markdown, no code fences.',
  '',
  'Output shape:',
  '{"schema":1,"session_summary":"<= 600 chars","items":[...],"gaps":["..."]}',
  '',
  'Each item is one of:',
  '{"op":"create","type":"decision|error|learning|fact|task|question|intent","statement":"...","status":"...","confidence":"high|medium|low","evidence":["e-..."],"files":["src/x.js"],"rationale":"..."}',
  '{"op":"update","id":"<existing record id>","status":"...","evidence":["e-..."]}',
  'Tasks also take: title, priority (high|normal|low|unranked), effort_estimate (e.g. "1-2h"), capability (low|medium|high), capability_reason.',
  '',
  'Allowed status values per type:',
  'decision: proposed, active, superseded, rejected',
  'error: observed, investigating, attempted, resolved_unverified, verified, reopened',
  'learning, fact: active, unverified, superseded',
  'task: open, in_progress, blocked, implemented_unverified, verified, done, cancelled, superseded',
  'question: open, answered',
  'intent: active, historical',
  '',
  'Rules:',
  '1. Extract only what the events support. Every item needs at least one evidence event id taken from the events given.',
  '2. Never mark anything verified or done unless an evidence event is a tool_result with "ok": true showing it succeeded. Otherwise use resolved_unverified (error) or implemented_unverified (task).',
  '3. An option that was considered and dropped is a decision with status rejected, not an active decision.',
  '4. Do not invent deadlines, owners, ticket numbers, file names or test results. If something is unclear, say so in gaps.',
  '5. If an event concerns an issue, task or decision that already exists in open_records, return an update with that id instead of a new create.',
  '6. An intent item needs evidence from a user_prompt event.',
  '7. Keep every string under 500 chars. Return at most 25 items. Return no items at all if the events carry nothing durable.',
  '8. files must be repo-relative paths taken from the events.',
  '9. session_summary states what happened in these events, factually, in the third person.'
].join('\n');

// Event fields sent to the provider: no src line/uuid, no machine paths (data minimization).
const EVENT_FIELDS = ['id', 'seq', 'ts', 'type', 'tool', 'text', 'ok', 'truncated'];

function cleanEvent(event) {
  const out = {};
  for (const key of EVENT_FIELDS) {
    if (event[key] === undefined) continue;
    out[key] = key === 'text' ? redact(String(event[key])).text : event[key];
  }
  return out;
}

// Drop any event that still names a denylisted path (defence in depth over capture).
function keepEvent(event, denyPaths) {
  const text = typeof event.text === 'string' ? event.text : '';
  if (!text) return true;
  for (const token of text.split(/[\s"'`;|&<>()=,]+/)) {
    if (token && /[./\\]/.test(token) && redactPath(token.replace(/^[A-Za-z]:/, ''), denyPaths)) return false;
  }
  return true;
}

function cleanOpenRecord(rec) {
  return {
    id: rec.id,
    type: rec.type,
    status: rec.status,
    statement: redact(String(rec.statement || rec.title || '')).text.slice(0, 300)
  };
}

/**
 * @returns {{system: string, user: string, events: object[], eventIds: Set<string>, inputTokens: number}}
 */
function build({ repo, openRecords = [], events = [], denyPaths = DEFAULT_DENY_PATHS }) {
  const kept = events.filter((e) => keepEvent(e, denyPaths)).map(cleanEvent);
  const payload = {
    repo: String(repo || '').slice(0, 120),
    open_records: openRecords.slice(0, 60).map(cleanOpenRecord),
    events: kept
  };
  const user = JSON.stringify(payload);
  return {
    system: SYSTEM,
    user,
    events: kept,
    eventIds: new Set(kept.map((e) => e.id)),
    inputTokens: estimateTokens(SYSTEM) + estimateTokens(user)
  };
}

// Split events into batches, in seq order, so each request stays under the token cap.
function batchEvents(events, { maxInputTokens = 12000, openRecords = [], repo = '' } = {}) {
  const ordered = [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const overhead = estimateTokens(SYSTEM) +
    estimateTokens(JSON.stringify({ repo, open_records: openRecords.slice(0, 60).map(cleanOpenRecord), events: [] }));
  const room = Math.max(500, maxInputTokens - overhead);
  const batches = [];
  let current = [];
  let tokens = 0;
  for (const event of ordered) {
    const cost = estimateTokens(JSON.stringify(event)) + 1;
    if (current.length > 0 && tokens + cost > room) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(event);
    tokens += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const REPAIR_PREFIX = 'Your previous output was not valid JSON: ';

function repairUser(user, parseError) {
  return user + '\n\n' + REPAIR_PREFIX + String(parseError) + '. Return only the JSON.';
}

module.exports = { SYSTEM, EVENT_FIELDS, build, batchEvents, repairUser, REPAIR_PREFIX, cleanOpenRecord };
