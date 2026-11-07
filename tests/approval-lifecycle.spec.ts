import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime, type ApprovalNotificationPin } from '../src/runtime/index.ts'
import { approvalLifecycleNotification, inspectNotificationRecord, notificationSha256 } from '../src/notifications/schema.ts'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks() })
async function fixture(source = yaml) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-approval-lifecycle-'))
  const key = 'whsec_' + randomBytes(32).toString('base64'), received: { body: string; signatureValid: boolean }[] = []
  const receiver = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    const expected = 'v1,' + createHmac('sha256', Buffer.from(key.slice(6), 'base64'))
      .update(req.headers['webhook-id'] + '.' + req.headers['webhook-timestamp'] + '.' + body).digest('base64')
    received.push({ body, signatureValid: req.headers['webhook-signature'] === expected })
    res.writeHead(202); res.end()
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { receiver.closeAllConnections(); receiver.close(() => resolve()) }))
  const notifications = { endpoints: [{ id: 'review', url: `http://127.0.0.1:${(receiver.address() as { port: number }).port}/events`,
    credentialRef: 'review/key', timeoutMs: 1000 }] }
  const owner = await LocalRuntime.open({ dataDirectory, notifications }); cleanup.push(() => owner.close())
  const run = await owner.run(source, { message: 'PRIVATE_INPUT' })
  if (run.state.status !== 'waiting') throw Error('missing approval')
  const pin = { runId: run.id, revision: run.revision, attemptId: run.state.attempt.id }
  const prepare = (eventKind: ApprovalNotificationPin['eventKind']) => owner.prepareApprovalNotification({ ...pin,
    ...(eventKind === undefined ? {} : { eventKind }) }, 'review')
  const send = async (eventKind: ApprovalNotificationPin['eventKind']) => {
    const { event, delivery: _delivery, ...pins } = await prepare(eventKind)
    const request = { ...pins, requestId: randomUUID() }
    return { event, request, receipt: await owner.sendApprovalNotification(request, 'PRIVATE_NOTIFICATION_ACTOR') }
  }
  return { owner, run, pin, prepare, send, received, dataDirectory, notifications,
    provision: () => owner.setCredential('review/key', key, 0, 'PRIVATE_OPERATOR') }
}
function dateOnly(at: number) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at) }

describe('recorded approval lifecycle notifications', () => {
  it.each(['approve', 'reject'])('delivers recorded %s metadata explicitly after the original deadline without exposing the decision', async action => {
    const f = await fixture(), requested = await f.prepare(undefined)
    await f.owner.decide(f.run.id, f.pin.attemptId, action, 'PRIVATE_DECISION_ACTOR')
    const prepared = await f.prepare('decided'), before = await f.owner.events(f.run.id)
    expect(prepared.event.type).toBe('ai.jevable.approval.decided')
    expect(prepared.event.id).not.toBe(requested.event.id)
    expect(prepared.event.time).toBe(before.find(event => event.kind === 'approval-decided')!.at)
    expect(prepared.event.data).toEqual(requested.event.data)
    expect(JSON.stringify(prepared)).not.toMatch(/PRIVATE_|action|actor|credential|whsec_/)
    expect(f.received).toEqual([])
    dateOnly(Date.parse(requested.event.data.expiresAt) + 1)
    expect(await f.prepare('decided')).toEqual(prepared)
    await f.provision()
    const sent = await f.send('decided')
    expect(sent.receipt.outcome).toMatchObject({ status: 'settled', result: { status: 'accepted' } })
    expect(f.received).toEqual([{ body: JSON.stringify(prepared.event), signatureValid: true }])
    expect(await f.owner.sendApprovalNotification(sent.request, 'PRIVATE_NOTIFICATION_ACTOR')).toEqual(sent.receipt)
    expect(await f.owner.events(f.run.id)).toEqual(before)
    await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.dataDirectory }); cleanup.push(() => reopened.close())
    expect(await reopened.sendApprovalNotification(sent.request, 'PRIVATE_NOTIFICATION_ACTOR')).toEqual(sent.receipt)
    expect((await reopened.listApprovalNotifications({})).deliveries[0]!.request.eventKind).toBe('decided')
    expect(f.received).toHaveLength(1)
  })
  it('does not convert an elapsed waiting deadline into expiry; only the committed expired decision can be sent', async () => {
    const f = await fixture(), requested = await f.prepare(undefined), before = await f.owner.events(f.run.id)
    dateOnly(Date.parse(requested.event.data.expiresAt) + 1)
    await expect(f.prepare('expired')).rejects.toHaveProperty('code', 'conflict')
    expect(await f.owner.events(f.run.id)).toEqual(before)
    expect((await f.owner.show(f.run.id)).state.status).toBe('waiting')
    await f.owner.decide(f.run.id, f.pin.attemptId, 'approve', 'PRIVATE_DECISION_ACTOR')
    await expect(f.prepare('decided')).rejects.toHaveProperty('code', 'conflict')
    const expiry = await f.prepare('expired')
    expect(expiry.event.type).toBe('ai.jevable.approval.expired')
    expect(f.received).toEqual([])
    await f.provision(); await f.send('expired')
    expect(f.received).toHaveLength(1)
    expect(JSON.parse(f.received[0]!.body)).toEqual(expiry.event)
    expect((await f.owner.show(f.run.id)).state).toMatchObject({ status: 'failed', code: 'approval-expired' })
  })
  it('projects a committed waiting cancellation without turning it into an approval decision', async () => {
    const f = await fixture(), requestId = randomUUID()
    await expect(f.prepare('cancelled')).rejects.toHaveProperty('code', 'conflict')
    f.owner.cancel(f.run.id, requestId, 'PRIVATE_CANCEL_ACTOR')
    const prepared = await f.prepare('cancelled'), before = await f.owner.events(f.run.id)
    expect(prepared.event.type).toBe('ai.jevable.approval.cancelled')
    expect(prepared.event.time).toBe(before.find(event => event.kind === 'run-cancelled')!.at)
    expect(JSON.stringify(prepared)).not.toContain(requestId)
    expect(f.received).toEqual([])
    await expect(f.prepare('decided')).rejects.toHaveProperty('code', 'conflict')
    await expect(f.prepare('expired')).rejects.toHaveProperty('code', 'conflict')
    await f.provision(); const sent = await f.send('cancelled')
    expect(await f.owner.sendApprovalNotification(sent.request, 'PRIVATE_NOTIFICATION_ACTOR')).toEqual(sent.receipt)
    expect(await f.owner.events(f.run.id)).toEqual(before)
    expect(f.received).toHaveLength(1)
  })
  it('preserves old requested event bytes with an omitted or explicit requested selector', async () => {
    const f = await fixture()
    const original = await f.prepare(undefined), explicit = await f.prepare('requested')
    expect(original.event).toEqual(explicit.event)
    expect(original).not.toHaveProperty('eventKind')
    expect(explicit.event.data).not.toHaveProperty('eventKind')
  })
  it('canonicalizes an explicit undefined selector so valid SDK same-ID retries remain receipt-only', async () => {
    const f = await fixture(); await f.provision()
    const prepared = await f.owner.prepareApprovalNotification({ ...f.pin, eventKind: undefined }, 'review')
    const { event: _event, delivery: _delivery, ...pins } = prepared
    const request = { ...pins, eventKind: undefined, redeliverOf: undefined, requestId: randomUUID() }
    const receipt = await f.owner.sendApprovalNotification(request, 'PRIVATE_NOTIFICATION_ACTOR')
    expect(await f.owner.sendApprovalNotification(request, 'PRIVATE_NOTIFICATION_ACTOR')).toEqual(receipt)
    expect(Object.hasOwn(request, 'eventKind')).toBe(true)
    expect(Object.hasOwn(request, 'redeliverOf')).toBe(true)
    expect(prepared).not.toHaveProperty('eventKind')
    expect(f.received).toHaveLength(1)
  })
  it('keeps requested/decided predecessor chains distinct and requires explicit fresh-ID lifecycle redelivery', async () => {
    const f = await fixture(); await f.provision()
    const requested = await f.send(undefined)
    await f.owner.decide(f.run.id, f.pin.attemptId, 'approve', 'PRIVATE_ACTOR')
    const decided = await f.send('decided')
    await expect(f.owner.sendApprovalNotification({ ...decided.request, requestId: randomUUID(), redeliverOf: requested.request.requestId }, 'PRIVATE_NOTIFICATION_ACTOR'))
      .rejects.toHaveProperty('code', 'conflict')
    const next = { ...decided.request, requestId: randomUUID(), redeliverOf: decided.request.requestId }
    expect((await f.owner.sendApprovalNotification(next, 'PRIVATE_NOTIFICATION_ACTOR')).event).toEqual(decided.event)
    expect(f.received).toHaveLength(3)
    await expect(f.owner.sendApprovalNotification({ ...next, requestId: randomUUID() }, 'PRIVATE_NOTIFICATION_ACTOR')).rejects.toHaveProperty('code', 'conflict')
    expect(f.received).toHaveLength(3)
  })
  it('retains a historical first decision while a second independent approval is waiting', async () => {
    const second = yaml.replace('    result:\n', '    second:\n      type: humanApproval\n      config:\n        title: Second review\n        input: "${{ inputs.message }}"\n        inputSchema: { type: string }\n        actions: [approve, reject]\n        expiresAfter: 24h\n        onReject: cancelled\n        onTimeout: expired\n    result:\n')
      .replace('      to: result\n', '      to: second\n    - from: second\n      port: approve\n      to: result\n')
    const f = await fixture(second)
    const run = await f.owner.decide(f.run.id, f.pin.attemptId, 'approve', 'PRIVATE_ACTOR')
    expect(run.state).toMatchObject({ status: 'waiting', next: 'second' })
    const prepared = await f.prepare('decided')
    expect(prepared.event.data.nodeId).toBe('review')
    await f.provision(); await f.send('decided')
    expect(await f.owner.show(f.run.id)).toEqual(run)
    expect(f.received).toHaveLength(1)
  })
  it.each(['decided', 'expired', 'cancelled'] as const)('rejects foreign run/revision/attempt pins and unavailable %s evidence without sending', async eventKind => {
    const f = await fixture()
    for (const change of [{ runId: randomUUID() }, { revision: 'f'.repeat(64) }, { attemptId: randomUUID() }]) {
      await expect(f.owner.prepareApprovalNotification({ ...f.pin, eventKind, ...change }, 'review')).rejects.toBeDefined()
    }
    await expect(f.prepare(eventKind)).rejects.toHaveProperty('code', 'conflict')
    expect(f.received).toEqual([])
  })
  it('refuses unsupported selectors and forged request/event selector combinations', async () => {
    const f = await fixture(); await f.provision()
    await expect(f.prepare('bad' as 'decided')).rejects.toHaveProperty('code', 'invalid-command')
    await f.owner.decide(f.run.id, f.pin.attemptId, 'approve', 'PRIVATE_ACTOR')
    const { receipt } = await f.send('decided')
    expect(() => inspectNotificationRecord({ ...receipt, request: { ...receipt.request, eventKind: undefined } })).toThrow(expect.objectContaining({ code: 'corrupt' }))
    expect(() => inspectNotificationRecord({ ...receipt, request: { ...receipt.request, eventKind: 'expired' } })).toThrow(expect.objectContaining({ code: 'corrupt' }))
    await expect(f.owner.sendApprovalNotification({ ...receipt.request, eventKind: 'expired', requestId: randomUUID() }, 'PRIVATE_NOTIFICATION_ACTOR')).rejects.toHaveProperty('code', 'conflict')
    expect(f.received).toHaveLength(1)
  })
  it('requires a recorded historical deadline rather than inventing one for legacy lifecycle events', async () => {
    const f = await fixture(); await f.owner.decide(f.run.id, f.pin.attemptId, 'approve', 'PRIVATE_ACTOR')
    const run = await f.owner.show(f.run.id), events = await f.owner.events(f.run.id)
    const legacy = events.map(e => { if (e.kind !== 'approval-requested') return e; const { expiresAt: _expiresAt, ...data } = e.data as Record<string, unknown>; return { ...e, data } })
    expect(() => approvalLifecycleNotification(run, legacy, { ...f.pin, eventKind: 'decided' })).toThrow(expect.objectContaining({ code: 'invalid-command' }))
  })
  it.each(['duplicate-wait', 'duplicate-intent', 'duplicate-decision', 'wrong-node', 'wrong-time', 'wrong-deadline'] as const)('refuses %s in lifecycle evidence', async fault => {
    const f = await fixture(); await f.owner.decide(f.run.id, f.pin.attemptId, 'approve', 'PRIVATE_ACTOR')
    const run = await f.owner.show(f.run.id), events = structuredClone(await f.owner.events(f.run.id))
    if (fault.startsWith('duplicate')) {
      const kind = fault === 'duplicate-wait' ? 'approval-requested' : fault === 'duplicate-intent' ? 'node-intent' : 'approval-decided'
      events.push(events.find(e => e.kind === kind && (kind !== 'node-intent' || (e.data as any).attempt.id === f.pin.attemptId))!)
    } else {
      const decision = events.find(e => e.kind === 'approval-decided')!
      if (fault === 'wrong-node') (decision.data as any).nodeId = 'foreign'
      if (fault === 'wrong-time') decision.at = '2020-01-01T00:00:00.000Z'
      if (fault === 'wrong-deadline') (events.find(e => e.kind === 'approval-requested')!.data as any).expiresAt = '2020-01-01T00:00:00.000Z'
    }
    expect(() => approvalLifecycleNotification(run, events, { ...f.pin, eventKind: 'decided' })).toThrow(expect.objectContaining({ code: 'corrupt' }))
  })
  it('does not accept an event timestamp later than its retained intent even with recomputed checksums', async () => {
    const f = await fixture(); await f.provision(); await f.owner.decide(f.run.id, f.pin.attemptId, 'approve', 'PRIVATE_ACTOR')
    const { receipt } = await f.send('decided'), event = { ...receipt.event, time: '2099-01-01T00:00:00.000Z' }
    const { source, type, time, data } = event; event.id = notificationSha256({ source, type, time, data })
    expect(() => inspectNotificationRecord({ ...receipt, event, request: { ...receipt.request, eventSha256: notificationSha256(event) } }))
      .toThrow(expect.objectContaining({ code: 'corrupt' }))
  })
  it.each(['missing-stop', 'duplicate-stop', 'wrong-request', 'wrong-node', 'wrong-status'] as const)('refuses %s as waiting cancellation proof', async fault => {
    const f = await fixture(); f.owner.cancel(f.run.id, randomUUID(), 'PRIVATE_ACTOR')
    const run = await f.owner.show(f.run.id), events = structuredClone(await f.owner.events(f.run.id))
    const stopped = events.find(e => e.kind === 'run-cancelled')!
    if (fault === 'missing-stop') events.splice(events.indexOf(stopped), 1)
    else if (fault === 'duplicate-stop') events.push(stopped)
    else if (fault === 'wrong-request') (stopped.data as any).requestId = randomUUID()
    else if (fault === 'wrong-node') (stopped.data as any).next = 'foreign'
    else (stopped.data as any).previousStatus = 'paused'
    expect(() => approvalLifecycleNotification(run, events, { ...f.pin, eventKind: 'cancelled' })).toThrow(expect.objectContaining({ code: 'corrupt' }))
  })
})
