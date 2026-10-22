'use strict';

const fs = require('fs');
const path = require('path');
const { repoRoot, hooksDir } = require('./git');
const { memoryDir, memoBin, sessionsDir } = require('./paths');
const repos = require('./repos');
const records = require('./store/records');
const stateReport = require('./report/state');
const { hasLegacy } = require('./migrate');
const { writeFileAtomic } = require('./util');

const MEMORY_FILES = {
  'progress.md': '# Progress\n\n(auto-written by the post-commit hook)\n'
};

const OLD_AGENTS_LINE = 'Read .memory/BRIEF.md before starting.';
const BLOCK_RE = /<!-- memo:start -->[\s\S]*?<!-- memo:end -->\n?/;
const GITIGNORE_LINE = '.memory/BRIEF.md';
const HOOK_MARK = '# memo-hook';

function createOnly(filePath, content) {
  if (fs.existsSync(filePath)) return 'skipped';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return 'created';
}

function appendLineIfAbsent(filePath, line) {
  let existing = '';
  if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf8');
  if (existing.split(/\r?\n/).includes(line)) return 'skipped';
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, prefix + line + '\n', 'utf8');
  return 'created';
}

function template(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'templates', name), 'utf8').replace(/\r\n?/g, '\n');
}

// Write a file only when its content differs.
function writeIfChanged(filePath, content) {
  let existing = null;
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch (_) { /* new file */ }
  if (existing === content) return 'skipped';
  writeFileAtomic(filePath, content);
  return existing === null ? 'created' : 'updated';
}

// AGENTS.md gets one marked block: replaced on rerun, never duplicated.
function agentsContent(existing) {
  const block = template('AGENTS.block.md');
  if (existing === null) return block;
  const text = existing.replace(/\r\n?/g, '\n');
  if (BLOCK_RE.test(text)) return text.replace(BLOCK_RE, block);
  const lines = text.split('\n').filter((l) => l !== OLD_AGENTS_LINE).join('\n').replace(/\n*$/, '');
  return (lines ? lines + '\n\n' : '') + block;
}

function hookContent() {
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'post-commit'),
    'utf8'
  );
  const fwd = (p) => p.replace(/\\/g, '/');
  return template
    .replace(/\r\n?/g, '\n')
    .replace('{{NODE}}', fwd(process.execPath))
    .replace('{{MEMO}}', fwd(memoBin()));
}

function installHook(root) {
  const hookPath = path.join(hooksDir(root), 'post-commit');
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (existing.includes(HOOK_MARK)) return 'skipped';
    const normalized = existing.replace(/\r\n?/g, '\n');
    const sep = normalized.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(hookPath, normalized + sep + hookContent(), 'utf8');
    return 'created';
  }
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, hookContent(), { encoding: 'utf8', mode: 0o755 });
  return 'created';
}

function init() {
  const root = repoRoot(process.cwd());
  const report = [];
  const notes = [];

  for (const [name, content] of Object.entries(MEMORY_FILES)) {
    const status = createOnly(path.join(memoryDir(root), name), content);
    report.push([status, `.memory/${name}`]);
  }

  report.push([writeIfChanged(path.join(memoryDir(root), 'README.md'), template('memory-README.md')), '.memory/README.md']);

  const agentsPath = path.join(root, 'AGENTS.md');
  const agentsOld = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : null;
  report.push([writeIfChanged(agentsPath, agentsContent(agentsOld)), 'AGENTS.md']);

  const claudePath = path.join(root, 'CLAUDE.md');
  if (!fs.existsSync(claudePath)) {
    fs.writeFileSync(claudePath, template('CLAUDE.md'), 'utf8');
    report.push(['created', 'CLAUDE.md']);
  } else {
    report.push(['skipped', 'CLAUDE.md']);
    if (!/^@AGENTS\.md\s*$/m.test(fs.readFileSync(claudePath, 'utf8'))) {
      notes.push('hint: CLAUDE.md has no "@AGENTS.md" line — add it so Claude Code loads the memory pointer');
    }
  }

  report.push([appendLineIfAbsent(path.join(root, '.gitignore'), GITIGNORE_LINE), '.gitignore']);

  report.push([installHook(root), 'post-commit hook']);

  const sDir = sessionsDir(root);
  report.push([fs.existsSync(sDir) ? 'skipped' : 'created', '.memory/sessions/']);
  fs.mkdirSync(sDir, { recursive: true });
  records.ensureDir(root);

  const statePath = stateReport.statePath(root);
  if (fs.existsSync(statePath)) report.push(['skipped', '.memory/PROJECT_STATE.md']);
  else {
    stateReport.writeState(root);
    report.push(['created', '.memory/PROJECT_STATE.md']);
  }

  const reg = repos.register(root);
  report.push([reg.status, `repo registered (${reg.repo.id})`]);

  for (const [status, name] of report) {
    console.log(`${status}  ${name}`);
  }
  if (hasLegacy(root)) notes.push('old notes found (.memory/decisions.md, errors.md, next.md) — run `memo migrate`');
  for (const n of notes) console.log(n);
  readiness(root);
}

// What still stands between this repo and automatic capture + processing.
// Missing Claude Code hooks are installed here (global, idempotent, backed up); the rest is reported.
function readiness(root) {
  const status = require('./status');
  const config = require('./config');
  let hooks = status.claudeHooks();
  if (!hooks.ok || hooks.stale.length > 0) {
    try {
      require('./capture/install-claude').setupClaude([]);
      hooks = status.claudeHooks();
    } catch (err) {
      console.log('warn  Claude Code hooks could not be installed: ' + err.message);
    }
  }
  const cfg = config.load();
  const key = config.keySource(cfg);
  const task = status.taskRegistered();
  const rows = [
    [hooks.ok && hooks.stale.length === 0, 'capture', hooks.ok ? 'Claude Code hooks installed — sessions in this repo are captured' : 'hooks missing — run `memo setup claude`'],
    [key.source !== 'none', 'api key', key.source !== 'none' ? key.detail : 'missing — run `memo key set` (capture still works; extraction waits)'],
    [task.ok, 'background', task.ok ? 'scheduled task runs every ' + cfg.intervalMinutes + ' min' : task.detail]
  ];
  console.log('');
  for (const [ok, name, detail] of rows) console.log((ok ? 'ready ' : 'todo  ') + name.padEnd(11) + ' ' + detail);
  const done = rows.every(([ok]) => ok);
  console.log(done
    ? '\nMEMO is active in ' + path.basename(root) + '. Start Claude Code here; memory appears in .memory/ after the next cycle.'
    : '\nMEMO is set up in ' + path.basename(root) + '. Fix the "todo" lines above (or rerun setup_memo.bat) for full automation.');
}

module.exports = init;
