import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProtobufTraceSerializer, JsonTraceSerializer, ProtobufMetricsSerializer, JsonMetricsSerializer,
  ProtobufLogsSerializer, JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import { startRuntimeService } from '../src/http/service.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import type { HttpRateDebit } from '../src/http/coordinated-rate-limits.ts'
import type { HttpRateSqlObserver } from '../src/http/rate-sql-observation.ts'

const fake = vi.hoisted(() => ({ clients: [] as any[], row: undefined as any, present: true, version: '170011',
  intercept: undefined as undefined | ((text: string, values: any[]) => Promise<any> | any) }))
vi.mock('pg/lib/client.js', () => ({ default: class {
  queries: { text: string; values: any[] }[] = []
  listeners = new Map<string, (() => void)[]>()
  connect = vi.fn(async () => {})
  end = vi.fn(async () => {})
  constructor(readonly options: any) { fake.clients.push(this) }
  on(name: string, listener: () => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); return this }
  emit(name: string) { for (const listener of this.listeners.get(name) ?? []) listener() }
  async query(text: string, values: any[] = []) {
    this.queries.push({ text, values: structuredClone(values) })
    const custom = await fake.intercept?.(text, values)
    if (custom !== undefined) return custom
    if (text === 'SHOW server_version_num') return { rows: [{ server_version_num: fake.version }] }
    if (text.includes('to_regclass')) return { rows: [{ present: fake.present ? 'jevable_http_rate.scopes' : null }] }
    if (text.startsWith('INSERT INTO') && !fake.row) fake.row = { format: 'jevable.http-rate/v1', version: 1,
      policy_sha256: values[1], policy: values[2], requests_units: String(values[3]), controls_units: String(values[4]), at_ms: '1000' }
    if (text.startsWith('SELECT CASE')) return { rows: fake.row ? [structuredClone(fake.row)] : [] }
    if (text.startsWith('WITH instant')) return { rows: [{ admitted: true, retry_after: 0 }] }
    return { rows: [] }
  }
} }))
import { PostgresHttpRateCoordinator, PostgresHttpRateCoordinatorError,
  type PostgresHttpRateCoordinatorOptions } from '../src/http/postgres-rate-limits.ts'

const bucket = { capacity: 2, refillTokens: 1, refillIntervalMs: 1000 }, policy = { requests: bucket, controls: { ...bucket, capacity: 3 } }
const owners: PostgresHttpRateCoordinator[] = []
const cleanup: (() => Promise<unknown>)[] = []
beforeEach(() => { fake.clients = []; fake.row = undefined; fake.present = true; fake.version = '170011'; fake.intercept = undefined })
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); for (const owner of owners.splice(0)) await owner.close(); vi.restoreAllMocks() })
function config(): PostgresHttpRateCoordinatorOptions { return { connection: { host: '127.0.0.1', port: 54321, database: 'fixture', user: 'fixture',
  password: 'PRIVATE_FIXTURE_PASSWORD', tls: { mode: 'loopback-test' } }, scope: randomUUID(), policy: structuredClone(policy), initialize: true,
  timeoutMs: 1000, statementTimeoutMs: 500, maxPendingDebits: 4 } }
async function open(value = config()) { const owner = await PostgresHttpRateCoordinator.open(value); owners.push(owner); return owner }
function debit(owner: PostgresHttpRateCoordinator, lane: 'requests' | 'controls' = 'requests'): HttpRateDebit {
  const admission = owner.admission()
  return { requestId: randomUUID(), scope: admission.scope, policy: admission.policy,
    policySha256: createHash('sha256').update(JSON.stringify(admission.policy)).digest('hex'), lane }
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }

describe('PostgreSQL coordinator admission/session ownership (driver doubles, SQL arithmetic qualified separately)', () => {
  it.each([{ enabled: true, sampled: 1 }, { enabled: true, sampled: 0 }, { enabled: false, sampled: 1 }])('serializes owned SQL span/log/metric observations through real local HTTP (%j), with a PG driver double', async ({ enabled, sampled }) => {
    const batches: Record<string, any[]> = { traces: [], metrics: [], logs: [] }, wire: Buffer[] = []
    for (const [signal, proto, json] of [['traces', ProtobufTraceSerializer, JsonTraceSerializer], ['metrics', ProtobufMetricsSerializer, JsonMetricsSerializer], ['logs', ProtobufLogsSerializer, JsonLogsSerializer]] as const) {
      const serialize = proto.serializeRequest
      vi.spyOn(proto, 'serializeRequest').mockImplementation((v: any) => { batches[signal]!.push(JSON.parse(Buffer.from(json.serializeRequest(v)!).toString())); return serialize(v) })
    }
    const collector = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); wire.push(Buffer.concat(chunks)); res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end() })
    await new Promise<void>((resolve, reject) => { collector.once('error', reject); collector.listen(0, '127.0.0.1', () => { collector.off('error', reject); resolve() }) })
    cleanup.push(() => new Promise<void>(resolve => { collector.close(() => resolve()); collector.closeAllConnections() }))
    const address = collector.address(); if (!address || typeof address === 'string') throw Error('listener')
    const base = `http://127.0.0.1:${address.port}`, coordinator = await open(), token = 'a'.repeat(64), remoteId = '1'.repeat(32)
    const server = await startRuntimeService({ token, actor: 'PRIVATE_ACTOR', coordinatedRateLimits: coordinator.admission(), runtime: {
      dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-quota-sql-')), telemetry: { authentication: { kind: 'none' },
        endpoint: base + '/v1/traces', metricsEndpoint: base + '/v1/metrics', logsEndpoint: base + '/v1/logs',
        httpRequests: true, httpResponseContext: true, httpAccessDecisions: enabled, sampleRatio: sampled,
        intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 2000 } } })
    cleanup.push(async () => { await server.close(); await server.closed })
    const response = await fetch(server.url + '/v1/health', { headers: { authorization: `Bearer ${token}`,
      'x-jevable-protocol': PROTOCOL_VERSION, traceparent: `00-${remoteId}-${'2'.repeat(16)}-01`, baggage: 'PRIVATE_BAGGAGE', tracestate: 'PRIVATE_STATE' } })
    expect(response.status).toBe(200); await response.arrayBuffer(); await server.close(); await server.closed
    const attrs = (row: any) => Object.fromEntries((row.attributes ?? []).map((a: any) => [a.key, Object.values(a.value)[0]]))
    const spans = batches.traces!.flatMap(b => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans))),
      logs = batches.logs!.flatMap(b => b.resourceLogs.flatMap((r: any) => r.scopeLogs.flatMap((s: any) => s.logRecords))),
      sql = spans.filter(s => s.name === 'jevable.http.rate.sql'), sqlLogs = logs.filter(l => l.eventName === 'jevable.http.rate.sql.ended'),
      metrics = batches.metrics!.at(-1).resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics)),
      sqlMetrics = metrics.filter((m: any) => m.name.startsWith('jevable.http.rate.sql.'))
    expect(sql).toHaveLength(enabled && sampled ? 4 : 0); expect(sqlLogs).toHaveLength(enabled ? 4 : 0); expect(sqlMetrics).toHaveLength(enabled ? 2 : 0)
    if (enabled) {
      expect(sqlLogs.map(l => attrs(l)['jevable.http.rate.sql.operation']).sort()).toEqual(['begin', 'commit', 'debit', 'lock'])
      for (const log of sqlLogs) { expect(attrs(log)['jevable.http.rate.sql.outcome']).toBe('acknowledged'); expect(log.traceId).not.toBe(remoteId) }
      for (const metric of sqlMetrics) { const points = metric.sum?.dataPoints ?? metric.histogram.dataPoints; expect(points).toHaveLength(4)
        for (const point of points) { expect(Object.keys(attrs(point)).sort()).toEqual(['jevable.http.rate.sql.operation', 'jevable.http.rate.sql.outcome']); expect(Number(point.asInt ?? point.asDouble ?? point.count)).toBe(1) } }
      if (sampled) { const quota = spans.find(s => s.name === 'jevable.http.access' && attrs(s)['jevable.http.access.stage'] === 'coordinated-rate-controls'); expect(quota).toBeDefined()
        for (const span of sql) { expect(span.traceId).toBe(quota.traceId); expect(span.parentSpanId).toBe(quota.spanId); expect(span.kind).toBe(3)
          expect(Object.keys(attrs(span)).sort()).toEqual(['db.operation.name', 'db.system.name', 'jevable.http.rate.sql.operation', 'jevable.http.rate.sql.outcome'])
          const log = sqlLogs.find(l => l.spanId === span.spanId && l.traceId === span.traceId); expect(log).toBeDefined() } }
    }
    expect(wire.length).toBeGreaterThan(0); expect(wire.every(b => b.length > 0)).toBe(true)
    const exported = JSON.stringify(batches); for (const secret of [token, 'PRIVATE_ACTOR', 'PRIVATE_BAGGAGE', 'PRIVATE_STATE', 'PRIVATE_FIXTURE_PASSWORD', coordinator.status().scope]) expect(exported).not.toContain(secret)
    // Real local HTTP/OTLP transport and paired JSON serialization; PostgreSQL driver is a double.
    // Not a real PostgreSQL COMMIT, Collector binary decoding, durable ingestion or Kubernetes proof.
  }, 15000)
  it.each(['requests', 'controls'] as const)('observes the exact entered SQL calls and acknowledgements on %s without query/parameter disclosure', async lane => {
    const owner = await open(), client = fake.clients[0], events: unknown[] = []
    const observe: HttpRateSqlObserver = operation => { events.push(['start', operation]); return { end: outcome => { events.push(['end', operation, outcome]) } } }
    client.queries = []
    expect(await owner.consume(debit(owner, lane), new AbortController().signal, observe)).toMatchObject({ admitted: true, lane })
    expect(events).toEqual(['begin', 'lock', 'debit', 'commit'].flatMap(op => [['start', op], ['end', op, 'acknowledged']]))
    expect(client.queries).toHaveLength(4); expect(JSON.stringify(events)).not.toMatch(/PRIVATE|jevable_http_rate|requests_units|policy_sha256/)
  })
  it.each(['begin', 'lock', 'debit', 'commit', 'rollback'] as const)('retains original failure/uncertain ownership when %s fails, with no SQL replay', async operation => {
    const owner = await open(), client = fake.clients[0], events: string[][] = [], order = ['begin', 'lock', 'debit', 'commit']
    client.queries = []
    const observe: HttpRateSqlObserver = op => ({ end: outcome => { events.push([op, outcome]) } })
    fake.intercept = text => {
      if (operation === 'begin' && text === 'BEGIN' || operation === 'lock' && text.startsWith('SELECT CASE')
        || operation === 'debit' && text.startsWith('WITH instant') || operation === 'commit' && text === 'COMMIT'
        || operation === 'rollback' && (text.startsWith('WITH instant') || text === 'ROLLBACK')) throw Error('PRIVATE_SQL_DRIVER')
    }
    await expect(owner.consume(debit(owner), new AbortController().signal, observe)).rejects.toHaveProperty('code', operation === 'commit' ? 'commit-uncertain' : 'unavailable')
    const failedIndex = operation === 'rollback' ? 2 : order.indexOf(operation)
    expect(events).toEqual([...order.slice(0, failedIndex).map(op => [op, 'acknowledged']),
      [operation === 'rollback' ? 'debit' : operation, operation === 'commit' ? 'uncertain' : 'failed'],
      ...(operation === 'commit' ? [] : [['rollback', operation === 'rollback' ? 'failed' : 'acknowledged']])])
    expect(client.queries.filter((q: any) => q.text === 'COMMIT')).toHaveLength(operation === 'commit' ? 1 : 0)
    expect(owner.status().state).toBe(operation === 'commit' || operation === 'rollback' ? 'lost' : 'open')
  })
  it.each(['begin-throws', 'end-throws', 'async-begin', 'async-end'] as const)('contains %s diagnostics without awaiting, repeating or changing SQL results', async mode => {
    const owner = await open(), client = fake.clients[0]; client.queries = []
    const observe = (() => {
      if (mode === 'begin-throws') throw Error('PRIVATE_OBSERVER')
      if (mode === 'async-begin') return Promise.reject(Error('PRIVATE_OBSERVER'))
      return { end() { if (mode === 'end-throws') throw Error('PRIVATE_OBSERVER'); if (mode === 'async-end') return Promise.reject(Error('PRIVATE_OBSERVER')) } }
    }) as HttpRateSqlObserver
    expect(await owner.consume(debit(owner), new AbortController().signal, observe)).toMatchObject({ admitted: true })
    await new Promise<void>(resolve => setImmediate(resolve)); expect(client.queries).toHaveLength(4); expect(owner.status().state).toBe('open')
  })
  it('reports acknowledged COMMIT even if a later abort suppresses the receipt, without a fictional rollback or refund', async () => {
    const owner = await open(), controller = new AbortController(), events: string[][] = []
    fake.intercept = text => { if (text === 'COMMIT') controller.abort() }
    await expect(owner.consume(debit(owner), controller.signal, op => ({ end: outcome => { events.push([op, outcome]) } }))).rejects.toHaveProperty('code', 'aborted')
    expect(events).toEqual(['begin', 'lock', 'debit', 'commit'].map(op => [op, 'acknowledged'])); expect(owner.status().state).toBe('open')
  })
  it('does not start observations or SQL for malformed, already-aborted or sealed commands', async () => {
    const owner = await open(), observe = vi.fn(), client = fake.clients[0]; client.queries = []
    await expect(owner.consume({ ...debit(owner), extra: 'PRIVATE' } as never, new AbortController().signal, observe)).rejects.toHaveProperty('code', 'invalid-command')
    const aborted = new AbortController(); aborted.abort(); await expect(owner.consume(debit(owner), aborted.signal, observe)).rejects.toHaveProperty('code', 'aborted')
    await owner.close(); await expect(owner.consume(debit(owner), new AbortController().signal, observe)).rejects.toHaveProperty('code', 'closed')
    expect(observe).not.toHaveBeenCalled(); expect(client.queries).toEqual([])
  })
  it.each([null, {}, { ...config(), extra: true }, { ...config(), scope: 'bad' }, { ...config(), initialize: 'yes' },
    { ...config(), timeoutMs: 99 }, { ...config(), timeoutMs: 5001 }, { ...config(), statementTimeoutMs: 99 },
    { ...config(), timeoutMs: 100, statementTimeoutMs: 101 }, { ...config(), maxPendingDebits: 0 }, { ...config(), maxPendingDebits: 65 },
    { ...config(), connection: { ...config().connection, host: 'remote.invalid', tls: { mode: 'loopback-test' } } },
    { ...config(), connection: { ...config().connection, password: '' } },
    { ...config(), connection: { ...config().connection, connectionString: 'PRIVATE_URI' } },
    { ...config(), connection: { ...config().connection, tls: { mode: 'verify-full', ca: 'invalid' } } },
    { ...config(), policy: { ...policy, requests: { ...bucket, capacity: 0 } } },
  ])('refuses malformed explicit configuration before constructing a client (%#)', async value => {
    await expect(PostgresHttpRateCoordinator.open(value as never)).rejects.toHaveProperty('code', 'invalid-config')
    expect(fake.clients).toHaveLength(0)
  })
  it('captures startup policy, initializes only explicitly and never creates a workflow journal or session lock', async () => {
    const value = config(), expected = structuredClone(value), pending = open(value)
    value.policy.requests.capacity = 99; value.scope = randomUUID(); value.connection.host = 'changed.invalid'
    const owner = await pending, client = fake.clients[0]
    expect(client.options).toMatchObject({ host: '127.0.0.1', port: 54321, database: 'fixture', password: 'PRIVATE_FIXTURE_PASSWORD',
      ssl: false, connectionTimeoutMillis: 1000, statement_timeout: 500, query_timeout: 1500 })
    expect(owner.admission().policy).toEqual(expected.policy); expect(owner.status().scope).toBe(expected.scope)
    owner.admission().policy.requests.capacity = 99; expect(owner.admission().policy).toEqual(expected.policy)
    expect(client.queries.some((q: any) => q.text.includes('CREATE SCHEMA'))).toBe(true)
    expect(client.queries.some((q: any) => /jevable_journal|pg_try_advisory_lock/u.test(q.text))).toBe(false)
    expect(JSON.stringify(owner.status())).not.toContain('PRIVATE_FIXTURE_PASSWORD')
  })
  it('attaches without resetting balances or initializing scope/schema', async () => {
    const first = await open(), value = config(); value.scope = first.admission().scope; value.initialize = false
    const second = await open(value), client = fake.clients[1], before = structuredClone(fake.row)
    expect(second.status().state).toBe('open')
    expect(client.queries.some((q: any) => /CREATE|INSERT|UPDATE jevable/u.test(q.text))).toBe(false)
    expect(fake.row).toEqual(before)
  })
  it('pins verified TLS configuration and never adopts an unsafe Node TLS environment override', async () => {
    const value = config(); value.connection.host = 'reviewed.invalid'; value.connection.tls = { mode: 'verify-full' }
    await open(value)
    expect(fake.clients[0].options.ssl).toMatchObject({ rejectUnauthorized: true, minVersion: 'TLSv1.2', checkServerIdentity: expect.any(Function) })
    expect(fake.clients[0].options).not.toHaveProperty('connectionString')
  })
  it.each(['table', 'scope', 'version', 'format', 'hash', 'policy', 'units', 'anchor'] as const)('refuses missing/conflicting/corrupt retained %s without overwriting it', async mode => {
    const first = await open(), value = config(); value.scope = first.admission().scope; value.initialize = false
    if (mode === 'table') fake.present = false
    if (mode === 'scope') fake.row = undefined
    if (mode === 'version') fake.row.version = 2
    if (mode === 'format') fake.row.format = 'wrong'
    if (mode === 'hash') fake.row.policy_sha256 = 'b'.repeat(64)
    if (mode === 'policy') fake.row.policy = '{}'
    if (mode === 'units') fake.row.requests_units = '2001'
    if (mode === 'anchor') fake.row.at_ms = '9223372036854775808'
    const before = structuredClone(fake.row)
    await expect(PostgresHttpRateCoordinator.open(value)).rejects.toBeInstanceOf(PostgresHttpRateCoordinatorError)
    expect(fake.row).toEqual(before); expect(fake.clients[1].end).toHaveBeenCalledTimes(1)
    expect(fake.clients[1].queries.at(-1).text).toBe('ROLLBACK')
  })
  it('requires PostgreSQL 17 before initializing anything', async () => {
    fake.version = '180000'
    await expect(open()).rejects.toHaveProperty('code', 'version-mismatch')
    expect(fake.clients[0].queries).toEqual([{ text: 'SHOW server_version_num', values: [] }])
    expect(fake.clients[0].end).toHaveBeenCalledTimes(1)
  })
  it('returns bound admission only after commit; quota refusal is a committed refill observation, not a thrown driver hint', async () => {
    const owner = await open(), request = debit(owner), client = fake.clients[0], signal = new AbortController().signal
    client.queries = []
    expect(await owner.consume(request, signal)).toEqual({ requestId: request.requestId, scope: request.scope, policySha256: request.policySha256, lane: request.lane, admitted: true })
    expect(client.queries.map((q: any) => q.text.startsWith('SELECT CASE') ? 'LOCK' : q.text.startsWith('WITH instant') ? 'DEBIT' : q.text)).toEqual(['BEGIN', 'LOCK', 'DEBIT', 'COMMIT'])
    fake.intercept = text => text.startsWith('WITH instant') ? { rows: [{ admitted: false, retry_after: 2 }] } : undefined
    expect(await owner.consume(debit(owner, 'controls'), signal)).toMatchObject({ lane: 'controls', admitted: false, retryAfterSeconds: 2 })
    expect(client.queries.at(-1).text).toBe('COMMIT'); expect(owner.status().pendingDebits).toBe(0)
  })
  it.each(['scope', 'hash', 'policy', 'extra', 'lane', 'signal', 'aborted'] as const)('refuses invalid %s before enqueue or SQL', async field => {
    const owner = await open(), request: any = debit(owner), client = fake.clients[0], controller = new AbortController()
    if (field === 'scope') request.scope = randomUUID()
    if (field === 'hash') request.policySha256 = 'b'.repeat(64)
    if (field === 'policy') request.policy.requests.capacity++
    if (field === 'extra') request.actor = 'PRIVATE_ACTOR'
    if (field === 'lane') request.lane = 'other'
    if (field === 'aborted') controller.abort()
    client.queries = []
    await expect(owner.consume(request, field === 'signal' ? {} as never : controller.signal)).rejects.toBeInstanceOf(PostgresHttpRateCoordinatorError)
    expect(client.queries).toEqual([]); expect(owner.status().pendingDebits).toBe(0)
  })
  it('bounds active plus waiting debits, isolates captured request mutation and refuses aborted queued work before BEGIN', async () => {
    const value = config(); value.maxPendingDebits = 2
    const owner = await open(value), entered = gate(), hold = gate(), client = fake.clients[0]
    fake.intercept = async text => { if (text.startsWith('SELECT CASE')) { entered.resolve(); await hold.promise } }
    const first = owner.consume(debit(owner), new AbortController().signal); await entered.promise
    const original = debit(owner), controller = new AbortController(), queued = owner.consume(original, controller.signal)
    const rejected = expect(queued).rejects.toHaveProperty('code', 'aborted')
    original.scope = randomUUID(); controller.abort()
    await expect(owner.consume(debit(owner), new AbortController().signal)).rejects.toHaveProperty('code', 'capacity')
    expect(owner.status().pendingDebits).toBe(2); hold.resolve(); await first; await rejected
    expect(client.queries.filter((q: any) => q.text === 'BEGIN')).toHaveLength(2) // startup plus first debit only
    expect(owner.status().pendingDebits).toBe(0)
  })
  it('checks elapsed monotonic admission deadline after a delayed lock, before UPDATE or COMMIT', async () => {
    const owner = await open(), client = fake.clients[0]; let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    fake.intercept = text => { if (text.startsWith('SELECT CASE')) now = 1000 }
    client.queries = []
    await expect(owner.consume(debit(owner), new AbortController().signal)).rejects.toHaveProperty('code', 'aborted')
    expect(client.queries.at(-1).text).toBe('ROLLBACK'); expect(client.queries.some((q: any) => q.text.startsWith('WITH instant'))).toBe(false)
  })
  it.each([{ admitted: true, retry_after: 1 }, { admitted: false, retry_after: 0 }, { admitted: false, retry_after: 3601 },
    { admitted: 'yes', retry_after: 0 }, undefined])('rolls back malformed debit results before COMMIT (%#)', async row => {
    const owner = await open(), client = fake.clients[0]; client.queries = []
    fake.intercept = text => text.startsWith('WITH instant') ? { rows: row ? [row] : [] } : undefined
    await expect(owner.consume(debit(owner), new AbortController().signal)).rejects.toHaveProperty('code', 'corrupt')
    expect(client.queries.at(-1).text).toBe('ROLLBACK'); expect(client.queries.some((q: any) => q.text === 'COMMIT')).toBe(false)
  })
  it('sanitizes driver errors and rolls back before any next explicit attempt', async () => {
    const owner = await open(), client = fake.clients[0]
    fake.intercept = text => { if (text.startsWith('WITH instant')) throw Error('PRIVATE_DATABASE_CONNECTION') }
    await expect(owner.consume(debit(owner), new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' })
    expect(client.queries.at(-1).text).toBe('ROLLBACK'); expect(owner.status().state).toBe('open')
  })
  it('does not roll back, refund, replay or reconnect after an uncertain COMMIT acknowledgement', async () => {
    const owner = await open(), client = fake.clients[0]; client.queries = []
    fake.intercept = text => { if (text === 'COMMIT') throw Error('PRIVATE_COMMIT_SOCKET') }
    await expect(owner.consume(debit(owner), new AbortController().signal)).rejects.toHaveProperty('code', 'commit-uncertain')
    expect(client.queries.at(-1).text).toBe('COMMIT'); expect(owner.status().state).toBe('lost')
    expect(client.end).toHaveBeenCalledTimes(1); expect(client.connect).toHaveBeenCalledTimes(1)
    await expect(owner.consume(debit(owner), new AbortController().signal)).rejects.toHaveProperty('code', 'unavailable')
    expect(client.queries.filter((q: any) => q.text === 'COMMIT')).toHaveLength(1)
  })
  it('returns no receipt after acknowledged commit if abort arrives, without refund or reconnect', async () => {
    const owner = await open(), client = fake.clients[0], controller = new AbortController(); client.queries = []
    fake.intercept = text => { if (text === 'COMMIT') controller.abort() }
    await expect(owner.consume(debit(owner), controller.signal)).rejects.toHaveProperty('code', 'aborted')
    expect(client.queries.at(-1).text).toBe('COMMIT'); expect(owner.status().state).toBe('open'); expect(client.end).not.toHaveBeenCalled()
  })
  it('seals queued admission, lets only already-active SQL settle, and owns one normal close', async () => {
    const owner = await open(), entered = gate(), hold = gate(), client = fake.clients[0]
    fake.intercept = async text => { if (text.startsWith('SELECT CASE')) { entered.resolve(); await hold.promise } }
    const active = owner.consume(debit(owner), new AbortController().signal); await entered.promise
    const queued = owner.consume(debit(owner), new AbortController().signal), refused = expect(queued).rejects.toHaveProperty('code', 'closed')
    const closing = owner.close(); expect(owner.status().state).toBe('closing'); expect(client.end).not.toHaveBeenCalled()
    hold.resolve(); await active; await refused; await closing; await owner.close()
    expect(client.end).toHaveBeenCalledTimes(1); expect(owner.status().state).toBe('closed'); expect(owner.status().pendingDebits).toBe(0)
  })
  it('seals the owner on session loss and never silently reconnects', async () => {
    const owner = await open(), client = fake.clients[0]; client.emit('error')
    await expect(owner.consume(debit(owner), new AbortController().signal)).rejects.toHaveProperty('code', 'unavailable')
    expect(client.connect).toHaveBeenCalledTimes(1); expect(client.end).toHaveBeenCalledTimes(1)
  })
})
