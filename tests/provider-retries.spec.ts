import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { ConfiguredModels } from '../src/providers/model-calls.ts'
import { ProviderStore } from '../src/providers/store.ts'
import { modelEvidenceSchema, type ModelEvidence } from '../src/providers/records.ts'
import { modelEvidenceVersion, validateModelEvidenceTransition } from '../src/providers/evidence-transition.ts'
import { modelRetryDelay } from '../src/providers/retry-model.ts'
import type { ProviderConnectionRecord } from '../src/providers/config.ts'
import type { ProviderPersistence } from '../src/providers/persistence.ts'
import { compileLocalRun, executionModelPlans } from '../src/runtime/run-evaluator.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import type { JevableAttemptId } from '../src/runtime/run-types.ts'
import { runTrace } from '../src/runtime/run-types.ts'
import type { ModelExecutionContext } from '../src/runtime/model-port.ts'
import { observeModelBackoff } from '../src/providers/backoff-observation.ts'

function node(maxAttempts = 3, timeoutSeconds = 2) {
  return executionModelPlans(compileLocalRun(JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow',
    metadata: { id: 'retry-provider', name: 'Retry provider' }, spec: { inputSchema: { type: 'string' }, nodes: {
      start: { type: 'trigger', config: { modes: ['manual'] } }, model: { type: 'llm', config: {
        provider: 'fixture', model: 'fixture-model', connection: { mode: 'workspace', id: 'fixture' }, prompt: '${{ inputs }}',
        responseFormat: 'text', historyScope: 'none', generation: { maxTokens: 30, stream: false }, execution: { maxAttempts, timeoutSeconds } } },
      end: { type: 'output', config: { value: '${{ nodes.model.output }}' } } },
    edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'end' }] } }), DEFAULT_COMPILER_LIMITS))[0]!
}
const input = { prompt: 'private input', systemPrompt: '' }
const route: ProviderConnectionRecord = { generation: 1, updatedAt: new Date().toISOString(), connection: {
  id: 'fixture', provider: 'fixture', protocol: 'openai-compatible', endpoint: 'http://127.0.0.1:1/v1',
  allowedModels: ['fixture-model'], authentication: { kind: 'bearer', credentialRef: 'fixture/key' },
  tokenParameter: 'max_tokens', maxResponseBytes: 10000, maxRequestBytes: 10000, maxStreamEvents: 100, maxTimeoutSeconds: 5 } }
const success = () => new Response(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 },
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'retained output' } }] }),
  { headers: { 'content-type': 'application/json' } })
const cleanup: (() => void)[] = []
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const close of cleanup.splice(0)) close() })

function fixture(beforeSave?: (record: ModelEvidence, version: number) => Promise<void> | void, signal?: AbortSignal) {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE model_calls(attempt_id TEXT PRIMARY KEY, record TEXT NOT NULL)')
  cleanup.push(() => database.close())
  const durable = new ProviderStore(database, 100000), writes: ModelEvidence[] = []
  const store: ProviderPersistence = { ...(signal ? { signal } : {}), connection: () => structuredClone(route), credential: () => 'PRIVATE_TOKEN',
    evidence: id => durable.evidence(id), async saveEvidence(record) {
      await beforeSave?.(record, modelEvidenceVersion(record))
      durable.saveEvidence(record); writes.push(structuredClone(record))
    } }
  return { models: new ConfiguredModels(store), durable, writes, id: randomUUID() as JevableAttemptId, store }
}

describe('durable configured-model retries', () => {
  it('observes each acknowledged retry delay before the next intent and never reconstructs waits on reentry', async () => {
    const f = fixture(), waits: { identity: any; result?: unknown }[] = []
    const context: ModelExecutionContext = { trace: runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
      startBackoff: identity => {
        const saved = f.durable.evidence(f.id)
        expect(saved?.schemaVersion).toBe(2)
        if (saved?.schemaVersion !== 2) throw Error('expected retry evidence')
        expect(saved.result.status).toBe('pending')
        expect(saved.tries.at(-1)).toMatchObject({ id: identity.afterTryId, number: identity.afterTryNumber, result: { status: 'failed', retryDelayMs: identity.delayMs } })
        const wait = { identity, result: undefined as unknown }; waits.push(wait)
        return { end: result => {
          expect(f.writes.at(-1)).toEqual(saved) // End is before a new intent or failure settlement.
          wait.result = result
        } }
      } }
    const fetch = vi.fn(async () => fetch.mock.calls.length < 3 ? new Response(null, { status: 503 }) : success())
    vi.stubGlobal('fetch', fetch)
    const result = await f.models.execute(node(), input, f.id, undefined, context)
    expect(result.usage.tries).toBe(3)
    expect(waits.map(x => x.identity.delayMs)).toEqual([100, 200])
    expect(waits.map(x => x.result)).toEqual([{ outcome: 'completed' }, { outcome: 'completed' }])
    expect(fetch).toHaveBeenCalledTimes(3)
    await expect(f.models.execute(node(), input, f.id, undefined, context)).resolves.toEqual(result)
    expect(waits).toHaveLength(2); expect(fetch).toHaveBeenCalledTimes(3)
  })

  it.each(['cancelled', 'owner-loss'] as const)('ends backoff on %s without adding a try or hiding ownership loss', async mode => {
    const abort = new AbortController(), reason = Error('PRIVATE_OWNER_LOSS'), f = fixture(undefined, mode === 'owner-loss' ? abort.signal : undefined)
    const ended: unknown[] = []
    const context: ModelExecutionContext = { trace: runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 }),
      startBackoff: () => { abort.abort(reason); return { end: result => ended.push(result) } } }
    const fetch = vi.fn(async () => new Response(null, { status: 503 })); vi.stubGlobal('fetch', fetch)
    const work = f.models.execute(node(), input, f.id, mode === 'cancelled' ? abort.signal : undefined, context)
    if (mode === 'owner-loss') await expect(work).rejects.toBe(reason)
    else await expect(work).rejects.toMatchObject({ code: 'cancelled' })
    expect(ended).toEqual([{ outcome: mode === 'cancelled' ? 'cancelled' : 'commit-or-execution-failed' }])
    expect(fetch).toHaveBeenCalledTimes(1)
    const saved = f.durable.evidence(f.id)
    expect(saved?.schemaVersion === 2 && saved.tries.length).toBe(1)
    expect(JSON.stringify(ended)).not.toContain('PRIVATE_OWNER_LOSS')
  })

  it('ends a deadline-expired backoff without creating another request intent', async () => {
    vi.useFakeTimers()
    const f = fixture(), ended: unknown[] = []
    const context: ModelExecutionContext = { trace: runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
      startBackoff: () => { vi.advanceTimersByTime(1100); return { end: result => ended.push(result) } } }
    const fetch = vi.fn(async () => new Response(null, { status: 503 })); vi.stubGlobal('fetch', fetch)
    await expect(f.models.execute(node(3, 1), input, f.id, undefined, context)).rejects.toMatchObject({ code: 'timeout' })
    expect(ended).toEqual([{ outcome: 'timeout' }]); expect(fetch).toHaveBeenCalledTimes(1)
    const saved = f.durable.evidence(f.id); expect(saved?.schemaVersion === 2 && saved.tries.length).toBe(1)
  })

  it.each(['start', 'end'] as const)('backoff observer %s failure does not change retries or result', async phase => {
    const f = fixture(), context: ModelExecutionContext = { trace: runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
      startBackoff: () => { if (phase === 'start') throw Error('PRIVATE_OBSERVER_ERROR'); return { end: () => { throw Error('PRIVATE_OBSERVER_ERROR') } } } }
    const fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? new Response(null, { status: 503 }) : success()); vi.stubGlobal('fetch', fetch)
    expect((await f.models.execute(node(), input, f.id, undefined, context)).usage.tries).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['single-try', 'retry-declined', 'settlement-failed'] as const)('does not observe an unadmitted wait for %s', async mode => {
    const failure = Error('settlement failed'), f = fixture((_record, version) => { if (mode === 'settlement-failed' && version === 2) throw failure })
    const startBackoff = vi.fn(() => ({ end: vi.fn() })), context: ModelExecutionContext = {
      trace: runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }), startBackoff }
    const fetch = vi.fn(async () => mode === 'single-try' ? success() : new Response(null, { status: 503, headers: mode === 'retry-declined' ? { 'retry-after': '20' } : {} }))
    vi.stubGlobal('fetch', fetch)
    if (mode === 'single-try') await f.models.execute(node(1), input, f.id, undefined, context)
    else if (mode === 'settlement-failed') await expect(f.models.execute(node(), input, f.id, undefined, context)).rejects.toBe(failure)
    else await expect(f.models.execute(node(), input, f.id, undefined, context)).rejects.toMatchObject({ code: 'http-error' })
    expect(startBackoff).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('settles an SDK backoff observer once even when its end callback throws', () => {
    const end = vi.fn(() => { throw Error('diagnostic failure') }), context: ModelExecutionContext = {
      trace: runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }), startBackoff: () => ({ end }) }
    const observation = observeModelBackoff(context, randomUUID(), 1, 100)
    observation.end({ outcome: 'completed' }); observation.end({ outcome: 'failed' })
    expect(end).toHaveBeenCalledOnce(); expect(end).toHaveBeenCalledWith({ outcome: 'completed' })
  })

  it('contains a throwing optional backoff getter without changing execution', async () => {
    const f = fixture(), context: ModelExecutionContext = { trace: runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }) }
    Object.defineProperty(context, 'startBackoff', { get: () => { throw Error('private diagnostic getter') } })
    const fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? new Response(null, { status: 503 }) : success()); vi.stubGlobal('fetch', fetch)
    expect((await f.models.execute(node(), input, f.id, undefined, context)).usage.tries).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('snapshots the backoff hook before awaits so caller mutation cannot replace the observer', async () => {
    const original = vi.fn(() => ({ end: vi.fn() })), replaced = vi.fn(() => ({ end: vi.fn() }))
    const context: ModelExecutionContext = { trace: runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }), startBackoff: original }
    const f = fixture((_record, version) => { if (version === 1) context.startBackoff = replaced })
    const fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? new Response(null, { status: 503 }) : success()); vi.stubGlobal('fetch', fetch)
    expect((await f.models.execute(node(), input, f.id, undefined, context)).usage.tries).toBe(2)
    expect(original).toHaveBeenCalledOnce(); expect(replaced).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3, 4])('closes try diagnostics once after evidence failure at version %i without redispatch', async version => {
    const failure = new Error('private storage failure'), f = fixture((_record, next) => { if (next === version) throw failure })
    const ended: { identity: { id: string; number: number }; result: unknown }[] = []
    const context: ModelExecutionContext = { trace: runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
      startTry: identity => ({ end: result => { ended.push({ identity, result }) } }) }
    const fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? new Response(null, { status: 503 }) : success()); vi.stubGlobal('fetch', fetch)
    await expect(f.models.execute(node(), input, f.id, undefined, context)).rejects.toBe(failure)
    expect(ended).toHaveLength(version >= 3 ? 2 : 1)
    expect(ended.at(-1)?.result).toMatchObject({ outcome: 'commit-or-execution-failed', settled: false, dispatched: version === 2 || version === 4 })
    expect(new Set(ended.map(e => e.identity.id)).size).toBe(ended.length)
    if (version > 1) await expect(f.models.execute(node(), input, f.id, undefined, context)).rejects.toMatchObject({ code: 'uncertain-attempt' })
    expect(ended).toHaveLength(version >= 3 ? 2 : 1)
  })

  it.each(['start', 'end', 'context', 'reused-context'] as const)('observer %s failures cannot change execution or retry counts', async phase => {
    const f = fixture(), parent = runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 })
    const context: ModelExecutionContext = { trace: parent, startTry: () => {
      if (phase === 'start') throw Error('diagnostic failed')
      return { get trace() { if (phase === 'context') throw Error('diagnostic failed'); return phase === 'reused-context'
        ? { ...parent, spanId: 'c'.repeat(16) as typeof parent.spanId } : parent }, end: () => { throw Error('diagnostic failed') } }
    } }
    const fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? new Response(null, { status: 503 }) : success()); vi.stubGlobal('fetch', fetch)
    expect(await f.models.execute(node(), input, f.id, undefined, context)).toMatchObject({ usage: { tries: 2 } })
    expect(fetch).toHaveBeenCalledTimes(2)
    const record = f.durable.evidence(f.id)
    if (phase === 'reused-context' && record?.schemaVersion === 2) {
      expect(record.tries[0]!.trace?.spanId).toBe('c'.repeat(16)); expect(record.tries[1]!.trace).toBeUndefined()
    }
  })
  it('keeps all failed tries, identical requests, and acknowledged intent before each fetch; reentry is read-only', async () => {
    const f = fixture(), requests: RequestInit[] = []
    const fetch = vi.fn(async (_url: string, request: RequestInit) => {
      requests.push(request)
      expect(modelEvidenceVersion(f.durable.evidence(f.id)!)).toBe(requests.length * 2 - 1)
      return requests.length < 3 ? new Response('private failure body', { status: 503 }) : success()
    }); vi.stubGlobal('fetch', fetch)
    const value = await f.models.execute(node(), input, f.id)
    expect(value).toEqual({ output: 'retained output', usage: { tries: 3, inputTokens: 5, outputTokens: 2 } })
    expect(f.writes.map(modelEvidenceVersion)).toEqual([1, 2, 3, 4, 5, 6])
    expect(f.writes.map(record => modelEvidenceSchema.safeParse(record).success)).toEqual(Array(6).fill(true))
    expect(requests.every(request => request.body === requests[0]!.body && request.redirect === 'manual')).toBe(true)
    expect(JSON.stringify(f.writes)).not.toMatch(/PRIVATE_TOKEN|private failure body/)
    expect(await new ConfiguredModels(f.store).execute(node(), input, f.id)).toEqual(value)
    expect(fetch).toHaveBeenCalledTimes(3)
    await expect(f.models.execute(node(2), input, f.id)).rejects.toMatchObject({ code: 'corrupt-evidence' })
    await expect(f.models.execute(node(3, 3), input, f.id)).rejects.toMatchObject({ code: 'corrupt-evidence' })
    const terminal = f.durable.evidence(f.id)!
    if (terminal.schemaVersion !== 2) throw Error('expected retry evidence')
    expect(new Set(terminal.tries.map(attempt => attempt.id)).size).toBe(3)
    const repeated = structuredClone(terminal); repeated.tries[1]!.id = repeated.tries[0]!.id
    expect(modelEvidenceSchema.safeParse(repeated).success).toBe(false)
    expect(() => f.durable.saveEvidence(terminal)).toThrow('conflict')
  })

  it.each([408, 429, 500, 502, 503, 504])('retries explicit transient HTTP %i up to the reviewed maximum', async status => {
    const f = fixture(), fetch = vi.fn(async () => new Response(null, { status })); vi.stubGlobal('fetch', fetch)
    await expect(f.models.execute(node(2), input, f.id)).rejects.toMatchObject({ code: 'http-error' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(f.durable.evidence(f.id)).toMatchObject({ schemaVersion: 2, result: { status: 'failed', code: 'http-error' },
      tries: [{ number: 1, result: { httpStatus: status, retryDelayMs: 100 } }, { number: 2, result: { httpStatus: status } }] })
    await expect(f.models.execute(node(2), input, f.id)).rejects.toMatchObject({ code: 'uncertain-attempt' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([301, 307, 400, 401, 403, 404, 422, 501])('does not retry HTTP %i', async status => {
    const f = fixture(), fetch = vi.fn(async () => new Response(null, { status })); vi.stubGlobal('fetch', fetch)
    await expect(f.models.execute(node(), input, f.id)).rejects.toMatchObject({ code: 'http-error' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(f.writes.map(modelEvidenceVersion)).toEqual([1, 2])
  })

  it.each(['transport', 'invalid', 'oversized'] as const)('does not retry %s failures', async kind => {
    const f = fixture(), fetch = vi.fn(async () => {
      if (kind === 'transport') throw new Error('private transport detail')
      return new Response(kind === 'invalid' ? '{}' : 'x'.repeat(10001), { headers: { 'content-type': 'application/json' } })
    }); vi.stubGlobal('fetch', fetch)
    await expect(f.models.execute(node(), input, f.id)).rejects.toMatchObject({ code:
      kind === 'transport' ? 'transport-error' : kind === 'invalid' ? 'invalid-response' : 'response-too-large' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.writes)).not.toContain('private transport detail')
  })

  it('does not shorten a server delay to fit the remaining execution budget', async () => {
    const f = fixture(), fetch = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': '20' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(f.models.execute(node(), input, f.id)).rejects.toMatchObject({ code: 'http-error' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([1, 2, 3, 4])('never sends another request after evidence write %i fails', async version => {
    const failure = new Error('storage unavailable'), f = fixture((_record, next) => { if (next === version) throw failure })
    const fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? new Response(null, { status: 503 }) : success())
    vi.stubGlobal('fetch', fetch)
    await expect(f.models.execute(node(), input, f.id)).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledTimes(version === 1 ? 0 : version === 4 ? 2 : 1)
    if (version > 1) {
      await expect(new ConfiguredModels(f.store).execute(node(), input, f.id)).rejects.toMatchObject({ code: 'uncertain-attempt' })
      expect(fetch).toHaveBeenCalledTimes(version === 4 ? 2 : 1)
    }
  })

  it('waits for the second intent acknowledgement before the second request', async () => {
    const reached = Promise.withResolvers<void>(), ack = Promise.withResolvers<void>()
    const f = fixture(async (_record, version) => { if (version === 3) { reached.resolve(); await ack.promise } })
    const fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? new Response(null, { status: 503 }) : success())
    vi.stubGlobal('fetch', fetch)
    const pending = f.models.execute(node(), input, f.id)
    try { await reached.promise; expect(fetch).toHaveBeenCalledTimes(1) } finally { ack.resolve() }
    expect(await pending).toMatchObject({ usage: { tries: 2 } })
  })

  it.each(['caller', 'owner'] as const)('stops after %s cancellation during backoff without a second intent', async kind => {
    const controller = new AbortController(), reason = new Error('ownership lost')
    const f = fixture((_record, version) => { if (version === 2) controller.abort(reason) }, kind === 'owner' ? controller.signal : undefined)
    const fetch = vi.fn(async () => new Response(null, { status: 503 })); vi.stubGlobal('fetch', fetch)
    const pending = f.models.execute(node(), input, f.id, kind === 'caller' ? controller.signal : undefined)
    if (kind === 'owner') await expect(pending).rejects.toBe(reason)
    else await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(f.writes.map(modelEvidenceVersion)).toEqual(kind === 'owner' ? [1, 2] : [1, 2, 3])
    expect(f.durable.evidence(f.id)).toMatchObject({ result: { status: kind === 'owner' ? 'pending' : 'failed' }, tries: [{ number: 1 }] })
  })

  it('preserves a single overall deadline while waiting on later evidence acknowledgement', async () => {
    const f = fixture(async (_record, version) => { if (version === 2) await new Promise(resolve => setTimeout(resolve, 1050)) })
    const fetch = vi.fn(async () => new Response(null, { status: 503 })); vi.stubGlobal('fetch', fetch)
    await expect(f.models.execute(node(3, 1), input, f.id)).rejects.toMatchObject({ code: 'timeout' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(f.writes.map(modelEvidenceVersion)).toEqual([1, 2, 3])
  })

  it('rejects prefix rewrites, skipped intents and policy changes', async () => {
    const f = fixture(), fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? new Response(null, { status: 503 }) : success())
    vi.stubGlobal('fetch', fetch); await f.models.execute(node(), input, f.id)
    const [initial, waiting, next, done] = f.writes
    expect(() => validateModelEvidenceTransition(undefined, waiting!)).toThrow('conflict')
    expect(() => validateModelEvidenceTransition(initial, next!)).toThrow('conflict')
    expect(() => validateModelEvidenceTransition(waiting, done!)).toThrow('conflict')
    const changed = structuredClone(next!)
    if (changed.schemaVersion !== 2) throw Error('expected retry evidence')
    changed.tries[0]!.at = '2020-01-01T00:00:00.000Z'
    expect(() => validateModelEvidenceTransition(waiting, changed)).toThrow('conflict')
    changed.tries = structuredClone(next!.schemaVersion === 2 ? next!.tries : [])
    changed.policy.maxAttempts = 4
    expect(() => validateModelEvidenceTransition(waiting, changed)).toThrow('conflict')
    const invalid = structuredClone(done!)
    if (invalid.schemaVersion !== 2) throw Error('expected retry evidence')
    invalid.tries[0]!.result = { status: 'failed', at: initial!.at, code: 'transport-error', retryDelayMs: 100 }
    expect(modelEvidenceSchema.safeParse(invalid).success).toBe(false)
  })
})

describe('retry delay calculation', () => {
  it('uses bounded exponential delay and does not reduce Retry-After', () => {
    const now = Date.parse('2026-09-30T00:00:00Z')
    expect([1, 2, 3, 6, 10].map(number => modelRetryDelay(number, null, now))).toEqual([100, 200, 400, 2000, 2000])
    expect(modelRetryDelay(1, '2', now)).toBe(2000)
    expect(modelRetryDelay(1, 'Wed, 30 Sep 2026 00:00:03 GMT', now)).toBe(3000)
    expect(modelRetryDelay(1, 'Tue, 29 Sep 2026 00:00:03 GMT', now)).toBe(100)
    expect(modelRetryDelay(1, 'bad delay', now)).toBe(100)
    expect(modelRetryDelay(1, '9'.repeat(129), now)).toBe(Infinity)
  })
})
