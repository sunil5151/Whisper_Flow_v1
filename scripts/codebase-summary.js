#!/usr/bin/env node
'use strict';

// Incremental codebase summary via OpenRouter.
//
//   node scripts/codebase-summary.js          first run: full codebase; later runs: git diff + previous summary
//   node scripts/codebase-summary.js --full   force a full rebuild
//
// Key: OPEN_ROUTER_API_KEY / OPENROUTER_API_KEY, else the OPEN_ROUTER_API_KEY line of groq_key.md (gitignored).
// Model: MEMO_SUMMARY_MODEL or z-ai/glm-5.3-flash.
// Every file and diff is passed through src/redact.js before it is sent.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { create } = require('../src/llm/openai');
const { redact, redactPath } = require('../src/redact');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'codebase_summary.md');
const KEY_FILE = path.join(ROOT, 'groq_key.md');
const MODEL = process.env.MEMO_SUMMARY_MODEL || 'z-ai/glm-5.3-flash';
const MARKER = /^<!-- codebase-summary base=([0-9a-f]{40}) model=(\S+) at=(\S+) -->$/m;

// Session transcripts, patches and personal notes are noise or private; key files never leave the machine.
const SKIP = /^(\.memory\/(sessions|records)\/|\.specstory\/|memory\/|\.vscode\/|test\/fixtures\/)|\.patch$|_key\.md$|^codebase_summary\.md$/;
const MAX_FILE = 40000;
const MAX_TEST_FILE = 4000;
const MAX_DIFF = 200000;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readKey() {
  const env = process.env.OPEN_ROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
  if (env) return env.trim();
  const line = fs.readFileSync(KEY_FILE, 'utf8').split(/\r?\n/).find((l) => /^\s*OPEN_ROUTER_API_KEY\s*=/.test(l)) || '';
  return line.slice(line.indexOf('=') + 1).trim();
}

const included = (p) => !SKIP.test(p) && !redactPath(p);

function fileBlock(rel) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return ''; }
  const cap = rel.startsWith('test/') ? MAX_TEST_FILE : MAX_FILE;
  const cut = text.length > cap ? text.slice(0, cap) + '\n…[truncated ' + (text.length - cap) + ' chars]' : text;
  return '=== ' + rel + ' ===\n' + redact(cut).text + '\n';
}

const SECTIONS = `Write GitHub-flavoured Markdown with exactly these sections:
## Overview — what the project is, in 3-5 lines
## Structure — directory tree with one line per important directory
## Main files — table: file | role
## Current status — what works today
## Completed — bullet list of finished features/phases
## Pending — bullet list of unfinished or planned work
## Known issues / bugs — concrete problems visible in code, docs or memory files
Be specific: name files and functions. Do not invent facts that are not in the input.`;

function fullPrompt(files) {
  return {
    system: 'You are a senior engineer writing a detailed, accurate summary of a codebase for other engineers and AI agents.\n' + SECTIONS,
    user: 'Repository files (secrets redacted):\n\n' + files.map(fileBlock).join('\n')
  };
}

function incrementalPrompt(previous, base, head) {
  const log = git(['log', '--oneline', base + '..HEAD']).trim();
  const changed = git(['diff', '--name-status', base]).trim().split('\n').filter(Boolean)
    .filter((l) => included(l.split('\t').pop()));
  const paths = changed.map((l) => l.split('\t').pop());
  let diff = paths.length ? redact(git(['diff', base, '--', ...paths])).text : '';
  if (diff.length > MAX_DIFF) diff = diff.slice(0, MAX_DIFF) + '\n…[diff truncated]';
  const untracked = git(['ls-files', '--others', '--exclude-standard']).trim().split('\n').filter((p) => p && included(p));
  const user = [
    'Previous summary (based on ' + base.slice(0, 7) + '):\n\n' + previous,
    'Commits since then:\n' + (log || '(none)'),
    'Changed files:\n' + (changed.join('\n') || '(none)'),
    'Diff ' + base.slice(0, 7) + '..working tree (secrets redacted):\n' + (diff || '(empty)'),
    untracked.length ? 'New untracked files:\n\n' + untracked.map(fileBlock).join('\n') : ''
  ].filter(Boolean).join('\n\n');
  return {
    system: 'You maintain a living summary of a codebase. Update the previous summary using only the git changes given; keep everything that is still true.\n'
      + 'Start with a section "## Changes since last run" — bullets: what changed, what got completed, what is newly pending, new or fixed bugs. '
      + 'If nothing meaningful changed, say so.\nThen the full updated summary.\n' + SECTIONS,
    user,
    changed: changed.length + untracked.length,
    head
  };
}

async function main() {
  const head = git(['rev-parse', 'HEAD']).trim();
  const prior = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const m = prior.match(MARKER);
  const full = process.argv.includes('--full') || !m;

  let prompt;
  if (full) {
    const files = git(['ls-files']).trim().split('\n').filter(included);
    prompt = fullPrompt(files);
    console.log('mode: full — ' + files.length + ' files, ' + prompt.user.length + ' chars');
  } else {
    prompt = incrementalPrompt(prior.replace(MARKER, '').trim(), m[1], head);
    console.log('mode: incremental since ' + m[1].slice(0, 7) + ' — ' + prompt.changed + ' changed files, ' + prompt.user.length + ' chars');
  }

  const client = create({ provider: 'openrouter', model: MODEL }, { apiKey: readKey(), timeoutMs: 600000 });
  const res = await client.complete({ system: prompt.system, user: prompt.user, maxTokens: 16000, json: false });
  if (!res.text) throw new Error('empty reply from ' + res.model);

  const body = redact(res.text).text;
  fs.writeFileSync(OUT, '<!-- codebase-summary base=' + head + ' model=' + res.model + ' at=' + new Date().toISOString() + ' -->\n'
    + '# Codebase summary\n\n' + body + '\n');
  console.log(body);
  console.log('\nwrote ' + path.relative(ROOT, OUT) + ' — model ' + res.model + ', tokens in ' + res.usage.input + ' / out ' + res.usage.output);
}

main().catch((err) => {
  console.error('codebase-summary failed: ' + (err.kind ? err.kind + ' — ' : '') + err.message);
  process.exit(1);
});
