import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSystemOneRequest, parseSystemOneReply, readSystemOneReply, SYSTEMONE_ROUNDING_TOLERANCE,
  type SystemOneLimits } from '../src/providers/systemone.ts'
import { ProviderError } from '../src/providers/config.ts'

const limits: SystemOneLimits = { maxRequestBytes: 100_000, maxResponseBytes: 100_000, maxDepth: 32, maxValues: 10_000 }
function request() {
  return { model: 'selected-alias', state: { text: 'Private ticket 你好', items: [1, true, null] }, questions: {
    team: { type: 'choice' as const, instructions: 'Which team?', criteria: { billing: 'Invoices', support: 'Product help' } },
    urgency: { type: 'score' as const, instructions: 'How urgent?', criteria: ['Routine', 'Soon', 'Immediate'] },
    review: { type: 'noul' as const, instructions: 'Does a person need to review this?' },
  } }
}
function reply() {
  return { model: 'resolved-model', answers: {
    team: { type: 'choice' as const, choice: 'billing', probabilities: { billing: 0.75, support: 0.25 }, confidence: 0.6 },
    urgency: { type: 'score' as const, score: 1.6, legend: { '0': 'Routine', '1': 'Soon', '2': 'Immediate' },
      probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 }, confidence: 0.8 },
    review: { type: 'noul' as const, noul: 0.9 },
  }, usage: { input_tokens: 120, output_tokens: 0 } }
}
function parse(value: unknown, bounds = limits) { return parseSystemOneReply(JSON.stringify(value), request(), bounds) }
function invalid(value: unknown) { expect(() => parse(value)).toThrowError(new ProviderError('invalid-response')) }
afterEach(() => vi.restoreAllMocks())

describe('native System One requests', () => {
  it('preserves typed state and exact question/rubric order without model calls or chat wrappers', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected dispatch'))
    const source = request(), copy = createSystemOneRequest(source, limits)
    expect(copy).toEqual(source); expect(Object.keys(copy)).toEqual(['model', 'state', 'questions'])
    source.state.text = 'changed'; source.questions.urgency.criteria.reverse()
    expect(copy.state).toEqual({ text: 'Private ticket 你好', items: [1, true, null] })
    expect(copy.questions.urgency).toMatchObject({ criteria: ['Routine', 'Soon', 'Immediate'] })
    expect(Object.isFrozen(copy.questions.urgency)).toBe(true); expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['text', [], {}])('accepts the documented state kind %j', state => {
    expect(createSystemOneRequest({ ...request(), state }, limits).state).toEqual(state)
  })
  it.each([null, true, 17])('refuses scalar state %j instead of silently stringifying it', state => {
    expect(() => createSystemOneRequest({ ...request(), state }, limits)).toThrowError(new ProviderError('unsupported-settings'))
  })
  it.each(['messages', 'stream', 'authorization', 'apiKey', 'tools'])('refuses unrecognized request option %s', field => {
    expect(() => createSystemOneRequest({ ...request(), [field]: 'private-secret' }, limits)).toThrowError(new ProviderError('unsupported-settings'))
  })
  it.each(['empty-questions', 'choice-too-small', 'choice-too-large', 'score-too-small', 'score-too-large', 'duplicate-levels', 'wrong-type', 'blank-instructions', 'invalid-key'])
    ('rejects unsupported question settings: %s', kind => {
      const source = request() as unknown as { model: string; state: unknown; questions: Record<string, any> }
      if (kind === 'empty-questions') source.questions = {}
      if (kind === 'choice-too-small') source.questions.team.criteria = { only: 'One' }
      if (kind === 'choice-too-large') source.questions.team.criteria = Object.fromEntries(Array.from({ length: 256 }, (_, n) => ['a' + n, 'Option']))
      if (kind === 'score-too-small') source.questions.urgency.criteria = ['Only']
      if (kind === 'score-too-large') source.questions.urgency.criteria = Array.from({ length: 11 }, (_, n) => String(n))
      if (kind === 'duplicate-levels') source.questions.urgency.criteria = ['Same', 'Same']
      if (kind === 'wrong-type') source.questions.review.type = 'boolean'
      if (kind === 'blank-instructions') source.questions.review.instructions = '  '
      if (kind === 'invalid-key') source.questions['bad.key'] = { type: 'noul', instructions: 'Question' }
      expect(() => createSystemOneRequest(source, limits)).toThrowError(new ProviderError('unsupported-settings'))
    })
  it('enforces byte/depth/value budgets before recursive schema parsing and excludes private data from errors', () => {
    for (const bounds of [{ ...limits, maxDepth: 2 }, { ...limits, maxValues: 3 }]) {
      expect(() => createSystemOneRequest(request(), bounds)).toThrowError(new ProviderError('unsupported-settings'))
    }
    expect(() => createSystemOneRequest(request(), { ...limits, maxRequestBytes: 1 })).toThrowError(new ProviderError('request-too-large'))
    for (const bounds of [{ ...limits, maxResponseBytes: 0 }, { ...limits, maxDepth: 129 }, { ...limits, maxValues: Infinity }]) {
      expect(() => createSystemOneRequest(request(), bounds)).toThrowError(new ProviderError('invalid-config'))
    }
  })
  it('refuses cycles, accessors and reserved object keys without executing an accessor', () => {
    const value = request(); (value.state as any).cycle = value
    expect(() => createSystemOneRequest(value, limits)).toThrowError(new ProviderError('unsupported-settings'))
    const get = vi.fn(() => 'secret'), second = request()
    Object.defineProperty(second.state, 'secret', { enumerable: true, get })
    expect(() => createSystemOneRequest(second, limits)).toThrowError(new ProviderError('unsupported-settings')); expect(get).not.toHaveBeenCalled()
    expect(() => createSystemOneRequest({ ...request(), state: JSON.parse('{"constructor":"secret"}') }, limits)).toThrowError(new ProviderError('unsupported-settings'))
  })
})

describe('native System One replies', () => {
  it('retains exact raw wire evidence, native Noul, provider usage and resolved aliases', () => {
    const raw = ' \n' + JSON.stringify(reply(), null, 2) + '\n', result = parseSystemOneReply(raw, request(), limits)
    expect(result.raw).toBe(raw); expect(result.reply).toEqual(reply())
    expect(result.reply.answers.review).toEqual({ type: 'noul', noul: 0.9 })
    expect(Object.isFrozen(result.reply.answers.review)).toBe(true)
    expect(result.reply.usage).toEqual({ input_tokens: 120, output_tokens: 0 })
  })
  it('accepts tied maximal choices without choosing a different answer', () => {
    const value = reply(); value.answers.team.probabilities = { billing: 0.5, support: 0.5 }; value.answers.team.choice = 'support'
    expect(parse(value).reply.answers.team).toEqual(value.answers.team)
  })
  it('admits only bounded rounding and never changes returned probabilities, scores or confidence', () => {
    const value = reply(); value.answers.team.probabilities.billing += SYSTEMONE_ROUNDING_TOLERANCE / 2
    value.answers.urgency.score += SYSTEMONE_ROUNDING_TOLERANCE
    expect(parse(value).reply).toEqual(value)
    value.answers.team.probabilities.billing += SYSTEMONE_ROUNDING_TOLERANCE * 2; invalid(value)
  })
  it.each(['missing', 'extra', 'type', 'wrong-choice', 'nonmaximal-choice', 'missing-label', 'extra-label', 'negative', 'greater-than-one',
    'not-a-number', 'mass', 'legend-text', 'legend-key', 'probability-key', 'missing-level', 'score-inconsistent', 'score-out-of-range',
    'confidence-missing', 'confidence-invalid', 'noul-confidence', 'noul-probability', 'noul-invalid', 'usage-missing', 'usage-negative',
    'usage-fractional', 'usage-unsafe', 'extra-envelope'])('refuses mismatched or malformed response: %s', kind => {
    const value: any = reply()
    switch (kind) {
      case 'missing': delete value.answers.review; break
      case 'extra': value.answers.extra = { type: 'noul', noul: 0.5 }; break
      case 'type': value.answers.review = { ...value.answers.team }; break
      case 'wrong-choice': value.answers.team.choice = 'unknown'; break
      case 'nonmaximal-choice': value.answers.team.choice = 'support'; break
      case 'missing-label': delete value.answers.team.probabilities.support; break
      case 'extra-label': value.answers.team.probabilities.other = 0; break
      case 'negative': value.answers.team.probabilities.support = -0.25; break
      case 'greater-than-one': value.answers.team.probabilities.billing = 1.25; break
      case 'not-a-number': value.answers.team.probabilities.billing = '0.75'; break
      case 'mass': value.answers.team.probabilities.billing = 0.9; break
      case 'legend-text': value.answers.urgency.legend['0'] = 'Rewritten'; break
      case 'legend-key': value.answers.urgency.legend['3'] = 'Extra'; break
      case 'probability-key': value.answers.urgency.probabilities['00'] = 0; break
      case 'missing-level': delete value.answers.urgency.probabilities['0']; break
      case 'score-inconsistent': value.answers.urgency.score = 1; break
      case 'score-out-of-range': value.answers.urgency.score = 2.1; break
      case 'confidence-missing': delete value.answers.team.confidence; break
      case 'confidence-invalid': value.answers.team.confidence = 1.1; break
      case 'noul-confidence': value.answers.review.confidence = 0.9; break
      case 'noul-probability': value.answers.review = { type: 'noul', probability: 0.9 }; break
      case 'noul-invalid': value.answers.review.noul = -0.1; break
      case 'usage-missing': delete value.usage; break
      case 'usage-negative': value.usage.input_tokens = -1; break
      case 'usage-fractional': value.usage.output_tokens = 0.5; break
      case 'usage-unsafe': value.usage.input_tokens = Number.MAX_SAFE_INTEGER + 1; break
      case 'extra-envelope': value.authorization = 'private-secret'; break
    }
    invalid(value)
  })
  it('rejects malformed JSON, reserved keys, excessive nesting and raw whitespace beyond the byte limit', () => {
    expect(() => parseSystemOneReply('{ private-secret', request(), limits)).toThrowError(new ProviderError('invalid-response'))
    invalid(JSON.parse('{"__proto__":{}}'))
    expect(() => parseSystemOneReply(JSON.stringify(reply()), request(), { ...limits, maxResponseBytes: 10 })).toThrowError(new ProviderError('response-too-large'))
    expect(() => parseSystemOneReply(' '.repeat(limits.maxResponseBytes) + JSON.stringify(reply()), request(), limits)).toThrowError(new ProviderError('response-too-large'))
    const value: any = reply(); value.answers.review.noul = Array.from({ length: 50 }, () => 0)
    invalid(value)
  })
})

describe('bounded native response reading', () => {
  it('reads split UTF-8 chunks and retains original whitespace', async () => {
    const source = request(); source.questions.urgency.criteria[0] = '普通'
    const value = reply(); value.answers.urgency.legend['0'] = '普通'
    const raw = JSON.stringify(value, null, 2) + '\n', bytes = new TextEncoder().encode(raw)
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } })
    const response = new Response(stream, { headers: { 'content-type': 'Application/JSON; charset=utf-8' } })
    expect(await readSystemOneReply(response, source, limits)).toEqual({ raw, reply: value }); expect(response.body!.locked).toBe(false)
  })
  it('snapshots caller request and limits before an asynchronous body read', async () => {
    let enqueue!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(controller) { enqueue = controller } })
    const source = request(), bounds = { ...limits }, task = readSystemOneReply(new Response(stream, { headers: { 'content-type': 'application/json' } }), source, bounds)
    source.questions.urgency.criteria.reverse(); bounds.maxResponseBytes = 1
    enqueue.enqueue(new TextEncoder().encode(JSON.stringify(reply()))); enqueue.close()
    expect((await task).reply).toEqual(reply())
  })
  it.each(['text/event-stream', 'text/html', 'text/plain', ''])('refuses media type %j and cancels the unused body', async contentType => {
    const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }), { headers: { 'content-type': contentType } })
    await expect(readSystemOneReply(response, request(), limits)).rejects.toThrowError(new ProviderError('invalid-response'))
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('refuses error and redirect statuses without parsing their private bodies', async () => {
    for (const status of [302, 401, 429, 500]) {
      const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }), { status, headers: { 'content-type': 'application/json' } })
      await expect(readSystemOneReply(response, request(), limits)).rejects.toThrowError(new ProviderError('http-error')); expect(cancel).toHaveBeenCalledOnce()
    }
    await expect(readSystemOneReply(new Response(null, { status: 204 }), request(), limits)).rejects.toThrowError(new ProviderError('invalid-response'))
  })
  it('bounds received bytes even when Content-Length lies and cancels/releases the reader on failure', async () => {
    const cancel = vi.fn(), response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(101)) }, cancel }),
      { headers: { 'content-type': 'application/json', 'content-length': '1' } })
    await expect(readSystemOneReply(response, request(), { ...limits, maxResponseBytes: 100 })).rejects.toThrowError(new ProviderError('response-too-large'))
    expect(cancel).toHaveBeenCalledOnce(); expect(response.body!.locked).toBe(false)
  })
  it.each([Uint8Array.of(0xff), Uint8Array.of(0xe4, 0xbd)])('rejects invalid or truncated UTF-8', async chunk => {
    const response = new Response(chunk, { headers: { 'content-type': 'application/json' } })
    await expect(readSystemOneReply(response, request(), limits)).rejects.toThrowError(new ProviderError('invalid-response'))
    expect(response.body!.locked).toBe(false)
  })
  it('sanitizes body read errors and retains the original parse failure when cleanup also fails', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('private secret')) } }), { headers: { 'content-type': 'application/json' } })
    await expect(readSystemOneReply(response, request(), limits)).rejects.toThrowError(new ProviderError('invalid-response'))
    expect(response.body!.locked).toBe(false)
  })
  it('refuses a body already owned by another reader without releasing that reader', async () => {
    const response = new Response(JSON.stringify(reply()), { headers: { 'content-type': 'application/json' } }), reader = response.body!.getReader()
    await expect(readSystemOneReply(response, request(), limits)).rejects.toThrowError(new ProviderError('invalid-response'))
    expect(response.body!.locked).toBe(true); await reader.cancel(); reader.releaseLock()
  })
})
