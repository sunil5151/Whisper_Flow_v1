'use strict';

// GitHub Copilot agent sessions (Copilot CLI and the VS Code agent host) → MEMO event envelopes.
//
//   <COPILOT_HOME or ~/.copilot>/session-state/<sid>/workspace.yaml   cwd:, git_root:
//   <COPILOT_HOME or ~/.copilot>/session-state/<sid>/events.jsonl     {type, data, id, timestamp}
//
// Copilot runs no MEMO hook, so the sweep finds these sessions by their git root.
// Like the Claude transcript, the format is not a documented contract: unknown types are dropped.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { relPath, denied, finish, cmpKey, LIMITS } = require('./claude');
const { sha1, isoLocal } = require('../util');

const CONTENT_RESULT_TOOLS = new Set(['view', 'read_file', 'show_file']);
const WRITE_TOOLS = new Set(['edit', 'create', 'write_file', 'str_replace', 'apply_patch']);

function copilotHome() {
  return process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
}

function yamlValue(text, key) {
  const m = new RegExp('^' + key + ':\\s*(.+?)\\s*$', 'm').exec(text);
  return m ? m[1].replace(/^(['"])(.*)\1$/, '$2') : null;
}

// Sessions whose git root (or cwd) is this repo: [{sid, transcriptPath}].
function discover(root) {
  const dir = path.join(copilotHome(), 'session-state');
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const want = cmpKey(root);
  const out = [];
  for (const sid of names) {
    let yaml;
    try { yaml = fs.readFileSync(path.join(dir, sid, 'workspace.yaml'), 'utf8'); } catch (_) { continue; }
    const where = yamlValue(yaml, 'git_root') || yamlValue(yaml, 'cwd');
    if (!where || cmpKey(where) !== want) continue;
    const transcriptPath = path.join(dir, sid, 'events.jsonl');
    if (fs.existsSync(transcriptPath)) out.push({ sid, transcriptPath });
  }
  return out;
}

function describeTool(name, args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  const p = a.path || a.filePath || a.file_path;
  const paths = typeof p === 'string' ? [p] : [];
  let text;
  if (typeof p === 'string') text = relPath(p, ctx) || '(no path)';
  else if (typeof a.command === 'string') {
    text = a.command;
    for (const tok of text.split(/[\s"'`;|&<>()=]+/)) if (tok && /[./\\]/.test(tok)) paths.push(tok);
  } else if (typeof a.pattern === 'string') text = a.pattern;
  else if (typeof a.query === 'string') text = a.query;
  else if (typeof a.url === 'string') text = a.url;
  else {
    try { text = JSON.stringify(a); } catch (_) { text = ''; }
  }
  return { text, paths };
}

/**
 * @param {object} line one events.jsonl object
 * @param {object} ctx  same as the Claude normalizer; ctx.tools maps toolCallId → [name, denied?]
 */
function normalize(line, ctx) {
  if (!line || typeof line !== 'object' || !line.data || typeof line.data !== 'object') return [];
  const d = line.data;
  const tools = ctx.tools || (ctx.tools = {});
  const env = (type, extra) => ({
    v: 1, id: 'e-' + sha1(ctx.sid + (line.id || ctx.raw || '')).slice(0, 8), sid: ctx.sid,
    ts: isoLocal(line.timestamp), agent: 'copilot', type, ...extra, src: { line: ctx.lineNo }
  });

  if (line.type === 'user.message') {
    const text = typeof d.content === 'string' ? d.content.trim() : '';
    return text ? [finish(env('user_prompt', { text }), LIMITS.user_prompt, ctx)] : [];
  }
  if (line.type === 'assistant.message') {
    const text = typeof d.content === 'string' ? d.content.trim() : '';
    return text ? [finish(env('assistant_text', { text }), LIMITS.assistant_text, ctx)] : [];
  }
  if (line.type === 'tool.execution_start') {
    const name = String(d.toolName || 'unknown');
    const { text, paths } = describeTool(name, d.arguments, ctx);
    const isDenied = paths.some((p) => denied(p, ctx));
    if (d.toolCallId) tools[d.toolCallId] = isDenied ? [name, 1] : [name];
    return isDenied ? [] : [finish(env('tool_call', { tool: name, text }), LIMITS.tool_call, ctx)];
  }
  if (line.type === 'tool.execution_complete') {
    const known = tools[d.toolCallId];
    if (known && known[1]) return [];
    const name = known ? known[0] : null;
    if (name && CONTENT_RESULT_TOOLS.has(name)) return [];
    const ok = d.success === true ? true : d.success === false ? false : undefined;
    let text = d.result && typeof d.result.content === 'string' ? d.result.content
      : d.error && typeof d.error.message === 'string' ? d.error.message : '';
    if (name && WRITE_TOOLS.has(name) && ok !== false) text = 'ok';
    const out = env('tool_result', { text });
    if (name) out.tool = name;
    if (ok !== undefined) out.ok = ok;
    return [finish(out, 0, ctx)];
  }
  return [];
}

module.exports = { normalize, discover, copilotHome };
