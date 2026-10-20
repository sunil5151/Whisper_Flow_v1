'use strict';

const PATTERNS = [
  { regex: /sk-[A-Za-z0-9_-]{16,}/g, keepLabel: false },
  { regex: /gh[pousr]_[A-Za-z0-9]{20,}/g, keepLabel: false },
  { regex: /github_pat_[A-Za-z0-9_]{20,}/g, keepLabel: false },
  { regex: /AKIA[0-9A-Z]{16}/g, keepLabel: false },
  { regex: /AIza[0-9A-Za-z_-]{35,}/g, keepLabel: false },
  { regex: /xox[abprs]-[A-Za-z0-9-]{10,}/g, keepLabel: false },
  { regex: /eyJ[\w-]+\.[\w-]+\.[\w-]+/g, keepLabel: false },
  { regex: /Bearer\s+\S+/gi, keepLabel: false },
  { regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, keepLabel: false },
  { regex: /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*([:=])\s*(\S+)/gi, keepLabel: true }
];

function redact(text) {
  if (typeof text !== 'string') return { text: '', count: 0 };
  let count = 0;
  let redacted = text;
  for (const pattern of PATTERNS) {
    redacted = redacted.replace(pattern.regex, (match, label, separator) => {
      count++;
      if (pattern.keepLabel && label && separator) return `${label}${separator}[REDACTED]`;
      return '[REDACTED]';
    });
  }
  return { text: redacted, count };
}

module.exports = { redact };
