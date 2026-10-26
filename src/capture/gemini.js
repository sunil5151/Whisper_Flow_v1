'use strict';

// Gemini in Google Antigravity → MEMO event envelopes.
//
//   <ANTIGRAVITY_HOME or ~/.gemini/antigravity>/brain/<id>/.system_generated/logs/transcript.jsonl
//   one step per line: {step_index, source, type, created_at, content?, tool_calls?: [{name, args}]}
//     USER_INPUT        the prompt, inside <USER_REQUEST>…</USER_REQUEST>
//     PLANNER_RESPONSE  the model's text (thinking is dropped) and its tool calls
//     GENERIC           one tool result, in the order of the calls before it
//
// The transcript names no workspace: a conversation belongs to the repo that holds the first
// absolute path its tool calls use. The format is not a documented contract: unknown steps are dropped.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { relPath, denied, finish, cmpKey, LIMITS } = require('./claude');
const { sha1, isoLocal } = require('../util');

const CONTENT_RESULT_TOOLS = new Set(['view_file', 'read_file', 'view_file_outline', 'view_code_item']);
const WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const PENDING = '~pending';

function home() {
  return process.env.ANTIGRAVITY_HOME || path.join(os.homedir(), '.gemini', 'antigravity');
}

// Arg values are JSON-encoded strings ("\"c:\\\\Users\\\\…\""); plain ones pass through.
function argValue(v) {
  if (typeof v !== 'string') return v;
  if (/^".*"$/s.test(v)) {
    try { return JSON.parse(v); } catch (_) { return v; }
  }
  return v;
}

function isAbsPath(v) {
  return typeof v === 'string' && (/^[A-Za-z]:[\\/]/.test(v) || /^\/[^/]/.test(v));
}

function firstPath(transcript) {
  let raw;
  try { raw = fs.readFileSync(transcript, 'utf8'); } catch (_) { return null; }
  for (const line of raw.split('\n')) {
    if (!line.includes('tool_calls')) continue;
    let step;
    try { step = JSON.parse(line); } catch (_) { continue; }
    for (const call of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
      for (const v of Object.values(call && call.args ? call.args : {})) {
        const p = argValue(v);
        if (isAbsPath(p)) return p;
      }
    }
  }
  return null;
}

// Conversations whose first tool path is inside this repo: [{sid, transcriptPath}].
function discover(root) {
  const dir = path.join(home(), 'brain');
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const want = cmpKey(root);
  const out = [];
  for (const sid of names) {
    const transcriptPath = path.join(dir, sid, '.system_generated', 'logs', 'transcript.jsonl');
    const p = firstPath(transcriptPath);
    if (!p) continue;
    const key = cmpKey(p);
    if (key === want || key.startsWith(want + '/')) out.push({ sid, transcriptPath });
  }
  return out;
}

function userText(content) {
  const text = String(content || '');
  const req = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text);
  if (req) return req[1].trim();
  return text.replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/g, '').trim();
}

function describeTool(args, ctx) {
  const a = {};
  for (const [k, v] of Object.entries(args && typeof args === 'object' ? args : {})) a[k] = argValue(v);
  const paths = Object.values(a).filter(isAbsPath);
  let text;
  if (typeof a.CommandLine === 'string') text = a.CommandLine;
  else if (paths.length) text = relPath(paths[0], ctx) || '(no path)';
  else if (typeof a.Query === 'string') text = a.Query;
  else {
    try { text = JSON.stringify(a); } catch (_) { text = ''; }
  }
  return { text, paths };
}

/**
 * @param {object} line one transcript.jsonl step
 * @param {object} ctx  same as the Claude normalizer; ctx.tools['~pending'] queues call names for their results
 */
function normalize(line, ctx) {
  if (!line || typeof line !== 'object' || typeof line.type !== 'string') return [];
  const tools = ctx.tools || (ctx.tools = {});
  const pending = Array.isArray(tools[PENDING]) ? tools[PENDING] : (tools[PENDING] = []);
  const step = line.step_index !== undefined ? line.step_index : ctx.lineNo;
  const env = (part, type, extra) => ({
    v: 1, id: 'e-' + sha1(ctx.sid + ':' + step + ':' + part).slice(0, 8), sid: ctx.sid,
    ts: isoLocal(line.created_at), agent: 'gemini', type, ...extra, src: { line: ctx.lineNo }
  });

  if (line.type === 'USER_INPUT') {
    const text = userText(line.content);
    return text ? [finish(env('u', 'user_prompt', { text }), LIMITS.user_prompt, ctx)] : [];
  }
  if (line.type === 'PLANNER_RESPONSE') {
    const out = [];
    const text = typeof line.content === 'string' ? line.content.trim() : '';
    if (text) out.push(finish(env('a', 'assistant_text', { text }), LIMITS.assistant_text, ctx));
    (Array.isArray(line.tool_calls) ? line.tool_calls : []).forEach((call, i) => {
      const name = String((call && call.name) || 'unknown');
      const { text: t, paths } = describeTool(call && call.args, ctx);
      const isDenied = paths.some((p) => denied(p, ctx));
      pending.push(isDenied ? [name, 1] : [name]);
      if (!isDenied) out.push(finish(env('c' + i, 'tool_call', { tool: name, text: t }), LIMITS.tool_call, ctx));
    });
    return out;
  }
  if (line.type === 'GENERIC') {
    const known = pending.shift();
    if (known && known[1]) return [];
    const name = known ? known[0] : null;
    if (name && CONTENT_RESULT_TOOLS.has(name)) return [];
    let text = String(line.content || '').replace(/^Created At: .*\n(Completed At: .*\n)?/, '');
    const ok = line.status === 'DONE' ? true : line.status === 'ERROR' ? false : undefined;
    if (name && WRITE_TOOLS.has(name) && ok !== false) text = 'ok';
    const out = env('r', 'tool_result', { text });
    if (name) out.tool = name;
    if (ok !== undefined) out.ok = ok;
    return [finish(out, 0, ctx)];
  }
  return [];
}

module.exports = { normalize, discover, home, argValue };
