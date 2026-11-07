import { z } from 'zod'
import { WorkflowRuntimeError } from '../runtime/errors.ts'

const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const octets = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/u
const trim = (value: string) => value.replace(/^[ \t]+|[ \t]+$/gu, '')
export const baggageKeysSchema = z.array(z.string().min(1).max(128).regex(token)).max(64)
  .refine(keys => new Set(keys).size === keys.length)

/** Explicit private carrier, not execution input, identity, authority or durable state. */
export interface TraceRequestContext { traceparent?: string | undefined; baggage?: string | undefined }
const contextSchema = z.strictObject({ traceparent: z.string().optional(), baggage: z.string().optional() })
export function parseTraceRequestContext(value: unknown): TraceRequestContext {
  const result = contextSchema.safeParse(value)
  if (!result.success) throw new WorkflowRuntimeError('invalid-command')
  return result.data
}

/** W3C wire-format filtering, not an unrestricted baggage platform. No decoding or attribute promotion.
 * Explicit empty policy disables admission. Undefined policy validates/canonicalizes all (client only).
 * Retain whole members/properties and duplicate order; never truncate a value or forward unknown keys.
 */
export function selectBaggage(header: string | undefined, allowedKeys?: readonly string[]): string | undefined {
  if (header === undefined || allowedKeys?.length === 0) return undefined
  const invalid = () => { throw new WorkflowRuntimeError('invalid-command') }
  if (typeof header !== 'string' || header.length > 8192 || /[^\x09\x20-\x7e]/u.test(header)) invalid()
  if (!trim(header)) return undefined
  const members = header.split(',')
  if (members.length > 64) invalid()
  const allowed = allowedKeys === undefined ? undefined : new Set(allowedKeys)
  const value = (raw: string) => {
    const text = trim(raw)
    if (!octets.test(text) || /%(?![a-fA-F0-9]{2})/u.test(text)) invalid()
    return text
  }
  const selected: string[] = []
  for (const member of members) {
    const [pair, ...properties] = member.split(';'), equal = pair!.indexOf('=')
    if (equal < 1) invalid()
    const key = trim(pair!.slice(0, equal))
    if (!token.test(key)) invalid()
    let canonical = key + '=' + value(pair!.slice(equal + 1))
    for (const property of properties) {
      const equal = property.indexOf('='), name = trim(equal < 0 ? property : property.slice(0, equal))
      if (!token.test(name)) invalid()
      canonical += ';' + name + (equal < 0 ? '' : '=' + value(property.slice(equal + 1)))
    }
    if (allowed === undefined || allowed.has(key)) selected.push(canonical)
  }
  return selected.length ? selected.join(',') : undefined
}
