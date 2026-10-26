'use strict';

// OpenAI-compatible chat completions over raw fetch (zero dependencies). Serves three providers:
//
//   openrouter POST https://openrouter.ai/api/v1/chat/completions   (default)
//   groq       POST https://api.groq.com/openai/v1/chat/completions
//   openai     POST <baseUrl or https://api.openai.com/v1>/chat/completions
//
// OpenRouter: max_tokens instead of max_completion_tokens, reasoning as {effort, exclude}.
//
// headers  Authorization: Bearer <key>, content-type: application/json
// body     {model, max_completion_tokens, response_format?, messages, reasoning_effort?, include_reasoning?}
// reply    {id, model, choices:[{message:{content}}], usage:{prompt_tokens, completion_tokens}}
//
// Groq shape checked against console.groq.com/docs (models, structured-outputs, reasoning,
// rate-limits), 22 Oct 2026, and by live calls recorded in docs/V1_REQUIREMENTS.md.
// response_format: strict json_schema on models Groq lists for strict mode, else json_object.
// If a host rejects json_schema, the call is repeated once with json_object.
// OpenAI itself: json_object; the Responses API is not used.

const { ProviderError, postJson, withRetries, errorFor } = require('./provider');
const limits = require('./limits');
const { apiKey } = require('../config');

const URL = 'https://api.openai.com/v1/chat/completions';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// console.groq.com/docs/structured-outputs: strict json_schema support (22 Oct 2026).
const GROQ_STRICT = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'meta-models/muse-spark-open']);

// config.baseUrl points the same wire format at any OpenAI-compatible host
// (Gemini's /v1beta/openai, OpenRouter, a local Ollama, …).
function endpoint(cfg) {
  if (cfg && cfg.baseUrl) return cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  if (cfg && cfg.provider === 'groq') return GROQ_URL;
  if (cfg && cfg.provider === 'openrouter') return OPENROUTER_URL;
  return URL;
}

// 'json_schema' | 'json_object' | 'none' for one call.
function formatFor(cfg, model, { json = true, schema = null } = {}) {
  if (!json) return 'none';
  const wanted = cfg.responseFormat || 'auto';
  if (wanted === 'none') return 'none';
  if (wanted === 'json_schema') return schema ? 'json_schema' : 'json_object';
  if (wanted === 'json_object') return 'json_object';
  if (cfg.provider === 'groq' && !cfg.baseUrl && schema && GROQ_STRICT.has(model)) return 'json_schema';
  if (cfg.provider === 'openrouter' && !cfg.baseUrl && schema) return 'json_schema';
  return 'json_object';
}

function responseFormat(format, schema) {
  if (format === 'json_schema') {
    return { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } };
  }
  if (format === 'json_object') return { type: 'json_object' };
  return undefined;
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

function errorMessage(name, status, text) {
  let detail = '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.error && typeof parsed.error.message === 'string') detail = parsed.error.message;
  } catch (_) { /* non-JSON error body */ }
  return name + ' ' + status + (detail ? ': ' + detail.slice(0, 200) : '');
}

function create(cfg, opts = {}) {
  const name = cfg.provider === 'groq' || cfg.provider === 'openrouter' ? cfg.provider : 'openai';
  const key = opts.apiKey !== undefined ? opts.apiKey : apiKey(cfg);
  // Once a host refuses json_schema, stay on json_object for the rest of this run.
  let schemaRefused = false;

  async function once({ system, user, maxTokens, model, format, schema }) {
    // Strict schemas list every key as required; without this hint models drop the unused ones.
    const sys = format === 'json_schema'
      ? system + '\nEvery item must contain every key of the schema: use null for fields that do not apply and [] for empty lists.'
      : system;
    const body = { model };
    if (name === 'openrouter') body.max_tokens = maxTokens;
    else body.max_completion_tokens = maxTokens;
    body.messages = [{ role: 'system', content: sys }, { role: 'user', content: user }];
    const rf = responseFormat(format, schema);
    if (rf) body.response_format = rf;
    if (name === 'groq' && /^openai\/gpt-oss/.test(model)) {
      if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
      body.include_reasoning = false;
    }
    if (name === 'openrouter' && cfg.reasoningEffort) body.reasoning = { effort: cfg.reasoningEffort, exclude: true };
    const res = await postJson(endpoint(cfg), {
      headers: { authorization: 'Bearer ' + key },
      body,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl
    });
    const requestId = (res.headers && typeof res.headers.get === 'function' && res.headers.get('x-request-id')) || null;
    const seen = limits.fromHeaders(res.headers);
    if (seen) limits.record(name, model, seen);
    if (res.status !== 200) {
      const err = errorFor(name, res, errorMessage(name, res.status, res.text), requestId);
      if (err.kind === 'too_large' && err.limit) limits.record(name, model, { learnedTokenLimit: err.limit });
      throw err;
    }
    let parsed;
    try { parsed = JSON.parse(res.text); } catch (err) {
      throw new ProviderError(name + ' returned invalid JSON envelope', { kind: 'retryable', status: res.status, requestId });
    }
    const usage = parsed.usage || {};
    return {
      text: textOf(parsed),
      usage: { input: Number(usage.prompt_tokens) || 0, output: Number(usage.completion_tokens) || 0 },
      model: parsed.model || model,
      requestId: parsed.id || requestId,
      format,
      limits: seen
    };
  }

  return {
    name,
    model: cfg.model,
    async complete({ system, user, maxTokens = 2000, model = cfg.model, json = true, schema = null }) {
      if (!key) throw new ProviderError('no API key for ' + name + ' — run `memo key set`', { kind: 'auth' });
      let format = formatFor(cfg, model, { json, schema });
      if (format === 'json_schema' && schemaRefused) format = 'json_object';
      const run = (fmt, retryOpts) => withRetries(name, () => once({ system, user, maxTokens, model, format: fmt, schema }),
        { ...opts, ...retryOpts });
      if (format !== 'json_schema') return run(format, {});
      try {
        // One retry on a schema miss, then JSON mode: the validator still checks everything.
        return await run('json_schema', { invalidOutputAttempts: 2 });
      } catch (err) {
        const refused = err.kind === 'bad_request' && /response_format|json_schema|schema/i.test(err.message);
        if (err.kind !== 'invalid_output' && !refused) throw err;
        schemaRefused = true;
        return run('json_object', {});
      }
    }
  };
}

module.exports = { create, URL, GROQ_URL, OPENROUTER_URL, GROQ_STRICT, endpoint, formatFor, textOf };
