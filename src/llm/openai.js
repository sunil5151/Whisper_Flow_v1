'use strict';

// OpenAI provider over raw fetch (zero dependencies).
//
// Endpoint used: POST <baseUrl or https://api.openai.com/v1>/chat/completions — the endpoint named
// in the P2 spec — with response_format {type:'json_object'} (JSON mode), headers
// Authorization: Bearer <key>, content-type: application/json.
//   body  {model, max_completion_tokens, response_format, messages:[{role:'system'},{role:'user'}]}
//   reply {id, model, choices:[{message:{content}}], usage:{prompt_tokens, completion_tokens}}
//
// UNVERIFIED: no live docs page was fetched for this task (no network allowed), and
// docs/PHASE0_FINDINGS.md §6–§7 are still a template, so the Responses-API question the
// plan raises is unresolved. max_completion_tokens is sent because max_tokens is rejected
// by newer models; if a model rejects it, this is the first thing to change.

const { ProviderError, postJson, withRetries, kindForStatus, retryAfterMs, looksLikeQuota, looksLikeRateLimit } = require('./provider');
const { apiKey } = require('../config');

const URL = 'https://api.openai.com/v1/chat/completions';

// config.baseUrl points the same wire format at any OpenAI-compatible host
// (Gemini's /v1beta/openai, Groq, OpenRouter, a local Ollama, …).
function endpoint(cfg) {
  return cfg && cfg.baseUrl ? cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions' : URL;
}

function textOf(body) {
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  const message = choice && choice.message;
  if (!message) return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
  }
  return '';
}

function errorMessage(status, text) {
  let detail = '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.error && typeof parsed.error.message === 'string') detail = parsed.error.message;
  } catch (_) { /* non-JSON error body */ }
  return 'openai ' + status + (detail ? ': ' + detail.slice(0, 200) : '');
}

function create(cfg, opts = {}) {
  const key = opts.apiKey !== undefined ? opts.apiKey : apiKey(cfg);
  return {
    name: 'openai',
    model: cfg.model,
    async complete({ system, user, maxTokens = 2000, model = cfg.model }) {
      if (!key) throw new ProviderError('no API key in env ' + cfg.apiKeyEnv, { kind: 'auth' });
      return withRetries('openai', async () => {
        const res = await postJson(endpoint(cfg), {
          headers: { authorization: 'Bearer ' + key },
          body: {
            model,
            max_completion_tokens: maxTokens,
            response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
          },
          timeoutMs: opts.timeoutMs,
          fetchImpl: opts.fetchImpl
        });
        const requestId = (res.headers && typeof res.headers.get === 'function' && res.headers.get('x-request-id')) || null;
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
          throw new ProviderError('openai returned invalid JSON envelope', { kind: 'retryable', status: res.status, requestId });
        }
        const usage = body.usage || {};
        return {
          text: textOf(body),
          usage: { input: Number(usage.prompt_tokens) || 0, output: Number(usage.completion_tokens) || 0 },
          model: body.model || model,
          requestId: body.id || requestId
        };
      }, opts);
    }
  };
}

module.exports = { create, URL, endpoint, textOf };
