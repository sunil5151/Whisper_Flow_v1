'use strict';

const fs = require('fs');
const path = require('path');
const { repoRoot } = require('./git');
const { memoryDir } = require('./paths');

function command() {
  let root;
  try {
    root = repoRoot(process.cwd());
  } catch (err) {
    console.error('Error: Run "memo init" first');
    process.exit(1);
  }

  const memDir = memoryDir(root);
  if (!fs.existsSync(memDir)) {
    console.error('Error: Run "memo init" first');
    process.exit(1);
  }

  const sections = ['progress.md', 'decisions.md', 'errors.md', 'next.md'];
  let brief = '# Memo Brief\n\n';

  for (const section of sections) {
    const filePath = path.join(memDir, section);
    let content = '';
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8').trim();
    }
    const title = section.replace('.md', '').charAt(0).toUpperCase() + section.replace('.md', '').slice(1);
    brief += `## ${title}\n\n${content || '_(empty)_'}\n\n`;
  }

  const briefPath = path.join(memDir, 'BRIEF.md');
  fs.writeFileSync(briefPath, brief, 'utf8');
  console.log(`Generated → .memory/BRIEF.md`);
}

module.exports = { command };