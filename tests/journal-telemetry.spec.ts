import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { parseTelemetryConfig, type TelemetryConfig } from '../src/telemetry/config.ts'
import { PostgresJournal, JournalError, parsePostgresConfiguration } from '../src/storage/postgres.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { showSchema } from '../src/contracts.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { fields, logRecords } from '../scripts/check-telemetry-package.mjs'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
const otherParent = '00-' + '3'.repeat(32) + '-' + '4'.repeat(16) + '-01'
const database = { host: '127.0.0.1', port: 5432, database: 'fixture', user: 'fixture', password: 'PRIVATE_DATABASE_PASSWORD',
  namespace: 'PRIVATE_NAMESPACE', initialize: false, tls: { mode: 'loopback-test' as const } }
const baseline = { endpoint: 'http://127.0.0.1/v1/traces', authentication: { kind: 'none' as const } }
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
// Actual journal/runtime control flow against a SQL-client double. This does not qualify real PostgreSQL.
function journalFixture() {
  const client = new EventEmitter() as EventEmitter & { query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  const { password: _password, ...options } = parsePostgresConfiguration(database)
  const journal = new (PostgresJournal as any)(client, options) as PostgresJournal
  Object.assign(journal, { state: 'open', epoch: '1' })
  let credentialReads = 0
  client.query = vi.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith('SELECT owner_id')) return { rows: [{ owner_id: journal.ownerId, epoch: '1' }] }
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: '0' }] }
    if (sql.startsWith('SELECT version,deleted,CASE') && parameters?.[1] === 'provider-credentials') {
      credentialReads++
      const value = JSON.stringify({ ref: parameters[2], generation: 1, updatedAt: '2026-10-04T00:00:00.000Z', value: 'PRIVATE_EXPORT_BEARER' })
      return { rows: [{ version: '1', deleted: false, value, bytes: Buffer.byteLength(value) }] }
    }
    return { rows: [] }
  })
  client.end = vi.fn(async () => {})
  cleanup.push(() => journal.close())
  const enqueue = <T>(work: () => Promise<T>, kind: 'read' | 'write' = 'read'): Promise<T> => (journal as any).enqueue(work, kind)
  return { journal, client, enqueue, credentialReads: () => credentialReads }
}
async function receiver() {
  const packets: { path: string; bytes: Buffer; authorization: string | undefined; baggage: string | undefined }[] = []
  let refuse = false
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk)
    packets.push({ path: request.url!, bytes: Buffer.concat(chunks), authorization: request.headers.authorization, baggage: request.headers.baggage as string | undefined })
    response.writeHead(refuse ? 503 : 200, { 'content-type': 'application/x-protobuf' }); response.end()
  })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  cleanup.push(() => new Promise<void>(yes => { server.close(() => yes()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('listener')
  const base = `http://127.0.0.1:${address.port}`
  const config: TelemetryConfig = { endpoint: base + '/v1/traces', logsEndpoint: base + '/v1/logs', authentication: { kind: 'none' },
    intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000 }
  const spans = () => packets.filter(p => p.path === '/v1/traces').flatMap(p => traceRecords(p.bytes))
  const logs = () => packets.filter(p => p.path === '/v1/logs').flatMap(p => logRecords(p.bytes))
  return { config, packets, spans, logs, reject: () => { refuse = true } }
}
function telemetry(config: TelemetryConfig, storage: 'postgres' | 'sqlite' = 'postgres') {
  const owner = new RuntimeTelemetry(config, () => undefined, { storage }); cleanup.push(() => owner.close()); return owner
}

describe('opt-in journal transaction OTel', () => {
  it('is a strict independent default-off opt-in requiring traces or logs, not metrics alone', () => {
    expect(parseTelemetryConfig(baseline).journalTransactions).toBe(false)
    for (const value of [null, 'true', 1]) expect(() => parseTelemetryConfig({ ...baseline, journalTransactions: value })).toThrow('invalid-command')
    expect(() => parseTelemetryConfig({ metricsEndpoint: baseline.endpoint, authentication: baseline.authentication, journalTransactions: true })).toThrow('invalid-command')
    expect(parseTelemetryConfig({ logsEndpoint: baseline.endpoint, authentication: baseline.authentication, journalTransactions: true }).storageTransactionMetrics).toBe(false)
    expect((showSchema('telemetry-config').schema as any).properties.journalTransactions).toMatchObject({ type: 'boolean', default: false })
  })
  it('refuses SQLite startup before opening state; never advertises unsupported tracing', async () => {
    const directory = join(await mkdtemp(join(tmpdir(), 'jevable-journal-unsupported-')), 'must-not-open')
    await expect(LocalRuntime.open({ dataDirectory: directory, telemetry: { ...baseline, journalTransactions: true } })).rejects.toMatchObject({ code: 'invalid-command' })
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    const owner = telemetry({ ...baseline, journalTransactions: true }, 'sqlite')
    expect(owner.observeJournalTransaction('read')).toBeUndefined(); expect(owner.status()).toMatchObject({ journalTransactions: false })
  })
  it.each([undefined, false])('emits nothing when opt-in is %s', async enabled => {
    const wire = await receiver(), config = enabled === undefined ? wire.config : { ...wire.config, journalTransactions: enabled }
    const owner = telemetry(config), f = journalFixture()
    f.journal.setTransactionObserver(kind => owner.observeJournalTransaction(kind))
    expect(await f.enqueue(async () => 'value')).toBe('value'); await owner.flush(); expect(wire.packets).toEqual([])
  })
  it.each([0, 1])('receives six bounded kind/outcome groups with owned correlation at sampling %s', async sampleRatio => {
    const wire = await receiver(), owner = telemetry({ ...wire.config, journalTransactions: true, sampleRatio, baggageKeys: ['request.class'] })
    for (const kind of ['read', 'write'] as const) for (const outcome of ['acknowledged', 'failed-before-commit', 'commit-uncertain'] as const) {
      const observation = owner.withTraceContext({ traceparent: parent, baggage: 'request.class=PRIVATE_BAGGAGE' }, () => owner.observeJournalTransaction(kind))!
      observation.end(outcome); observation.end(outcome)
    }
    await owner.flush()
    expect(wire.spans()).toHaveLength(sampleRatio ? 6 : 0); expect(wire.logs()).toHaveLength(6)
    expect(owner.status()).toMatchObject({ journalTransactions: true, signals: ['traces', 'logs'] })
    const groups = new Set<string>()
    for (const log of wire.logs()) {
      const outcome = log.attributes['jevable.storage.transaction.outcome'], failed = outcome !== 'acknowledged'
      groups.add(log.attributes['jevable.storage.transaction.kind'] + '/' + outcome)
      expect(log.event).toBe('jevable.storage.journal.transaction.ended'); expect(Reflect.get(log, 'body')).toBe(log.event)
      expect(log.traceId).toBe('1'.repeat(32)); expect(log.spanId).toMatch(/^[a-f0-9]{16}$/u)
      expect(Reflect.get(log, 'severity')).toBe(failed ? 17 : 9); expect(log.attributes['jevable.duration.seconds']).toBeGreaterThanOrEqual(0)
      expect(Object.keys(log.attributes).sort()).toEqual(['jevable.storage.transaction.kind', 'jevable.storage.transaction.outcome', 'jevable.duration.seconds', ...(failed ? ['error.type'] : [])].sort())
      if (sampleRatio) expect(wire.spans().find(span => span.spanId === log.spanId)).toMatchObject({ parent: '2'.repeat(16), traceId: log.traceId, name: 'jevable.storage.journal.transaction' })
    }
    expect(groups.size).toBe(6)
    for (const span of wire.spans()) {
      expect(Reflect.get(span, 'links')).toEqual([]); expect(Reflect.get(span, 'resource')['jevable.storage.kind']).toBe('postgres')
      expect(Object.keys(span.attributes).sort()).toEqual(['jevable.storage.transaction.kind', 'jevable.storage.transaction.outcome', ...(span.attributes['error.type'] ? ['error.type'] : [])].sort())
    }
    for (const packet of wire.packets) { expect(packet.baggage).toBeUndefined(); expect(packet.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false) }
    const rawSpans = wire.packets.filter(p => p.path === '/v1/traces').flatMap(p => (fields(p.bytes).get(1) ?? []).flatMap((r: Buffer) =>
      (fields(r).get(2) ?? []).flatMap((s: Buffer) => (fields(s).get(2) ?? []).map((span: Buffer) => fields(span)))))
    for (const span of rawSpans) {
      const attributes = wire.spans().find(s => s.spanId === span.get(2)![0].toString('hex'))!.attributes
      expect(Number(fields(span.get(15)![0]).get(3)![0])).toBe(attributes['jevable.storage.transaction.outcome'] === 'acknowledged' ? 1 : 2)
      expect(span.get(8)![0].readBigUInt64LE()).toBeGreaterThanOrEqual(span.get(7)![0].readBigUInt64LE())
    }
  })
  it.each(['traces', 'logs'] as const)('supports %s-only destinations without invented other signals', async signal => {
    const wire = await receiver(), owner = telemetry({ ...wire.config, ...(signal === 'logs' ? { endpoint: undefined } : { logsEndpoint: undefined }), journalTransactions: true })
    owner.observeJournalTransaction('read')!.end('acknowledged'); await owner.flush()
    expect(wire.spans()).toHaveLength(signal === 'traces' ? 1 : 0); expect(wire.logs()).toHaveLength(signal === 'logs' ? 1 : 0)
  })
  it('isolates queued request parents, excludes queue admission delay and skips pre-BEGIN lost work', async () => {
    const wire = await receiver(), owner = telemetry({ ...wire.config, journalTransactions: true }), f = journalFixture(), gate = held(), entered = held()
    f.journal.setTransactionObserver(kind => owner.observeJournalTransaction(kind))
    const first = owner.withParent(parent, () => f.enqueue(async () => { entered.release(); await gate.promise; return 1 }))
    await entered.promise
    const second = owner.withParent(otherParent, () => f.enqueue(async () => 2, 'write'))
    expect(owner.status()).toMatchObject({ accepted: 0 }); gate.release(); expect(await Promise.all([first, second])).toEqual([1, 2])
    await owner.flush()
    expect(wire.spans().find(s => s.attributes['jevable.storage.transaction.kind'] === 'write')).toMatchObject({ traceId: '3'.repeat(32), parent: '4'.repeat(16) })
    expect(wire.spans().find(s => s.attributes['jevable.storage.transaction.kind'] === 'read')).toMatchObject({ traceId: '1'.repeat(32), parent: '2'.repeat(16) })
    const enteredAgain = held(), releaseAgain = held()
    const active = f.enqueue(async () => { enteredAgain.release(); await releaseAgain.promise }), queued = f.enqueue(async () => 3).catch(e => e)
    await enteredAgain.promise; f.client.emit('error', Error('PRIVATE_LOSS')); releaseAgain.release()
    await expect(active).rejects.toMatchObject({ code: 'commit-uncertain' }); expect(await queued).toMatchObject({ code: 'ownership-lost' })
    await owner.flush(); expect(wire.spans()).toHaveLength(3); expect(wire.logs()).toHaveLength(3)
    expect(wire.spans().at(-1)!.attributes['jevable.storage.transaction.outcome']).toBe('commit-uncertain')
  })
  it('never consults ambient OTel context and rejects foreign kinds before starting', async () => {
    const wire = await receiver(), owner = telemetry({ ...wire.config, journalTransactions: true })
    const ambient = vi.spyOn(context, 'active').mockReturnValue(trace.setSpanContext(ROOT_CONTEXT, { traceId: '9'.repeat(32), spanId: '8'.repeat(16), traceFlags: 1 }))
    expect(owner.observeJournalTransaction('PRIVATE_KIND' as never)).toBeUndefined()
    owner.observeJournalTransaction('read')!.end('acknowledged'); await owner.flush()
    expect(wire.spans()[0]!.traceId).not.toBe('9'.repeat(32)); expect(wire.spans()[0]!.parent).toBeUndefined(); expect(ambient).not.toHaveBeenCalled()
  })
  it('export refusal cannot replace a value/domain error or replay SQL/workflow actions', async () => {
    const wire = await receiver(), owner = telemetry({ ...wire.config, journalTransactions: true }), f = journalFixture()
    f.journal.setTransactionObserver(kind => owner.observeJournalTransaction(kind)); wire.reject()
    const work = vi.fn(async () => ({ private: 'PRIVATE_PAYLOAD' })), error = new JournalError('conflict')
    expect(await f.enqueue(work)).toEqual({ private: 'PRIVATE_PAYLOAD' })
    await expect(f.enqueue(async () => { throw error }, 'write')).rejects.toBe(error)
    const queries = f.client.query.mock.calls.length; await owner.flush(); await owner.flush()
    expect(work).toHaveBeenCalledOnce(); expect(f.client.query).toHaveBeenCalledTimes(queries)
    expect(owner.status()).toMatchObject({ failedBatches: 1, logs: { failedBatches: 1 } })
    expect(wire.spans()).toHaveLength(2); expect(wire.logs()).toHaveLength(2)
  })
  it('closes once and does not manufacture transaction history after shutdown', async () => {
    const wire = await receiver(), owner = telemetry({ ...wire.config, journalTransactions: true })
    owner.observeJournalTransaction('write')!.end('acknowledged'); await owner.close(); await owner.close()
    expect(owner.observeJournalTransaction('read')).toBeUndefined(); expect(wire.spans()).toHaveLength(1); expect(wire.logs()).toHaveLength(1)
  })
  it.each(['creation', 'settlement'] as const)('isolates OTel %s faults without replacing values/errors or causing SQL retries', async failure => {
    const wire = await receiver(), owner = telemetry({ ...wire.config, journalTransactions: true }), f = journalFixture()
    if (failure === 'creation') vi.spyOn((owner as any).provider, 'getTracer').mockImplementation(() => { throw Error('PRIVATE_TRACER_ERROR') })
    else vi.spyOn((owner as any).logs, 'journalTransaction').mockImplementation(() => { throw Error('PRIVATE_LOG_ERROR') })
    f.journal.setTransactionObserver(kind => owner.observeJournalTransaction(kind))
    const value = {}, error = new JournalError('limit'), work = vi.fn(async () => value)
    expect(await f.enqueue(work)).toBe(value); await expect(f.enqueue(async () => { throw error })).rejects.toBe(error)
    expect(work).toHaveBeenCalledOnce(); expect(f.client.query).toHaveBeenCalledTimes(6)
    expect(f.client.query.mock.calls.at(-1)![0]).toBe('ROLLBACK'); expect(f.journal.status().state).toBe('open')
    await owner.flush(); expect(wire.logs()).toHaveLength(0); expect(wire.spans()).toHaveLength(failure === 'settlement' ? 2 : 0)
  })
  it('runtime busy-close refuses while an observed journal request is active, then drains without a duplicate settlement', async () => {
    const wire = await receiver(), f = journalFixture()
    vi.spyOn(PostgresJournal, 'open').mockResolvedValue(f.journal)
    const owner = await PostgresRuntime.open({ database, telemetry: { ...wire.config, journalTransactions: true } })
    cleanup.push(() => owner.close())
    const query = f.client.query.getMockImplementation()!, gate = held(), entered = held()
    f.client.query.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'BEGIN') { entered.release(); await gate.promise }
      return Reflect.apply(query, undefined, args)
    })
    const request = owner.health(); await entered.promise
    await expect(owner.close()).rejects.toMatchObject({ code: 'busy' }); expect(f.client.end).not.toHaveBeenCalled()
    gate.release(); await request; await owner.close()
    expect(wire.spans()).toHaveLength(1); expect(wire.logs()).toHaveLength(1); expect(f.client.end).toHaveBeenCalledOnce()
  })
  it.each([false, true])('wires runtime opt-in=%s after startup; exporter credential SQL remains counted but never recursive', async enabled => {
    const wire = await receiver(), f = journalFixture(), setObserver = vi.spyOn(f.journal, 'setTransactionObserver')
    vi.spyOn(PostgresJournal, 'open').mockResolvedValue(f.journal)
    const owner = await PostgresRuntime.open({ database, telemetry: { ...wire.config, journalTransactions: enabled,
      storageTransactionMetrics: true, metricsEndpoint: wire.config.endpoint!.replace('/v1/traces', '/v1/metrics'),
      authentication: { kind: 'bearer', credentialRef: 'private.collector' } } })
    cleanup.push(() => owner.close())
    expect(setObserver).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(wire.packets).toHaveLength(0)
    const before = f.credentialReads(); await owner.health(); await owner.telemetryFlush()
    expect(wire.spans()).toHaveLength(enabled ? 1 : 0); expect(wire.logs()).toHaveLength(enabled ? 1 : 0)
    const readsAfterFlush = f.credentialReads(); expect(readsAfterFlush - before).toBe(enabled ? 3 : 1)
    const metrics = f.journal.transactionMetrics(); if (!metrics.available) throw Error('missing metrics')
    expect(metrics.values.filter(v => v.kind === 'read' && v.outcome === 'acknowledged')[0]!.transactions).toBe(1 + readsAfterFlush - before)
    await owner.telemetryFlush(); await owner.close()
    expect(wire.spans()).toHaveLength(enabled ? 1 : 0); expect(wire.logs()).toHaveLength(enabled ? 1 : 0)
    expect(f.client.end).toHaveBeenCalledOnce()
    for (const packet of wire.packets) {
      expect(packet.authorization).toBe('Bearer PRIVATE_EXPORT_BEARER'); expect(packet.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false)
    }
  })
})
