const fs = require('node:fs');
const path = require('node:path');
const { repoRoot } = require('./git');
const { memoryDir, memoHome } = require('./paths');
const { redact } = require('./redact');

function pad(n) {
  return String(n).padStart(2, '0');
}

function getLocalTimestamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function run(argv) {
  let type = null;
  let isPersonal = false;
  let textParts = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-t' || arg === '--type') {
      type = argv[i + 1];
      i++;
    } else if (arg === '--personal') {
      isPersonal = true;
    } else {
      textParts.push(arg);
    }
  }

  const rawText = textParts.join(' ').trim();

  if (isPersonal) {
    if (!rawText) {
      console.error('Error: missing text for personal note');
      process.exit(1);
    }
    const { text, count } = redact(rawText);
    const home = memoHome();
    fs.mkdirSync(home, { recursive: true });
    const personalPath = path.join(home, 'personal.md');

    if (!fs.existsSync(personalPath)) {
      fs.writeFileSync(personalPath, '# About me\n', 'utf8');
    }
    fs.appendFileSync(personalPath, `- ${text}\n`, 'utf8');
    console.log(`Saved → ~/.memo/personal.md`);
    if (count > 0) {
      console.log(`⚠ ${count} secret(s) redacted`);
    }
    return;
  }

  const validTypes = ['decision', 'error', 'next'];
  if (!type || !validTypes.includes(type) || !rawText) {
    console.error(`Error: usage: memo note -t <decision|error|next> <text...>`);
    console.error(`Valid types: ${validTypes.join(', ')}`);
    process.exit(1);
  }

  let root;
  try {
    root = repoRoot(process.cwd());
  } catch (err) {
    console.error(`Error: Run "memo init" first`);
    process.exit(1);
  }

  const memDir = memoryDir(root);
  if (!fs.existsSync(memDir)) {
    console.error(`Error: Run "memo init" first`);
    process.exit(1);
  }

  const { text, count } = redact(rawText);
  const timestamp = getLocalTimestamp();

  if (type === 'decision' || type === 'error') {
    const filename = `${type}s.md`;
    const filePath = path.join(memDir, filename);
    const entry = `\n## ${timestamp} · ${type}\n${text}\n`;
    fs.appendFileSync(filePath, entry, 'utf8');
    console.log(`Saved → .memory/${filename}`);
  } else if (type === 'next') {
    const filePath = path.join(memDir, 'next.md');
    const entry = `- [ ] ${text}\n`;
    fs.appendFileSync(filePath, entry, 'utf8');
    console.log(`Saved → .memory/next.md`);
  }
}

module.exports = run;