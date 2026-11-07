import { describe, expect, it, vi } from 'vitest'
import { trace, createTraceState } from '@opentelemetry/api'
import { observeHttpRateSql } from '../src/telemetry/rate-sql.ts'
import { HTTP_RATE_SQL_OPERATIONS, beginHttpRateSqlObservation, endHttpRateSqlObservation } from '../src/http/rate-sql-observation.ts'

const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1, traceState: createTraceState('private=PRIVATE_STATE') }
function fixture() {
  const span = { setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn(), spanContext: () => ({ traceId: parent.traceId, spanId: 'c'.repeat(16), traceFlags: 1 }) }
  const tracer = { startSpan: vi.fn((_name: string, _options: any, _context: any) => span) }, settled = vi.fn()
  return { span, tracer, settled }
}
describe('bounded owned quota SQL diagnostics', () => {
  it.each(HTTP_RATE_SQL_OPERATIONS.flatMap(operation => ['acknowledged', 'failed', 'uncertain'].map(outcome => ({ operation, outcome }))))('ends exactly once with fixed enums (%j)', ({ operation, outcome }) => {
    const f = fixture(), observation = observeHttpRateSql(f.tracer as any, operation, parent, f.settled)!
    observation.end(outcome as any); observation.end('failed')
    expect(f.span.end).toHaveBeenCalledOnce(); expect(f.settled).toHaveBeenCalledOnce()
    expect(f.tracer.startSpan.mock.calls[0]?.[0]).toBe('jevable.http.rate.sql')
    expect(f.tracer.startSpan.mock.calls[0]?.[1].kind).toBe(2) // API SpanKind.CLIENT; serialized OTLP kind is 3.
    expect(trace.getSpanContext(f.tracer.startSpan.mock.calls[0]?.[2])).toEqual({ traceId: parent.traceId, spanId: parent.spanId, traceFlags: 1 })
    expect(f.settled.mock.calls[0]?.[0]).toMatchObject({ 'db.system.name': 'postgresql', 'jevable.http.rate.sql.operation': operation, 'jevable.http.rate.sql.outcome': outcome })
    expect(f.settled.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(0); expect(f.span.setStatus).toHaveBeenCalledTimes(outcome === 'acknowledged' ? 0 : 1)
    expect(JSON.stringify(f.settled.mock.calls)).not.toContain('PRIVATE_STATE')
  })
  it.each([undefined, { ...parent, traceId: '0'.repeat(32) }, { ...parent, spanId: '0'.repeat(16) }, { ...parent, traceId: 'PRIVATE' }])('emits nothing without a valid explicit parent (%j)', value => {
    const f = fixture(); expect(observeHttpRateSql(f.tracer as any, 'commit', value, f.settled)).toBeUndefined(); expect(f.tracer.startSpan).not.toHaveBeenCalled()
  })
  it('refuses unknown operations and ends invalid outcomes without payload log or metric records', () => {
    const f = fixture(); expect(observeHttpRateSql(f.tracer as any, 'PRIVATE' as never, parent, f.settled)).toBeUndefined()
    observeHttpRateSql(f.tracer as any, 'commit', parent, f.settled)!.end('PRIVATE' as never)
    expect(f.span.end).toHaveBeenCalledOnce(); expect(f.settled).not.toHaveBeenCalled()
  })
  it('contains native asynchronous diagnostics without assimilating foreign thenables', async () => {
    const then = vi.fn(() => { throw Error('PRIVATE') }), observation = { then, end: vi.fn() }
    expect(beginHttpRateSqlObservation(() => Promise.reject(Error('PRIVATE')) as never, 'begin')).toBeUndefined()
    expect(beginHttpRateSqlObservation(() => observation, 'begin')).toBe(observation)
    endHttpRateSqlObservation({ end: () => Promise.reject(Error('PRIVATE')) }, 'acknowledged')
    await new Promise<void>(resolve => setImmediate(resolve)); expect(then).not.toHaveBeenCalled()
  })
})
