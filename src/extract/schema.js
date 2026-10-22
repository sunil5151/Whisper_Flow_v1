'use strict';

// JSON Schema of the extraction reply, for providers with strict structured output
// (Groq gpt-oss: console.groq.com/docs/structured-outputs, read 22 Oct 2026).
// Strict mode needs every property in `required` and additionalProperties:false, so
// optional fields are nullable. extract/validate.js still checks everything afterwards.

const nullable = (type) => ({ type: [type, 'null'] });

const ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', enum: ['create', 'update'] },
    id: nullable('string'),
    type: nullable('string'),
    statement: nullable('string'),
    title: nullable('string'),
    status: nullable('string'),
    confidence: nullable('string'),
    evidence: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    rationale: nullable('string'),
    priority: nullable('string'),
    effort_estimate: nullable('string'),
    capability: nullable('string'),
    capability_reason: nullable('string')
  }
};
ITEM.required = Object.keys(ITEM.properties);

const EXTRACTION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schema: { type: 'integer' },
    session_summary: { type: 'string' },
    items: { type: 'array', items: ITEM },
    gaps: { type: 'array', items: { type: 'string' } }
  },
  required: ['schema', 'session_summary', 'items', 'gaps']
};

module.exports = { EXTRACTION, NAME: 'memo_extraction' };
