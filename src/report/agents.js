'use strict';

// The memo block in the instruction files other agents load on their own:
//   AGENTS.md                         Codex, Cursor, Windsurf, Copilot agent mode
//   .github/copilot-instructions.md   GitHub Copilot (chat and coding agent)
//   GEMINI.md                         Gemini CLI / Code Assist
// Claude Code gets the same facts pushed by the SessionStart hook; these agents run no hook,
// so the block carries a snapshot of the state inline instead of only a pointer to it.

const fs = require('node:fs');
const path = require('node:path');
const state = require('./state');
const { writeFileAtomic } = require('../util');

const AGENT_FILES = ['AGENTS.md', '.github/copilot-instructions.md', 'GEMINI.md'];
const BLOCK_RE = /<!-- memo:start -->[\s\S]*?<!-- memo:end -->\n?/;
const OLD_AGENTS_LINE = 'Read .memory/BRIEF.md before starting.';
const MAX_SNAPSHOT_CHARS = 4500;
const STALE_MS = 24 * 3600 * 1000;

function template() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'AGENTS.block.md'), 'utf8').replace(/\r\n?/g, '\n');
}

// Derived from the data only (never the clock), so the block changes only when the memory does.
function snapshot(root, loaded = state.loadState(root)) {
  const { sections } = require('../context');
  const last = state.lastProcessedTs(root, loaded.index);
  const newest = loaded.index.reduce((best, e) => (e.end && e.end > best ? e.end : best), '');
  const pending = loaded.index.some((e) => (Number(e.events) || 0) > (Number(e.processedThrough) || 0));
  const stale = pending && (!last || Date.parse(newest) - Date.parse(last) > STALE_MS);
  const lines = ['', '### Snapshot (sessions processed up to ' + (last ? last.slice(0, 10) : 'none') + ')'];
  if (stale) lines.push('> Stale: newer sessions are captured but not processed yet — run `memo status`. Check the code before trusting old items.');
  let size = lines.join('\n').length;
  // Recent sessions first: it is what an agent asked about earlier chats needs, and the cap cuts from the end.
  const parts = sections(loaded, { items: 4, intents: 3, sessionChars: 160, sessionCount: 5, links: true });
  parts.unshift(...parts.splice(parts.findIndex(([title]) => title === 'Recent sessions'), 1));
  for (const [title, items] of parts) {
    if (items.length === 0) continue;
    const head = title + ':';
    if (size + head.length + 2 > MAX_SNAPSHOT_CHARS) break;
    lines.push(head);
    size += head.length + 1;
    for (const item of items) {
      if (size + item.length + 1 > MAX_SNAPSHOT_CHARS) break;
      lines.push(item);
      size += item.length + 1;
    }
  }
  if (lines.length === 2 + (stale ? 1 : 0)) lines.push('(no records yet)');
  return lines.join('\n') + '\n';
}

function block(root) {
  return template().replace('{{SNAPSHOT}}', snapshot(root));
}

// File text with the block replaced, or appended when the file has none.
function withBlock(existing, text) {
  if (existing === null) return text;
  const body = existing.replace(/\r\n?/g, '\n');
  if (BLOCK_RE.test(body)) return body.replace(BLOCK_RE, () => text);
  const kept = body.split('\n').filter((l) => l !== OLD_AGENTS_LINE).join('\n').replace(/\n*$/, '');
  return (kept ? kept + '\n\n' : '') + text;
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

function write(file, existing, content) {
  if (existing !== null && existing.replace(/\r\n?/g, '\n') === content) return 'skipped';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, content);
  return existing === null ? 'created' : 'updated';
}

// `memo init`: every agent file gets the block. Returns [[status, relPath]].
function install(root) {
  const text = block(root);
  return AGENT_FILES.map((rel) => {
    const file = path.join(root, rel);
    const existing = read(file);
    return [write(file, existing, withBlock(existing, text)), rel];
  });
}

// Each cycle / `memo report`: refresh only the files that still carry the block.
function refresh(root) {
  const text = block(root);
  const changed = [];
  for (const rel of AGENT_FILES) {
    const file = path.join(root, rel);
    const existing = read(file);
    if (existing === null || !BLOCK_RE.test(existing)) continue;
    if (write(file, existing, withBlock(existing, text)) !== 'skipped') changed.push(rel);
  }
  return changed;
}

// Same text once the generated block is taken out (line endings ignored).
function sameOutsideBlock(a, b) {
  const strip = (s) => String(s).replace(/\r\n?/g, '\n').replace(BLOCK_RE, '').trim();
  return strip(a) === strip(b);
}

module.exports = { AGENT_FILES, BLOCK_RE, snapshot, block, withBlock, install, refresh, sameOutsideBlock };
