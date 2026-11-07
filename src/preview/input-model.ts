import type { WorkflowValueSchemaDefinition as Schema } from '../workflow/index.ts'

/** Pure, serializable input tools. Client checks aid editing; runtime admission remains authoritative. */
export function schemaInputTools() {
  const reserved = new Set(['__proto__', 'prototype', 'constructor'])
  const limits = { bytes: 1_000_000, values: 100_000, depth: 64, fields: 128, formDepth: 8, arrayItems: 32, enumItems: 100 }
  const fail = () => { throw Error('Input is not a bounded JSON value. Keep sensitive data out of shared previews.') }
  const snapshot = (value: unknown): any => {
    let count = 0
    const visit = (item: unknown, depth: number) => {
      if (++count > limits.values || depth > limits.depth) fail()
      if (item === null || typeof item === 'boolean') return
      if (typeof item === 'number') { if (!Number.isFinite(item)) fail(); return }
      if (typeof item === 'string') { if (item.length > limits.bytes) fail(); return }
      if (!item || typeof item !== 'object') fail()
      if (Array.isArray(item)) {
        if (item.length > limits.values || Object.keys(item).length !== item.length) fail()
        for (const child of item) visit(child, depth + 1)
      } else {
        if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail()
        for (const [key, child] of Object.entries(item!)) { if (reserved.has(key)) fail(); visit(child, depth + 1) }
      }
    }
    visit(value, 0)
    const json = JSON.stringify(value)
    if (new TextEncoder().encode(json).length > limits.bytes) fail()
    return JSON.parse(json)
  }
  const parse = (text: string) => {
    if (text.length > limits.bytes || new TextEncoder().encode(text).length > limits.bytes) fail()
    let value: unknown
    try { value = JSON.parse(text) } catch { throw Error('Enter valid JSON. The existing input has not been replaced.') }
    return snapshot(value)
  }
  const schema = (value: unknown): Schema => {
    const result = snapshot(value) as Schema
    let count = 0
    const visit = (item: Schema, depth: number) => {
      if (++count > limits.fields || depth > limits.formDepth || !item || typeof item !== 'object' || Array.isArray(item)) throw Error('Use JSON for this schema; it exceeds the field editor limits.')
      const allowed: Record<string, string[]> = { object: ['properties', 'required', 'additionalProperties'], array: ['items', 'minItems', 'maxItems'],
        string: ['enum', 'minLength', 'maxLength'], number: ['enum', 'minimum', 'maximum'], integer: ['enum', 'minimum', 'maximum'], boolean: ['enum'], null: ['enum'] }
      if (!Object.hasOwn(allowed, item.type) || Object.keys(item).some(key => !['type', 'description', ...allowed[item.type]!].includes(key))
        || (item.description !== undefined && typeof item.description !== 'string')) throw Error('Use JSON for this schema; its field type or constraints are unsupported.')
      for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength'] as const) if (item[key] !== undefined && (!Number.isSafeInteger(item[key]) || item[key]! < 0)) throw Error('Invalid schema bounds; use JSON and review the workflow.')
      for (const key of ['minimum', 'maximum'] as const) if (item[key] !== undefined && (typeof item[key] !== 'number' || !Number.isFinite(item[key]))) throw Error('Invalid schema bounds; use JSON and review the workflow.')
      if (item.enum !== undefined && (!Array.isArray(item.enum) || item.enum.length < 1 || item.enum.length > limits.enumItems || item.enum.some(v => v !== null && !['string', 'boolean', 'number'].includes(typeof v)))) throw Error('Use JSON for this schema; its choices cannot be represented safely.')
      if (item.type === 'object') {
        if (item.properties !== undefined && (!item.properties || typeof item.properties !== 'object' || Array.isArray(item.properties))) throw Error('Invalid object schema; use JSON.')
        if (item.required !== undefined && (!Array.isArray(item.required) || item.required.some(key => typeof key !== 'string' || !Object.hasOwn(item.properties ?? {}, key)))) throw Error('Use JSON for undeclared required fields.')
        if (item.additionalProperties !== undefined && typeof item.additionalProperties !== 'boolean') throw Error('Invalid object schema; use JSON.')
        for (const child of Object.values(item.properties ?? {})) visit(child, depth + 1)
      }
      if (item.type === 'array') visit(item.items!, depth + 1)
    }
    visit(result, 0); return result
  }
  const typeMatches = (s: Schema, value: unknown) => s.type === 'null' ? value === null
    : s.type === 'array' ? Array.isArray(value) : s.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : s.type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : typeof value === s.type
  const compatible = (s: Schema, input: unknown) => {
    const value = snapshot(input); let count = 0
    const visit = (s: Schema, value: any, depth: number) => {
      if (++count > limits.fields || depth > limits.formDepth || !typeMatches(s, value)) throw Error('Use JSON for this input; fields would change its types or exceed editor limits.')
      if (s.enum && !s.enum.some(option => option === value)) throw Error('Use JSON to correct a value outside its listed choices.')
      if (s.type === 'object') for (const [key, child] of Object.entries(s.properties ?? {})) {
        if (Object.hasOwn(value, key)) visit(child, value[key], depth + 1)
        else if (++count > limits.fields) throw Error('Use JSON for this input; too many optional fields.')
      }
      if (s.type === 'array') {
        if (value.length > limits.arrayItems) throw Error('Use JSON for arrays longer than 32 items; no entries were removed.')
        for (const item of value) visit(s.items!, item, depth + 1)
      }
    }
    visit(s, value, 0); return value
  }
  const seed = (s: Schema): any => {
    if (s.enum) { const option = s.enum.find(value => typeMatches(s, value)); if (option !== undefined) return option }
    if (s.type === 'object') return Object.fromEntries((s.required ?? []).map(key => [key, seed(s.properties![key]!)]))
    if (s.type === 'array') return []
    if (s.type === 'string') return ''
    if (s.type === 'number' || s.type === 'integer') return 0
    return s.type === 'boolean' ? false : null
  }
  const scalar = (s: Schema, text: string): any => {
    if (s.enum) {
      if (!/^(0|[1-9][0-9]*)$/.test(text) || Number(text) >= s.enum.length) throw Error('Choose one of the listed values.')
      return s.enum[Number(text)]
    }
    if (s.type === 'string') return text
    if (s.type === 'null') return null
    if (s.type === 'boolean') { if (text === 'true') return true; if (text === 'false') return false; throw Error('Choose true or false.') }
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text) || !Number.isFinite(Number(text))) throw Error('Enter a finite number using JSON number syntax; blank is not zero.')
    if (s.type === 'integer' && !Number.isInteger(Number(text))) throw Error('Enter an integer, not a fractional value.')
    return Number(text)
  }
  const validate = (s: Schema, input: unknown) => {
    const value = snapshot(input)
    // Describe only schema-declared fields and constraints, never entered values or unknown property names.
    const label = (path: string[]) => path.map(part => [...part].slice(0, 80).join('') + ([...part].length > 80 ? '…' : '')).join(' → ').slice(0, 400)
    const issue = (s: Schema, value: any, path: string[]): string | undefined => {
      const problem = (message: string) => `${label(path)}: ${message}`
      if (!typeMatches(s, value)) return problem({ string: 'Enter text.', number: 'Enter a number.', integer: 'Enter a whole number.',
        boolean: 'Choose true or false.', null: 'Use null.', object: 'Enter an object with named fields.', array: 'Enter a list of items.' }[s.type])
      if (s.enum && !s.enum.some(option => option === value)) return problem('Choose one of the listed values.')
      if (s.type === 'string') {
        const length = [...value].length
        if (length < (s.minLength ?? 0)) return problem(`Enter at least ${s.minLength} character${s.minLength === 1 ? '' : 's'}.`)
        if (length > (s.maxLength ?? Infinity)) return problem(`Use no more than ${s.maxLength} character${s.maxLength === 1 ? '' : 's'}.`)
      }
      if (s.type === 'integer' || s.type === 'number') {
        if (value < (s.minimum ?? -Infinity)) return problem(`Enter a number of at least ${s.minimum}.`)
        if (value > (s.maximum ?? Infinity)) return problem(`Enter a number no greater than ${s.maximum}.`)
      }
      if (s.type === 'array') {
        if (value.length < (s.minItems ?? 0)) return problem(`Include at least ${s.minItems} item${s.minItems === 1 ? '' : 's'}.`)
        if (value.length > (s.maxItems ?? Infinity)) return problem(`Use no more than ${s.maxItems} item${s.maxItems === 1 ? '' : 's'}.`)
        for (const [index, item] of value.entries()) {
          const found = issue(s.items!, item, [...path, `Item ${index + 1}`])
          if (found) return found
        }
      }
      if (s.type === 'object') {
        for (const key of s.required ?? []) if (!Object.hasOwn(value, key)) return `${label([...path, key])}: Include this required field.`
        for (const [key, item] of Object.entries(value)) {
          if (Object.hasOwn(s.properties ?? {}, key)) {
            const found = issue(s.properties![key]!, item, [...path, key])
            if (found) return found
          } else if (s.additionalProperties === false) return problem('Remove additional fields that are not listed in this form.')
        }
      }
    }
    const problem = issue(s, value, ['Input'])
    if (problem) throw Error(`Input does not meet the schema. ${problem} Nothing was submitted.`)
    return value
  }
  return { limits, snapshot, parse, schema, compatible, seed, scalar, validate }
}
