'use strict';

// Anthropic Messages API over raw fetch (zero dependencies, plan rule §0.3).
//
// Shape used: POST https://api.anthropic.com/v1/messages
//   headers x-api-key, anthropic-version: 2023-06-01, content-type: application/json
//   body    {model, max_tokens, system, messages:[{role:'user', content}]}
//   reply   {id, model, content:[{type:'text',text}], usage:{input_tokens,output_tokens}, stop_reason}
// Source: bundled claude-api reference (Messages API / current model ids + pricing),
// read 2026-10-21. No live docs call was made, so treat the exact shape as UNVERIFIED
// against today's published docs until one real call succeeds.
//
// Structured-output / JSON mode is deliberately NOT used: the plan allows it only if
// P0 verified it in current docs, and docs/PHASE0_FINDINGS.md §7 is still a template.
// Plain text + extract/validate.js instead.
//
// Note: current Haiku/Sonnet/Opus models think by default and return thinking blocks
// with empty text before the answer, so every text block is collected, not content[0].

const { ProviderError, postJson, withRetries, kindForStatus, retryAfterMs, looksLikeQuota, looksLikeRateLimit } = require('./provider');
const { apiKey } = require('../config');

const URL = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

function textOf(body) {
  if (!body || !Array.isArray(body.content)) return '';
  return body.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

function errorMessage(status, text) {
  let detail = '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.error && typeof parsed.error.message === 'string') detail = parsed.error.message;
    else if (parsed && typeof parsed.message === 'string') detail = parsed.message;
  } catch (_) { /* non-JSON error body */ }
  return 'anthropic ' + status + (detail ? ': ' + detail.slice(0, 200) : '');
}

function create(cfg, opts = {}) {
  const key = opts.apiKey !== undefined ? opts.apiKey : apiKey(cfg);
  return {
    name: 'anthropic',
    model: cfg.model,
    async complete({ system, user, maxTokens = 2000, model = cfg.model }) {
      if (!key) throw new ProviderError('no API key in env ' + cfg.apiKeyEnv, { kind: 'auth' });
      return withRetries('anthropic', async () => {
        const res = await postJson(URL, {
          headers: { 'x-api-key': key, 'anthropic-version': VERSION },
          body: { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] },
          timeoutMs: opts.timeoutMs,
          fetchImpl: opts.fetchImpl
        });
        const requestId = (res.headers && typeof res.headers.get === 'function' && res.headers.get('request-id')) || null;
        if (res.status !== 200) {
          const kind = looksLikeQuota(res.status, res.text) ? 'quota'
            : looksLikeRateLimit(res.status, res.text) ? 'retryable'
              : kindForStatus(res.status);
          throw new ProviderError(errorMessage(res.status, res.text), {
            kind, status: res.status, retryAfterMs: retryAfterMs(res.headers), requestId
          });
        }
        let body;
        try { body = JSON.parse(res.text); } catch (err) {
          throw new ProviderError('anthropic returned invalid JSON envelope', { kind: 'retryable', status: res.status, requestId });
        }
        if (body.stop_reason === 'refusal') {
          throw new ProviderError('anthropic declined this request (stop_reason refusal)', {
            kind: 'bad_request', status: res.status, requestId: body.id || requestId
          });
        }
        const usage = body.usage || {};
        return {
          text: textOf(body),
          usage: { input: Number(usage.input_tokens) || 0, output: Number(usage.output_tokens) || 0 },
          model: body.model || model,
          requestId: body.id || requestId
        };
      }, opts);
    }
  };
}

module.exports = { create, URL, VERSION, textOf };
