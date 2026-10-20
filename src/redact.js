'use strict';

const PATTERNS = [
  { regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { regex: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { regex: /sk-[A-Za-z0-9_-]{16,}/g },
  { regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { regex: /AKIA[0-9A-Z]{16}/g },
  { regex: /AIza[0-9A-Za-z_-]{35,}/g },
  { regex: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { regex: /eyJ[\w-]+\.[\w-]+\.[\w-]+/g },
  { regex: /Bearer\s+\S+/gi },
  // scheme://user:pass@host → scheme://[REDACTED]@host
  { regex: /\b([A-Za-z][\w+.-]*):\/\/[^\s:@/]+:[^\s@/]+@/g, replace: (m, scheme) => `${scheme}://[REDACTED]@` },
  // .env style lines: NAME=value (value ≥ 8 chars)
  { regex: /^([A-Z][A-Z0-9_]{2,})=(?!\[REDACTED\])\S{8,}$/gm, replace: (m, name) => `${name}=[REDACTED]` },
  // long base64/hex tokens shortly after the words key / secret / token
  {
    regex: /\b(key|secret|token)\b([^\n]{0,20}?)([A-Za-z0-9+/=_-]{40,})/gi,
    replace: (m, word, mid) => `${word}${mid}[REDACTED]`
  },
  {
    regex: /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*([:=])\s*(?!\[REDACTED\])(\S+)/gi,
    replace: (m, label, sep) => `${label}${sep}[REDACTED]`
  }
];

const DEFAULT_DENY_PATHS = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'credentials*.json', 'secrets/**'];

function redact(text) {
  if (typeof text !== 'string') return { text: '', count: 0 };
  let count = 0;
  let redacted = text;
  for (const pattern of PATTERNS) {
    redacted = redacted.replace(pattern.regex, (...args) => {
      count++;
      return pattern.replace ? pattern.replace(...args) : '[REDACTED]';
    });
  }
  return { text: redacted, count };
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

// true → the path matches a deny pattern and everything about it must be dropped.
// Patterns without "/" match any path segment; patterns with "/" match from any segment start.
function redactPath(relPath, denyPaths = DEFAULT_DENY_PATHS) {
  if (typeof relPath !== 'string' || !relPath) return false;
  const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const glob of denyPaths) {
    const re = globToRegex(glob);
    if (glob.includes('/')) {
      for (let i = 0; i < parts.length; i++) if (re.test(parts.slice(i).join('/'))) return true;
    } else if (parts.some((seg) => re.test(seg))) {
      return true;
    }
  }
  return false;
}

module.exports = { redact, redactPath, DEFAULT_DENY_PATHS };
