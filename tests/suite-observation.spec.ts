import { expect, it, vi } from 'vitest'
import { withSuiteObservation, type SuiteObservation, type SuiteObservationIdentity, type SuiteCaseSnapshot } from '../src/testing/suite-observation.ts'
import { createTestSuite, runTestSuite, testSuiteResult } from '../src/testing/suite.ts'
import { randomUUID } from 'node:crypto'
import { observeTestSuite } from '../src/telemetry/suite.ts'
import type { Tracer } from '@opentelemetry/api'

const identity: SuiteObservationIdentity = { sha256: 'a'.repeat(64), mode: 'run', failurePolicy: 'stop', entries: 2, concurrency: 1 }
const privateFailure = new Error('PRIVATE_DIAGNOSTIC_FAILURE')
it.each(['passed', 'failed', 'pending', 'attention', 'uncertain', 'blocked', 'interrupted'])('preserves the original %s report and admits only frozen metadata', async status => {
  const result = { status, private: 'PRIVATE_REPORT' }, work = vi.fn(async () => result), finish = vi.fn()
  const observer = vi.fn((received: SuiteObservationIdentity) => {
    expect(received).toEqual(identity); expect(Object.isFrozen(received)).toBe(true)
    expect(() => { received.entries = 99 }).toThrow()
    return { within: (once: () => Promise<unknown>) => once(), finish }
  })
  expect(await withSuiteObservation({ observeTestSuite: observer }, identity, work)).toBe(result)
  expect(work).toHaveBeenCalledTimes(1); expect(finish).toHaveBeenCalledExactlyOnceWith(status)
})
it.each(['start-throw', 'start-rejection', 'getter-throw', 'within-throw', 'after-work-throw', 'twice', 'deferred', 'ignored', 'replacement', 'rejection', 'finish-throw', 'finish-getter', 'finish-rejection'])('contains %s diagnostics without replacing or replaying work', async fault => {
  const report = { status: 'passed' }, work = vi.fn(async () => report), finish = vi.fn()
  let deferred: (() => Promise<unknown>) | undefined
  const observation: SuiteObservation = {
    within(once) {
      if (fault === 'within-throw') throw privateFailure
      if (fault === 'deferred') { deferred = once; return undefined }
      if (fault === 'ignored') return undefined
      const execution = once()
      if (fault === 'after-work-throw') throw privateFailure
      if (fault === 'twice') expect(once()).toBe(execution)
      if (fault === 'replacement') return { status: 'failed', private: 'PRIVATE_FORGED_REPORT' }
      if (fault === 'rejection') return Promise.reject(privateFailure)
      return execution
    },
    finish(outcome) {
      finish(outcome)
      if (fault === 'finish-throw') throw privateFailure
      if (fault === 'finish-rejection') return Promise.reject(privateFailure) as never
    },
  }
  if (fault === 'finish-getter') Object.defineProperty(observation, 'finish', { get() { throw privateFailure } })
  const host = { observeTestSuite: () => { if (fault === 'start-throw') throw privateFailure; if (fault === 'start-rejection') return Promise.reject(privateFailure) as never; return observation } }
  if (fault === 'getter-throw') Object.defineProperty(host, 'observeTestSuite', { get() { throw privateFailure } })
  expect(await withSuiteObservation(host, identity, work)).toBe(report)
  if (deferred) { expect(await deferred()).toBe(report); expect(await deferred()).toBe(report) }
  expect(work).toHaveBeenCalledTimes(1)
  if (!['start-throw', 'start-rejection', 'getter-throw', 'finish-getter'].includes(fault)) expect(finish).toHaveBeenCalledExactlyOnceWith('passed')
  await new Promise(resolve => setImmediate(resolve)) // Rejected diagnostic promises must already have a handler.
})
it('preserves the identical work failure despite faulty diagnostics', async () => {
  const original = new Error('PRIVATE_WORK_FAILURE'), work = vi.fn(async () => { throw original }), finish = vi.fn(() => { throw privateFailure })
  await expect(withSuiteObservation({ observeTestSuite: () => ({ within: once => { once(); throw privateFailure }, finish }) }, identity, work)).rejects.toBe(original)
  expect(work).toHaveBeenCalledTimes(1); expect(finish).toHaveBeenCalledExactlyOnceWith('operation-failed')
})
it('does not dispatch a deferred callback before or after diagnostic return', async () => {
  const work = vi.fn(async () => ({ status: 'passed' })), deferred = Promise.withResolvers<() => Promise<unknown>>()
  const task = withSuiteObservation({ observeTestSuite: () => ({ within: once => { queueMicrotask(() => deferred.resolve(once)) }, finish() {} }) }, identity, work)
  const callback = await deferred.promise
  await callback(); await task; await callback()
  expect(work).toHaveBeenCalledTimes(1)
})
it('validates manifests, reviewed hashes and options before creating any observation', async () => {
  const prepared = createTestSuite({ title: 'PRIVATE_SUITE', tests: [{ id: randomUUID(), generation: 1, sha256: 'b'.repeat(64) }], failurePolicy: 'stop' })
  const observe = vi.fn(), read = vi.fn(), host = { observeTestSuite: observe, testResult: read, testCase: read, project: read, runTest: read }
  await expect(runTestSuite(host, prepared.suite, '0'.repeat(64))).rejects.toMatchObject({ code: 'conflict' })
  await expect(runTestSuite(host, prepared.suite, prepared.sha256, { signal: {} as AbortSignal })).rejects.toMatchObject({ code: 'invalid-command' })
  await expect(runTestSuite(host, prepared.suite, prepared.sha256, { extra: true } as never)).rejects.toMatchObject({ code: 'invalid-command' })
  await expect(testSuiteResult(host, { ...prepared.suite, private: 'PRIVATE_BAD_FIELD' })).rejects.toThrow()
  expect(observe).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
})
it('captures the validated signal before an asynchronous diagnostic scope; options cannot retarget it', async () => {
  const prepared = createTestSuite({ title: 'PRIVATE_SUITE', tests: [{ id: randomUUID(), generation: 1, sha256: 'b'.repeat(64) }], failurePolicy: 'stop' })
  const controller = new AbortController(); controller.abort()
  const options: { signal?: AbortSignal } = { signal: controller.signal }, read = vi.fn(), finish = vi.fn()
  const host = { observeTestSuite: () => ({ within: (work: () => Promise<unknown>) => work(), finish }), testResult: read, testCase: read, project: read, runTest: read }
  const invocation = runTestSuite(host, prepared.suite, prepared.sha256, options)
  delete options.signal
  expect((await invocation).status).toBe('interrupted'); expect(read).not.toHaveBeenCalled()
  expect(finish).toHaveBeenCalledExactlyOnceWith('interrupted')
})
it.each([
  { sha256: 'PRIVATE_HASH' }, { mode: 'PRIVATE_MODE' }, { failurePolicy: 'PRIVATE_POLICY' },
  { entries: 0 }, { entries: 101 }, { concurrency: 0 }, { concurrency: 9 }, { concurrency: 1.5 }, { title: 'PRIVATE_TITLE' },
])('refuses invalid diagnostic identity before opening a span: %j', invalid => {
  const startSpan = vi.fn(), settled = vi.fn()
  expect(observeTestSuite({ startSpan } as unknown as Tracer, { ...identity, ...invalid } as never, undefined, (_parent, work) => work(), settled)).toBeUndefined()
  expect(startSpan).not.toHaveBeenCalled(); expect(settled).not.toHaveBeenCalled()
})
it('ends once, normalizes unknown outcomes, and does not start work after finish', () => {
  const span = { spanContext: () => ({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 }), setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }
  const settled = vi.fn(), work = vi.fn(async () => undefined)
  const observation = observeTestSuite({ startSpan: () => span } as unknown as Tracer, identity, undefined, (_parent, callback) => callback(), settled)!
  observation.finish('PRIVATE_UNKNOWN_OUTCOME'); observation.finish('passed'); observation.within(work)
  expect(span.end).toHaveBeenCalledTimes(1); expect(settled).toHaveBeenCalledTimes(1); expect(work).not.toHaveBeenCalled()
  expect(settled.mock.calls[0]![0]['jevable.suite.outcome']).toBe('operation-failed')
  expect(JSON.stringify(settled.mock.calls)).not.toContain('PRIVATE_')
})
it.each(['throw', 'getter', 'rejection'])('contains %s case diagnostics and freezes snapshots without replay', async fault => {
  const hook = vi.fn((snapshot: SuiteCaseSnapshot) => {
    expect(Object.isFrozen(snapshot)).toBe(true)
    if (fault === 'throw') throw privateFailure
    if (fault === 'rejection') return Promise.reject(privateFailure) as never
  })
  const observation: SuiteObservation = { within: work => work(), finish() {}, cases: hook }
  if (fault === 'getter') Object.defineProperty(observation, 'cases', { get() { throw privateFailure } })
  const report = { status: 'passed' }, work = vi.fn(async (cases: (snapshot: SuiteCaseSnapshot) => void) => {
    cases({ waiting: 1, running: 0, settled: 0 }); cases({ waiting: 0, running: 1, settled: 0 }); return report
  })
  expect(await withSuiteObservation({ observeTestSuite: () => observation }, identity, work)).toBe(report)
  expect(work).toHaveBeenCalledTimes(1)
  await new Promise(resolve => setImmediate(resolve))
})
it('bounds case snapshots, preserves settled monotonicity, drains once, and excludes result-only reads', () => {
  const span = { spanContext: () => ({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 }), setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }
  const counts = vi.fn(), tracer = { startSpan: () => span } as unknown as Tracer
  const observation = observeTestSuite(tracer, identity, undefined, (_parent, work) => work(), vi.fn(), counts)!
  observation.cases!({ waiting: 2, running: 0, settled: 0 })
  for (const bad of [{ waiting: -1, running: 0, settled: 0 }, { waiting: 3, running: 0, settled: 0 },
    { waiting: 0, running: 2, settled: 0 }, { waiting: NaN, running: 0, settled: 0 }, { waiting: 1.5, running: 0, settled: 0 }]) observation.cases!(bad)
  expect(counts).toHaveBeenCalledTimes(1)
  observation.cases!({ waiting: 0, running: 1, settled: 1 })
  observation.cases!({ waiting: 0, running: 1, settled: 0 }); expect(counts).toHaveBeenCalledTimes(2)
  observation.finish('operation-failed'); observation.finish('passed'); observation.cases!({ waiting: 2, running: 0, settled: 0 })
  expect(counts).toHaveBeenCalledTimes(3)
  expect(counts.mock.calls[2]).toEqual(['stop', { waiting: 0, running: 1, settled: 1 }, { waiting: 0, running: 0, settled: 1 }])
  const result = observeTestSuite(tracer, { ...identity, mode: 'result' }, undefined, (_parent, work) => work(), vi.fn(), counts)!
  result.cases!({ waiting: 1, running: 0, settled: 0 }); result.finish('pending')
  expect(counts).toHaveBeenCalledTimes(3)
})
