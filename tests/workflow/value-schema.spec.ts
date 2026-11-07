import { describe, expect, it } from 'vitest'
import { admitWorkflowData, compileValueSchema, validateWorkflowValue, WorkflowCompileError, WorkflowValueError } from '../../src/workflow/index.ts'
import type { WorkflowDataLimits } from '../../src/workflow/index.ts'

const limits: WorkflowDataLimits = { maxBytes: 20_000, maxDepth: 32, maxValues: 1000 }
const validate = (schema: unknown, value: unknown) => validateWorkflowValue(compileValueSchema(schema, limits), value, limits)

describe('workflow value schema', () => {
  it('projects declared required properties and checks every nested value without coercion', () => {
    const schema = compileValueSchema({ type: 'object', required: ['message', 'scores'], additionalProperties: false, properties: {
      message: { type: 'string', minLength: 2, maxLength: 10 },
      scores: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'integer', minimum: 0, maximum: 5 } },
      enabled: { type: 'boolean', enum: [true] }, empty: { type: 'null' },
    } }, limits)
    const input = { message: '支援', scores: [1, 2], enabled: true, empty: null }
    const value = validateWorkflowValue(schema, input, limits)
    expect(value).toEqual(input)
    expect(value).not.toBe(input)
    expect(Object.isFrozen(value)).toBe(true)
    expect(schema.valueType).toEqual({ kind: 'object', required: ['message', 'scores'], properties: {
      message: { kind: 'string' }, scores: { kind: 'array', items: { kind: 'number' } },
      enabled: { kind: 'boolean' }, empty: { kind: 'null' },
    } })
    for (const changed of [{ ...input, scores: ['2'] }, { ...input, scores: [1.5] }, { ...input, scores: [-1] },
      { ...input, scores: [6] }, { ...input, scores: [] }, { ...input, scores: [1, 2, 3, 4] }, { ...input, message: 'x' },
      { ...input, message: 'x'.repeat(11) }, { ...input, enabled: false }, { ...input, empty: false }, { scores: [1] },
      { ...input, secret: 'must-not-appear' }]) {
      expect(() => validateWorkflowValue(schema, changed, limits)).toThrow(WorkflowValueError)
      try { validateWorkflowValue(schema, changed, limits) } catch (error) { expect(String(error)).not.toContain('must-not-appear') }
    }
    expect(() => validateWorkflowValue(structuredClone(schema), input, limits)).toThrow(/receipt/u)
  })

  it.each([
    [{ type: 'string', enum: ['a', 'b'] }, 'a'], [{ type: 'number', minimum: -2 }, -1.5],
    [{ type: 'boolean' }, false], [{ type: 'null', enum: [null] }, null],
    [{ type: 'object' }, { arbitrary: true }], [{ type: 'object', properties: {}, additionalProperties: true }, {}],
    [{ type: 'array', items: { type: 'object' } }, []],
  ])('accepts the declared subset %j', (schema, value) => {
    expect(validate(schema, value)).toEqual(value)
  })

  it.each([
    true, {}, { type: 'unknown' }, { type: ['string', 'null'] }, { type: 'array' },
    { type: 'object', required: ['missing'] }, { type: 'object', required: ['a', 'a'], properties: { a: { type: 'string' } } },
    { type: 'string', pattern: '(a+)+$' }, { type: 'string', format: 'uri' }, { $ref: 'https://example.invalid/schema' },
    { type: 'string', default: 'hidden' }, { type: 'string', enum: [] }, { type: 'string', enum: ['a', 'a'] },
    { type: 'number', maximum: '3' }, { type: 'string', minLength: -1 },
    { type: 'object', additionalProperties: { type: 'string' } }, { type: 'object', properties: { nested: { type: 'string', unknown: true } } },
  ])('rejects unsupported or inconsistent schemas without loading references: %j', (schema) => {
    expect(() => compileValueSchema(schema, limits)).toThrow(WorkflowCompileError)
  })

  it('bounds schemas and complete JSON values before validation', () => {
    expect(() => compileValueSchema({ type: 'object' }, { ...limits, maxBytes: 5 })).toThrow(/byte/u)
    expect(() => admitWorkflowData({ value: 'x' }, { ...limits, maxValues: 1 })).toThrow(/bounded/u)
    expect(() => admitWorkflowData({ a: { b: 1 } }, { ...limits, maxDepth: 1 })).toThrow(/bounded/u)
    for (const patch of [{ maxBytes: 0 }, { maxValues: 1.5 }, { maxDepth: 129 }]) {
      expect(() => admitWorkflowData(null, { ...limits, ...patch })).toThrow(/budgets/u)
    }
    for (const value of [undefined, NaN, Infinity, { hidden: undefined }, new Date(), new Array(1000)]) {
      expect(() => admitWorkflowData(value, limits)).toThrow(WorkflowValueError)
    }
    expect(admitWorkflowData('支援', { ...limits, maxBytes: 8 })).toBe('支援')
    expect(() => admitWorkflowData('支援', { ...limits, maxBytes: 7 })).toThrow(/byte/u)
    expect(validate({ type: 'object', properties: { absent: { type: 'string' } } }, {})).toEqual({})
  })
})
