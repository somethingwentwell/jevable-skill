import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, createHmac } from 'node:crypto'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { parse, stringify } from 'yaml'
import { LocalRuntime, reviewAutomaticApprovalPolicy, type NotificationRuntimeConfig } from '../src/runtime/index.ts'
import type { LocalRun } from '../src/runtime/run-types.ts'
import { notificationSha256, type NotificationRecord, type NotificationEndpoint } from '../src/notifications/schema.ts'
import type { ApprovalNotificationDispatcher } from '../src/notifications/dispatcher.ts'
import { parseTelemetryConfig } from '../src/telemetry/config.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { fields, metricSums, logRecords, resourceAttributes } from '../scripts/check-telemetry-package.mjs'

const loopYaml = await readFile(new URL('../examples/loop-approval.yaml', import.meta.url), 'utf8')
const approvalYaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
type Mode = 'sampled' | 'unsampled' | 'logs-metrics'
type Span = ReturnType<typeof traceRecords>[number] & { links: { traceId: string; spanId: string }[]; resource: Record<string, string> }
type Wire = { path: string; contentType: string | undefined; bytes: Buffer }
type Received = { path: string; body: string; headers: Record<string, string | undefined>; keyGeneration: number; valid: boolean; intent: NotificationRecord | undefined }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  // Release test barriers before owner drain; a failed assertion must not strand a real POST.
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.useRealTimers()
})
async function until(check: () => boolean | Promise<boolean>) {
  // Expiry cases deliberately fake Date only; the test deadline remains monotonic.
  const deadline = performance.now() + 5000
  while (!await check()) { if (performance.now() > deadline) throw Error('Fixture condition did not arrive'); await delay(5) }
}
function waiting(run: LocalRun) { if (run.state.status !== 'waiting') throw Error('Expected a waiting approval'); return run.state }
function source(mode: 'forEach' | 'repeatUntil', terminalReject = false) {
  const doc = parse(loopYaml), loop = doc.spec.nodes.each.config
  if (mode === 'repeatUntil') {
    doc.spec.inputSchema = { type: 'string' }; loop.mode = mode; delete loop.items
    loop.input = '${{ inputs }}'; loop.until = '${{ loop.index >= 1 }}'; loop.maxIterations = 2; loop.onLimit = 'fail'
  }
  if (terminalReject) {
    loop.body.nodes.review.config.onReject = 'cancelled'
    loop.body.exits = loop.body.exits.filter((exit: { port: string }) => exit.port !== 'reject')
  }
  return stringify(doc)
}

/** Actual SQLite/public startup and received OTLP bytes. No serializer mock or Collector service. */
async function fixture(label: string, yaml = loopYaml, mode: Mode = 'sampled', destinations = 1) {
  const privateRoot = process.env.JEVABLE_AUTOMATIC_INTERACTION_FIXTURE_DIR
  let root = tmpdir()
  if (privateRoot !== undefined) {
    root = await realpath(privateRoot)
    const qualification = await realpath(join(dirname(fileURLToPath(import.meta.url)), '..', '.qualification'))
    if (dirname(root) !== qualification || !/^automatic-interactions-source-[A-Za-z0-9]+$/u.test(root.slice(qualification.length + 1)))
      throw Error('Fixture evidence root must be a private automatic-interactions source directory')
  }
  const directory = await mkdtemp(join(root, 'case-'))
  const wire: Wire[] = [], received: Received[] = [], owners: LocalRuntime[] = [], gates: (() => void)[] = []
  const checkpoints: { label: string; population: ReturnType<typeof population> }[] = []
  const keyHistory: { ref: string; generation: number; value: string }[] = []
  const currentKeys = new Map<string, { generation: number; value: string }>()
  const replies = new Map<string, number>(), held = new Map<string, ServerResponse[]>()
  let endpoints: NotificationEndpoint[] = [], config: NotificationRuntimeConfig | undefined
  const population = () => {
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'), { readOnly: true })
    try {
      return Object.fromEntries(['runs', 'events', 'approval_deliveries', 'automatic_approval_admissions', 'automatic_approval_events'].map(table =>
        [table, db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
          ? db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() : []]))
    } finally { db.close() }
  }
  const records = () => (population().approval_deliveries ?? []).map(row => JSON.parse(row.record as string) as NotificationRecord)
  const checkpoint = (label: string) => { const value = population(); checkpoints.push({ label, population: value }); return value }
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
      const bytes = Buffer.concat(chunks), path = req.url ?? ''
      if (path.startsWith('/v1/')) {
        wire.push({ path, contentType: req.headers['content-type'], bytes })
        res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(); return
      }
      const ep = endpoints.find(value => new URL(value.url).pathname === path), key = ep && currentKeys.get(ep.credentialRef)
      if (!ep || !key) throw Error('Unconfigured fixture destination')
      const body = bytes.toString(), headers = Object.fromEntries(['webhook-id', 'webhook-timestamp', 'webhook-signature', 'traceparent']
        .map(name => [name, typeof req.headers[name] === 'string' ? req.headers[name] : undefined]))
      const signature = 'v1,' + createHmac('sha256', Buffer.from(key.value.slice(6), 'base64'))
        .update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64')
      const intent = records().find(record => record.event.id === headers['webhook-id'] && record.request.endpointId === ep.id)
      received.push({ path, body, headers, keyGeneration: key.generation, valid: headers['webhook-signature'] === signature, intent })
      const pending = held.get(path)
      if (pending) pending.push(res)
      else { res.writeHead(replies.get(path) ?? 202); res.end('PRIVATE_RECIPIENT_RESPONSE') }
    } catch { res.writeHead(500); res.end('fixture error') }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture listener missing')
  const base = `http://127.0.0.1:${address.port}`
  endpoints = Array.from({ length: destinations }, (_, index) => ({ id: `PRIVATE_RECIPIENT_${index}`, url: `${base}/PRIVATE_DESTINATION_${index}`,
    credentialRef: `PRIVATE_SIGNING_REF_${index}`, timeoutMs: 1500 }))
  const telemetry = parseTelemetryConfig({ ...(mode === 'logs-metrics' ? {} : { endpoint: base + '/v1/traces' }),
    metricsEndpoint: base + '/v1/metrics', logsEndpoint: base + '/v1/logs', authentication: { kind: 'none' },
    sampleRatio: mode === 'unsampled' ? 0 : 1, intervalMs: 60000, timeoutMs: 1000, flushTimeoutMs: 1500 })
  const release = () => {
    for (const gate of gates.splice(0)) gate()
    for (const [path, responses] of held) for (const response of responses) { response.writeHead(replies.get(path) ?? 202); response.end() }
    held.clear()
  }
  cleanups.push(async () => {
    release()
    try {
      for (const owner of owners.slice().reverse()) await owner.close()
      if (privateRoot !== undefined) {
        const files = {
          'fixture.json': { label, mode, directory, endpoints, config, authority: 'synthetic loopback test only; public reviewed source startup; no shipped qualification' },
          'received.json': received,
          'wire.json': wire.map(({ bytes, ...metadata }) => ({ ...metadata, body: bytes.toString('base64') })),
          'population.json': population(), 'checkpoints.json': checkpoints, 'synthetic-keys.json': keyHistory,
        }
        for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
      }
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    }
  })
  const seed = await LocalRuntime.open({ dataDirectory: directory, notifications: { endpoints } }); owners.push(seed)
  const project = await seed.editProject({ operation: 'create', title: 'Automatic interaction fixture', yaml, actor: 'PRIVATE_AUTHOR' })
  for (const endpoint of endpoints) {
    const value = 'whsec_' + randomBytes(32).toString('base64'), key = { generation: 1, value }
    seed.setCredential(endpoint.credentialRef, value, 0, 'PRIVATE_AUTHOR'); currentKeys.set(endpoint.credentialRef, key)
    keyHistory.push({ ref: endpoint.credentialRef, ...key })
  }
  await seed.close()
  const scope = { kind: 'project', id: project.id, generation: project.generation, revision: project.acceptedRevision }
  function configuration(selected: NotificationEndpoint[]) {
    const review = reviewAutomaticApprovalPolicy({ format: 'jevable.ai/automatic-approval-policy/v1', routes: selected.map(endpoint => ({
      scope, endpointId: endpoint.id, endpointSha256: notificationSha256(endpoint), eventKinds: ['requested', 'decided', 'expired', 'cancelled'] })) })
    return { endpoints: selected, maxInFlight: 4, automatic: { policy: review.policy, reviewedPolicySha256: review.policySha256,
      maxPending: 4, maxAdmissions: 100, maxEvents: 200 } } satisfies NotificationRuntimeConfig
  }
  config = configuration(endpoints)
  const open = async (notifications: NotificationRuntimeConfig = config!) => {
    const owner = await LocalRuntime.open({ dataDirectory: directory, telemetry, notifications }); owners.push(owner); return owner
  }
  const owner = await open()
  const start = (runtime = owner, input: unknown = ['PRIVATE_FIRST_ITEM', 'PRIVATE_SECOND_ITEM']) =>
    runtime.runProject(project.id, project.generation, project.acceptedRevision, input, { id: randomUUID() })
  const idle = async (runtime = owner) => {
    await until(() => { const status = runtime.automaticApprovalNotificationStatus(); return status.live?.pending === 0 && status.live?.active === 0 })
    expect(runtime.automaticApprovalNotificationStatus().live).not.toHaveProperty('fault')
  }
  const admissions = async (runtime = owner) => (await runtime.automaticApprovalAdmissions({ limit: 100 })).records
  const traces = () => wire.filter(p => p.path === '/v1/traces').flatMap(p => traceRecords(p.bytes)) as Span[]
  const logs = () => wire.filter(p => p.path === '/v1/logs').flatMap(p => logRecords(p.bytes))
  const metric = () => {
    const packet = wire.filter(p => p.path === '/v1/metrics').at(-1)
    return packet && metricSums(packet.bytes).find(m => m.name === 'jevable.notification.attempts')
  }
  async function audit(runtime = owner, extraUnretainedObservations = 0, currentOwnerAttempts?: number) {
    await idle(runtime); await runtime.telemetryFlush()
    const retained = records(), ledger = await admissions(runtime), allSpans = traces(), notificationSpans = allSpans.filter(span => span.name === 'jevable.notification.delivery')
    const notificationLogs = logs().filter(log => log.event === 'jevable.notification.delivery.ended')
    expect(received.every(post => post.valid && post.intent?.outcome.status === 'pending' && post.headers.traceparent === undefined)).toBe(true)
    for (const post of received) {
      const event = JSON.parse(post.body)
      expect(post.headers['webhook-id']).toBe(event.id)
      expect(post.intent?.event).toEqual(event)
      expect(post.intent?.credentialGeneration).toBe(post.keyGeneration)
    }
    for (const admission of ledger) if (admission.outcome.status === 'delivery-recorded') {
      const receipt = retained.find(record => record.request.requestId === admission.request.requestId)
      expect(receipt).toBeDefined(); expect(receipt!.request).toEqual(admission.request); expect(receipt!.event).toEqual(admission.event)
      expect(receipt!.actor).toBe(`automatic:${admission.policySha256}`)
      expect(notificationSha256(receipt)).toBe(admission.outcome.deliverySha256)
    }
    for (const receipt of retained) {
      const identity = receipt.telemetry!.trace, log = notificationLogs.filter(value => value.spanId === identity.spanId && value.traceId === identity.traceId)
      expect(log).toHaveLength(1)
      const attributes = { 'jevable.run.id': receipt.request.runId, 'jevable.attempt.id': receipt.request.attemptId,
        'jevable.notification.request_id': receipt.request.requestId, 'jevable.notification.event_id': receipt.event.id,
        'jevable.notification.endpoint_sha256': receipt.request.endpointSha256, 'jevable.notification.event_kind': receipt.request.eventKind ?? 'requested',
        'jevable.notification.intent_acknowledged': true, 'jevable.notification.transport_attempted': true,
        'jevable.notification.settlement_acknowledged': true,
        'jevable.notification.outcome': receipt.outcome.status === 'settled' ? receipt.outcome.result.status : 'pending' }
      expect(log[0]!.attributes).toMatchObject(attributes)
      expect(log[0]!.event).toBe(log[0]!.body)
      if (mode === 'sampled') {
        expect(identity.traceFlags).toBe(1)
        const matched = notificationSpans.filter(span => span.spanId === identity.spanId && span.traceId === identity.traceId)
        expect(matched).toHaveLength(1); expect(matched[0]!.attributes).toMatchObject(attributes)
        expect(matched[0]!.parent).toBeUndefined()
        const workflow = receipt.telemetry!.workflow!
        expect(matched[0]!.links).toEqual([{ traceId: workflow.traceId, spanId: workflow.spanId }])
        expect(allSpans.some(span => span.traceId === workflow.traceId && span.spanId === workflow.spanId)).toBe(true)
      } else expect(identity.traceFlags).toBe(0)
    }
    if (mode === 'sampled') expect(notificationSpans).toHaveLength(retained.length + extraUnretainedObservations)
    else expect(allSpans).toEqual([])
    expect(notificationLogs).toHaveLength(retained.length + extraUnretainedObservations)
    const counter = metric(); expect(counter).toBeDefined(); expect(counter!.temporality).toBe(2)
    // Cumulative counters are process-local, not reconstructed from historical receipts on reopen.
    expect(counter!.points.reduce((sum, point) => sum + point.value, 0)).toBe(currentOwnerAttempts ?? retained.length + extraUnretainedObservations)
    const metricPacket = wire.filter(packet => packet.path === '/v1/metrics').at(-1)!
    const durations = (fields(metricPacket.bytes).get(1) ?? []).flatMap(resource => (fields(resource).get(2) ?? []).flatMap(scope =>
      (fields(scope).get(2) ?? []).filter(metric => fields(metric).get(1)![0].toString() === 'jevable.notification.duration')))
    expect(durations).toHaveLength(1)
    const duration = fields(fields(durations[0]).get(9)![0])
    expect(Number(duration.get(2)![0])).toBe(2)
    expect((duration.get(1) ?? []).reduce((sum, point) => sum + Number(fields(point).get(4)![0].readBigUInt64LE()), 0))
      .toBe(currentOwnerAttempts ?? retained.length + extraUnretainedObservations)
    for (const point of counter!.points) expect(Object.keys(point.labels).sort()).toEqual([
      'jevable.notification.intent_acknowledged', 'jevable.notification.outcome', 'jevable.notification.settlement_acknowledged', 'jevable.notification.transport_attempted'])
    for (const packet of wire) {
      expect(packet.contentType).toBe('application/x-protobuf')
      expect(resourceAttributes(packet.bytes).every(resource => !!resource['service.name'] && !!resource['service.instance.id'])).toBe(true)
      expect(packet.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false)
      for (const key of keyHistory) expect(packet.bytes.includes(Buffer.from(key.value))).toBe(false)
    }
    // Endpoint IDs are retained correlation metadata; private payloads/actors/URLs/credential references are not.
    for (const values of [ledger, retained]) for (const forbidden of ['PRIVATE_FIRST_ITEM', 'PRIVATE_SECOND_ITEM', 'PRIVATE_REPEATED_ITEM',
      'PRIVATE_REVIEW_INPUT', 'PRIVATE_AUTHOR', 'PRIVATE_REVIEWER', 'PRIVATE_OPERATOR', 'PRIVATE_SIGNING_REF_', 'PRIVATE_DESTINATION_', 'whsec_'])
      expect(JSON.stringify(values)).not.toContain(forbidden)
    return { retained, ledger, notificationSpans, notificationLogs, counter: counter! }
  }
  return { owner, directory, endpoints, received, wire, records, population, checkpoint, scope, config, configuration, open, start, idle, admissions,
    audit, gates, release, traces, logs, metric,
    hold(index = 0) { held.set(new URL(endpoints[index]!.url).pathname, []) },
    reject(index: number, status = 503) { replies.set(new URL(endpoints[index]!.url).pathname, status) },
    rotate(runtime = owner, index = 0) {
      const endpoint = endpoints[index]!, previous = currentKeys.get(endpoint.credentialRef)!, value = 'whsec_' + randomBytes(32).toString('base64')
      runtime.setCredential(endpoint.credentialRef, value, previous.generation, 'PRIVATE_OPERATOR')
      const key = { generation: previous.generation + 1, value }; currentKeys.set(endpoint.credentialRef, key); keyHistory.push({ ref: endpoint.credentialRef, ...key })
    },
  }
}

describe('public source automatic lifecycle interactions and received OTLP', () => {
  for (const loop of ['forEach', 'repeatUntil'] as const) for (const mode of ['sampled', 'unsampled', 'logs-metrics'] as const) {
    it(`${loop}/${mode}: each committed review attempt has distinct scoped lifecycle identities and observed delivery`, async () => {
      const f = await fixture(`${loop}-${mode}`, source(loop), mode)
      const first = await f.start(f.owner, loop === 'forEach' ? ['PRIVATE_FIRST_ITEM', 'PRIVATE_SECOND_ITEM'] : 'PRIVATE_REPEATED_ITEM')
      await f.idle(); expect(waiting(first).scope).toEqual({ loop: 'each', index: 0 })
      const second = await f.owner.decide(first.id, waiting(first).attempt.id, 'approve', 'PRIVATE_REVIEWER')
      await f.idle(); expect(waiting(second).scope).toEqual({ loop: 'each', index: 1 })
      expect(waiting(second).attempt.id).not.toBe(waiting(first).attempt.id)
      const done = await f.owner.decide(first.id, waiting(second).attempt.id, 'approve', 'PRIVATE_REVIEWER')
      expect(done.state).toMatchObject({ status: 'completed', output: { count: 2 } })
      const checked = await f.audit(); expect(checked.ledger).toHaveLength(4); expect(checked.retained).toHaveLength(4); expect(f.received).toHaveLength(4)
      for (const [index, run] of [first, second].entries()) {
        const events = checked.ledger.filter(record => record.request.attemptId === waiting(run).attempt.id)
        expect(events.map(record => record.request.eventKind).sort()).toEqual(['decided', 'requested'])
        expect(events.every(record => record.event.data.scope?.index === index && record.event.data.loopExpiresAt === new Date(first.loopDeadlines.each!).toISOString())).toBe(true)
        expect(events[0]!.event.data).toEqual(events[1]!.event.data)
      }
      expect(new Set(checked.ledger.map(record => record.request.requestId)).size).toBe(4)
      expect(new Set(checked.ledger.map(record => record.event.id)).size).toBe(4)
      const before = f.checkpoint('before-history'), postCount = f.received.length, notificationCount = checked.notificationLogs.length
      await expect(f.owner.decide(first.id, waiting(first).attempt.id, 'approve', 'PRIVATE_REVIEWER')).rejects.toHaveProperty('code', 'conflict')
      await f.owner.show(first.id); await f.owner.events(first.id); await f.admissions(); await f.owner.telemetryFlush()
      expect(f.checkpoint('after-history')).toEqual(before); expect(f.received).toHaveLength(postCount)
      expect(f.logs().filter(log => log.event === 'jevable.notification.delivery.ended')).toHaveLength(notificationCount)
      await f.owner.close(); const reopened = await f.open()
      expect(await reopened.show(first.id)).toEqual(done); await reopened.events(first.id); await f.admissions(reopened); await reopened.telemetryFlush()
      expect(f.checkpoint('after-reopen')).toEqual(before); expect(f.received).toHaveLength(postCount)
      expect(f.logs().filter(log => log.event === 'jevable.notification.delivery.ended')).toHaveLength(notificationCount)
    })
  }

  it.each(['reject', 'expired', 'cancelled'] as const)('terminal %s retains only the stopped iteration and does not enter or approve the next item', async kind => {
    const f = await fixture(`terminal-${kind}`, source('forEach', kind === 'reject').replace('30m', '1s'))
    const run = await f.start(); await f.idle()
    let result: LocalRun
    if (kind === 'cancelled') result = f.owner.cancel(run.id, randomUUID(), 'PRIVATE_OPERATOR')
    else {
      if (kind === 'expired') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(waiting(run).expiresAt) + 1) }
      result = await f.owner.decide(run.id, waiting(run).attempt.id, kind === 'reject' ? 'reject' : 'approve', 'PRIVATE_REVIEWER')
    }
    expect(result.state).toMatchObject(kind === 'cancelled' ? { status: 'cancelled', scope: { loop: 'each', index: 0 } }
      : { status: 'failed', code: kind === 'reject' ? 'approval-rejected' : 'approval-expired', scope: { loop: 'each', index: 0 } })
    const checked = await f.audit(); expect(checked.ledger).toHaveLength(2)
    expect(checked.ledger.map(a => a.request.eventKind).sort()).toEqual(['requested', kind === 'reject' ? 'decided' : kind].sort())
    expect(checked.ledger.every(a => a.request.attemptId === waiting(run).attempt.id && a.event.data.scope?.index === 0)).toBe(true)
    expect((await f.owner.events(run.id)).filter(event => event.kind === 'approval-requested')).toHaveLength(1)
  })

  it('elapsed approval/loop time and reads never create automatic expiry or cancellation', async () => {
    const f = await fixture('clock-neutral', loopYaml.replace('timeoutSeconds: 3600', 'timeoutSeconds: 1'))
    const run = await f.start(); await f.idle(); const before = f.checkpoint('before-clock-reads')
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(waiting(run).expiresAt) + 1)
    await f.owner.show(run.id); await f.owner.events(run.id); await f.admissions(); await f.idle()
    expect(f.checkpoint('after-clock-reads')).toEqual(before); expect(f.received).toHaveLength(1)
    const result = await f.owner.decide(run.id, waiting(run).attempt.id, 'approve', 'PRIVATE_REVIEWER')
    expect(result.state).toMatchObject({ status: 'failed', code: 'loop-timeout' })
    const checked = await f.audit(); expect(checked.ledger).toHaveLength(1)
    expect((await f.owner.events(run.id)).filter(event => event.kind === 'approval-expired' || event.kind === 'approval-decided')).toEqual([])
  })

  it('one endpoint rejection does not suppress a sibling destination or change the waiting workflow', async () => {
    const f = await fixture('fanout-rejection', approvalYaml, 'sampled', 2); f.reject(1)
    const run = await f.start(f.owner, { message: 'PRIVATE_REVIEW_INPUT' }), checked = await f.audit()
    expect(await f.owner.show(run.id)).toEqual(run); expect(run.state.status).toBe('waiting')
    expect(checked.ledger).toHaveLength(2); expect(checked.retained.map(r => r.outcome.status === 'settled' && r.outcome.result.status).sort()).toEqual(['accepted', 'rejected'])
    expect(new Set(checked.ledger.map(a => a.request.requestId)).size).toBe(2)
    expect(new Set(checked.ledger.map(a => a.event.id)).size).toBe(1)
    expect(checked.counter.points.map(point => [point.labels['jevable.notification.outcome'], point.value]).sort()).toEqual([['accepted', 1], ['rejected', 1]])
  })

  it('reviewed destination replacement applies only to newly committed lifecycle events, not retained waits', async () => {
    const f = await fixture('destination-replacement', approvalYaml)
    const run = await f.start(f.owner, { message: 'PRIVATE_REVIEW_INPUT' }); await f.idle(); await f.owner.close()
    const oldEndpoint = f.endpoints[0]!, nextEndpoint = { ...oldEndpoint, url: oldEndpoint.url.replace('_0', '_replacement') }
    const nextConfig = f.configuration([nextEndpoint]); f.endpoints[0] = nextEndpoint
    const reopened = await f.open(nextConfig); const before = f.checkpoint('before-replacement-reads')
    await reopened.show(run.id); await reopened.events(run.id); await f.admissions(reopened); await reopened.telemetryFlush()
    expect(f.received).toHaveLength(1); expect(f.checkpoint('after-replacement-reads')).toEqual(before)
    const done = await reopened.decide(run.id, waiting(run).attempt.id, 'approve', 'PRIVATE_REVIEWER')
    expect(done.state.status).toBe('completed')
    const checked = await f.audit(reopened, 0, 1); expect(f.received.map(post => post.path)).toEqual(['/PRIVATE_DESTINATION_0', '/PRIVATE_DESTINATION_replacement'])
    expect(new Set(checked.ledger.map(a => a.policySha256)).size).toBe(2)
    expect(new Set(checked.ledger.map(a => a.request.endpointSha256)).size).toBe(2)
    expect(checked.ledger.map(a => a.request.eventKind).sort()).toEqual(['decided', 'requested'])
  })

  it('credential rotation between commits signs the new event with the new generation while retaining the original receipt', async () => {
    const f = await fixture('credential-rotation', approvalYaml), run = await f.start(f.owner, { message: 'PRIVATE_REVIEW_INPUT' })
    await f.idle(); const first = f.records()[0]!; f.rotate()
    await f.owner.decide(run.id, waiting(run).attempt.id, 'approve', 'PRIVATE_REVIEWER'); const checked = await f.audit()
    expect(checked.retained.map(record => record.credentialGeneration)).toEqual([1, 2])
    expect(f.received.map(post => post.keyGeneration)).toEqual([1, 2]); expect(checked.retained[0]).toEqual(first)
  })

  it('automatic initial intent wins a concurrent manual initial send without changing workflow or producing a second POST', async () => {
    const f = await fixture('automatic-wins', approvalYaml); f.hold()
    const run = await f.start(f.owner, { message: 'PRIVATE_REVIEW_INPUT' }); await until(() => f.received.length === 1)
    const { event: _event, delivery: _delivery, ...pins } = await f.owner.prepareApprovalNotification({ runId: run.id, revision: run.revision, attemptId: waiting(run).attempt.id }, f.endpoints[0]!.id)
    await expect(f.owner.sendApprovalNotification({ ...pins, requestId: randomUUID() }, 'PRIVATE_MANUAL_SENDER')).rejects.toHaveProperty('code', 'conflict')
    expect(f.received).toHaveLength(1); expect(await f.owner.show(run.id)).toEqual(run)
    f.release(); const checked = await f.audit(f.owner, 1)
    expect(checked.ledger).toHaveLength(1); expect(checked.retained).toHaveLength(1)
    expect(checked.counter.points.some(point => point.labels['jevable.notification.outcome'] === 'intent-not-acknowledged' && point.value === 1)).toBe(true)
  })

  it('manual initial intent wins a delayed automatic task; the automatic admission records conflict and never replays', async () => {
    const f = await fixture('manual-wins', approvalYaml)
    // Test-only scheduling barrier before the real dispatcher; no production replay/activation hook.
    const dispatcher = (f.owner as unknown as { notifications: ApprovalNotificationDispatcher }).notifications, original = dispatcher.send.bind(dispatcher)
    let release!: () => void, arrived = false
    const barrier = new Promise<void>(resolve => { release = resolve }); f.gates.push(release)
    vi.spyOn(dispatcher, 'send').mockImplementation(async (value, actor, options) => {
      if (actor.startsWith('automatic:')) { arrived = true; await barrier }
      return original(value, actor, options)
    })
    const run = await f.start(f.owner, { message: 'PRIVATE_REVIEW_INPUT' }); await until(() => arrived)
    const { event: _event, delivery: _delivery, ...pins } = await f.owner.prepareApprovalNotification({ runId: run.id, revision: run.revision, attemptId: waiting(run).attempt.id }, f.endpoints[0]!.id)
    const request = { ...pins, requestId: randomUUID() }, receipt = await f.owner.sendApprovalNotification(request, 'PRIVATE_MANUAL_SENDER')
    release(); await f.idle(); await f.owner.telemetryFlush()
    const ledger = await f.admissions(); expect(ledger).toHaveLength(1); expect(ledger[0]!.outcome).toMatchObject({ status: 'failed', code: 'conflict' })
    expect(f.records()).toEqual([receipt]); expect(f.received).toHaveLength(1); expect(f.received[0]!.valid).toBe(true)
    // Manual actor is intentionally retained locally; it must never enter OTLP or public automatic metadata.
    expect(JSON.stringify([...f.traces(), ...f.logs()])).not.toContain('PRIVATE_')
    expect(f.logs().filter(log => log.event === 'jevable.notification.delivery.ended')).toHaveLength(2)
    expect(f.metric()!.points.reduce((sum, point) => sum + point.value, 0)).toBe(2)
    const before = f.checkpoint('before-manual-retry'); await f.owner.sendApprovalNotification(request, 'PRIVATE_MANUAL_SENDER'); await f.admissions()
    expect(f.checkpoint('after-manual-retry')).toEqual(before); expect(f.received).toHaveLength(1); expect(await f.owner.show(run.id)).toEqual(run)
    await f.owner.close(); const reopened = await f.open(); await reopened.show(run.id); await f.admissions(reopened); await f.idle(reopened)
    expect(f.received).toHaveLength(1); expect(f.checkpoint('after-manual-reopen')).toEqual(before)
  })

  it('a review decided before the delayed requested-send check keeps its outcome and sends only the recorded decision', async () => {
    const f = await fixture('decision-before-requested-send', approvalYaml)
    const dispatcher = (f.owner as unknown as { notifications: ApprovalNotificationDispatcher }).notifications, original = dispatcher.send.bind(dispatcher)
    let release!: () => void, arrived = false
    const barrier = new Promise<void>(resolve => { release = resolve }); f.gates.push(release)
    vi.spyOn(dispatcher, 'send').mockImplementation(async (value, actor, options) => {
      if (actor.startsWith('automatic:') && (value as { eventKind?: string }).eventKind === 'requested') { arrived = true; await barrier }
      return original(value, actor, options)
    })
    const run = await f.start(f.owner, { message: 'PRIVATE_REVIEW_INPUT' }); await until(() => arrived)
    const done = await f.owner.decide(run.id, waiting(run).attempt.id, 'approve', 'PRIVATE_REVIEWER')
    expect(done.state.status).toBe('completed'); await until(() => f.received.length === 1); release()
    const checked = await f.audit(); expect(checked.retained).toHaveLength(1); expect(checked.ledger).toHaveLength(2)
    expect(checked.ledger.find(record => record.request.eventKind === 'requested')!.outcome).toMatchObject({ status: 'failed', code: 'conflict' })
    expect(checked.retained[0]!.request.eventKind).toBe('decided'); expect(await f.owner.show(run.id)).toEqual(done)
  })
})
