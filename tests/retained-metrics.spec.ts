import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { JsonMetricsSerializer, ProtobufMetricsSerializer } from '@opentelemetry/otlp-transformer'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { RetainedRunMetrics, type RetainedMetricSnapshot } from '../src/runtime/retained-metrics.ts'
import type { LocalRun } from '../src/runtime/run-types.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { RunStore } from '../src/runtime/store.ts'
import { DatabaseSync } from 'node:sqlite'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const config = { metricsEndpoint: 'http://127.0.0.1:4318/v1/metrics', retainedStateMetrics: true,
  authentication: { kind: 'none' as const }, intervalMs: 60000, timeoutMs: 100, flushTimeoutMs: 300 }
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const time = Date.parse('2026-09-30T00:00:00Z')
function record(id: string, status: string, attempt = 'attempt', at = time) {
  return { id, updatedAt: new Date(at).toISOString(), state: { status, attempt: { id: attempt }, expiresAt: new Date(at + 10000).toISOString() } } as unknown as LocalRun
}
function receiver() {
  const batches: any[] = [], original = ProtobufMetricsSerializer.serializeRequest
  vi.spyOn(ProtobufMetricsSerializer, 'serializeRequest').mockImplementation(metrics => {
    batches.push(JSON.parse(Buffer.from(JsonMetricsSerializer.serializeRequest(metrics)!).toString()))
    return original(metrics)
  })
  const fetch = vi.fn(async () => new Response(null, { headers: { 'content-type': 'application/x-protobuf' } }))
  vi.stubGlobal('fetch', fetch)
  const metrics = (index = batches.length - 1): any[] => batches[index].resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics))
  const points = (name: string, index?: number): any[] => metrics(index).find(m => m.name === name)?.gauge?.dataPoints ?? []
  const point = (name: string, state?: string, index?: number) => points(`jevable.retained.${name}`, index).find(p =>
    p.attributes.find((a: any) => a.key === 'jevable.retained.state')?.value.stringValue === state)
  const value = (name: string, state?: string, index?: number) => Number(point(name, state, index)?.asInt ?? point(name, state, index)?.asDouble)
  return { batches, fetch, metrics, points, point, value }
}
async function owner(dataDirectory?: string, overrides = {}) {
  const directory = dataDirectory ?? await mkdtemp(join(tmpdir(), 'jevable-retained-metrics-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, telemetry: { ...config, ...overrides } })
  cleanup.push(() => runtime.close()); return { runtime, directory }
}

describe('retained checkpoint metric projection', () => {
  it('requires complete initialization and an explicit metrics endpoint', () => {
    expect(parseTelemetryConfig({ ...config, retainedStateMetrics: undefined }).retainedStateMetrics).toBe(false)
    expect(() => parseTelemetryConfig({ ...config, metricsEndpoint: undefined, endpoint: config.metricsEndpoint })).toThrow()
    expect(() => parseTelemetryConfig({ ...config, retainedStateMetrics: 'true' })).toThrow()
    const state = new RetainedRunMetrics(10)
    expect(state.snapshot(time)).toEqual({ available: false }); state.ready()
    expect(state.snapshot(time)).toMatchObject({ available: true, runs: { waiting: 0, completed: 0 } })
  })

  it('counts retained statuses, not cumulative starts or active execution', () => {
    const state = new RetainedRunMetrics(10); state.ready()
    state.committed(record('a', 'paused'), 'run-created')
    state.committed(record('a', 'executing'), 'node-intent')
    state.committed(record('b', 'completed'), 'node-result')
    expect(state.snapshot(time)).toMatchObject({ runs: { paused: 0, executing: 1, completed: 1 } })
    state.committed(record('a', 'cancelled'), 'run-cancelled')
    expect(state.snapshot(time)).toMatchObject({ runs: { executing: 0, cancelled: 1, completed: 1 } })
  })

  it('keeps the persisted request time through segment/cancellation writes and recomputes expiry without deciding', () => {
    const state = new RetainedRunMetrics(10); state.ready()
    const waiting = record('a', 'waiting')
    state.committed(waiting, 'approval-requested')
    state.committed({ ...waiting, updatedAt: new Date(time + 5000).toISOString() }, 'execution-segment')
    expect(state.snapshot(time + 6000)).toMatchObject({ approvals: { awaiting: { count: 1, oldestAgeSeconds: 6 }, expired: { count: 0 } } })
    expect(state.snapshot(time + 10000)).toMatchObject({ runs: { waiting: 1 }, approvals: { awaiting: { count: 0, oldestAgeSeconds: 0 }, expired: { count: 1, oldestAgeSeconds: 10 } } })
    expect(state.snapshot(time - 500)).toMatchObject({ approvals: { awaiting: { oldestAgeSeconds: 0 } } })
    expect(waiting.state.status).toBe('waiting')
    state.committed(record('a', 'failed'), 'approval-decided')
    expect(state.snapshot(time + 11000)).toMatchObject({ approvals: { expired: { count: 0, oldestAgeSeconds: 0 } } })
  })

  it('restores the exact attempt request event, not creation/update time or a previous approval', () => {
    const state = new RetainedRunMetrics(10), waiting = record('a', 'waiting', 'current')
    state.restore(waiting, [
      { kind: 'approval-requested', at: new Date(time - 10000).toISOString(), data: { attemptId: 'previous' } },
      { kind: 'approval-requested', at: new Date(time - 3000).toISOString(), data: { attemptId: 'current' } },
    ]); state.ready()
    expect(state.snapshot(time)).toMatchObject({ approvals: { awaiting: { count: 1, oldestAgeSeconds: 3 } } })
  })

  it.each(['missing-event', 'duplicate-event', 'limit', 'invalidated', 'lost-owner'] as const)('reports unavailable for %s instead of a partial or zero backlog', cause => {
    let healthy = true
    const state = new RetainedRunMetrics(1, () => healthy); state.ready()
    state.committed(record('a', 'paused'), 'run-created')
    if (cause === 'missing-event') state.restore(record('a', 'waiting'), [])
    if (cause === 'duplicate-event') state.restore(record('a', 'waiting'), Array.from({ length: 2 }, () => ({ kind: 'approval-requested', at: new Date(time).toISOString(), data: { attemptId: 'attempt' } })))
    if (cause === 'limit') state.committed(record('b', 'paused'), 'run-created')
    if (cause === 'invalidated') state.invalidate()
    if (cause === 'lost-owner') healthy = false
    expect(state.snapshot(time)).toEqual({ available: false })
    state.ready(); expect(state.snapshot(time)).toEqual({ available: false })
  })
})

describe('owned runtime retained-state metric export', () => {
  it('exports eleven fixed-label points on an idle owner without creating execution observations', async () => {
    const wire = receiver(), { runtime } = await owner()
    await runtime.telemetryFlush()
    expect(wire.metrics()).toHaveLength(4)
    expect(wire.metrics().flatMap(m => m.gauge.dataPoints)).toHaveLength(11)
    expect(wire.value('available')).toBe(1)
    expect(wire.value('runs', 'waiting')).toBe(0)
    for (const metric of wire.metrics()) for (const point of metric.gauge.dataPoints)
      expect(point.attributes.every((a: any) => a.key === 'jevable.retained.state')).toBe(true)
  })

  it('tracks saved pauses, completions, approvals and cancellation; samples without database reads', async () => {
    const wire = receiver(), { runtime } = await owner()
    await runtime.run(echo, 'PRIVATE_ECHO')
    const paused = await runtime.run(echo, 'PRIVATE_PAUSED', { paused: true })
    const waiting = await runtime.run(approval, { message: 'PRIVATE_APPROVAL' })
    await runtime.telemetryFlush()
    expect(wire.value('runs', 'completed')).toBe(1); expect(wire.value('runs', 'paused')).toBe(1)
    expect(wire.value('runs', 'waiting')).toBe(1); expect(wire.value('approvals', 'awaiting')).toBe(1)
    const get = vi.spyOn(RunStore.prototype, 'get'), events = vi.spyOn(RunStore.prototype, 'events')
    await runtime.telemetryFlush()
    expect(get).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled()
    get.mockRestore(); events.mockRestore()
    runtime.cancel(waiting.id, randomUUID(), 'PRIVATE_ACTOR'); await runtime.resume(paused.id)
    await runtime.telemetryFlush()
    expect(wire.value('runs', 'completed')).toBe(2); expect(wire.value('runs', 'cancelled')).toBe(1)
    expect(wire.value('approvals', 'awaiting')).toBe(0); expect(wire.value('approval_oldest_age', 'awaiting')).toBe(0)
    expect(JSON.stringify(wire.batches)).not.toMatch(/PRIVATE_|message/)
    expect(JSON.stringify(wire.batches)).not.toContain(waiting.id)
  })

  it.each(['approve', 'reject'] as const)('restores approval age across restart and removes backlog after explicit %s', async action => {
    const wire = receiver(), first = await owner()
    const waiting = await first.runtime.run(approval, { message: 'PRIVATE_RESTART' })
    if (waiting.state.status !== 'waiting') throw Error('no approval')
    await first.runtime.close()
    const second = await owner(first.directory), before = await second.runtime.show(waiting.id)
    await second.runtime.telemetryFlush()
    expect(wire.value('approvals', 'awaiting')).toBe(1)
    expect(wire.metrics().some(m => m.name === 'jevable.execution.segments')).toBe(false)
    expect(await second.runtime.show(waiting.id)).toEqual(before)
    await second.runtime.decide(waiting.id, waiting.state.attempt.id, action, 'PRIVATE_ACTOR')
    await second.runtime.telemetryFlush()
    expect(wire.value('runs', action === 'approve' ? 'completed' : 'failed')).toBe(1)
    expect(wire.value('runs', 'waiting')).toBe(0)
    expect(wire.value('approvals', 'awaiting')).toBe(0)
  })

  it('observes deadline passage and downtime from the journal without automatically expiring an approval', async () => {
    const wire = receiver(), first = await owner()
    const waiting = await first.runtime.run(approval, { message: 'PRIVATE_EXPIRED' })
    if (waiting.state.status !== 'waiting') throw Error('no approval')
    const events = await first.runtime.events(waiting.id), requested = events.find(e => e.kind === 'approval-requested')!
    await first.runtime.close()
    const now = Date.parse(waiting.state.expiresAt) + 1000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const second = await owner(first.directory)
    await second.runtime.telemetryFlush()
    expect(wire.value('approvals', 'expired')).toBe(1)
    expect(wire.value('approval_oldest_age', 'expired')).toBe((now - Date.parse(requested.at)) / 1000)
    expect(await second.runtime.show(waiting.id)).toEqual(waiting)
    expect(await second.runtime.events(waiting.id)).toEqual(events)
  })

  it('omits unknown backlog rather than retaining stale gauge values after invalidation', async () => {
    const wire = receiver(), state = new RetainedRunMetrics(1)
    state.ready(); state.committed(record('a', 'waiting'), 'approval-requested')
    const runtime = new RuntimeTelemetry(config, () => undefined, { retainedState: () => state.snapshot(time) })
    cleanup.push(() => runtime.close()); await runtime.flush()
    expect(wire.value('approvals', 'awaiting')).toBe(1)
    state.invalidate(); await runtime.flush()
    expect(wire.value('available')).toBe(0)
    expect(wire.points('jevable.retained.runs')).toEqual([])
    expect(wire.points('jevable.retained.approvals')).toEqual([])
  })

  it('reports an unavailable diagnostic reader instead of exporting stale backlog, then accepts a fresh snapshot', async () => {
    const wire = receiver(), state = new RetainedRunMetrics(2)
    state.ready(); state.committed(record('a', 'waiting'), 'approval-requested')
    let failed = false
    const runtime = new RuntimeTelemetry(config, () => undefined, { retainedState: () => {
      if (failed) throw Error('PRIVATE_DIAGNOSTIC_FAILURE')
      return state.snapshot(time)
    } })
    cleanup.push(() => runtime.close()); await runtime.flush()
    expect(wire.value('available')).toBe(1)
    expect(wire.value('approvals', 'awaiting')).toBe(1)
    failed = true; await runtime.flush()
    expect(wire.value('available')).toBe(0)
    expect(wire.points('jevable.retained.runs')).toEqual([])
    expect(wire.points('jevable.retained.approvals')).toEqual([])
    expect(wire.points('jevable.retained.approval_oldest_age')).toEqual([])
    failed = false; state.committed(record('a', 'completed'), 'node-result'); await runtime.flush()
    expect(wire.value('available')).toBe(1)
    expect(wire.value('runs', 'completed')).toBe(1)
    expect(wire.value('runs', 'waiting')).toBe(0)
    expect(wire.value('approvals', 'awaiting')).toBe(0)
    expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_DIAGNOSTIC_FAILURE')
  })

  it.each(['null', 'missing-runs', 'missing-bucket', 'false-availability', 'negative-count', 'fractional-count',
    'unsafe-count', 'overflow-total', 'string-count', 'infinite-age', 'negative-age', 'empty-bucket-age',
    'approval-mismatch', 'throwing-field'] as const)('omits the whole retained snapshot for %s without retaining previous gauges', async cause => {
    const wire = receiver(), state = new RetainedRunMetrics(1)
    state.ready(); state.committed(record('a', 'waiting'), 'approval-requested')
    const good = state.snapshot(time)
    let snapshot: unknown = good
    const runtime = new RuntimeTelemetry(config, () => undefined, { retainedState: () => snapshot as RetainedMetricSnapshot })
    cleanup.push(() => runtime.close()); await runtime.flush()
    expect(wire.value('available')).toBe(1)
    const bad: any = structuredClone(good)
    if (cause === 'null') snapshot = null
    else {
      if (cause === 'missing-runs') delete bad.runs
      if (cause === 'missing-bucket') delete bad.approvals.expired
      if (cause === 'false-availability') bad.available = 'PRIVATE_TRUTHY'
      if (cause === 'negative-count') bad.runs.completed = -1
      if (cause === 'fractional-count') bad.runs.completed = 0.5
      if (cause === 'unsafe-count') bad.runs.completed = Number.MAX_SAFE_INTEGER + 1
      if (cause === 'overflow-total') bad.runs.completed = Number.MAX_SAFE_INTEGER
      if (cause === 'string-count') bad.runs.completed = 'PRIVATE_COUNT'
      if (cause === 'infinite-age') bad.approvals.awaiting.oldestAgeSeconds = Infinity
      if (cause === 'negative-age') bad.approvals.awaiting.oldestAgeSeconds = -1
      if (cause === 'empty-bucket-age') bad.approvals.expired.oldestAgeSeconds = 1
      if (cause === 'approval-mismatch') bad.approvals.expired.count = 1
      if (cause === 'throwing-field') Object.defineProperty(bad.runs, 'completed', { get() { throw Error('PRIVATE_GETTER') } })
      snapshot = bad
    }
    await runtime.flush()
    expect(wire.value('available')).toBe(0)
    expect(wire.metrics().map(m => m.name)).toEqual(['jevable.retained.available'])
    expect(JSON.stringify(wire.batches)).not.toMatch(/PRIVATE_/u)
    snapshot = good; await runtime.flush()
    expect(wire.value('available')).toBe(1)
    expect(wire.value('runs', 'waiting')).toBe(1)
    expect(wire.metrics()).toHaveLength(4)
  })

  it('contains an initial diagnostic failure without suppressing independent request observations', async () => {
    const wire = receiver()
    const runtime = new RuntimeTelemetry({ ...config, httpRequests: true }, () => undefined, {
      retainedState: () => { throw Error('PRIVATE_INITIAL_FAILURE') },
    })
    cleanup.push(() => runtime.close())
    runtime.observeHttpRequest('GET', '/v1/health')!.end(200, true)
    await runtime.flush()
    expect(wire.value('available')).toBe(0)
    expect(wire.points('jevable.retained.runs')).toEqual([])
    const requests = wire.metrics().find(m => m.name === 'jevable.http.requests').sum.dataPoints
    expect(requests).toHaveLength(1)
    expect(Number(requests[0].asInt ?? requests[0].asDouble)).toBe(1)
    expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_INITIAL_FAILURE')
  })

  it('does not replay or change real workflow evidence during a diagnostic source failure', async () => {
    const wire = receiver(), { runtime } = await owner()
    const waiting = await runtime.run(approval, { message: 'PRIVATE_PENDING' })
    const events = await runtime.events(waiting.id)
    await runtime.telemetryFlush()
    expect(wire.value('runs', 'waiting')).toBe(1)
    const fault = vi.spyOn(RetainedRunMetrics.prototype, 'snapshot').mockImplementation(() => { throw Error('PRIVATE_PROJECTION_FAILURE') })
    const completed = await runtime.run(echo, 'PRIVATE_COMPLETED')
    expect(completed.state.status).toBe('completed')
    await runtime.telemetryFlush()
    expect(wire.value('available')).toBe(0)
    expect(wire.points('jevable.retained.runs')).toEqual([])
    expect(await runtime.show(waiting.id)).toEqual(waiting)
    expect(await runtime.events(waiting.id)).toEqual(events)
    expect((await runtime.run(echo, 'PRIVATE_COMPLETED', { id: completed.id }))).toEqual(completed)
    fault.mockRestore(); await runtime.telemetryFlush()
    expect(wire.value('available')).toBe(1)
    expect(wire.value('runs', 'waiting')).toBe(1)
    expect(wire.value('runs', 'completed')).toBe(1)
    expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_PROJECTION_FAILURE')
  })

  it('copies only fixed diagnostic fields without exporting or evaluating extra payload fields', async () => {
    const wire = receiver(), state = new RetainedRunMetrics(1)
    state.ready(); state.committed(record('a', 'waiting'), 'approval-requested')
    const snapshot: any = state.snapshot(time)
    snapshot.runs.PRIVATE_EXTRA = 100
    snapshot.approvals.awaiting.actor = 'PRIVATE_ACTOR'
    Object.defineProperty(snapshot, 'payload', { get() { throw Error('PRIVATE_UNUSED_GETTER') } })
    const before = { ...snapshot.runs }
    const runtime = new RuntimeTelemetry(config, () => undefined, { retainedState: () => snapshot })
    cleanup.push(() => runtime.close()); await runtime.flush()
    expect(wire.value('available')).toBe(1)
    expect(wire.metrics().flatMap(m => m.gauge.dataPoints)).toHaveLength(11)
    expect(snapshot.runs).toEqual(before)
    expect(JSON.stringify(wire.batches)).not.toMatch(/PRIVATE_/u)
  })

  it('invalidates after a real SQLite commit failure, preserves evidence, and rebuilds on explicit reopen', async () => {
    const wire = receiver(), first = await owner()
    const waiting = await first.runtime.run(approval, { message: 'PRIVATE_COMMIT' })
    await first.runtime.telemetryFlush()
    const original = DatabaseSync.prototype.exec; let fail = true
    const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === 'COMMIT' && fail) { fail = false; throw new Error('PRIVATE_COMMIT_FAILURE') }
      return original.call(this, sql)
    })
    await expect(first.runtime.run(echo, 'new', { paused: true })).rejects.toThrow('PRIVATE_COMMIT_FAILURE')
    fault.mockRestore(); await first.runtime.telemetryFlush()
    expect(wire.value('available')).toBe(0); expect(wire.points('jevable.retained.runs')).toEqual([])
    expect(await first.runtime.show(waiting.id)).toEqual(waiting)
    await first.runtime.close()
    const second = await owner(first.directory); await second.runtime.telemetryFlush()
    expect(wire.value('available')).toBe(1); expect(wire.value('runs', 'waiting')).toBe(1)
    expect(wire.value('runs', 'paused')).toBe(0)
    expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_COMMIT')
  })

  it('reports an unavailable source for a telemetry-only SDK host instead of claiming an empty runtime', async () => {
    const wire = receiver(), runtime = new RuntimeTelemetry(config, () => undefined)
    cleanup.push(() => runtime.close()); await runtime.flush()
    expect(wire.value('available')).toBe(0)
    expect(wire.points('jevable.retained.runs')).toHaveLength(0)
  })

  it('retains an uncertain model intent across restart without calling it active work or redispatching it', async () => {
    const wire = receiver(), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-retained-uncertain-'))
    const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'PRIVATE_MODEL' },
      spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
        write: { type: 'llm', config: { provider: 'fixture', model: 'fixture-model', connection: { mode: 'workspace', id: 'fixture' },
          prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
          execution: { timeoutSeconds: 1, maxAttempts: 1 }, historyScope: 'none' } },
        end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } }, edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
    let calls = 0
    const models = { admit() {}, async verify() {}, async execute(): Promise<never> { calls++; throw new Error('PRIVATE_UNCERTAIN') } }
    const first = await LocalRuntime.open({ dataDirectory, telemetry: config, models }); cleanup.push(() => first.close())
    const id = randomUUID(); await expect(first.run(source, 'PRIVATE_INPUT', { id })).rejects.toThrow('PRIVATE_UNCERTAIN')
    await first.telemetryFlush(); expect(wire.value('runs', 'executing')).toBe(1)
    const active = wire.metrics().find(m => m.name === 'jevable.execution.active').sum.dataPoints[0]
    expect(Number(active.asInt ?? active.asDouble)).toBe(0)
    await first.close()
    const second = await LocalRuntime.open({ dataDirectory, telemetry: config, models }); cleanup.push(() => second.close())
    await second.telemetryFlush(); expect(wire.value('runs', 'executing')).toBe(1)
    expect((await second.run(source, 'PRIVATE_INPUT', { id })).state.status).toBe('executing')
    expect(calls).toBe(1); expect(JSON.stringify(wire.batches)).not.toContain('PRIVATE_')
  })

  it('samples changing approval age on idle intervals without incrementing execution counters', async () => {
    vi.useFakeTimers(); vi.setSystemTime(time)
    const wire = receiver(), state = new RetainedRunMetrics(1)
    state.ready(); state.committed(record('a', 'waiting'), 'approval-requested')
    const runtime = new RuntimeTelemetry({ ...config, intervalMs: 100 }, () => undefined, { retainedState: () => state.snapshot() })
    cleanup.push(() => runtime.close())
    await vi.advanceTimersByTimeAsync(300)
    expect(wire.fetch).toHaveBeenCalledTimes(3)
    expect(wire.value('approval_oldest_age', 'awaiting')).toBe(0.3)
    expect(wire.metrics().some(m => m.name.startsWith('jevable.execution.'))).toBe(false)
    await runtime.close(); const count = wire.fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000); expect(wire.fetch).toHaveBeenCalledTimes(count)
  })
})
