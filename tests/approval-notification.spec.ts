import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalNotificationDispatcher, type NotificationPersistence } from '../src/notifications/dispatcher.ts'
import { requestedApprovalNotification, inspectNotificationRecord, notificationEndpointSchema,
  type NotificationRecord, type NotificationEndpoint, type NotificationRequest } from '../src/notifications/schema.ts'
import { notificationSigningKey, postApprovalNotification } from '../src/notifications/transport.ts'
import { validateNotificationIntent, validateNotificationSettlement } from '../src/notifications/transitions.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { SQLiteNotificationStore, initializeNotificationTables } from '../src/notifications/sqlite-store.ts'
import { createTlsFixture } from '../scripts/tls-fixture.mjs'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })

/** Test-only atomic adapter. Production SQLite/PostgreSQL adapters must implement the same guards and exclusive ownership. */
class MemoryNotifications implements NotificationPersistence {
  readonly rows = new Map<string, NotificationRecord>()
  readonly writes: NotificationRecord[] = []
  get(id: string) { return structuredClone(this.rows.get(id)) }
  createIntent(value: NotificationRecord) {
    if (this.rows.has(value.request.requestId)) return false
    const previous = [...this.rows.values()].filter(row => row.request.eventSha256 === value.request.eventSha256
      && row.request.endpointId === value.request.endpointId).at(-1)
    const record = validateNotificationIntent(value, previous)
    this.rows.set(record.request.requestId, structuredClone(record)); this.writes.push(structuredClone(record)); return true
  }
  settle(value: NotificationRecord) {
    const checked = validateNotificationSettlement(this.rows.get(value.request.requestId), value)
    if (!checked.changed) return
    this.rows.set(value.request.requestId, structuredClone(checked.record)); this.writes.push(structuredClone(checked.record))
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-notification-'))
  const runtime = await LocalRuntime.open({ dataDirectory: join(directory, 'state') }); cleanup.push(() => runtime.close())
  const run = await runtime.run(yaml, { message: 'PRIVATE_REVIEW_INPUT' })
  if (run.state.status !== 'waiting') throw Error('expected approval wait')
  const pin = { runId: run.id, revision: run.revision, attemptId: run.state.attempt.id }
  const secret = 'whsec_' + randomBytes(32).toString('base64'), store = new MemoryNotifications(), controller = new AbortController()
  const received: { body: string; headers: Record<string, string | string[] | undefined> }[] = []
  let response: (reply: ServerResponse) => void = reply => { reply.writeHead(202); reply.end('PRIVATE_RESPONSE') }
  const server = createServer(async (request, reply) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    received.push({ body: Buffer.concat(chunks).toString('utf8'), headers: request.headers }); response(reply)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('listener missing')
  const endpoint: NotificationEndpoint = { id: 'review-queue', url: `http://127.0.0.1:${address.port}/notify`, credentialRef: 'approval/key', timeoutMs: 500 }
  const host = { signal: controller.signal, credential: vi.fn(async (): Promise<{ value: string; generation: number } | undefined> => ({ value: secret, generation: 1 })),
    requested: vi.fn(async (pinValue: typeof pin) => requestedApprovalNotification(await runtime.show(pinValue.runId), await runtime.events(pinValue.runId), pinValue)) }
  const dispatcher = new ApprovalNotificationDispatcher(host, store, [endpoint])
  const prepare = async (patch: Partial<NotificationRequest> = {}) => {
    const { event: _event, delivery: _delivery, ...request } = await dispatcher.prepare(pin, endpoint.id)
    return { ...request, requestId: randomUUID(), ...patch }
  }
  return { directory, runtime, run, pin, secret, store, received, controller, endpoint, host, dispatcher, prepare,
    setResponse: (callback: (reply: ServerResponse) => void) => { response = callback } }
}

describe('explicit approval notification core', () => {
  it('signals only a selected delivery while a sibling remains pending and can accept normally', async () => {
    const f = await fixture(), sibling = await f.runtime.run(yaml, { message: 'other' })
    if (sibling.state.status !== 'waiting') throw Error('missing wait')
    const { event: _event, delivery: _delivery, ...pins } = await f.dispatcher.prepare(
      { runId: sibling.id, revision: sibling.revision, attemptId: sibling.state.attempt.id }, f.endpoint.id)
    const command = await f.prepare(), other = { ...pins, requestId: randomUUID() }
    const firstReply = Promise.withResolvers<ServerResponse>(), secondReply = Promise.withResolvers<ServerResponse>()
    let count = 0; f.setResponse(reply => (++count === 1 ? firstReply : secondReply).resolve(reply))
    const sending = f.dispatcher.send(command, 'fixture'); await firstReply.promise
    const otherSending = f.dispatcher.send(other, 'fixture'), reply = await secondReply.promise
    try {
      expect((await f.dispatcher.abort(command.requestId)).status).toBe('abort-requested')
      expect((await sending).outcome).toMatchObject({ result: { status: 'uncertain', reason: 'aborted' } })
      expect((await f.dispatcher.inspect(other.requestId)).outcome.status).toBe('pending')
      reply.writeHead(202); reply.end()
      expect((await otherSending).outcome).toMatchObject({ result: { status: 'accepted' } })
      expect(f.received).toHaveLength(2)
    } finally { f.controller.abort(); await Promise.allSettled([sending, otherSending]) }
  })

  it.each(['before', 'after'] as const)('requires a retained identity during %s-intent acknowledgement and never fabricates delivery', async position => {
    const f = await fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const original = f.store.createIntent.bind(f.store)
    vi.spyOn(f.store, 'createIntent').mockImplementation((async (record: NotificationRecord) => {
      if (position === 'after') original(record)
      entered.resolve(); await gate.promise
      return position === 'before' ? original(record) : true
    }) as any)
    const command = await f.prepare(), sending = f.dispatcher.send(command, 'fixture')
    try {
      await entered.promise
      if (position === 'before') await expect(f.dispatcher.abort(command.requestId)).rejects.toHaveProperty('code', 'not-found')
      else expect((await f.dispatcher.abort(command.requestId)).status).toBe('abort-requested')
      gate.resolve()
      const saved = await sending
      expect(saved.outcome).toMatchObject({ result: position === 'before' ? { status: 'accepted' } : { status: 'uncertain', reason: 'aborted' } })
      expect(f.received).toHaveLength(position === 'before' ? 1 : 0)
      expect((await f.dispatcher.abort(command.requestId)).status).toBe('not-active')
    } finally { gate.resolve(); f.controller.abort(); await sending.catch(() => {}) }
  })

  it('does not overwrite an accepted transport result when abort races its pending settlement acknowledgement', async () => {
    const f = await fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const original = f.store.settle.bind(f.store)
    vi.spyOn(f.store, 'settle').mockImplementation((async (record: NotificationRecord) => {
      entered.resolve(); await gate.promise; original(record)
    }) as any)
    const command = await f.prepare(), sending = f.dispatcher.send(command, 'fixture')
    try {
      await entered.promise
      expect((await f.dispatcher.abort(command.requestId)).status).toBe('abort-requested')
      gate.resolve(); expect((await sending).outcome).toMatchObject({ result: { status: 'accepted', httpStatus: 202 } })
      expect((await f.dispatcher.abort(command.requestId)).status).toBe('not-active')
      expect(f.received).toHaveLength(1)
    } finally { gate.resolve(); f.controller.abort(); await sending.catch(() => {}) }
  })

  it('prepares stable thin events without credentials, sends or workflow mutation', async () => {
    const f = await fixture(), before = await f.runtime.events(f.run.id)
    const a = await f.dispatcher.prepare(f.pin, f.endpoint.id), b = await f.dispatcher.prepare(f.pin, f.endpoint.id)
    expect(a).toEqual(b); expect(a.event.type).toBe('ai.jevable.approval.requested')
    expect(a.event.id).toMatch(/^[a-f0-9]{64}$/); expect(a.delivery).toBe('not-attempted')
    expect(f.host.credential).not.toHaveBeenCalled(); expect(f.store.rows.size).toBe(0); expect(f.received).toEqual([])
    expect(JSON.stringify(a)).not.toMatch(/PRIVATE_|Review this|approve|reject|\/notify|approval\/key/)
    expect(await f.runtime.events(f.run.id)).toEqual(before)
  })
  it('commits intent before one signed POST; identical request IDs only read retained receipts', async () => {
    const f = await fixture(), command = await f.prepare(), before = await f.runtime.events(f.run.id)
    const create = vi.spyOn(f.store, 'createIntent'), settled = await f.dispatcher.send(command, 'PRIVATE_ACTOR')
    expect(create).toHaveBeenCalledTimes(1); expect(f.store.writes.map(r => r.outcome.status)).toEqual(['pending', 'settled'])
    expect(settled.outcome).toMatchObject({ status: 'settled', result: { status: 'accepted', httpStatus: 202 } })
    expect(f.received).toHaveLength(1)
    const wire = f.received[0]!, event = JSON.parse(wire.body), timestamp = wire.headers['webhook-timestamp']
    expect(wire.headers['content-type']).toBe('application/cloudevents+json')
    expect(wire.headers['webhook-id']).toBe(event.id)
    expect(wire.headers['webhook-signature']).toBe('v1,' + createHmac('sha256', Buffer.from(f.secret.slice(6), 'base64'))
      .update(`${event.id}.${timestamp}.${wire.body}`).digest('base64'))
    expect(wire.body).toBe(JSON.stringify(settled.event))
    expect(JSON.stringify(await f.dispatcher.inspect(command.requestId))).not.toMatch(/PRIVATE_|whsec_|\/notify/)
    await f.runtime.decide(f.run.id, f.pin.attemptId, 'approve', 'fixture')
    const withoutConfiguration = new ApprovalNotificationDispatcher(f.host, f.store, [])
    expect(await withoutConfiguration.send(command, 'PRIVATE_ACTOR')).toEqual(settled)
    expect(f.received).toHaveLength(1); expect(before.length).toBeGreaterThan(0)
  })
  it('requires explicit predecessor-linked redelivery and preserves the event ID/body', async () => {
    const f = await fixture(), first = await f.prepare(), result = await f.dispatcher.send(first, 'fixture')
    await expect(f.dispatcher.send(await f.prepare(), 'fixture')).rejects.toHaveProperty('code', 'conflict')
    const rotated = 'whsec_' + randomBytes(32).toString('base64')
    f.host.credential.mockResolvedValueOnce({ value: rotated, generation: 2 })
    const second = await f.prepare({ redeliverOf: first.requestId }), redelivered = await f.dispatcher.send(second, 'fixture')
    expect(redelivered.event).toEqual(result.event); expect(f.received).toHaveLength(2)
    expect(f.received[0]!.body).toBe(f.received[1]!.body)
    expect(result.credentialGeneration).toBe(1); expect(redelivered.credentialGeneration).toBe(2)
    const wire = f.received[1]!
    expect(wire.headers['webhook-signature']).toBe('v1,' + createHmac('sha256', Buffer.from(rotated.slice(6), 'base64'))
      .update(`${redelivered.event.id}.${wire.headers['webhook-timestamp']}.${wire.body}`).digest('base64'))
    await expect(f.dispatcher.send(await f.prepare({ redeliverOf: first.requestId }), 'fixture')).rejects.toHaveProperty('code', 'conflict')
    expect(f.received).toHaveLength(2)
  })
  it('captures signing value and generation together before awaiting current approval evidence', async () => {
    const f = await fixture(), command = await f.prepare(), credential = { value: f.secret, generation: 1 }
    f.host.credential.mockResolvedValueOnce(credential)
    f.host.requested.mockImplementationOnce(async pin => {
      credential.generation = 2; credential.value = 'whsec_' + randomBytes(32).toString('base64')
      return requestedApprovalNotification(await f.runtime.show(pin.runId), await f.runtime.events(pin.runId), pin)
    })
    const record = await f.dispatcher.send(command, 'fixture'), wire = f.received[0]!
    expect(record.credentialGeneration).toBe(1)
    expect(wire.headers['webhook-signature']).toBe('v1,' + createHmac('sha256', Buffer.from(f.secret.slice(6), 'base64'))
      .update(`${record.event.id}.${wire.headers['webhook-timestamp']}.${wire.body}`).digest('base64'))
  })
  it.each(['before', 'after'])('does not send after %s-commit intent acknowledgement failure', async position => {
    const f = await fixture(), command = await f.prepare(), original = f.store.createIntent.bind(f.store)
    vi.spyOn(f.store, 'createIntent').mockImplementation(record => { if (position === 'after') original(record); throw Error('fixture commit uncertain') })
    await expect(f.dispatcher.send(command, 'fixture')).rejects.toThrow('fixture commit uncertain')
    expect(f.received).toHaveLength(0)
    if (position === 'after') {
      expect((await f.dispatcher.send(command, 'fixture')).outcome.status).toBe('pending')
      expect(f.received).toHaveLength(0)
    }
  })
  it.each(['before', 'after'])('does not repeat a POST after %s-commit settlement acknowledgement failure', async position => {
    const f = await fixture(), command = await f.prepare(), original = f.store.settle.bind(f.store)
    vi.spyOn(f.store, 'settle').mockImplementation(record => { if (position === 'after') original(record); throw Error('fixture settlement uncertain') })
    await expect(f.dispatcher.send(command, 'fixture')).rejects.toThrow('fixture settlement uncertain')
    expect(f.received).toHaveLength(1)
    const again = await f.dispatcher.send(command, 'fixture')
    expect(again.outcome.status).toBe(position === 'before' ? 'pending' : 'settled'); expect(f.received).toHaveLength(1)
  })
  it('retains timeout as uncertain and does not automatically retry', async () => {
    const f = await fixture(); f.setResponse(() => {})
    const command = await f.prepare(), record = await f.dispatcher.send(command, 'fixture')
    expect(record.outcome).toMatchObject({ result: { status: 'uncertain', reason: 'timeout' } })
    expect(await f.dispatcher.send(command, 'fixture')).toEqual(record); expect(f.received).toHaveLength(1)
  })
  it('records redirect rejection without following it or retaining its response body', async () => {
    const f = await fixture(); f.setResponse(reply => { reply.writeHead(302, { location: '/second' }); reply.end('PRIVATE_REDIRECT') })
    const record = await f.dispatcher.send(await f.prepare(), 'fixture')
    expect(record.outcome).toMatchObject({ result: { status: 'rejected', httpStatus: 302 } })
    expect(f.received).toHaveLength(1); expect(JSON.stringify(record)).not.toContain('PRIVATE_REDIRECT')
  })
  it('aborts an in-flight attempt without replay or workflow cancellation', async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(); f.setResponse(() => entered.resolve())
    const command = await f.prepare(), before = await f.runtime.events(f.run.id), running = f.dispatcher.send(command, 'fixture')
    await entered.promise; f.controller.abort(); const record = await running
    expect(record.outcome).toMatchObject({ result: { status: 'uncertain', reason: 'aborted' } })
    expect(await f.runtime.events(f.run.id)).toEqual(before); expect(f.received).toHaveLength(1)
  })
  it('returns a pending receipt while active and refuses concurrent explicit redelivery', async () => {
    const f = await fixture(), entered = Promise.withResolvers<ServerResponse>(); f.setResponse(reply => entered.resolve(reply))
    const command = await f.prepare(), running = f.dispatcher.send(command, 'fixture'), reply = await entered.promise
    expect((await f.dispatcher.send(command, 'fixture')).outcome.status).toBe('pending')
    await expect(f.dispatcher.send(await f.prepare({ redeliverOf: command.requestId }), 'fixture')).rejects.toHaveProperty('code', 'busy')
    reply.writeHead(204); reply.end(); await running; expect(f.received).toHaveLength(1)
  })
  it('does not manufacture a settlement time after the wall clock moves behind intent admission', async () => {
    const f = await fixture(), entered = Promise.withResolvers<ServerResponse>(); f.setResponse(reply => entered.resolve(reply))
    const command = await f.prepare(), running = f.dispatcher.send(command, 'fixture'), reply = await entered.promise
    const failure = expect(running).rejects.toHaveProperty('code', 'corrupt')
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.now() - 60000))
    reply.writeHead(204); reply.end(); await failure
    expect((await f.dispatcher.send(command, 'fixture')).outcome.status).toBe('pending')
    expect(f.received).toHaveLength(1)
  })
  it('does not lose the active guard when a same-ID request races slow intent persistence', async () => {
    const f = await fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), original = f.store.createIntent.bind(f.store)
    vi.spyOn(f.store, 'createIntent').mockImplementation((async (record: NotificationRecord) => { entered.resolve(); await gate.promise; return original(record) }) as any)
    const command = await f.prepare(), running = f.dispatcher.send(command, 'fixture'); await entered.promise
    await expect(f.dispatcher.send(command, 'fixture')).rejects.toHaveProperty('code', 'busy')
    gate.resolve(); await running; expect(f.received).toHaveLength(1)
  })
  it('bounds active delivery attempts while leaving existing receipt reads available', async () => {
    const f = await fixture(), entered = Promise.withResolvers<ServerResponse>(); f.setResponse(reply => entered.resolve(reply))
    const dispatcher = new ApprovalNotificationDispatcher(f.host, f.store, [f.endpoint], { maxInFlight: 1 })
    const command = await f.prepare(), running = dispatcher.send(command, 'fixture'), reply = await entered.promise
    expect((await dispatcher.send(command, 'fixture')).outcome.status).toBe('pending')
    await expect(dispatcher.send(await f.prepare(), 'fixture')).rejects.toHaveProperty('code', 'busy')
    reply.writeHead(204); reply.end(); await running; expect(f.received).toHaveLength(1)
  })
  it.each(['event', 'endpoint', 'actor', 'attempt'])('refuses changed %s pins without a new dispatch', async field => {
    const f = await fixture(), command = await f.prepare(); await f.dispatcher.send(command, 'fixture')
    const changed = { ...command, ...(field === 'event' ? { eventSha256: 'a'.repeat(64) } : {}),
      ...(field === 'endpoint' ? { endpointSha256: 'b'.repeat(64) } : {}), ...(field === 'attempt' ? { attemptId: randomUUID() } : {}) }
    await expect(f.dispatcher.send(changed, field === 'actor' ? 'changed' : 'fixture')).rejects.toHaveProperty('code', 'conflict')
    expect(f.received).toHaveLength(1)
  })
  it('rejects stale expiry, missing credentials and owner loss before intent/dispatch', async () => {
    const f = await fixture(), command = await f.prepare()
    f.host.credential.mockResolvedValueOnce(undefined)
    await expect(f.dispatcher.send(command, 'fixture')).rejects.toHaveProperty('code', 'invalid-command')
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.now() + 2 * 86400000))
    await expect(f.dispatcher.send(command, 'fixture')).rejects.toHaveProperty('code', 'conflict')
    vi.useRealTimers(); f.controller.abort()
    await expect(f.dispatcher.send(command, 'fixture')).rejects.toHaveProperty('code', 'closed')
    expect(f.store.writes).toEqual([]); expect(f.received).toEqual([])
  })
  it('detects tampered stored evidence and forbids terminal receipt rewriting', async () => {
    const f = await fixture(), command = await f.prepare(), record = await f.dispatcher.send(command, 'fixture')
    const tampered = structuredClone(record); tampered.event.data.nodeId = 'tampered'
    expect(() => inspectNotificationRecord(tampered)).toThrow(expect.objectContaining({ code: 'corrupt' }))
    expect(() => validateNotificationSettlement(record, { ...record, actor: 'replacement' })).toThrow()
    expect(() => validateNotificationSettlement(record, { ...record, outcome: { status: 'settled', at: record.createdAt,
      result: { status: 'rejected', httpStatus: 500 } } })).toThrow()
    expect(validateNotificationSettlement(record, record).changed).toBe(false)
  })
  it('refuses missing or inconsistent approval journal events without retaining private data', async () => {
    const f = await fixture(), events = await f.runtime.events(f.run.id), requested = events.find(e => e.kind === 'approval-requested')!
    for (const journal of [[], [requested, requested], [{ ...requested, data: { ...requested.data as object, nodeId: 'other' } }]])
      expect(() => requestedApprovalNotification(f.run, journal, f.pin)).toThrow(expect.objectContaining({ code: 'corrupt' }))
  })
  it('keeps HTTPS verification enabled despite the unsafe Node environment override', async () => {
    const f = await fixture(), credentials = await createTlsFixture(f.directory)
    let requests = 0
    const server = createHttpsServer({ key: await readFile(credentials.key), cert: await readFile(credentials.cert) }, (_request, reply) => {
      requests++; reply.writeHead(204); reply.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    const address = server.address(); if (!address || typeof address === 'string') throw Error('listener missing')
    const event = (await f.dispatcher.prepare(f.pin, f.endpoint.id)).event, previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    try {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
      expect(await postApprovalNotification({ ...f.endpoint, url: `https://127.0.0.1:${address.port}/notify` }, event, f.secret))
        .toEqual({ status: 'uncertain', reason: 'transport' })
      expect(requests).toBe(0)
    } finally { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous }
  })
  it.each(['http://example.com/notify', 'https://user:pass@example.com/', 'https://example.com/?secret=x', 'https://example.com/#x',
    'file:///tmp/socket', 'https://example.com/\nprivate'])('refuses unsafe endpoint %s', url => {
    expect(notificationEndpointSchema.safeParse({ id: 'fixture', url, credentialRef: 'secret', timeoutMs: 100 }).success).toBe(false)
  })
  it.each(['secret', 'whsec_!!!!', 'whsec_YQ==', 'whsec_' + randomBytes(65).toString('base64')])('rejects invalid signing key encoding/length', key => {
    expect(() => notificationSigningKey(key)).toThrow()
  })
})

describe('SQLite approval notification persistence', () => {
  async function durable(policy = { maxDeliveries: 10, maxEvents: 20 }) {
    const f = await fixture(), path = join(f.directory, 'deliveries.sqlite')
    let db = new DatabaseSync(path)
    cleanup.push(async () => db.close())
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE'); initializeNotificationTables(db); db.exec('COMMIT')
    let store = new SQLiteNotificationStore(db, policy)
    const reopen = () => { db.close(); db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON'); store = new SQLiteNotificationStore(db, policy); return store }
    return { ...f, get db() { return db }, get durableStore() { return store }, reopen,
      dispatcherForStore: () => new ApprovalNotificationDispatcher(f.host, store, [f.endpoint]) }
  }
  it('retains exact delivery receipts and predecessor history across database reopening without dispatch', async () => {
    const f = await durable(), request = await f.prepare(), result = await f.dispatcherForStore().send(request, 'fixture')
    expect(f.db.prepare('SELECT count(*) AS count FROM approval_delivery_events').get()?.count).toBe(2)
    f.reopen()
    const dispatcher = f.dispatcherForStore()
    expect(await dispatcher.send(request, 'fixture')).toEqual(result); expect(f.received).toHaveLength(1)
    await dispatcher.send(await f.prepare({ redeliverOf: request.requestId }), 'fixture')
    f.reopen(); expect(f.received).toHaveLength(2)
    expect(f.db.prepare('SELECT count(*) AS count FROM approval_delivery_events').get()?.count).toBe(4)
    expect(f.durableStore.get(request.requestId)).toEqual(result)
  })
  it('preserves a committed pending intent after a lost acknowledgement without sending on same-ID retry', async () => {
    const f = await durable(), request = await f.prepare(), exec = f.db.exec.bind(f.db)
    vi.spyOn(f.db, 'exec').mockImplementation(sql => { exec(sql); if (sql === 'COMMIT') throw Error('lost commit acknowledgement') })
    await expect(f.dispatcherForStore().send(request, 'fixture')).rejects.toThrow('lost commit acknowledgement')
    expect(f.received).toHaveLength(0); vi.restoreAllMocks(); f.reopen()
    expect((await f.dispatcherForStore().send(request, 'fixture')).outcome.status).toBe('pending')
    expect(f.received).toHaveLength(0)
    await f.dispatcherForStore().send(await f.prepare({ redeliverOf: request.requestId }), 'fixture')
    expect(f.received).toHaveLength(1)
  })
  it('rolls back both row and audit entry when intent persistence fails before dispatch', async () => {
    const f = await durable()
    f.db.exec("CREATE TRIGGER fail_notification BEFORE INSERT ON approval_delivery_events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
    await expect(f.dispatcherForStore().send(await f.prepare(), 'fixture')).rejects.toThrow('fixture failure')
    expect(f.received).toHaveLength(0)
    expect(f.db.prepare('SELECT count(*) AS count FROM approval_deliveries').get()?.count).toBe(0)
    expect(f.db.prepare('SELECT count(*) AS count FROM approval_delivery_events').get()?.count).toBe(0)
  })
  it('rolls back a failed settlement audit without claiming an unacknowledged HTTP result or replaying it', async () => {
    const f = await durable(), request = await f.prepare()
    f.db.exec("CREATE TRIGGER fail_settlement BEFORE INSERT ON approval_delivery_events WHEN NEW.kind='settled' BEGIN SELECT RAISE(ABORT, 'fixture settlement failure'); END")
    await expect(f.dispatcherForStore().send(request, 'fixture')).rejects.toThrow('fixture settlement failure')
    expect(f.received).toHaveLength(1)
    expect(f.durableStore.get(request.requestId)?.outcome.status).toBe('pending')
    expect(f.db.prepare('SELECT count(*) AS count FROM approval_delivery_events').get()?.count).toBe(1)
    f.db.exec('DROP TRIGGER fail_settlement'); f.reopen()
    expect((await f.dispatcherForStore().send(request, 'fixture')).outcome.status).toBe('pending')
    expect(f.received).toHaveLength(1)
  })
  it('reserves settlement capacity at intent admission and rejects excess redelivery without a POST', async () => {
    const f = await durable({ maxDeliveries: 10, maxEvents: 2 }), request = await f.prepare()
    await f.dispatcherForStore().send(request, 'fixture')
    await expect(f.dispatcherForStore().send(await f.prepare({ redeliverOf: request.requestId }), 'fixture')).rejects.toHaveProperty('code', 'limit')
    expect(f.received).toHaveLength(1); f.reopen()
    expect(f.durableStore.get(request.requestId)?.outcome.status).toBe('settled')
  })
  it.each(['audit', 'actor', 'endpoint', 'predecessor'])('rejects tampered %s on activation without repairing evidence', async kind => {
    const f = await durable(), request = await f.prepare(), result = await f.dispatcherForStore().send(request, 'fixture')
    if (kind === 'audit') f.db.prepare("DELETE FROM approval_delivery_events WHERE kind='settled'").run()
    else if (kind === 'endpoint') f.db.prepare('UPDATE approval_deliveries SET endpoint_id=?').run('other')
    else {
      const changed = structuredClone(result)
      if (kind === 'actor') changed.actor = 'changed'
      else changed.request.redeliverOf = randomUUID()
      f.db.prepare('UPDATE approval_deliveries SET record=?').run(JSON.stringify(changed))
    }
    const before = f.db.prepare('SELECT record FROM approval_deliveries').all()
    expect(() => new SQLiteNotificationStore(f.db, { maxDeliveries: 10, maxEvents: 20 })).toThrow(expect.objectContaining({ code: 'corrupt' }))
    expect(f.db.prepare('SELECT record FROM approval_deliveries').all()).toEqual(before)
    expect(f.received).toHaveLength(1)
  })
})
