import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime, type NotificationRuntimeConfig, type NotificationRequest } from '../src/runtime/index.ts'
import { notificationSha256 } from '../src/notifications/schema.ts'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(config: Partial<NotificationRuntimeConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-notification-owner-')), dataDirectory = join(directory, 'state')
  const received: { body: string; signature: string | undefined; timestamp: string | undefined }[] = []
  let response: (reply: ServerResponse) => void = reply => { reply.writeHead(202); reply.end('PRIVATE_RESPONSE') }
  let receive: (() => void) | undefined
  const server = createServer(async (request, reply) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    received.push({ body: Buffer.concat(chunks).toString('utf8'), signature: request.headers['webhook-signature'] as string,
      timestamp: request.headers['webhook-timestamp'] as string }); receive?.(); response(reply)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing listener')
  const endpoint = { id: 'review', url: `http://127.0.0.1:${address.port}/PRIVATE_DESTINATION`, credentialRef: 'notifications/key', timeoutMs: 2000 }
  const notifications = { endpoints: [endpoint], ...config }
  const runtime = await LocalRuntime.open({ dataDirectory, notifications }); cleanup.push(() => runtime.close())
  const run = await runtime.run(yaml, { message: 'PRIVATE_REVIEW' })
  if (run.state.status !== 'waiting') throw Error('missing wait')
  const pin = { runId: run.id, revision: run.revision, attemptId: run.state.attempt.id }
  const key = 'whsec_' + randomBytes(32).toString('base64')
  const prepare = async (): Promise<NotificationRequest> => {
    const { event: _event, delivery: _delivery, ...request } = await runtime.prepareApprovalNotification(pin, endpoint.id)
    return { ...request, requestId: randomUUID() }
  }
  const provision = () => runtime.setCredential(endpoint.credentialRef, key, 0, 'PRIVATE_OPERATOR')
  const reopen = async (configuration?: NotificationRuntimeConfig) => {
    await runtime.close()
    const next = await LocalRuntime.open({ dataDirectory, ...(configuration ? { notifications: configuration } : {}) })
    cleanup.push(() => next.close()); return next
  }
  const database = <T>(work: (db: DatabaseSync) => T) => {
    const db = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    try { return work(db) } finally { db.close() }
  }
  return { directory, dataDirectory, runtime, run, pin, key, endpoint, notifications, received, prepare, provision, reopen, database,
    hold: () => new Promise<void>(resolve => { response = () => {}; receive = resolve }) }
}

describe('standalone SQLite notification owner', () => {
  it('aborts only the selected live send without cancelling its workflow or replaying its retained ID', async () => {
    const f = await fixture(); f.provision()
    const request = await f.prepare(), arrived = f.hold(), before = await f.runtime.events(f.run.id)
    const safety = new AbortController(), sending = f.runtime.sendApprovalNotification(request, 'operator', { signal: safety.signal })
    try {
      await arrived
      const result = await f.runtime.abortApprovalNotification(request.requestId)
      expect(result).toMatchObject({ schemaVersion: 1, requestId: request.requestId, status: 'abort-requested',
        receipt: { request, outcome: { status: 'pending' } },
        semantics: 'process-local-signal; inspect-retained-send-outcome; no-effect-retraction' })
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|whsec_|credentialRef|actor/)
      const settled = await sending
      expect(settled.outcome).toMatchObject({ status: 'settled', result: { status: 'uncertain', reason: 'aborted' } })
      expect(await f.runtime.show(f.run.id)).toEqual(f.run)
      expect(await f.runtime.events(f.run.id)).toEqual(before)
      expect((await f.runtime.abortApprovalNotification(request.requestId)).status).toBe('not-active')
      expect(await f.runtime.sendApprovalNotification(request, 'operator')).toEqual(settled)
      expect(f.received).toHaveLength(1)
    } finally { safety.abort(); await sending.catch(() => {}) }
  })

  it('does not settle inactive pending evidence after a failed settlement and configuration-free reopen', async () => {
    const f = await fixture(); f.provision(); const request = await f.prepare()
    f.database(db => db.exec("CREATE TRIGGER abort_settlement_fault BEFORE INSERT ON approval_delivery_events WHEN NEW.kind='settled' BEGIN SELECT RAISE(ABORT, 'fixture'); END"))
    await expect(f.runtime.sendApprovalNotification(request, 'operator')).rejects.toThrow()
    f.database(db => db.exec('DROP TRIGGER abort_settlement_fault'))
    const reopened = await f.reopen(), before = await reopened.inspectApprovalNotification(request.requestId)
    const result = await reopened.abortApprovalNotification(request.requestId)
    expect(result).toMatchObject({ status: 'not-active', receipt: { outcome: { status: 'pending' } } })
    expect(await reopened.inspectApprovalNotification(request.requestId)).toEqual(before)
    expect((await reopened.sendApprovalNotification(request, 'operator')).outcome).toEqual(before.outcome)
    expect(await reopened.inspectApprovalNotification(request.requestId)).toEqual(before)
    expect(f.received).toHaveLength(1)
  })

  it('refuses unknown and malformed abort identities without creating evidence or changing a settled result', async () => {
    const f = await fixture(); f.provision(); const request = await f.prepare()
    await expect(f.runtime.abortApprovalNotification('bad-id')).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.runtime.abortApprovalNotification(request.requestId)).rejects.toHaveProperty('code', 'not-found')
    const sent = await f.runtime.sendApprovalNotification(request, 'operator')
    const result = await f.runtime.abortApprovalNotification(request.requestId)
    expect(result.status).toBe('not-active'); expect(result.receipt).toEqual(await f.runtime.inspectApprovalNotification(request.requestId))
    expect(result.receipt.outcome).toEqual(sent.outcome)
    expect(f.received).toHaveLength(1)
  })

  it('lists bounded redacted delivery history through settlement/restart without delivery or workflow mutation', async () => {
    const f = await fixture(); f.provision()
    expect((await f.runtime.listApprovalNotifications({})).deliveries).toEqual([])
    const request = await f.prepare()
    const first = await f.runtime.sendApprovalNotification(request, 'PRIVATE_OPERATOR')
    const second = await f.runtime.sendApprovalNotification({ ...request, requestId: randomUUID(), redeliverOf: request.requestId }, 'PRIVATE_OPERATOR')
    const expected = [first, second].sort((a, b) => a.request.requestId < b.request.requestId ? -1 : 1)
    const before = await f.runtime.events(f.run.id), page = await f.runtime.listApprovalNotifications({ limit: 1 })
    expect(page.deliveries.map(r => r.request.requestId)).toEqual([expected[0]!.request.requestId])
    expect(page.nextCursor).toBe(expected[0]!.request.requestId)
    const last = await f.runtime.listApprovalNotifications({ after: page.nextCursor!, limit: 1 })
    expect(last.deliveries.map(r => r.request.requestId)).toEqual([expected[1]!.request.requestId]); expect(last.nextCursor).toBeNull()
    expect(JSON.stringify([page, last])).not.toMatch(/PRIVATE_|credentialGeneration|event"|actor|whsec_|notifications\/key/)
    expect(await f.runtime.events(f.run.id)).toEqual(before)
    await expect(f.runtime.listApprovalNotifications({ after: randomUUID() })).rejects.toHaveProperty('code', 'not-found')
    expect(() => f.runtime.listApprovalNotifications({ limit: 201 })).toThrow()
    await f.runtime.decide(f.run.id, f.pin.attemptId, 'approve', 'human')
    const reopened = await f.reopen()
    expect(await reopened.listApprovalNotifications({ limit: 1 })).toEqual(page)
    expect(f.received).toHaveLength(2)
  })
  it('shows pending history while transport is held, then the retained terminal outcome on a fresh page', async () => {
    const f = await fixture(); f.provision(); const arrival = f.hold(), request = await f.prepare(), abort = new AbortController()
    const send = f.runtime.sendApprovalNotification(request, 'operator', { signal: abort.signal })
    try {
      await arrival
      expect((await f.runtime.listApprovalNotifications({})).deliveries[0]!.outcome).toEqual({ status: 'pending' })
    } finally { abort.abort(); await send }
    expect((await f.runtime.listApprovalNotifications({})).deliveries[0]!.outcome).toMatchObject({ status: 'settled', result: { status: 'uncertain' } })
    expect(f.received).toHaveLength(1)
  })
  it('refuses paged history when a retained delivery is detached from its workflow history', async () => {
    const f = await fixture(); f.provision(); const request = await f.prepare()
    await f.runtime.sendApprovalNotification(request, 'operator')
    f.database(db => {
      const row = JSON.parse(db.prepare('SELECT record FROM approval_deliveries WHERE id=?').get(request.requestId)!.record as string)
      row.event.data.nodeId = 'forged'
      const { source, type, time, data } = row.event
      row.event.id = notificationSha256({ source, type, time, data }); row.request.eventSha256 = notificationSha256(row.event)
      db.prepare('UPDATE approval_deliveries SET record=?,event_sha256=? WHERE id=?').run(JSON.stringify(row), row.request.eventSha256, request.requestId)
    })
    await expect(f.runtime.listApprovalNotifications({})).rejects.toHaveProperty('code', 'corrupt')
  })
  it('prepares metadata without credentials or delivery, and does not send on startup/reopen/run', async () => {
    const f = await fixture(), before = await f.runtime.events(f.run.id)
    const prepared = await f.runtime.prepareApprovalNotification(f.pin, f.endpoint.id)
    expect(prepared.delivery).toBe('not-attempted')
    expect(f.runtime.notificationDestinations()).toEqual([{ id: 'review', endpointSha256: prepared.endpointSha256 }])
    expect(JSON.stringify(prepared)).not.toMatch(/PRIVATE_|whsec_|notifications\/key/)
    expect(await f.runtime.events(f.run.id)).toEqual(before)
    expect(f.database(db => db.prepare('SELECT count(*) AS count FROM approval_deliveries').get()?.count)).toBe(0)
    const reopened = await f.reopen(f.notifications)
    expect(await reopened.prepareApprovalNotification(f.pin, f.endpoint.id)).toEqual(prepared)
    expect(f.received).toEqual([])
  })

  it('sends a signed thin event with a committed SQLite intent and records no response or secret', async () => {
    const f = await fixture(); f.provision()
    const before = await f.runtime.events(f.run.id), request = await f.prepare()
    const result = await f.runtime.sendApprovalNotification(request, 'PRIVATE_OPERATOR')
    expect(result.outcome).toMatchObject({ status: 'settled', result: { status: 'accepted', httpStatus: 202 } })
    expect(result.credentialGeneration).toBe(1)
    const wire = f.received[0]!
    expect(wire.signature).toBe('v1,' + createHmac('sha256', Buffer.from(f.key.slice(6), 'base64'))
      .update(`${result.event.id}.${wire.timestamp}.${wire.body}`).digest('base64'))
    expect(wire.body).toBe(JSON.stringify(result.event))
    const rows = f.database(db => db.prepare('SELECT kind,record FROM approval_delivery_events ORDER BY sequence').all())
    expect(rows.map(row => row.kind)).toEqual(['intent', 'settled'])
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_RESPONSE|PRIVATE_REVIEW|PRIVATE_DESTINATION|whsec_/)
    expect(JSON.stringify(await f.runtime.inspectApprovalNotification(request.requestId))).not.toContain('PRIVATE_OPERATOR')
    expect(await f.runtime.events(f.run.id)).toEqual(before)
    expect(await f.runtime.show(f.run.id)).toEqual(f.run)
  })

  it('retains same-ID receipts after approval, restart and destination removal; never redispatches', async () => {
    const f = await fixture(); f.provision()
    const request = await f.prepare(), saved = await f.runtime.sendApprovalNotification(request, 'operator')
    await f.runtime.decide(f.run.id, f.pin.attemptId, 'approve', 'human')
    const reopened = await f.reopen()
    expect(reopened.notificationDestinations()).toEqual([])
    expect(await reopened.sendApprovalNotification(request, 'operator')).toEqual(saved)
    expect((await reopened.inspectApprovalNotification(request.requestId)).outcome).toEqual(saved.outcome)
    await expect(reopened.sendApprovalNotification(request, 'different')).rejects.toHaveProperty('code', 'conflict')
    expect(f.received).toHaveLength(1)
  })

  it('requires explicit linked redelivery, records rotated credential generations, and refuses stale predecessors', async () => {
    const f = await fixture(); f.provision()
    const request = await f.prepare(), first = await f.runtime.sendApprovalNotification(request, 'operator')
    await expect(f.runtime.sendApprovalNotification(await f.prepare(), 'operator')).rejects.toHaveProperty('code', 'conflict')
    f.runtime.setCredential(f.endpoint.credentialRef, 'whsec_' + randomBytes(32).toString('base64'), 1, 'operator')
    const second = await f.runtime.sendApprovalNotification({ ...request, requestId: randomUUID(), redeliverOf: request.requestId }, 'operator')
    expect(second.credentialGeneration).toBe(2); expect(second.event).toEqual(first.event)
    await expect(f.runtime.sendApprovalNotification({ ...request, requestId: randomUUID(), redeliverOf: request.requestId }, 'operator'))
      .rejects.toHaveProperty('code', 'conflict')
    expect(f.received).toHaveLength(2)
  })

  it('keeps ownership and credentials busy until per-delivery abort settles; abort does not cancel the workflow', async () => {
    const f = await fixture(); f.provision()
    const request = await f.prepare(), received = f.hold(), controller = new AbortController()
    const pending = f.runtime.sendApprovalNotification(request, 'operator', { signal: controller.signal })
    await received
    await expect(f.runtime.close()).rejects.toHaveProperty('code', 'busy')
    await expect(LocalRuntime.open({ dataDirectory: f.dataDirectory })).rejects.toHaveProperty('code', 'busy')
    expect(() => f.runtime.setCredential(f.endpoint.credentialRef, f.key, 1, 'operator')).toThrow(expect.objectContaining({ code: 'busy' }))
    controller.abort()
    const saved = await pending
    expect(saved.outcome).toMatchObject({ status: 'settled', result: { status: 'uncertain', reason: 'aborted' } })
    expect(await f.runtime.show(f.run.id)).toEqual(f.run)
    expect(await f.runtime.sendApprovalNotification(request, 'operator', { signal: controller.signal })).toEqual(saved)
    expect(f.received).toHaveLength(1)
  })

  it('refuses an already-aborted new send before retaining intent', async () => {
    const f = await fixture(); f.provision()
    const request = await f.prepare(), controller = new AbortController(); controller.abort()
    await expect(f.runtime.sendApprovalNotification(request, 'operator', { signal: controller.signal })).rejects.toHaveProperty('code', 'closed')
    await expect(f.runtime.inspectApprovalNotification(request.requestId)).rejects.toHaveProperty('code', 'not-found')
    expect(f.received).toHaveLength(0)
  })

  it('reserves settlement capacity and refuses additional intents before POST', async () => {
    const f = await fixture({ maxDeliveries: 2, maxEvents: 2 }); f.provision()
    const request = await f.prepare(); await f.runtime.sendApprovalNotification(request, 'operator')
    await expect(f.runtime.sendApprovalNotification({ ...request, requestId: randomUUID(), redeliverOf: request.requestId }, 'operator'))
      .rejects.toHaveProperty('code', 'limit')
    expect(f.received).toHaveLength(1)
  })

  it('refuses a wait changed between verified observation and intent admission', async () => {
    const f = await fixture(); f.provision()
    const request = await f.prepare(), show = f.runtime.show.bind(f.runtime)
    vi.spyOn(f.runtime, 'show').mockImplementationOnce(async id => {
      const observed = await show(id)
      await f.runtime.decide(f.run.id, f.pin.attemptId, 'approve', 'human')
      return observed
    })
    await expect(f.runtime.sendApprovalNotification(request, 'operator')).rejects.toHaveProperty('code', 'conflict')
    expect(f.received).toHaveLength(0)
    await expect(f.runtime.inspectApprovalNotification(request.requestId)).rejects.toHaveProperty('code', 'not-found')
  })

  it.each(['missing', 'wrong-ref'])('refuses %s signing credentials without retaining intent', async mode => {
    const f = await fixture(), request = await f.prepare()
    if (mode === 'wrong-ref') {
      f.provision()
      f.database(db => db.prepare("UPDATE provider_credentials SET record=json_set(record,'$.ref','other') WHERE ref=?").run(f.endpoint.credentialRef))
    }
    await expect(f.runtime.sendApprovalNotification(request, 'operator')).rejects.toHaveProperty('code', mode === 'missing' ? 'invalid-command' : 'corrupt-evidence')
    await expect(f.runtime.inspectApprovalNotification(request.requestId)).rejects.toHaveProperty('code', 'not-found')
    expect(f.received).toHaveLength(0)
  })

  it.each(['null', 'unknown', 'duplicate', 'remote-http', 'limits'])('validates %s configuration before creating state', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-invalid-notification-')), dataDirectory = join(directory, 'absent')
    const endpoint = { id: 'review', url: 'https://receiver.example/events', credentialRef: 'key', timeoutMs: 1000 }
    const notifications = kind === 'null' ? null : kind === 'unknown' ? { automaticSend: true } : kind === 'duplicate' ? { endpoints: [endpoint, endpoint] }
      : kind === 'remote-http' ? { endpoints: [{ ...endpoint, url: 'http://receiver.example/events' }] } : { maxInFlight: 0 }
    await expect(LocalRuntime.open({ dataDirectory, notifications: notifications as NotificationRuntimeConfig })).rejects.toHaveProperty('code', 'invalid-command')
    await expect(stat(dataDirectory)).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('migrates schema 15 atomically without rewriting workflow history and refuses missing version-16 delivery tables', async () => {
    const f = await fixture(), before = await f.runtime.events(f.run.id); await f.runtime.close()
    f.database(db => db.exec('DROP TABLE approval_delivery_events; DROP TABLE approval_deliveries; PRAGMA user_version=15'))
    const reopened = await f.reopen()
    expect(await reopened.show(f.run.id)).toEqual(f.run); expect(await reopened.events(f.run.id)).toEqual(before)
    expect(f.database(db => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(18)
    await reopened.close()
    f.database(db => db.exec('DROP TABLE approval_delivery_events'))
    await expect(LocalRuntime.open({ dataDirectory: f.dataDirectory })).rejects.toHaveProperty('code', 'corrupt')
    await expect(stat(join(f.dataDirectory, 'runtime.lock'))).rejects.toHaveProperty('code', 'ENOENT')
    expect(f.database(db => db.prepare("SELECT name FROM sqlite_master WHERE name='approval_delivery_events'").get())).toBeUndefined()
  })

  it.each(['node', 'deadline', 'project'])('refuses internally consistent but historically false %s receipt on reopen', async field => {
    const f = await fixture(); f.provision()
    const request = await f.prepare(); await f.runtime.sendApprovalNotification(request, 'operator')
    await f.runtime.decide(f.run.id, f.pin.attemptId, 'approve', 'human'); await f.runtime.close()
    f.database(db => {
      const mutate = (encoded: string) => {
        const record = JSON.parse(encoded)
        if (field === 'node') record.event.data.nodeId = 'other'
        if (field === 'deadline') record.event.data.expiresAt = '2099-01-01T00:00:00.000Z'
        if (field === 'project') record.event.data.project = { id: randomUUID(), generation: 1 }
        const { source, type, time, data } = record.event
        record.event.id = notificationSha256({ source, type, time, data }); record.request.eventSha256 = notificationSha256(record.event)
        return record
      }
      // Use one replacement identity in both snapshots/journal so the domain history check, not just checksums, must reject it.
      const saved = mutate(db.prepare('SELECT record FROM approval_deliveries').get()!.record as string)
      db.prepare('UPDATE approval_deliveries SET record=?,event_sha256=?').run(JSON.stringify(saved), saved.request.eventSha256)
      const rows = db.prepare('SELECT sequence,record FROM approval_delivery_events').all()
      for (const row of rows) {
        const record = JSON.parse(row.record as string); record.event = saved.event; record.request = saved.request
        db.prepare('UPDATE approval_delivery_events SET record=? WHERE sequence=?').run(JSON.stringify(record), row.sequence!)
      }
    })
    await expect(LocalRuntime.open({ dataDirectory: f.dataDirectory })).rejects.toHaveProperty('code', 'corrupt')
    await expect(stat(join(f.dataDirectory, 'runtime.lock'))).rejects.toHaveProperty('code', 'ENOENT')
    expect(f.received).toHaveLength(1)
  })

  it('does not replay a retained pending receipt after an uncertain settlement acknowledgement', async () => {
    const f = await fixture(); f.provision()
    const request = await f.prepare()
    f.database(db => db.exec("CREATE TRIGGER deny_delivery_settlement BEFORE INSERT ON approval_delivery_events WHEN NEW.kind='settled' BEGIN SELECT RAISE(ABORT, 'fixture'); END"))
    await expect(f.runtime.sendApprovalNotification(request, 'operator')).rejects.toThrow('fixture')
    const reopened = await f.reopen()
    expect((await reopened.sendApprovalNotification(request, 'operator')).outcome.status).toBe('pending')
    expect(f.received).toHaveLength(1)
  })

  it('refuses operations after owner closure', async () => {
    const f = await fixture(), request = await f.prepare(); await f.runtime.close()
    await expect(f.runtime.prepareApprovalNotification(f.pin, f.endpoint.id)).rejects.toHaveProperty('code', 'closed')
    await expect(f.runtime.inspectApprovalNotification(request.requestId)).rejects.toHaveProperty('code', 'closed')
    await expect(f.runtime.sendApprovalNotification(request, 'operator')).rejects.toHaveProperty('code', 'closed')
    expect(() => f.runtime.notificationDestinations()).toThrow(expect.objectContaining({ code: 'closed' }))
  })

  it('refuses an invalid historical intent timestamp before admitting a new delivery', async () => {
    const f = await fixture(); f.provision()
    const request = await f.prepare()
    f.database(db => db.prepare("UPDATE events SET at='invalid' WHERE kind='node-intent' AND json_extract(data,'$.attempt.id')=?")
      .run(f.pin.attemptId))
    await expect(f.runtime.sendApprovalNotification(request, 'operator')).rejects.toHaveProperty('code', 'corrupt')
    await expect(f.runtime.inspectApprovalNotification(request.requestId)).rejects.toHaveProperty('code', 'not-found')
    expect(f.received).toHaveLength(0)
  })

  it('preserves legacy journal bytes and explicitly retained deadlines after a legacy wait settles', async () => {
    const f = await fixture()
    f.database(db => db.exec("UPDATE events SET data=json_remove(data,'$.expiresAt') WHERE kind='approval-requested'"))
    const events = await f.runtime.events(f.run.id); f.provision()
    const request = await f.prepare(), receipt = await f.runtime.sendApprovalNotification(request, 'operator')
    expect(await f.runtime.events(f.run.id)).toEqual(events)
    await f.runtime.decide(f.run.id, f.pin.attemptId, 'approve', 'human')
    const reopened = await f.reopen()
    expect(await reopened.sendApprovalNotification(request, 'operator')).toEqual(receipt)
    expect(f.received).toHaveLength(1)
  })

  it('rolls back notification schema initialization failure, preserving the prior version and workflow bytes', async () => {
    const f = await fixture(); await f.runtime.close()
    const before = f.database(db => db.prepare('SELECT record FROM runs').all())
    f.database(db => db.exec('DROP TABLE approval_delivery_events; DROP TABLE approval_deliveries; PRAGMA user_version=15; CREATE VIEW approval_deliveries AS SELECT id FROM runs'))
    await expect(LocalRuntime.open({ dataDirectory: f.dataDirectory })).rejects.toThrow()
    expect(f.database(db => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(15)
    expect(f.database(db => db.prepare('SELECT record FROM runs').all())).toEqual(before)
    expect(f.database(db => db.prepare("SELECT name FROM sqlite_master WHERE name='approval_delivery_events'").get())).toBeUndefined()
    await expect(stat(join(f.dataDirectory, 'runtime.lock'))).rejects.toHaveProperty('code', 'ENOENT')
    expect(f.received).toHaveLength(0)
  })
})
