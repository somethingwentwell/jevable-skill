import { describe, expect, it } from 'vitest'
import { compileValueSchema, validateWorkflowValue } from '../../src/workflow/value-schema.ts'
import { WorkflowValueError } from '../../src/workflow/errors.ts'

const limits = { maxBytes: 100000, maxDepth: 32, maxValues: 10000 }

describe('bounded weak schema receipt reuse', () => {
  it('reuses only validated immutable receipts without admitting caller mutations or deserialized copies', () => {
    const input = { type: 'string', enum: ['receipt-a'], description: 'Receipt cache test' }
    const first = compileValueSchema(input, limits)
    expect(compileValueSchema(structuredClone(input), limits)).toBe(first)
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.definition)).toBe(true)
    input.enum[0] = 'receipt-b'
    const changed = compileValueSchema(input, limits)
    expect(changed).not.toBe(first)
    expect(validateWorkflowValue(first, 'receipt-a', limits)).toBe('receipt-a')
    expect(() => validateWorkflowValue(first, 'receipt-b', limits)).toThrow()
    expect(validateWorkflowValue(changed, 'receipt-b', limits)).toBe('receipt-b')
    expect(() => validateWorkflowValue({ ...first }, 'receipt-a', limits)).toThrow(WorkflowValueError)
  })

  it('checks every invocation budget and schema admission even when an identical receipt exists', () => {
    const input = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }
    const receipt = compileValueSchema(input, limits)
    for (const policy of [{ ...limits, maxBytes: 1 }, { ...limits, maxDepth: 1 }, { ...limits, maxValues: 1 }])
      expect(() => compileValueSchema(input, policy)).toThrow()
    expect(() => compileValueSchema({ ...input, coercion: true }, limits)).toThrow()
    expect(compileValueSchema(input, limits)).toBe(receipt)
    expect(() => validateWorkflowValue(receipt, { message: 17 }, limits)).toThrow()
    expect(() => validateWorkflowValue(receipt, { message: 'too-long' }, { ...limits, maxBytes: 2 })).toThrow()
  })

  it('bounds receipt lookup without invalidating held receipts or mixing different constraints', () => {
    const first = compileValueSchema({ type: 'string', enum: ['bounded-first'] }, limits)
    const held = Array.from({ length: 140 }, (_, index) => compileValueSchema({ type: 'string', enum: [`bounded-${index}`] }, limits))
    const again = compileValueSchema({ type: 'string', enum: ['bounded-first'] }, limits)
    expect(again).not.toBe(first)
    expect(validateWorkflowValue(first, 'bounded-first', limits)).toBe('bounded-first')
    for (const [index, receipt] of held.entries()) {
      expect(validateWorkflowValue(receipt, `bounded-${index}`, limits)).toBe(`bounded-${index}`)
      expect(() => validateWorkflowValue(receipt, 'bounded-first', limits)).toThrow()
    }
  })
})
