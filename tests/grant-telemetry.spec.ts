import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, prepareGrantToken } from '../src/runtime/index.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { observeGrantCall, observeGrantOperation } from '../src/telemetry/grants.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { fields, logRecords, metricSums } from '../scripts/check-telemetry-package.mjs'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
async function fixture(options: Record<string, unknown> = {}, refused = false) {
  const received: { path: string; bytes: Buffer; baggage: string | undefined }[] = []
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const b of req) chunks.push(b)
    received.push({ path: req.url!, bytes: Buffer.concat(chunks), baggage: req.headers.baggage as string | undefined })
    res.writeHead(refused ? 503 : 200, { 'content-type': 'application/x-protobuf' }); res.end()
  })
  await new Promise<void>((yes, no) => { receiver.once('error', no); receiver.listen(0, '127.0.0.1', yes) })
  cleanup.push(() => new Promise<void>(yes => { receiver.close(() => yes()); receiver.closeAllConnections() }))
  const address = receiver.address(); if (!address || typeof address === 'string') throw Error('listener')
  const base = `http://127.0.0.1:${address.port}`, dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-grant-telemetry-'))
  const runtime = await LocalRuntime.open({ dataDirectory, telemetry: { endpoint: base + '/v1/traces',
    metricsEndpoint: base + '/v1/metrics', logsEndpoint: base + '/v1/logs', authentication: { kind: 'none' },
    intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000, ...options } })
  cleanup.push(() => runtime.close())
  const traces = () => received.filter(r => r.path === '/v1/traces').flatMap(r => traceRecords(r.bytes)).filter(s => s.name === 'jevable.access.grant')
  const logs = () => received.filter(r => r.path === '/v1/logs').flatMap(r => logRecords(r.bytes)).filter(l => l.event === 'jevable.access.grant.ended')
  const sums = () => received.filter(r => r.path === '/v1/metrics').flatMap(r => metricSums(r.bytes)).filter(m => m.name === 'jevable.access.grant.calls')
  return { runtime, received, dataDirectory, traces, logs, sums }
}
async function grantFixture(runtime: LocalRuntime) {
  const run = await runtime.run(approval, { message: 'PRIVATE_INPUT' })
  if (run.state.status !== 'waiting') throw Error('wait')
  const proof = prepareGrantToken(randomUUID())
  const command = { id: proof.id, tokenSha256: proof.tokenSha256, actor: 'PRIVATE_ISSUER',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), scope: { kind: 'reviewer' as const, runId: run.id,
      attemptId: run.state.attempt.id, revision: run.revision, decisions: ['approve' as const] } }
  return { run, proof, command }
}
it('defaults off and strictly admits only boolean grant opt-ins', () => {
  const config = { endpoint: 'http://127.0.0.1/v1/traces', authentication: { kind: 'none' as const } }
  expect(parseTelemetryConfig(config).grantOperations).toBe(false)
  for (const grantOperations of ['true', 1, null]) expect(() => parseTelemetryConfig({ ...config, grantOperations })).toThrow('invalid-command')
})
it.each([0, 1])('joins actual grant calls, raw wire privacy, retries and durable history at sampleRatio %s', async sampleRatio => {
  const f = await fixture({ grantOperations: true, sampleRatio, baggageKeys: ['request.class'] }), g = await grantFixture(f.runtime)
  const call = <T>(work: () => T) => f.runtime.withTraceContext({ traceparent: parent, baggage: 'request.class=PRIVATE_BAGGAGE' }, work)
  const issued = await call(() => f.runtime.issueGrant(g.command))
  await call(() => f.runtime.issueGrant(g.command))
  await expect(call(() => f.runtime.issueGrant({ ...g.command, actor: 'PRIVATE_CHANGED' }))).rejects.toMatchObject({ code: 'conflict' })
  const read = call(() => f.runtime.grant(g.proof.id)); expect(read).not.toBeInstanceOf(Promise); expect(read.id).toBe(issued.id)
  expect(() => call(() => f.runtime.grant(randomUUID()))).toThrow('not-found')
  expect(call(() => f.runtime.grants()).grants).toHaveLength(1)
  expect(() => call(() => f.runtime.grants({ limit: 0 }))).toThrow('invalid-command')
  const revoke = { id: g.proof.id, requestId: randomUUID(), expectedGeneration: 1 as const, actor: 'PRIVATE_REVOKER' }
  await call(() => f.runtime.revokeGrant(revoke)); await call(() => f.runtime.revokeGrant(revoke))
  await expect(call(() => f.runtime.revokeGrant({ ...revoke, requestId: randomUUID() }))).rejects.toMatchObject({ code: 'conflict' })
  await f.runtime.close()
  expect(() => f.runtime.grant(g.proof.id)).toThrow('closed')
  const spans = f.traces(), logs = f.logs(), sum = f.sums().at(-1)!
  expect(spans).toHaveLength(sampleRatio ? 10 : 0); expect(logs).toHaveLength(10)
  expect(Reflect.get(sum, 'temporality')).toBe(2); expect(sum.points).toHaveLength(8); expect(sum.points.reduce((n: number, p: any) => n + p.value, 0)).toBe(10)
  const groups = Object.fromEntries(sum.points.map((p: any) => [p.labels['jevable.grant.operation'] + '.' + p.labels['jevable.grant.outcome'], p.value]))
  expect(groups).toEqual({ 'issue.returned': 2, 'issue.threw': 1, 'get.returned': 1, 'get.threw': 1,
    'page.returned': 1, 'page.threw': 1, 'revoke.returned': 2, 'revoke.threw': 1 })
  for (const point of sum.points) expect(Object.keys(point.labels).sort()).toEqual(['jevable.grant.operation', 'jevable.grant.outcome'])
  for (const span of spans) {
    expect(span.traceId).toBe('1'.repeat(32)); expect(span.parent).toBe('2'.repeat(16))
    expect(Object.keys(span.attributes).sort()).toEqual((span.attributes['jevable.grant.outcome'] === 'threw'
      ? ['error.type', 'jevable.grant.operation', 'jevable.grant.outcome'] : ['jevable.grant.operation', 'jevable.grant.outcome']).sort())
    expect(logs.some(l => l.spanId === span.spanId && l.traceId === span.traceId)).toBe(true)
  }
  expect(logs.filter(l => l.attributes['jevable.grant.outcome'] === 'threw').every(l => Reflect.get(l, 'severity') === 17 && l.attributes['error.type'] === 'grant_operation_threw')).toBe(true)
  // Independent wire histogram count, not the product observer or an exporter mock.
  const histogramCounts = f.received.filter(r => r.path === '/v1/metrics').flatMap(r =>
    (fields(r.bytes).get(1) ?? []).flatMap((resource: Buffer) => (fields(resource).get(2) ?? []).flatMap((scope: Buffer) =>
      (fields(scope).get(2) ?? []).flatMap((metric: Buffer) => {
        const m = fields(metric); if (m.get(1)![0].toString() !== 'jevable.access.grant.duration') return []
        return [(fields(m.get(9)![0]).get(1) ?? []).reduce((count: number, point: Buffer) => count + Number(fields(point).get(4)![0].readBigUInt64LE()), 0)]
      }))))
  expect(histogramCounts.at(-1)).toBe(10)
  for (const r of f.received) { expect(r.baggage).toBeUndefined(); expect(r.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false)
    for (const secret of [g.proof.token, g.proof.tokenSha256, g.proof.id, g.run.id]) {
      if (secret === g.run.id) continue // Execution diagnostics legitimately identify their own run; grant diagnostics do not.
      expect(r.bytes.includes(Buffer.from(secret))).toBe(false)
    }
  }
  const db = new DatabaseSync(join(f.dataDirectory, 'runtime.sqlite'), { readOnly: true })
  try {
    expect(db.prepare('SELECT count(*) AS n FROM access_grants').get()).toMatchObject({ n: 1 })
    expect(db.prepare('SELECT count(*) AS n FROM access_grant_events').get()).toMatchObject({ n: 2 })
    const saved = JSON.parse((db.prepare('SELECT record FROM access_grants').get() as { record: string }).record)
    expect(saved.generation).toBe(2); expect(saved.revocation.requestId).toBe(revoke.requestId)
  } finally { db.close() }
})
it.each([undefined, false])('does not emit grant signals when grantOperations=%s', async grantOperations => {
  const f = await fixture(grantOperations === undefined ? {} : { grantOperations }), g = await grantFixture(f.runtime)
  await f.runtime.issueGrant(g.command); f.runtime.grant(g.proof.id); f.runtime.grants(); await f.runtime.close()
  expect(f.traces()).toEqual([]); expect(f.logs()).toEqual([]); expect(f.sums()).toEqual([])
})
it('collector rejection changes exporter health, not grant history or issuance/revocation authority', async () => {
  const f = await fixture({ grantOperations: true }, true), g = await grantFixture(f.runtime)
  await f.runtime.issueGrant(g.command); await f.runtime.telemetryFlush()
  expect(f.runtime.grant(g.proof.id).status).toBe('active')
  await f.runtime.revokeGrant({ id: g.proof.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner' })
  expect(f.runtime.grant(g.proof.id).status).toBe('revoked'); await f.runtime.close()
  expect(f.received.length).toBeGreaterThan(0)
})
it('preserves synchronous identity/throw and diagnostic hook failures without another call', () => {
  const result = {}, error = new Error('PRIVATE_ERROR'), work = vi.fn(() => result), end = vi.fn(() => { throw Error('broken') })
  expect(observeGrantCall(() => ({ end }), work)).toBe(result); expect(work).toHaveBeenCalledTimes(1)
  expect(end).toHaveBeenCalledWith('returned')
  try { observeGrantCall(() => { throw Error('begin') }, () => { throw error }) } catch (e) { expect(e).toBe(error) }
})
it.each([false, true])('settles an owned asynchronous call before ending, rejected=%s', async rejected => {
  let settle!: (value: unknown) => void, reject!: (error: unknown) => void
  const promise = new Promise((yes, no) => { settle = yes; reject = no }), end = vi.fn(), result = {}, error = new Error('PRIVATE_ASYNC')
  const value = observeGrantCall(() => ({ end }), () => promise); expect(end).not.toHaveBeenCalled()
  if (rejected) { reject(error); await expect(value).rejects.toBe(error); expect(end).toHaveBeenCalledWith('threw') }
  else { settle(result); expect(await value).toBe(result); expect(end).toHaveBeenCalledWith('returned') }
  expect(end).toHaveBeenCalledTimes(1)
})
it('ends once and contains failing diagnostic settlement callbacks', () => {
  const span = { setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn(), spanContext: () => ({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 }) }
  const callback = vi.fn(() => { throw Error('PRIVATE_DIAGNOSTIC') })
  const observed = observeGrantOperation({ startSpan: () => span } as any, 'get', undefined, callback)
  expect(() => { observed.end('threw'); observed.end('returned') }).not.toThrow(); expect(callback).toHaveBeenCalledTimes(1)
  expect(span.end).toHaveBeenCalledTimes(1)
})
it('refuses arbitrary operation labels and observations after telemetry shutdown', async () => {
  const t = new RuntimeTelemetry({ endpoint: 'http://127.0.0.1/v1/traces', authentication: { kind: 'none' }, grantOperations: true }, () => undefined)
  expect(t.observeGrantOperation('PRIVATE_LABEL' as any)).toBeUndefined(); await t.close()
  expect(t.observeGrantOperation('get')).toBeUndefined()
})
