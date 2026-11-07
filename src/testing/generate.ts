/** Schema samples only: no graph execution, provider calls or inferred business expectations. */
import { validateWorkflowValue, type CompiledValueSchema, type WorkflowDataLimits, type WorkflowValueSchemaDefinition } from '../workflow/index.ts'
import type { JsonValue } from '../workflow/index.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'

export const GENERATOR_VERSION = 'schema-boundary/v1' as const
export const GENERATION_LIMITS = Object.freeze({ candidates: 32, attempts: 256, inputBytes: 100000,
  totalInputBytes: 1000000, values: 10000, depth: 32, stringLength: 16384, arrayItems: 256 })
export type SampleReason = 'sample' | 'required-only' | 'enum' | 'boolean' | 'minimum' | 'maximum' | 'empty' | 'optional-omitted' | 'array-length'
type Schema = WorkflowValueSchemaDefinition
type Path = (string | number)[]
type Budget = { values: number; bytes: number; depth: number }
class SampleLimit extends Error {}
class NoSample extends Error {}
const pointer = (path: Path) => path.map(key => '/' + String(key).replace(/~/gu, '~0').replace(/\//gu, '~1')).join('')
const countBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
function scalarMatches(schema: Schema, value: string | number | boolean | null) {
  if (schema.type === 'null') return value === null
  if (schema.type === 'boolean') return typeof value === 'boolean'
  if (schema.type === 'string') return typeof value === 'string' && [...value].length >= (schema.minLength ?? 0) && [...value].length <= (schema.maxLength ?? Infinity)
  return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isInteger(value))
    && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity)
}

/** Allocation budgets apply while constructing values, not only after large arrays/strings exist. */
function seed(schema: Schema, budget: Budget, requiredOnly = false, depth = 0): JsonValue {
  if (--budget.values < 0 || depth > budget.depth) throw new SampleLimit()
  if (schema.enum) {
    const valid = schema.enum.filter(item => scalarMatches(schema, item))
    if (!valid.length) throw new NoSample()
    const value = valid.find(item => countBytes(item) <= budget.bytes)
    if (value === undefined) throw new SampleLimit()
    if ((budget.bytes -= countBytes(value)) < 0) throw new SampleLimit()
    return value
  }
  if (schema.type === 'object') {
    if ((budget.bytes -= 2) < 0) throw new SampleLimit()
    const entries: [string, JsonValue][] = [], properties = schema.properties ?? {}, required = new Set(schema.required ?? [])
    for (const key of new Set([...Object.keys(properties), ...required])) {
      if (requiredOnly && !required.has(key)) continue
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new NoSample()
      const saved = { ...budget }
      try {
        if ((budget.bytes -= countBytes(key) + 1 + (entries.length ? 1 : 0)) < 0) throw new SampleLimit()
        const child = properties[key]
        if (!child && schema.additionalProperties === false) throw new NoSample()
        entries.push([key, child ? seed(child, budget, requiredOnly, depth + 1) : seed({ type: 'null' }, budget, requiredOnly, depth + 1)])
      } catch (error) {
        if (required.has(key) || !(error instanceof SampleLimit || error instanceof NoSample)) throw error
        Object.assign(budget, saved) // An impossible optional field must not prevent a valid required-only input.
      }
    }
    return Object.fromEntries(entries)
  }
  if (schema.type === 'array') {
    if ((budget.bytes -= 2) < 0) throw new SampleLimit()
    const count = Math.max(schema.minItems ?? 0, requiredOnly ? 0 : Math.min(1, schema.maxItems ?? 1))
    if (count > (schema.maxItems ?? Infinity) || !schema.items) throw new NoSample()
    if (count > GENERATION_LIMITS.arrayItems || count > budget.values) throw new SampleLimit()
    return Array.from({ length: count }, (_, index) => {
      if (index && --budget.bytes < 0) throw new SampleLimit()
      return seed(schema.items!, budget, requiredOnly, depth + 1)
    })
  }
  let value: JsonValue
  if (schema.type === 'string') {
    const length = Math.max(schema.minLength ?? 0, Math.min(6, schema.maxLength ?? 6, Math.max(0, budget.bytes - 2)))
    if (length > (schema.maxLength ?? Infinity)) throw new NoSample()
    if (length > GENERATION_LIMITS.stringLength || length > budget.bytes) throw new SampleLimit()
    value = 'sample'.padEnd(length, 'x').slice(0, length)
  } else if (schema.type === 'number' || schema.type === 'integer') {
    const lower = schema.type === 'integer' ? Math.ceil(schema.minimum ?? -Infinity) : schema.minimum ?? -Infinity
    const upper = schema.type === 'integer' ? Math.floor(schema.maximum ?? Infinity) : schema.maximum ?? Infinity
    value = Math.max(lower, Math.min(0, upper))
    if (!Number.isFinite(value) || value > upper || !scalarMatches(schema, value)) throw new NoSample()
  } else value = schema.type === 'boolean' ? true : null
  if ((budget.bytes -= countBytes(value)) < 0) throw new SampleLimit()
  return value
}

type Variation = { path: Path; reason: SampleReason; value?: JsonValue; omit?: true; oversized?: true }
function* variations(schema: Schema, value: JsonValue, path: Path = []): Generator<Variation> {
  if (schema.enum) {
    for (const option of schema.enum) yield { path, reason: 'enum', value: option }
  } else if (schema.type === 'boolean') {
    yield { path, reason: 'boolean', value: false }; yield { path, reason: 'boolean', value: true }
  } else if (schema.type === 'integer' || schema.type === 'number') {
    for (const [bound, reason] of [[schema.minimum, 'minimum'], [schema.maximum, 'maximum']] as const) {
      if (bound === undefined) continue
      const number = schema.type === 'integer' ? reason === 'minimum' ? Math.ceil(bound) : Math.floor(bound) : bound
      yield { path, reason, value: number }
    }
  } else if (schema.type === 'string') {
    for (const [length, reason] of [[schema.minLength ?? 0, 'minimum'], [schema.maxLength, 'maximum']] as const) {
      if (length === undefined) continue
      if (length > GENERATION_LIMITS.stringLength) yield { path, reason, oversized: true }
      else yield { path, reason: length === 0 ? 'empty' : reason, value: 'x'.repeat(length) }
    }
  } else if (schema.type === 'array' && Array.isArray(value)) {
    for (const count of new Set([schema.minItems ?? 0, 1, 2, schema.maxItems].filter((n): n is number => n !== undefined))) {
      if (count < (schema.minItems ?? 0) || count > (schema.maxItems ?? Infinity)) continue
      if (count > GENERATION_LIMITS.arrayItems) { yield { path, reason: 'array-length', oversized: true }; continue }
      try {
        const budget = { values: GENERATION_LIMITS.values, bytes: GENERATION_LIMITS.inputBytes, depth: GENERATION_LIMITS.depth }
        yield { path, reason: 'array-length', value: Array.from({ length: count }, () => seed(schema.items!, budget)) }
      } catch (error) {
        if (!(error instanceof SampleLimit || error instanceof NoSample)) throw error
        yield { path, reason: 'array-length', oversized: true }
      }
    }
    if (value.length) yield* variations(schema.items!, value[0]!, [...path, 0])
  } else if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(value, key)) continue
      if (!schema.required?.includes(key)) yield { path: [...path, key], reason: 'optional-omitted', omit: true }
      yield* variations(child, value[key]!, [...path, key])
    }
  }
}

function change(base: JsonValue, variation: Variation): JsonValue {
  if (!variation.path.length) return structuredClone(variation.value!)
  const copy = structuredClone(base)
  let parent = copy as Record<string | number, JsonValue>
  for (const key of variation.path.slice(0, -1)) parent = parent[key] as Record<string | number, JsonValue>
  const key = variation.path.at(-1)!
  if (variation.omit) delete parent[key]
  else parent[key] = structuredClone(variation.value!)
  return copy
}

/** Generate bounded, unique, fully validated inputs in stable order. This does not establish branch coverage. */
export function generateInputs(compiled: CompiledValueSchema, limits: WorkflowDataLimits, requested = 12) {
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > GENERATION_LIMITS.candidates) throw new WorkflowRuntimeError('invalid-command')
  const candidates: { input: JsonValue; reason: SampleReason; path: string }[] = [], seen = new Set<string>()
  const diagnostics = { attempted: 0, invalid: 0, skippedBounds: 0, totalInputBytes: 0, limitReached: false, noSeed: false }
  const budget = (): Budget => ({ values: Math.min(limits.maxValues, GENERATION_LIMITS.values),
    bytes: Math.min(limits.maxBytes, GENERATION_LIMITS.inputBytes), depth: Math.min(limits.maxDepth, GENERATION_LIMITS.depth) })
  const add = (input: JsonValue, reason: SampleReason, path: Path) => {
    if (candidates.length >= requested || diagnostics.attempted >= GENERATION_LIMITS.attempts) { diagnostics.limitReached = true; return false }
    diagnostics.attempted++
    const encoded = JSON.stringify(input), bytes = Buffer.byteLength(encoded)
    if (bytes > GENERATION_LIMITS.inputBytes || diagnostics.totalInputBytes + bytes > GENERATION_LIMITS.totalInputBytes) { diagnostics.skippedBounds++; return true }
    if (seen.has(encoded)) return true
    try { validateWorkflowValue(compiled, input, limits) }
    catch { diagnostics.invalid++; return true }
    seen.add(encoded); diagnostics.totalInputBytes += bytes
    candidates.push({ input, reason, path: pointer(path) }); return true
  }
  let base: JsonValue
  try { base = seed(compiled.definition, budget()) }
  catch (error) {
    if (!(error instanceof SampleLimit || error instanceof NoSample)) throw error
    if (error instanceof SampleLimit) diagnostics.skippedBounds++
    try { base = seed(compiled.definition, budget(), true) }
    catch (fallback) {
      if (!(fallback instanceof SampleLimit || fallback instanceof NoSample)) throw fallback
      diagnostics.noSeed = true; return { candidates, diagnostics }
    }
  }
  add(base, 'sample', [])
  try { add(seed(compiled.definition, budget(), true), 'required-only', []) }
  catch (error) { if (!(error instanceof SampleLimit || error instanceof NoSample)) throw error; diagnostics.skippedBounds++ }
  for (const variation of variations(compiled.definition, base)) {
    if (candidates.length >= requested || diagnostics.attempted >= GENERATION_LIMITS.attempts) { diagnostics.limitReached = true; break }
    if (variation.oversized || pointer(variation.path).length > 4096) { diagnostics.attempted++; diagnostics.skippedBounds++; continue }
    if (!add(change(base, variation), variation.reason, variation.path)) break
  }
  return { candidates, diagnostics }
}
