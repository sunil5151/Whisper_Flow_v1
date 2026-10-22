'use strict';

// Preloaded into every test process (npm test → node --require). Child `memo` processes inherit
// process.env, so no test can reach the real ~/.memo, ~/.claude/settings.json, the real
// scheduled task or the Windows key store, even if it forgets to set these itself.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.MEMO_TEST_ISOLATED) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-test-isolated-'));
  process.env.MEMO_TEST_ISOLATED = base;
  process.env.MEMO_HOME = path.join(base, 'home');
  process.env.MEMO_CLAUDE_SETTINGS = path.join(base, 'claude-settings.json');
  process.env.MEMO_TASK_NAME = 'MEMO test task (never registered)';
  process.env.MEMO_FAKE_TASK = JSON.stringify({ exists: false });
  process.env.MEMO_SECRET_BACKEND = 'file';
  process.env.MEMO_SHIM_DIR = path.join(base, 'shim');
  process.env.MEMO_NO_PATH_EDIT = '1';
  for (const name of ['MEMO_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MEMO_MOCK_LLM']) delete process.env[name];
  process.on('exit', () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
}
