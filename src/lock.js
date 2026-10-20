'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sleepMs } = require('./util');

// Exclusive lock file. Returns { release, recovered } or null when busy.
// A lock older than staleMs is taken over (recovered: true).
function acquire(lockPath, { staleMs = 60000, waitMs = 0 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  let recovered = false;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      let released = false;
      return {
        recovered,
        release() {
          if (released) return;
          released = true;
          try { fs.unlinkSync(lockPath); } catch (_) { /* already gone */ }
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let age = 0;
    try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch (_) { continue; }
    if (age > staleMs) {
      try { fs.unlinkSync(lockPath); recovered = true; } catch (_) { /* raced */ }
      continue;
    }
    if (Date.now() >= deadline) return null;
    sleepMs(50);
  }
}

module.exports = { acquire };
