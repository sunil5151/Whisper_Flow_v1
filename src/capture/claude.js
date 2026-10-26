'use strict';

// Claude Code transcript line → MEMO event envelopes (§6.1).
// The transcript format is not a documented contract: be tolerant, drop what is unknown.

const { redact, redactPath, DEFAULT_DENY_PATHS } = require('../redact');
const { sha1, isoLocal } = require('../util');

const LIMITS = { user_prompt: 4000, assistant_text: 3000, tool_call: 300, system: 300 };
const RESULT_HEAD = 500;
const RESULT_TAIL = 300;
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);
const CONTENT_RESULT_TOOLS = new Set(['Read', 'NotebookRead']); // results dropped entirely
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']); // results reduced to ok/error

function cut(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function cutResult(text) {
  if (text.length <= RESULT_HEAD + RESULT_TAIL) return { text, truncated: false };
  return { text: `${text.slice(0, RESULT_HEAD)}\n…\n${text.slice(-RESULT_TAIL)}`, truncated: true };
}

function isWinAbs(p) { return /^[A-Za-z]:[\\/]/.test(p); }
function isAbs(p) { return p.startsWith('/') || p.startsWith('\\\\') || isWinAbs(p); }
function slashes(p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, ''); }
function cmpKey(p) { return isWinAbs(p) ? slashes(p).toLowerCase() : slashes(p); }

// Repo-relative forward-slash path, "<outside-repo>" for anything outside, null if unusable.
function relPath(p, ctx) {
  if (typeof p !== 'string' || !p.trim()) return null;
  let abs = p.trim();
  if (!isAbs(abs)) {
    if (!ctx.cwd) return slashes(abs).split('/').includes('..') ? '<outside-repo>' : slashes(abs);
    abs = `${slashes(ctx.cwd)}/${abs}`;
  }
  const parts = [];
  for (const seg of slashes(abs).split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  const full = parts.join('/');
  const root = cmpKey(ctx.root);
  const key = cmpKey(full);
  if (key === root) return '.';
  if (!key.startsWith(root + '/')) return '<outside-repo>';
  return full.slice(slashes(ctx.root).length + 1);
}

// Checked on the raw path too, so a denied file outside the repo is also dropped.
function denied(raw, ctx) {
  if (typeof raw !== 'string' || !raw) return false;
  return redactPath(slashes(raw).replace(/^[A-Za-z]:/, ''), ctx.denyPaths || DEFAULT_DENY_PATHS);
}

// Hide absolute machine paths inside free text.
function scrubPaths(text, ctx) {
  let out = text;
  const swap = (base, label) => {
    if (!base) return;
    const fwd = base.replace(/\\/g, '/').replace(/\/+$/, '');
    const variants = new Set([base, base.replace(/\//g, '\\'), fwd, fwd.replace(/\//g, '\\\\')]);
    const win = isWinAbs(base);
    if (win) {
      // Git Bash (/c/Users/…) and file URIs (file:///c%3A/Users/…) spell the same path differently.
      variants.add('/' + fwd[0] + fwd.slice(2));
      variants.add(fwd[0] + '%3A' + fwd.slice(2));
    }
    for (const v of variants) {
      if (v.length < 4) continue;
      const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), win ? 'gi' : 'g');
      out = out.replace(re, label);
    }
  };
  swap(ctx.root, '<repo>');
  swap(ctx.home, '~');
  return out;
}

function stripReminders(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
}

function countLines(s) {
  return typeof s === 'string' && s ? s.split('\n').length : 0;
}

// Short description of a tool call + the paths it touches.
function describeToolUse(name, input, ctx) {
  const inp = input && typeof input === 'object' ? input : {};
  const paths = [];
  let text;
  if (FILE_TOOLS.has(name)) {
    const p = inp.file_path || inp.notebook_path || inp.path;
    const rel = relPath(p, ctx);
    if (typeof p === 'string') paths.push(p);
    text = rel || '(no path)';
    if (name === 'Write') text += ` (${countLines(inp.content)} lines)`;
    if (name === 'Edit') text += ` (-${countLines(inp.old_string)} +${countLines(inp.new_string)} lines)`;
    if (name === 'MultiEdit' && Array.isArray(inp.edits)) text += ` (${inp.edits.length} edits)`;
  } else if (name === 'Bash' || name === 'PowerShell') {
    text = String(inp.command || '');
    for (const tok of text.split(/[\s"'`;|&<>()=]+/)) {
      if (tok && /[./\\]/.test(tok)) paths.push(tok);
    }
  } else if (name === 'Glob' || name === 'Grep') {
    const rel = inp.path ? relPath(inp.path, ctx) : null;
    if (typeof inp.path === 'string') paths.push(inp.path);
    text = `${inp.pattern || ''}${rel ? ` in ${rel}` : ''}`;
  } else if (name === 'WebFetch') {
    text = String(inp.url || '');
  } else if (name === 'WebSearch') {
    text = String(inp.query || '');
  } else if (name === 'Task' || name === 'Agent') {
    text = String(inp.description || inp.subagent_type || '');
  } else if (name === 'TodoWrite' && Array.isArray(inp.todos)) {
    text = inp.todos.map((t) => `[${t.status || '?'}] ${t.content || ''}`).join('; ');
  } else {
    try { text = JSON.stringify(inp); } catch (_) { text = ''; }
  }
  return { text, paths };
}

function makeId(sid, line, raw, blockIndex) {
  return `e-${sha1(`${sid}${line.uuid || raw}${blockIndex}`).slice(0, 8)}`;
}

function finish(env, limit, ctx) {
  const scrubbed = scrubPaths(env.text, ctx);
  const red = redact(scrubbed).text;
  const c = env.type === 'tool_result' ? cutResult(red) : cut(red, limit);
  env.text = redact(c.text).text;
  if (c.truncated) env.truncated = true;
  return env;
}

/**
 * @param {object} line parsed transcript line
 * @param {object} ctx  { sid, root, cwd, home, lineNo, raw, tools: {toolUseId: [name, denied]}, denyPaths }
 *                      ctx.tools is mutated (tool_use ids remembered for their later results).
 * @returns {object[]} envelopes without seq
 */
function normalize(line, ctx) {
  if (!line || typeof line !== 'object') return [];
  if (line.isSidechain === true) return []; // subagent transcripts: not captured in MVP
  const out = [];
  const tools = ctx.tools || (ctx.tools = {});
  const lctx = { ...ctx, cwd: line.cwd || ctx.cwd };
  const base = (blockIndex, type) => {
    const env = { v: 1, id: makeId(ctx.sid, line, ctx.raw || '', blockIndex), sid: ctx.sid, ts: isoLocal(line.timestamp), agent: 'claude-code', type };
    return env;
  };
  const src = () => ({ line: ctx.lineNo, ...(line.uuid ? { uuid: line.uuid } : {}) });

  if (line.type === 'system') {
    if (line.subtype === 'compact_boundary') {
      out.push({ ...base(0, 'system'), text: 'context compacted', src: src() });
    }
    return out;
  }

  if (line.type !== 'user' && line.type !== 'assistant') return out;
  const msg = line.message && typeof line.message === 'object' ? line.message : {};
  const content = msg.content;

  if (line.type === 'user') {
    if (line.isMeta === true) return out;
    if (line.isCompactSummary === true) return out; // model-written summary; compact_boundary marks the event
    const items = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const texts = [];
    items.forEach((item, i) => {
      if (!item || typeof item !== 'object') return;
      if (item.type === 'text' && typeof item.text === 'string') {
        texts.push(item.text);
      } else if (item.type === 'tool_result') {
        const known = tools[item.tool_use_id];
        const name = known ? known[0] : null;
        if (known && known[1]) return; // denied path
        if (name && CONTENT_RESULT_TOOLS.has(name)) return; // never store file contents
        const env = { ...base(i, 'tool_result') };
        if (name) env.tool = name;
        if (item.is_error === true) env.ok = false;
        else if (item.is_error === false) env.ok = true;
        let text = contentText(item.content);
        if (name && WRITE_TOOLS.has(name)) text = env.ok === false ? text : 'ok';
        env.text = text;
        env.src = src();
        out.push(finish(env, 0, lctx));
      }
    });
    let text = stripReminders(texts.join('\n'));
    if (!text) return out;
    if (/<local-command-stdout>|<local-command-stderr>/.test(text)) return out;
    const cmd = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
    if (cmd) {
      const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
      out.unshift(finish({ ...base('cmd', 'system'), text: `command ${cmd[1].trim()} ${args.trim()}`.trim(), src: src() }, LIMITS.system, lctx));
      return out;
    }
    if (/^\[Request interrupted by user/.test(text)) {
      out.unshift({ ...base('int', 'system'), text: 'interrupted by user', src: src() });
      return out;
    }
    out.unshift(finish({ ...base('text', 'user_prompt'), text, src: src() }, LIMITS.user_prompt, lctx));
    return out;
  }

  // assistant
  const items = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const blockIndex = typeof line.apiBlockIndex === 'number' ? `${line.apiBlockIndex}.${i}` : i;
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      out.push(finish({ ...base(blockIndex, 'assistant_text'), text: item.text.trim(), src: src() }, LIMITS.assistant_text, lctx));
    } else if (item.type === 'tool_use') {
      const name = String(item.name || 'unknown');
      const { text, paths } = describeToolUse(name, item.input, lctx);
      const isDenied = paths.some((p) => denied(p, lctx));
      if (item.id) tools[item.id] = isDenied ? [name, 1] : [name];
      if (isDenied) return;
      out.push(finish({ ...base(blockIndex, 'tool_call'), tool: name, text, src: src() }, LIMITS.tool_call, lctx));
    }
    // thinking, redacted_thinking, image, anything else: dropped
  });
  return out;
}

module.exports = { normalize, relPath, denied, finish, cmpKey, LIMITS };
