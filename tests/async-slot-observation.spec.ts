import { expect, it, vi } from 'vitest'
import { observeAsyncSlot } from '../src/telemetry/async-slots.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { capabilities } from '../src/capabilities.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'

it('discovers the real startup opt-in without enabling an exporter or async routes', () => {
  const discovery = capabilities().workflowRuntime.httpAsyncCapacityTelemetry
  expect(discovery).toMatchObject({ option: 'httpRequests', default: false, configuration: 'startup-only',
    requires: ['metricsEndpoint', 'enabled-async-http-routes'], signal: 'metrics', owners: ['sqlite', 'postgres'],
    traceSampling: 'independent', source: 'process-local-held-http-slots',
    instrument: { name: 'jevable.http.async.slots', kind: 'up-down-counter', unit: '{slot}', temporality: 'cumulative', monotonic: false },
    pointLabels: { 'jevable.http.async.phase': ['admitting', 'completing'] } })
  const config = { metricsEndpoint: 'http://127.0.0.1:4318/v1/metrics', authentication: { kind: 'none' } }
  expect(parseTelemetryConfig(config)[discovery.option as 'httpRequests']).toBe(discovery.default)
  expect(parseTelemetryConfig({ ...config, [discovery.option]: true }).httpRequests).toBe(true)
})

it('returns detached async-capacity discovery on every call', () => {
  const baseline = capabilities().workflowRuntime.httpAsyncCapacityTelemetry
  const changed = capabilities().workflowRuntime.httpAsyncCapacityTelemetry
  changed.requires.push('forged'); changed.owners.push('forged'); changed.collection.push('forged')
  changed.pointLabels['jevable.http.async.phase'].push('forged'); changed.instrument.name = 'forged'
  changed.phases.admitting = 'forged'; changed.exclusions.push('forged'); changed.default = true
  expect(capabilities().workflowRuntime.httpAsyncCapacityTelemetry).toEqual(baseline)
})

it('observes admission, completion and exactly one release without executing work', () => {
  const change = vi.fn(), observation = observeAsyncSlot(change)
  expect(change.mock.calls).toEqual([['admitting', 1]])
  observation.admitted(); observation.admitted()
  expect(change.mock.calls).toEqual([['admitting', 1], ['admitting', -1], ['completing', 1]])
  observation.end(); observation.end(); observation.admitted()
  expect(change.mock.calls).toEqual([['admitting', 1], ['admitting', -1], ['completing', 1], ['completing', -1]])
})

it('releases refused admission without fabricating a completion phase', () => {
  const change = vi.fn(), observation = observeAsyncSlot(change)
  observation.end(); observation.admitted(); observation.end()
  expect(change.mock.calls).toEqual([['admitting', 1], ['admitting', -1]])
})

it('contains diagnostic callback failures at every phase without replaying notifications', () => {
  const change = vi.fn(() => { throw Error('PRIVATE_DIAGNOSTIC') })
  const observation = observeAsyncSlot(change)
  expect(() => { observation.admitted(); observation.end(); observation.end() }).not.toThrow()
  expect(change.mock.calls).toEqual([['admitting', 1], ['admitting', -1], ['completing', 1], ['completing', -1]])
})

it.each([false, undefined])('keeps async slot diagnostics off with HTTP opt-in %s', async httpRequests => {
  const telemetry = new RuntimeTelemetry({ metricsEndpoint: 'http://127.0.0.1:4318/v1/metrics',
    authentication: { kind: 'none' }, httpRequests, intervalMs: 60000 }, () => undefined)
  try { expect(telemetry.observeHttpAsyncSlot()).toBeUndefined() }
  finally { await telemetry.close() }
})

it('does not construct metric-only slot diagnostics for a traces-only configuration', async () => {
  const telemetry = new RuntimeTelemetry({ endpoint: 'http://127.0.0.1:4318/v1/traces',
    authentication: { kind: 'none' }, httpRequests: true, intervalMs: 60000 }, () => undefined)
  try { expect(telemetry.observeHttpAsyncSlot()).toBeUndefined() }
  finally { await telemetry.close() }
})
