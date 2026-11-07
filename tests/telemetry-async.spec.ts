import { afterEach, describe, expect, it, vi } from 'vitest'
import { postOtlp } from '../src/telemetry/otlp.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'

const policy = parseTelemetryConfig({ endpoint: 'https://collector.invalid/v1/traces',
  authentication: { kind: 'bearer', credentialRef: 'otel/key' }, timeoutMs: 30, intervalMs: 60000 })
const ok = () => new Response(null, { status: 200, headers: { 'content-type': 'application/x-protobuf' } })
const defer = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('bounded asynchronous OTLP credentials and export admission', () => {
  it('awaits fresh credentials before dispatch without caching a previous token', async () => {
    const fetch = vi.fn(async () => ok()); vi.stubGlobal('fetch', fetch)
    const key = defer<string>(), controller = new AbortController()
    const sending = postOtlp(policy.endpoint!, new Uint8Array([1]), policy, () => key.promise, controller)
    await Promise.resolve(); expect(fetch).not.toHaveBeenCalled()
    key.resolve('private-first'); await sending
    await postOtlp(policy.endpoint!, new Uint8Array([1]), policy, async () => 'private-second', new AbortController())
    expect((fetch.mock.calls as unknown as [string, RequestInit][]).map(call => call[1].headers)).toEqual([
      { 'content-type': 'application/x-protobuf', authorization: 'Bearer private-first' },
      { 'content-type': 'application/x-protobuf', authorization: 'Bearer private-second' },
    ])
  })
  it.each(['resolve', 'reject'] as const)('times out a hung credential read and safely handles its late %s', async outcome => {
    vi.useFakeTimers()
    const fetch = vi.fn(), key = defer<string>(); vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const result = postOtlp(policy.endpoint!, new Uint8Array([1]), policy, () => key.promise, controller)
    const refused = expect(result).rejects.toMatchObject({ category: 'transport', message: 'transport' })
    await vi.advanceTimersByTimeAsync(31); await refused
    expect(controller.signal.aborted).toBe(true)
    if (outcome === 'resolve') key.resolve('late-private-key'); else key.reject(new Error('private database diagnostics'))
    await Promise.resolve(); expect(fetch).not.toHaveBeenCalled()
  })
  it('aborts lookup on shutdown and never invokes a pre-aborted resolver', async () => {
    const fetch = vi.fn(), key = defer<string>(), controller = new AbortController(); vi.stubGlobal('fetch', fetch)
    const read = vi.fn(() => key.promise)
    const result = postOtlp(policy.endpoint!, new Uint8Array([1]), policy, read, controller)
    await Promise.resolve(); expect(read).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(result).rejects.toMatchObject({ category: 'transport' })
    await expect(postOtlp(policy.endpoint!, new Uint8Array([1]), policy, read, controller)).rejects.toMatchObject({ category: 'transport' })
    expect(read).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled(); key.resolve('discarded')
  })
  it.each([undefined, new Error('PRIVATE_STORAGE_DETAIL')])('refuses missing/failed credentials with sanitized diagnostics', async failure => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(postOtlp(policy.endpoint!, new Uint8Array([1]), policy, async () => {
      if (failure) throw failure
      return undefined
    }, new AbortController())).rejects.toMatchObject({ category: 'transport', message: 'transport' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not read a credential for an explicitly unauthenticated collector', async () => {
    const fetch = vi.fn(async () => ok()), read = vi.fn(); vi.stubGlobal('fetch', fetch)
    await postOtlp(policy.endpoint!, new Uint8Array([1]), { ...policy, authentication: { kind: 'none' } }, read, new AbortController())
    expect(read).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce()
  })
  it('defers all three signals during configuration without dropping records or spinning metric flush', async () => {
    const fetch = vi.fn(async () => ok()); vi.stubGlobal('fetch', fetch)
    let allowed = false
    const telemetry = new RuntimeTelemetry({ ...policy, authentication: { kind: 'none' },
      metricsEndpoint: 'https://collector.invalid/v1/metrics', logsEndpoint: 'https://collector.invalid/v1/logs' }, () => undefined,
    { storage: 'postgres', canExport: () => allowed })
    try {
      telemetry.end(telemetry.start('jevable.run', {}), 'completed')
      await telemetry.flush(); expect(fetch).not.toHaveBeenCalled(); expect(telemetry.busy()).toBe(false)
      expect(telemetry.status()).toMatchObject({ queued: 1, dropped: 0, metrics: { pendingChanges: true }, logs: { queued: 1, dropped: 0 } })
      allowed = true; await telemetry.flush()
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(telemetry.status()).toMatchObject({ exported: 1, queued: 0, logs: { exported: 1 }, metrics: { pendingChanges: false } })
    } finally { allowed = true; await telemetry.close() }
  })
  it.each(['traces', 'metrics', 'logs'] as const)('reports busy through the asynchronous %s credential lookup and shutdown abort', async signal => {
    const fetch = vi.fn(), key = defer<string>(); vi.stubGlobal('fetch', fetch)
    const telemetry = new RuntimeTelemetry({ [signal === 'traces' ? 'endpoint' : `${signal}Endpoint`]: `https://collector.invalid/v1/${signal}`,
      authentication: policy.authentication, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 10 }, () => key.promise)
    telemetry.end(telemetry.start('jevable.run', {}), 'completed')
    const flush = telemetry.flush()
    expect(telemetry.busy()).toBe(true)
    await telemetry.close(); await flush
    expect(telemetry.busy()).toBe(false); expect(fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(telemetry.status())).toContain('transport'); key.reject(new Error('late-private-error'))
  })
})
