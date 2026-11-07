import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { ProtobufTraceSerializer, JsonTraceSerializer, ProtobufMetricsSerializer, JsonMetricsSerializer,
  ProtobufLogsSerializer, JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import { LocalRuntime } from '../src/runtime/local.ts'
import { SQLiteNotificationStore } from '../src/notifications/sqlite-store.ts'
import { type NotificationRecord } from '../src/notifications/schema.ts'
import { RuntimeMetrics } from '../src/telemetry/metrics.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { runTrace } from '../src/runtime/run-types.ts'
import { parseTelemetryConfig, type TelemetryConfig } from '../src/telemetry/config.ts'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const attrs = (value: any) => Object.fromEntries((value.attributes ?? []).map((a: any) => [a.key,
  a.value.stringValue ?? a.value.intValue ?? a.value.boolValue ?? a.value.doubleValue]))
const notificationName = 'jevable.notification.delivery'
async function fixture(mode: 'all' | 'off' | 'metrics' | 'logs' | 'unsampled' = 'all') {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-notification-telemetry-'))
  const batches: Record<string, any[]> = { traces: [], metrics: [], logs: [] }, wire: Buffer[] = [], deliveries: any[] = []
  const traceSerialize = ProtobufTraceSerializer.serializeRequest, metricSerialize = ProtobufMetricsSerializer.serializeRequest,
    logSerialize = ProtobufLogsSerializer.serializeRequest
  vi.spyOn(ProtobufTraceSerializer, 'serializeRequest').mockImplementation(value => {
    batches.traces!.push(JSON.parse(Buffer.from(JsonTraceSerializer.serializeRequest(value)!).toString())); return traceSerialize(value)
  })
  vi.spyOn(ProtobufMetricsSerializer, 'serializeRequest').mockImplementation(value => {
    batches.metrics!.push(JSON.parse(Buffer.from(JsonMetricsSerializer.serializeRequest(value)!).toString())); return metricSerialize(value)
  })
  vi.spyOn(ProtobufLogsSerializer, 'serializeRequest').mockImplementation(value => {
    batches.logs!.push(JSON.parse(Buffer.from(JsonLogsSerializer.serializeRequest(value)!).toString())); return logSerialize(value)
  })
  let receiverReply: (reply: ServerResponse) => void = reply => { reply.writeHead(202); reply.end('PRIVATE_RESPONSE') }
  let collectorStatus = 200, arrival: (() => void) | undefined
  const stored = () => {
    const db = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'), { readOnly: true })
    try { return db.prepare('SELECT record FROM approval_deliveries ORDER BY rowid').all().map(row => JSON.parse(row.record as string) as NotificationRecord) }
    finally { db.close() }
  }
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    if (request.url === '/PRIVATE_DESTINATION') {
      deliveries.push({ event: JSON.parse(bytes.toString()), headers: request.headers, committed: stored().at(-1) })
      arrival?.(); receiverReply(reply)
    } else { wire.push(bytes); reply.writeHead(collectorStatus, { 'content-type': 'application/x-protobuf' }); reply.end() }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing listener')
  const base = `http://127.0.0.1:${address.port}`
  const telemetry = parseTelemetryConfig({ ...(mode === 'metrics' || mode === 'logs' ? {} : { endpoint: base + '/v1/traces' }),
    ...(mode === 'logs' ? {} : { metricsEndpoint: base + '/v1/metrics' }), ...(mode === 'metrics' ? {} : { logsEndpoint: base + '/v1/logs' }),
    sampleRatio: mode === 'unsampled' ? 0 : 1, authentication: { kind: 'none' }, intervalMs: 60000, timeoutMs: 500, flushTimeoutMs: 1000 })
  const endpoint = { id: 'PRIVATE_DESTINATION_ID', url: base + '/PRIVATE_DESTINATION', credentialRef: 'PRIVATE_KEY_REF', timeoutMs: 500 }
  const notifications = { endpoints: [endpoint] }, key = 'whsec_' + randomBytes(32).toString('base64')
  const open = async (config: TelemetryConfig | undefined = mode === 'off' ? undefined : telemetry, configured = true) => {
    const runtime = await LocalRuntime.open({ dataDirectory, ...(config ? { telemetry: config } : {}), ...(configured ? { notifications } : {}) })
    cleanup.push(() => runtime.close()); return runtime
  }
  const runtime = await open()
  runtime.setCredential(endpoint.credentialRef, key, 0, 'PRIVATE_OPERATOR')
  const run = await runtime.run(yaml, { message: 'PRIVATE_REVIEW' }); if (run.state.status !== 'waiting') throw Error('missing wait')
  const pin = { runId: run.id, revision: run.revision, attemptId: run.state.attempt.id }
  const { event, delivery, ...pins } = await runtime.prepareApprovalNotification(pin, endpoint.id)
  const request = { ...pins, requestId: randomUUID() }
  await runtime.telemetryFlush(); wire.length = 0; for (const values of Object.values(batches)) values.length = 0
  const spans = () => batches.traces!.flatMap(b => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)))
    .filter(span => span.name === notificationName)
  const logs = () => batches.logs!.flatMap(b => b.resourceLogs.flatMap((r: any) => r.scopeLogs.flatMap((s: any) => s.logRecords)))
    .filter(log => log.eventName === 'jevable.notification.delivery.ended')
  const metric = (name = 'jevable.notification.attempts') => batches.metrics!.at(-1)?.resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics)).find((m: any) => m.name === name)
  return { runtime, run, pin, request, event, notifications, telemetry, endpoint, key, dataDirectory, open, stored,
    batches, wire, deliveries, spans, logs, metric, rejectCollector: () => { collectorStatus = 503 },
    reply: (status: number) => { receiverReply = response => { response.writeHead(status); response.end('PRIVATE_RESPONSE') } },
    hold: () => new Promise<void>(resolve => { arrival = resolve; receiverReply = () => {} }) }
}

describe('durable notification telemetry', () => {
  it.each(['decided', 'cancelled'] as const)('exports the bounded %s event kind and durable identity without reconstructing history', async eventKind => {
    const f = await fixture()
    if (eventKind === 'decided') await f.runtime.decide(f.run.id, f.pin.attemptId, 'approve', 'PRIVATE_ACTOR')
    else f.runtime.cancel(f.run.id, randomUUID(), 'PRIVATE_ACTOR')
    await f.runtime.telemetryFlush()
    const { event: _event, delivery: _delivery, ...pins } = await f.runtime.prepareApprovalNotification({ ...f.pin, eventKind }, f.endpoint.id)
    const request = { ...pins, requestId: randomUUID() }, receipt = await f.runtime.sendApprovalNotification(request, 'PRIVATE_SENDER')
    await f.runtime.telemetryFlush()
    const spans = f.spans(), logs = f.logs()
    expect(spans).toHaveLength(1); expect(logs).toHaveLength(1)
    expect(attrs(spans[0])['jevable.notification.event_kind']).toBe(eventKind)
    expect(attrs(logs[0])['jevable.notification.event_kind']).toBe(eventKind)
    expect(logs[0].spanId).toBe(receipt.telemetry!.trace.spanId)
    expect(JSON.stringify([...spans, ...logs])).not.toMatch(/PRIVATE_|whsec_/)
    const prior = JSON.stringify(f.batches), count = f.deliveries.length
    await f.runtime.sendApprovalNotification(request, 'PRIVATE_SENDER'); await f.runtime.telemetryFlush()
    expect(JSON.stringify(f.batches)).toBe(prior); expect(f.deliveries).toHaveLength(count)
  })

  it('ends the original delivery observation once after explicit abort and never reconstructs it on abort history reads', async () => {
    const f = await fixture(), arrived = f.hold(), safety = new AbortController()
    const sending = f.runtime.sendApprovalNotification(f.request, 'actor', { signal: safety.signal })
    try {
      await arrived
      const acknowledgement = await f.runtime.abortApprovalNotification(f.request.requestId)
      expect(acknowledgement.status).toBe('abort-requested')
      const saved = await sending; await f.runtime.telemetryFlush()
      expect(saved.outcome).toMatchObject({ result: { status: 'uncertain', reason: 'aborted' } })
      expect(acknowledgement.receipt.telemetry).toEqual(saved.telemetry)
      expect(f.spans()).toHaveLength(1); expect(f.logs()).toHaveLength(1)
      expect(f.spans()[0].spanId).toBe(saved.telemetry!.trace.spanId)
      expect(attrs(f.logs()[0])['jevable.notification.outcome']).toBe('uncertain')
      expect(Number(f.metric().sum.dataPoints[0].asDouble ?? f.metric().sum.dataPoints[0].asInt)).toBe(1)
      const prior = JSON.stringify(f.batches), count = f.wire.length
      await f.runtime.abortApprovalNotification(f.request.requestId)
      await f.runtime.telemetryFlush()
      expect(JSON.stringify(f.batches)).toBe(prior); expect(f.wire).toHaveLength(count)
      expect(f.deliveries).toHaveLength(1)
    } finally { safety.abort(); await sending.catch(() => {}) }
  })

  it('commits trace identity before POST and joins all three signals to the workflow without private metadata', async () => {
    const f = await fixture(), result = await f.runtime.sendApprovalNotification(f.request, 'PRIVATE_ACTOR')
    expect(f.deliveries[0].committed.telemetry).toEqual(result.telemetry)
    expect(f.deliveries[0].committed.outcome.status).toBe('pending')
    expect(f.deliveries[0].event).toEqual(f.event); expect(f.deliveries[0].headers.traceparent).toBeUndefined()
    await f.runtime.telemetryFlush()
    const span = f.spans()[0], log = f.logs()[0]
    expect(span.spanId).toBe(result.telemetry!.trace.spanId); expect(span.traceId).toBe(result.telemetry!.trace.traceId)
    expect(span.links.map((link: any) => link.spanId)).toEqual([f.run.traceSegments!.at(-1)!.trace.spanId])
    expect(log.spanId).toBe(span.spanId); expect(log.traceId).toBe(span.traceId)
    expect(attrs(log)).toMatchObject({ 'jevable.notification.request_id': f.request.requestId, 'jevable.notification.outcome': 'accepted',
      'jevable.notification.intent_acknowledged': true, 'jevable.notification.transport_attempted': true, 'jevable.notification.settlement_acknowledged': true })
    const points = f.metric().sum.dataPoints
    expect(points).toHaveLength(1); expect(Number(points[0].asDouble ?? points[0].asInt)).toBe(1)
    expect(Object.keys(attrs(points[0])).sort()).toEqual(['jevable.notification.intent_acknowledged', 'jevable.notification.outcome',
      'jevable.notification.settlement_acknowledged', 'jevable.notification.transport_attempted'])
    expect(Number(f.metric('jevable.notification.duration').histogram.dataPoints[0].count)).toBe(1)
    expect(JSON.stringify(f.batches)).not.toContain('PRIVATE_'); expect(Buffer.concat(f.wire).includes(Buffer.from('PRIVATE_'))).toBe(false)
    expect(Buffer.concat(f.wire).includes(Buffer.from(f.key))).toBe(false)
  })
  it('links explicit redelivery after restart to the retained workflow and previous delivery, with an explicit parent only', async () => {
    const f = await fixture(), first = await f.runtime.sendApprovalNotification(f.request, 'actor')
    await f.runtime.close(); const reopened = await f.open()
    const parent = '00-11111111111111111111111111111111-2222222222222222-01'
    const next = { ...f.request, requestId: randomUUID(), redeliverOf: f.request.requestId }
    const second = await reopened.withTraceParent(parent, () => reopened.sendApprovalNotification(next, 'actor'))
    expect(second.telemetry!.previous).toEqual(first.telemetry!.trace)
    expect(second.telemetry!.workflow).toEqual(first.telemetry!.workflow)
    expect(second.telemetry!.parent!.spanId).toBe('2222222222222222')
    await reopened.telemetryFlush()
    const span = f.spans().at(-1)
    expect(span.traceId).toBe('11111111111111111111111111111111'); expect(span.parentSpanId).toBe('2222222222222222')
    expect(span.links.map((link: any) => link.spanId)).toEqual([second.telemetry!.workflow!.spanId, first.telemetry!.trace.spanId])
    expect(f.deliveries).toHaveLength(2)
  })
  it('does not reconstruct spans/logs/counters on prepare, inspection, same-ID reads or owner restart', async () => {
    const f = await fixture(), saved = await f.runtime.sendApprovalNotification(f.request, 'actor')
    await f.runtime.telemetryFlush(); const batches = JSON.stringify(f.batches), count = f.wire.length
    await f.runtime.inspectApprovalNotification(f.request.requestId); await f.runtime.prepareApprovalNotification(f.pin, f.endpoint.id)
    expect(await f.runtime.sendApprovalNotification(f.request, 'actor')).toEqual(saved)
    await f.runtime.telemetryFlush(); expect(f.wire).toHaveLength(count); expect(JSON.stringify(f.batches)).toBe(batches)
    await f.runtime.close(); const reopened = await f.open(f.telemetry, false), after = f.wire.length
    expect(await reopened.sendApprovalNotification(f.request, 'actor')).toEqual(saved)
    await reopened.telemetryFlush(); expect(f.wire).toHaveLength(after); expect(f.deliveries).toHaveLength(1)
  })
  it.each(['metrics', 'logs', 'unsampled'] as const)('retains unsampled identities with %s signals', async mode => {
    const f = await fixture(mode), saved = await f.runtime.sendApprovalNotification(f.request, 'actor')
    await f.runtime.telemetryFlush(); expect(saved.telemetry!.trace.traceFlags).toBe(0); expect(f.spans()).toHaveLength(0)
    if (mode !== 'metrics') expect(f.logs()[0].spanId).toBe(saved.telemetry!.trace.spanId)
    if (mode !== 'logs') expect(f.metric().sum.dataPoints).toHaveLength(1)
  })
  it('preserves legacy untraced receipts without retrofitting identity when telemetry is enabled later', async () => {
    const f = await fixture('off'), saved = await f.runtime.sendApprovalNotification(f.request, 'actor')
    expect(saved.telemetry).toBeUndefined(); await f.runtime.close()
    const reopened = await f.open(f.telemetry)
    expect(await reopened.sendApprovalNotification(f.request, 'actor')).toEqual(saved)
    await reopened.telemetryFlush(); expect(f.wire).toHaveLength(0)
    const next = await reopened.sendApprovalNotification({ ...f.request, requestId: randomUUID(), redeliverOf: f.request.requestId }, 'actor')
    expect(next.telemetry!.previous).toBeUndefined(); expect(next.telemetry!.workflow).toBeUndefined()
    expect(f.deliveries).toHaveLength(2)
  })
  it.each([400, 503])('records receiver rejection %s as failure, not approval or an automatic retry', async status => {
    const f = await fixture(); f.reply(status)
    const saved = await f.runtime.sendApprovalNotification(f.request, 'actor'); await f.runtime.telemetryFlush()
    expect(saved.outcome).toMatchObject({ result: { status: 'rejected', httpStatus: status } })
    expect(attrs(f.spans()[0])['jevable.notification.outcome']).toBe('rejected'); expect(f.spans()[0].status.code).toBe(2)
    expect((await f.runtime.show(f.run.id)).state.status).toBe('waiting'); expect(f.deliveries).toHaveLength(1)
  })
  it('observes per-delivery abort as uncertain while keeping workflow approval unchanged', async () => {
    const f = await fixture(), arrived = f.hold(), controller = new AbortController()
    const sending = f.runtime.sendApprovalNotification(f.request, 'actor', { signal: controller.signal })
    await arrived; controller.abort(); const saved = await sending; await f.runtime.telemetryFlush()
    expect(saved.outcome).toMatchObject({ result: { status: 'uncertain', reason: 'aborted' } })
    expect(attrs(f.logs()[0])).toMatchObject({ 'jevable.notification.outcome': 'uncertain', 'jevable.notification.uncertainty': 'aborted' })
    expect((await f.runtime.show(f.run.id)).state.status).toBe('waiting')
  })
  it.each(['intent-before', 'intent-after', 'settlement-before', 'settlement-after'] as const)('keeps %s acknowledgement uncertainty separate from durable evidence', async phase => {
    const f = await fixture(), method = phase.startsWith('intent') ? 'createIntent' : 'settle'
    const original: (this: SQLiteNotificationStore, value: NotificationRecord) => boolean | void = SQLiteNotificationStore.prototype[method]
    const spy = vi.spyOn(SQLiteNotificationStore.prototype, method).mockImplementation(function(this: SQLiteNotificationStore, value: NotificationRecord): never {
      if (phase.endsWith('after')) original.call(this, value)
      throw Error('PRIVATE_DATABASE_ERROR')
    })
    await expect(f.runtime.sendApprovalNotification(f.request, 'actor')).rejects.toThrow('PRIVATE_DATABASE_ERROR'); spy.mockRestore()
    await f.runtime.telemetryFlush()
    const observed = attrs(f.spans()[0]), isIntent = phase.startsWith('intent')
    expect(observed).toMatchObject({ 'jevable.notification.outcome': isIntent ? 'intent-not-acknowledged' : 'settlement-not-acknowledged',
      'jevable.notification.intent_acknowledged': !isIntent, 'jevable.notification.transport_attempted': !isIntent,
      'jevable.notification.settlement_acknowledged': false })
    expect(f.deliveries).toHaveLength(isIntent ? 0 : 1)
    if (phase !== 'intent-before') {
      const saved = await f.runtime.sendApprovalNotification(f.request, 'actor')
      expect(saved.telemetry!.trace.spanId).toBe(f.spans()[0].spanId)
      expect(saved.outcome.status).toBe(phase === 'settlement-after' ? 'settled' : 'pending')
      await f.runtime.telemetryFlush(); expect(f.spans()).toHaveLength(1)
    }
    expect(JSON.stringify(f.batches)).not.toContain('PRIVATE_')
  })
  it('collector failure and instrumentation end failure do not alter delivery or authorize replay', async () => {
    const f = await fixture(); f.rejectCollector()
    const saved = await f.runtime.sendApprovalNotification(f.request, 'actor'); await f.runtime.telemetryFlush()
    const status: any = f.runtime.telemetryStatus()
    expect(status.failedBatches).toBeGreaterThan(0); expect(status.metrics.failedBatches).toBeGreaterThan(0); expect(status.logs.failedBatches).toBeGreaterThan(0)
    expect(saved.outcome).toMatchObject({ result: { status: 'accepted' } })
    expect(await f.runtime.sendApprovalNotification(f.request, 'actor')).toEqual(saved)
    vi.spyOn(RuntimeMetrics.prototype, 'notification').mockImplementation(() => { throw Error('PRIVATE_DIAGNOSTIC_ERROR') })
    const next = await f.runtime.sendApprovalNotification({ ...f.request, requestId: randomUUID(), redeliverOf: f.request.requestId }, 'actor')
    expect(next.outcome).toMatchObject({ result: { status: 'accepted' } }); expect(f.deliveries).toHaveLength(2)
  })
  it('bounds labels across many request/destination identities and sanitizes unknown observation outcomes', async () => {
    const f = await fixture(), saved = await f.runtime.sendApprovalNotification(f.request, 'actor')
    await f.runtime.telemetryFlush()
    const telemetry = new RuntimeTelemetry(f.telemetry, () => undefined); cleanup.push(() => telemetry.close())
    for (let i = 0; i < 150; i++) {
      const record = structuredClone(saved); record.request.requestId = randomUUID(); record.request.endpointId = 'PRIVATE_ENDPOINT_' + i
      record.request.endpointSha256 = i.toString(16).padStart(64, '0')
      const observer = telemetry.notification(record, f.run)!
      const result = { outcome: 'PRIVATE_OUTCOME_' + i, intentAcknowledged: false, transportAttempted: false,
        settlementAcknowledged: false, reason: 'PRIVATE_REASON', httpStatus: -1 } as any
      observer.finish(result); observer.finish(result)
    }
    await telemetry.flush()
    const points = f.metric().sum.dataPoints; expect(points).toHaveLength(1)
    expect(Number(points[0].asDouble ?? points[0].asInt)).toBe(150)
    expect(attrs(points[0])['jevable.notification.outcome']).toBe('other')
    expect(JSON.stringify(f.batches)).not.toContain('PRIVATE_')
  })
  it('does not permit settlement to replace an intent trace identity', async () => {
    const f = await fixture(), saved = await f.runtime.sendApprovalNotification(f.request, 'actor')
    const changed = structuredClone(saved); changed.telemetry!.trace = runTrace.parse({ ...changed.telemetry!.trace, spanId: 'abcdef1234567890' })
    const db = new DatabaseSync(join(f.dataDirectory, 'runtime.sqlite'))
    try {
      const store = new SQLiteNotificationStore(db, { maxDeliveries: 10000, maxEvents: 20000 })
      expect(() => store.settle(changed)).toThrow('conflict')
    } finally { db.close() }
    expect(await f.runtime.inspectApprovalNotification(f.request.requestId)).toMatchObject({ telemetry: saved.telemetry })
  })
  it.each(['workflow', 'previous'] as const)('refuses a forged %s trace link even when delivery snapshots and their audit agree', async link => {
    const f = await fixture(); let saved = await f.runtime.sendApprovalNotification(f.request, 'actor')
    if (link === 'previous') saved = await f.runtime.sendApprovalNotification({ ...f.request, requestId: randomUUID(), redeliverOf: f.request.requestId }, 'actor')
    await f.runtime.close()
    const db = new DatabaseSync(join(f.dataDirectory, 'runtime.sqlite'))
    try {
      for (const table of ['approval_deliveries', 'approval_delivery_events']) {
        const rows = db.prepare(`SELECT rowid AS rid,record FROM ${table}`).all()
        for (const row of rows) {
          const record = JSON.parse(row.record as string)
          if (record.request.requestId !== saved.request.requestId) continue
          record.telemetry[link].spanId = 'abcdef1234567890'
          db.prepare(`UPDATE ${table} SET record=? WHERE rowid=?`).run(JSON.stringify(record), row.rid as number)
        }
      }
    } finally { db.close() }
    await expect(f.open()).rejects.toHaveProperty('code', 'corrupt')
  })
})
