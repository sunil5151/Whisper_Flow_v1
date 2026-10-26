'use strict';

// One-field browser page for the API key, served on 127.0.0.1 only for the length of setup.
// The page posts the key to this process; the process stores it encrypted and makes one tiny
// real request, so the person sees "connected" (or the exact problem) before leaving the page.

const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PAGE = (provider, label, keyUrl, token) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MEMO setup</title>
<style>
:root{--bg:#0b0f17;--card:#121826;--line:#243049;--text:#e8edf7;--mute:#8b97b1;--accent:#6ea8ff;--ok:#4ade80;--bad:#f87171}
@media (prefers-color-scheme:light){:root{--bg:#f3f6fb;--card:#fff;--line:#d9e1ef;--text:#101828;--mute:#5b6678;--accent:#2563eb;--ok:#16a34a;--bad:#dc2626}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,Segoe UI,sans-serif}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 28px;box-shadow:0 20px 60px rgba(0,0,0,.25)}
.logo{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,var(--accent),#a78bfa);display:grid;place-items:center;font-weight:800;color:#fff;margin-bottom:18px}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 20px;color:var(--mute);font-size:14px}
label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--text);font:15px ui-monospace,Consolas,monospace}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:600 15px system-ui;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
a{color:var(--accent)}.hint{margin:12px 0 0;font-size:13px}
#msg{margin-top:14px;font-size:14px;min-height:20px}.ok{color:var(--ok)}.bad{color:var(--bad)}
.lock{margin-top:22px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--mute)}
</style></head><body><main>
<div class="logo">M</div>
<h1>Connect MEMO</h1>
<p>One last step. Paste your ${label} key and MEMO takes care of the rest.</p>
<form id="f"><label for="k">${provider} API key</label>
<input id="k" type="password" autocomplete="off" spellcheck="false" placeholder="sk-or-v1-…" autofocus required>
<button id="b" type="submit">Connect</button></form>
${keyUrl ? `<p class="hint">No key yet? <a href="${keyUrl}" target="_blank" rel="noopener">Get one here</a> — it takes a minute.</p>` : ''}
<div id="msg" role="status"></div>
<div class="lock">🔒 Stored encrypted for your Windows account. Never written to a repo, never shown again.</div>
</main>
<script>
const f=document.getElementById('f'),k=document.getElementById('k'),b=document.getElementById('b'),m=document.getElementById('msg');
f.addEventListener('submit',async e=>{e.preventDefault();b.disabled=true;m.className='';m.textContent='Checking your key…';
try{const r=await fetch('/key',{method:'POST',headers:{'content-type':'application/json','x-memo-token':'${token}'},body:JSON.stringify({key:k.value})});
const j=await r.json();
if(j.ok){f.style.display='none';m.className='ok';m.textContent='✓ Connected. You can close this tab and go back to your terminal.';}
else{m.className='bad';m.textContent=j.error||'That key did not work.';b.disabled=false;k.select();}
}catch(_){m.className='bad';m.textContent='Lost contact with MEMO setup. Is the terminal still running?';b.disabled=false;}});
</script></body></html>`;

function openBrowser(url) {
  try {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Serves the key page until a key is accepted by `submit(key)` (which resolves {ok, error?}),
 * or `timeoutMs` passes. Resolves true when a key was accepted, false otherwise.
 */
function collectKey({ provider, label, keyUrl, submit, timeoutMs = 10 * 60 * 1000, open = openBrowser, onUrl = () => {} }) {
  return new Promise((resolve) => {
    const token = crypto.randomBytes(16).toString('hex');
    let done = false;
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(PAGE(provider, label, keyUrl, token));
        return;
      }
      if (req.method === 'POST' && req.url === '/key' && req.headers['x-memo-token'] === token) {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', async () => {
          let result;
          try { result = await submit(String(JSON.parse(body).key || '').trim()); } catch (err) { result = { ok: false, error: err.message }; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          if (result.ok) finish(true);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      setTimeout(() => { server.close(); if (server.closeAllConnections) server.closeAllConnections(); resolve(ok); }, 300);
    }
    server.on('error', () => finish(false));
    server.listen(0, '127.0.0.1', () => {
      const url = 'http://127.0.0.1:' + server.address().port + '/';
      onUrl(url);
      if (!open(url)) onUrl(url);
    });
  });
}

module.exports = { collectKey, openBrowser, PAGE };
