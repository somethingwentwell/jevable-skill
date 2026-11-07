/** Pure native Jev/Laya System One wire codec. No HTTP dispatch, credentials or runtime admission. */
import { z } from 'zod'
import { deepFreeze } from '../shared/values.ts'
import { assertJsonTree } from '../workflow/json-data.ts'
import { ProviderError } from './config.ts'
import { assertSystemOneAnswers } from '../workflow/systemone-answers.ts'
export { SYSTEMONE_ROUNDING_TOLERANCE } from '../workflow/systemone-answers.ts'

const limitsSchema = z.strictObject({
  maxRequestBytes: z.number().int().min(1).max(16_000_000),
  maxResponseBytes: z.number().int().min(1).max(16_000_000),
  maxDepth: z.number().int().min(1).max(128),
  maxValues: z.number().int().min(1).max(1_000_000),
})
export type SystemOneLimits = z.infer<typeof limitsSchema>
const name = z.string().min(1).max(256).refine(value => value.trim() === value)
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u)
const description = z.string().min(1).refine(value => value.trim().length > 0)
const question = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('choice'), instructions: description,
    criteria: z.record(description, description).refine(value => Object.keys(value).length >= 2 && Object.keys(value).length <= 255) }),
  z.strictObject({ type: z.literal('score'), instructions: description, criteria: z.array(description).min(2).max(10)
    .refine(value => new Set(value).size === value.length) }),
  z.strictObject({ type: z.literal('noul'), instructions: description }),
])
const requestSchema = z.strictObject({ model: name,
  state: z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]),
  questions: z.record(key, question).refine(value => Object.keys(value).length > 0),
})
export type SystemOneRequest = z.infer<typeof requestSchema>
const probability = z.number().min(0).max(1)
const answer = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('choice'), choice: z.string(), confidence: probability,
    probabilities: z.record(z.string(), probability) }),
  z.strictObject({ type: z.literal('score'), score: z.number().min(0), confidence: probability,
    legend: z.record(z.string(), z.string()), probabilities: z.record(z.string(), probability) }),
  // Native Noul has no separate confidence. Do not manufacture one from its probability.
  z.strictObject({ type: z.literal('noul'), noul: probability }),
])
const replySchema = z.strictObject({ model: name, answers: z.record(key, answer),
  usage: z.strictObject({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
})
export type SystemOneReply = z.infer<typeof replySchema>
export interface SystemOneResult { raw: string; reply: SystemOneReply }

function policy(value: SystemOneLimits): SystemOneLimits {
  const result = limitsSchema.safeParse(value)
  if (!result.success) throw new ProviderError('invalid-config')
  return result.data
}
function data(value: unknown, limits: SystemOneLimits, direction: 'request' | 'response') {
  try { assertJsonTree(value, limits) }
  catch { throw new ProviderError(direction === 'request' ? 'unsupported-settings' : 'invalid-response') }
  const raw = JSON.stringify(value)
  if (Buffer.byteLength(raw) > (direction === 'request' ? limits.maxRequestBytes : limits.maxResponseBytes)) {
    throw new ProviderError(direction === 'request' ? 'request-too-large' : 'response-too-large')
  }
  return JSON.parse(raw) as unknown
}

/** Admit the workflow-supported question subset, preserving state, rubric order and exact model selection. */
export function createSystemOneRequest(value: unknown, limits: SystemOneLimits): SystemOneRequest {
  const parsed = requestSchema.safeParse(data(value, policy(limits), 'request'))
  if (!parsed.success) throw new ProviderError('unsupported-settings')
  return deepFreeze(parsed.data)
}

/** Parse exact wire evidence without converting it to the legacy workflow Decision output contract. */
export function parseSystemOneReply(raw: string, request: SystemOneRequest, limits: SystemOneLimits): SystemOneResult {
  const bounds = policy(limits), admitted = createSystemOneRequest(request, bounds)
  if (typeof raw !== 'string') throw new ProviderError('invalid-response')
  if (Buffer.byteLength(raw) > bounds.maxResponseBytes) throw new ProviderError('response-too-large')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new ProviderError('invalid-response') }
  const parsed = replySchema.safeParse(data(value, bounds, 'response'))
  if (!parsed.success) throw new ProviderError('invalid-response')
  const reply = parsed.data
  try { assertSystemOneAnswers(admitted.questions, reply.answers) } catch { throw new ProviderError('invalid-response') }
  return deepFreeze({ raw, reply })
}

/** Read one already-authorized JSON response with decompressed-byte/UTF-8 limits. This function never sends a request. */
export async function readSystemOneReply(response: Response, request: SystemOneRequest, limits: SystemOneLimits): Promise<SystemOneResult> {
  // Snapshot all caller-owned policy/request data before the first body read.
  const bounds = policy(limits), admitted = createSystemOneRequest(request, bounds)
  const refuse = async (code: 'http-error' | 'invalid-response') => {
    await response.body?.cancel().catch(() => {})
    throw new ProviderError(code)
  }
  if (!response.ok) return refuse('http-error')
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !response.body || response.body.locked) {
    return refuse('invalid-response')
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, raw = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > bounds.maxResponseBytes) throw new ProviderError('response-too-large')
      raw += decoder.decode(value, { stream: true })
    }
    raw += decoder.decode()
    return parseSystemOneReply(raw, admitted, bounds)
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError('invalid-response')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
