import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, chmod, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime } from '../src/runtime/index.ts'
import { startRuntimeService, RuntimeClient, type RuntimeOperation } from '../src/http/index.ts'
import { dispatchOperation } from '../src/http/operations.ts'
import { operationCapabilities } from '../src/http/operation-host.ts'
import { PROTOCOL_VERSION, CORE_VERSION } from '../src/capabilities.ts'
import { localRuntimeOptions } from '../src/telemetry/options.ts'
import { operationSelection } from '../src/cli/operations.ts'
import { ReleaseSession } from '../src/releases/service-session.ts'
import { main } from '../src/cli.ts'
import { createTlsFixture, fixturePort } from '../scripts/tls-fixture.mjs'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function cli(...args: string[]) {
  let out = '', err = ''
  const exit = await main(args, { out: value => { out += value }, err: value => { err += value } })
  return { exit, result: out ? JSON.parse(out) : undefined, error: err ? JSON.parse(err) : undefined }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-notification-api-')), dataDirectory = join(directory, 'state')
  const received: string[] = [], token = randomBytes(32).toString('hex'), key = 'whsec_' + randomBytes(32).toString('base64')
  let reply: (response: ServerResponse) => void = response => { response.writeHead(202); response.end('PRIVATE_RESPONSE') }
  let resolveReceived: (() => void) | undefined, held: ServerResponse | undefined
  const receiver = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    received.push(Buffer.concat(chunks).toString('utf8')); held = response; resolveReceived?.(); reply(response)
  })
  await new Promise<void>((resolve, reject) => { receiver.once('error', reject); receiver.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { receiver.closeAllConnections(); receiver.close(() => resolve()) }))
  const address = receiver.address(); if (!address || typeof address === 'string') throw Error('listener missing')
  const endpoint = { id: 'review', url: `http://127.0.0.1:${address.port}/PRIVATE_DESTINATION`, credentialRef: 'review/key', timeoutMs: 1000 }
  const notifications = { endpoints: [endpoint] }, configFile = join(directory, 'notifications.json'), tokenFile = join(directory, 'token')
  await writeFile(configFile, JSON.stringify(notifications), { mode: 0o600 }); await writeFile(tokenFile, token, { mode: 0o600 })
  const owner = await LocalRuntime.open({ dataDirectory })
  let run
  try { owner.setCredential(endpoint.credentialRef, key, 0, 'PRIVATE_PROVISIONER'); run = await owner.run(yaml, { message: 'PRIVATE_REVIEW' }) }
  finally { await owner.close() }
  if (run.state.status !== 'waiting') throw Error('expected wait')
  const pin = { runId: run.id, revision: run.revision, attemptId: run.state.attempt.id }
  const start = async (configured = true, tls?: Awaited<ReturnType<typeof createTlsFixture>>, maxConcurrentRequests?: number) => {
    const port = tls ? await fixturePort() : undefined
    const service = await startRuntimeService({ runtime: { dataDirectory, ...(configured ? { notifications } : {}) }, token,
      actor: 'PRIVATE_HOST_ACTOR', ...(maxConcurrentRequests ? { maxConcurrentRequests } : {}), ...(tls ? { port: port!, tls: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: '127.0.0.1',
        certificateFile: tls.cert, privateKeyFile: tls.key } } : {}) })
    cleanup.push(async () => { await service.close(); await service.closed })
    const client = new RuntimeClient(service.url, token, 3000, 20_000_000, tls ? { ca: tls.ca } : {})
    const call = async (value: RuntimeOperation) => (await client.operation(value) as { result: any }).result
    const prepare = async () => {
      const { event: _event, delivery: _delivery, ...request } = await call({ operation: 'notifications.prepare', pin, endpointId: endpoint.id })
      return { ...request, requestId: randomUUID() }
    }
    return { service, client, call, prepare }
  }
  const readRows = () => {
    const db = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'), { readOnly: true })
    try { return db.prepare('SELECT record FROM approval_deliveries').all().map(row => JSON.parse(row.record as string)) }
    finally { db.close() }
  }
  const hold = () => { reply = () => {}; return new Promise<void>(resolve => { resolveReceived = resolve }) }
  return { directory, dataDirectory, endpoint, notifications, configFile, tokenFile, token, key, pin, run, received, start, readRows, hold,
    finish: () => { held?.writeHead(202); held?.end() }, response: (status: number) => { reply = r => { r.writeHead(status); r.end() } },
    flags: ['--data-dir', dataDirectory], configuredFlags: ['--data-dir', dataDirectory, '--notifications-file', configFile] }
}

describe('standalone notification CLI and management API', () => {
  it.each(['decided', 'cancelled'] as const)('routes CLI %s preparation through the explicitly selected owner without sending on settlement', async eventKind => {
    const f = await fixture(), tls = await createTlsFixture(f.directory), host = await f.start(true, tls)
    if (eventKind === 'decided') await host.call({ operation: 'approvals.decide', id: f.run.id, attemptId: f.pin.attemptId, action: 'approve' })
    else await host.call({ operation: 'runs.cancel', id: f.run.id, requestId: randomUUID() })
    const before = await host.call({ operation: 'runs.events', id: f.run.id })
    const flags = ['--endpoint', host.service.url, '--token-file', f.tokenFile, '--ca-file', tls.cert, '--instance-id', host.service.instanceId]
    const prepared = await cli('approvals', 'notify', 'prepare', f.run.id, '--revision', f.pin.revision, '--attempt', f.pin.attemptId,
      '--destination', f.endpoint.id, '--event-kind', eventKind, ...flags)
    expect(prepared.exit).toBe(0); expect(prepared.result.event.type).toBe(`ai.jevable.approval.${eventKind}`)
    expect(prepared.result.eventKind).toBe(eventKind); expect(f.received).toEqual([])
    const { event: _event, delivery: _delivery, ...pins } = prepared.result
    const sent = await host.call({ operation: 'notifications.send', request: { ...pins, requestId: randomUUID() } })
    expect(sent.outcome.result.status).toBe('accepted')
    expect(sent.actor).toBeUndefined(); expect(JSON.stringify(sent)).not.toContain('PRIVATE_')
    expect(await host.call({ operation: 'runs.events', id: f.run.id })).toEqual(before)
    expect(f.received).toHaveLength(1)
    const invalid = await cli('approvals', 'notify', 'prepare', f.run.id, '--revision', f.pin.revision, '--attempt', f.pin.attemptId,
      '--destination', f.endpoint.id, '--event-kind', 'automatic', ...flags)
    expect(invalid.exit).toBe(2); expect(f.received).toHaveLength(1)
  })

  it('allows authenticated per-delivery abort through bounded control capacity while a send fills normal admission', async () => {
    const f = await fixture(), host = await f.start(true, undefined, 1), request = await host.prepare(), arrived = f.hold()
    const before = await host.call({ operation: 'runs.show', id: f.run.id })
    const sending = host.call({ operation: 'notifications.send', request })
    try {
      await arrived
      await expect(host.call({ operation: 'notifications.destinations' })).rejects.toHaveProperty('code', 'concurrency-limit')
      await expect(new RuntimeClient(host.service.url, '0'.repeat(64)).operation({ operation: 'notifications.abort', requestId: request.requestId }))
        .rejects.toHaveProperty('code', 'unauthorized')
      await expect(host.call({ operation: 'notifications.abort', requestId: request.requestId, actor: 'forged' } as RuntimeOperation))
        .rejects.toHaveProperty('code', 'invalid-command')
      const result = await host.call({ operation: 'notifications.abort', requestId: request.requestId })
      expect(result).toMatchObject({ status: 'abort-requested', requestId: request.requestId, receipt: { outcome: { status: 'pending' } } })
      expect((await sending).outcome).toMatchObject({ status: 'settled', result: { status: 'uncertain', reason: 'aborted' } })
      expect(await host.call({ operation: 'runs.show', id: f.run.id })).toEqual(before)
      expect((await host.call({ operation: 'notifications.abort', requestId: request.requestId })).status).toBe('not-active')
      expect(f.received).toHaveLength(1)
    } finally { f.finish(); await sending.catch(() => {}) }
  })

  it('routes an explicit selected-owner CLI abort over HTTPS and reports inactive receipt-only history after reopen', async () => {
    const f = await fixture(), tls = await createTlsFixture(f.directory), host = await f.start(true, tls)
    const flags = ['--endpoint', host.service.url, '--token-file', f.tokenFile, '--ca-file', tls.cert, '--instance-id', host.service.instanceId]
    const request = await host.prepare(), arrived = f.hold(), sending = host.call({ operation: 'notifications.send', request })
    try {
      await arrived
      const aborted = await cli('approvals', 'notify', 'abort', request.requestId, ...flags)
      expect(aborted.exit).toBe(0); expect(aborted.result.status).toBe('abort-requested')
      expect((await sending).outcome.result).toEqual({ status: 'uncertain', reason: 'aborted' })
      await host.service.close(); await host.service.closed
      const historical = await cli('approvals', 'notify', 'abort', request.requestId, ...f.flags)
      expect(historical.exit).toBe(0); expect(historical.result.status).toBe('not-active')
      expect(historical.result.receipt.outcome.result.reason).toBe('aborted')
      expect(f.received).toHaveLength(1)
    } finally { f.finish(); await sending.catch(() => {}) }
  })

  it('exposes read-only authenticated history pages without destination configuration and requires explicit paging', async () => {
    const f = await fixture(), api = await f.start()
    const first = await api.prepare(), second = { ...first, requestId: randomUUID(), redeliverOf: first.requestId }
    await api.call({ operation: 'notifications.send', request: first }); await api.call({ operation: 'notifications.send', request: second })
    const page = await api.call({ operation: 'notifications.list', page: { limit: 1 } })
    expect(page.deliveries).toHaveLength(1); expect(page.nextCursor).toBe(page.deliveries[0].request.requestId)
    const last = await api.call({ operation: 'notifications.list', page: { after: page.nextCursor, limit: 1 } })
    expect(last.deliveries).toHaveLength(1); expect(last.nextCursor).toBeNull()
    expect(JSON.stringify([page, last])).not.toMatch(/PRIVATE_|credentialGeneration|actor|event"/)
    for (const value of [{ operation: 'notifications.list' }, { operation: 'notifications.list', page: { limit: 201 } },
      { operation: 'notifications.list', page: {}, actor: 'override' }, { operation: 'notifications.list', page: { after: 'bad' } }])
      await expect(api.call(value as RuntimeOperation)).rejects.toHaveProperty('code', 'invalid-command')
    await api.service.close(); await api.service.closed
    const listed = await cli('approvals', 'notify', 'list', '--page', '--limit', '1', ...f.flags)
    expect(listed.exit).toBe(0); expect(listed.result).toEqual(page)
    const tail = await cli('approvals', 'notify', 'list', '--page', '--after', page.nextCursor, '--limit', '1', ...f.flags)
    expect(tail.result).toEqual(last)
    expect((await cli('approvals', 'notify', 'list', ...f.flags)).exit).not.toBe(0)
    expect((await cli('approvals', 'notify', 'list', '--limit', '1', ...f.flags)).exit).not.toBe(0)
    expect(f.received).toHaveLength(2)
    const reopened = await f.start(false)
    expect(await reopened.call({ operation: 'notifications.list', page: { limit: 1 } })).toEqual(page)
  })
  it('uses private explicit CLI configuration and retained request files without implicit delivery', async () => {
    const f = await fixture()
    const destinations = await cli('approvals', 'notify', 'destinations', ...f.configuredFlags)
    expect(destinations.exit).toBe(0); expect(destinations.result.destinations).toHaveLength(1)
    const prepared = await cli('approvals', 'notify', 'prepare', f.run.id, '--revision', f.pin.revision,
      '--attempt', f.pin.attemptId, '--destination', 'review', ...f.configuredFlags)
    expect(prepared.exit).toBe(0); expect(prepared.result.delivery).toBe('not-attempted'); expect(f.received).toHaveLength(0)
    expect(JSON.stringify([prepared.result, destinations.result])).not.toMatch(/PRIVATE_|review\/key|whsec_/)
    const { event: _event, delivery: _delivery, ...pins } = prepared.result, request = { ...pins, requestId: randomUUID() }
    const file = join(f.directory, 'request.json'); await writeFile(file, JSON.stringify(request))
    const sent = await cli('approvals', 'notify', 'send', file, ...f.configuredFlags)
    expect(sent.exit).toBe(0); expect(sent.result.outcome.result).toEqual({ status: 'accepted', httpStatus: 202 })
    expect(sent.result.actor).toBeUndefined(); expect(f.readRows()[0].actor).toMatch(/^local:/)
    const retry = await cli('approvals', 'notify', 'send', file, ...f.flags)
    expect(retry).toEqual(sent)
    expect((await cli('approvals', 'notify', 'show', request.requestId, ...f.flags)).result).toEqual(sent.result)
    expect(f.received).toHaveLength(1)
    expect(f.readRows()[0].request).toEqual(request)
    const redelivery = { ...request, requestId: randomUUID(), redeliverOf: request.requestId }
    await writeFile(file, JSON.stringify(redelivery))
    const redelivered = await cli('approvals', 'notify', 'send', file, ...f.configuredFlags)
    expect(redelivered.exit).toBe(0); expect(redelivered.result.event).toEqual(sent.result.event)
    expect(f.received).toHaveLength(2)
  })

  it.each([['rejected', 503, 1], ['uncertain', 0, 5]] as const)('returns explicit %s CLI status without automatic retries', async (status, httpStatus, exit) => {
    const f = await fixture(), owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory, notifications: f.notifications })
    const prepared = await owner.prepareApprovalNotification(f.pin, 'review'); await owner.close()
    const { event: _event, delivery: _delivery, ...pins } = prepared, request = { ...pins, requestId: randomUUID() }
    const file = join(f.directory, 'request.json'); await writeFile(file, JSON.stringify(request))
    if (httpStatus) f.response(httpStatus); else void f.hold()
    const result = await cli('approvals', 'notify', 'send', file, ...f.configuredFlags)
    expect(result.exit).toBe(exit); expect(result.result.outcome.result.status).toBe(status)
    expect((await cli('approvals', 'notify', 'send', file, ...f.flags)).result).toEqual(result.result)
    expect((await cli('approvals', 'notify', 'show', request.requestId, ...f.flags)).exit).toBe(0)
    expect(f.received).toHaveLength(1)
  })

  it('requires reviewed request IDs and rejects extra actor/destination/key fields before state is opened', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-notification-input-')), file = join(directory, 'request.json'), state = join(directory, 'absent')
    for (const value of [{}, { requestId: randomUUID(), actor: 'forged' }, { url: 'https://other.example', signingKey: 'PRIVATE' }]) {
      await writeFile(file, JSON.stringify(value))
      expect((await cli('approvals', 'notify', 'send', file, '--data-dir', state)).exit).toBe(2)
      await expect(stat(state)).rejects.toHaveProperty('code', 'ENOENT')
    }
    expect((await cli('approvals', 'notify', 'prepare', randomUUID(), '--data-dir', state)).exit).toBe(2)
    expect((await cli('approvals', 'notify', 'show', 'bad-id', '--data-dir', state)).exit).toBe(2)
  })

  it('authenticates notification routes, assigns the host actor and retains receipt identity after restart', async () => {
    const f = await fixture(), first = await f.start(), request = await first.prepare()
    const caps: any = await first.client.capabilities()
    expect(caps.api.operations.approvalNotifications).toMatchObject({ available: true, scope: 'management-owner', automaticDelivery: false })
    expect(JSON.stringify(await first.call({ operation: 'notifications.destinations' }))).not.toContain('PRIVATE_')
    await expect(new RuntimeClient(first.service.url, '0'.repeat(64)).operation({ operation: 'notifications.send', request }))
      .rejects.toHaveProperty('code', 'unauthorized')
    expect(f.readRows()).toHaveLength(0)
    const sent = await first.call({ operation: 'notifications.send', request })
    expect(sent.actor).toBeUndefined(); expect(f.readRows()[0].actor).toBe('PRIVATE_HOST_ACTOR')
    expect(JSON.stringify(sent)).not.toMatch(/PRIVATE_|whsec_/)
    await first.call({ operation: 'approvals.decide', id: f.run.id, attemptId: f.pin.attemptId, action: 'approve' })
    await first.service.close(); await first.service.closed
    const second = await f.start(false)
    expect((await second.call({ operation: 'notifications.destinations' })).destinations).toEqual([])
    expect(await second.call({ operation: 'notifications.show', requestId: request.requestId })).toEqual(sent)
    expect(await second.call({ operation: 'notifications.send', request })).toEqual(sent)
    expect(f.received).toHaveLength(1)
  })

  it.each(['actor', 'url', 'key', 'signal', 'endpoint'])('refuses injected %s in API sends', async field => {
    const f = await fixture(), service = await f.start(), request = await service.prepare()
    for (const body of [{ operation: 'notifications.send', request, [field]: 'PRIVATE_FORGED' },
      { operation: 'notifications.send', request: { ...request, [field]: 'PRIVATE_FORGED' } }]) {
      await expect(service.client.operation(body as RuntimeOperation)).rejects.toHaveProperty('code', 'invalid-command')
    }
    expect(f.received).toHaveLength(0); expect(f.readRows()).toHaveLength(0)
  })

  it('drains an admitted notification before releasing the owner, while refusing new work', async () => {
    const f = await fixture(), host = await f.start(), request = await host.prepare(), arrived = f.hold()
    const sending = host.call({ operation: 'notifications.send', request }); await arrived
    expect(await host.service.close(1)).toMatchObject({ status: 'draining' })
    await expect(host.call({ operation: 'notifications.destinations' })).rejects.toThrow()
    await expect(LocalRuntime.open({ dataDirectory: f.dataDirectory })).rejects.toHaveProperty('code', 'busy')
    f.finish()
    expect((await sending).outcome.result.status).toBe('accepted')
    await host.service.closed
    const owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory })
    try { expect((await owner.inspectApprovalNotification(request.requestId)).outcome.status).toBe('settled') }
    finally { await owner.close() }
    expect(f.received).toHaveLength(1)
  })

  it('finishes a client-disconnected admitted send and returns its retained receipt without replay', async () => {
    const f = await fixture(), host = await f.start(), request = await host.prepare(), arrived = f.hold()
    const call = httpRequest(host.service.url + '/v1/operations', { method: 'POST', headers: {
      authorization: `Bearer ${f.token}`, 'x-jevable-protocol': PROTOCOL_VERSION, 'content-type': 'application/json',
    } }); call.on('error', () => {}); call.end(JSON.stringify({ operation: 'notifications.send', request }))
    await arrived; call.destroy()
    expect((await host.call({ operation: 'notifications.show', requestId: request.requestId })).outcome.status).toBe('pending')
    f.finish(); await host.service.close(); await host.service.closed
    const restarted = await f.start(false)
    expect((await restarted.call({ operation: 'notifications.send', request })).outcome.result.status).toBe('accepted')
    expect(f.received).toHaveLength(1)
  })

  it('routes CLI sends through an explicitly selected verified HTTPS owner without local configuration', async () => {
    const f = await fixture(), tls = await createTlsFixture(f.directory), host = await f.start(true, tls)
    const flags = ['--endpoint', host.service.url, '--token-file', f.tokenFile, '--ca-file', tls.cert, '--instance-id', host.service.instanceId]
    const prepared = await cli('approvals', 'notify', 'prepare', f.run.id, '--revision', f.pin.revision,
      '--attempt', f.pin.attemptId, '--destination', 'review', ...flags)
    expect(prepared.exit).toBe(0)
    const { event: _event, delivery: _delivery, ...pins } = prepared.result, request = { ...pins, requestId: randomUUID() }
    const file = join(f.directory, 'request.json'); await writeFile(file, JSON.stringify(request))
    expect((await cli('approvals', 'notify', 'send', file, ...flags)).exit).toBe(0)
    expect(f.readRows()[0].actor).toBe('PRIVATE_HOST_ACTOR')
    expect((await cli('approvals', 'notify', 'send', file, ...flags, '--notifications-file', f.configFile)).exit).toBe(2)
    expect((await cli('approvals', 'notify', 'show', request.requestId, ...flags)).result.request).toEqual(request)
    const listed = await cli('approvals', 'notify', 'list', '--page', ...flags)
    expect(listed.exit).toBe(0); expect(listed.result.deliveries[0].request).toEqual(request)
    expect(f.received).toHaveLength(1)
  })

  it.each(['permissions', 'symlink', 'malformed', 'oversize', 'secret-field'])('refuses %s configuration before opening state', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-notification-config-')), file = join(directory, 'config.json'), state = join(directory, 'absent')
    await writeFile(file, mode === 'malformed' ? '{PRIVATE_BAD' : mode === 'oversize' ? ' '.repeat(100001)
      : mode === 'secret-field' ? '{"signingKey":"PRIVATE"}' : '{}', { mode: 0o600 })
    let selected = file
    if (mode === 'permissions') await chmod(file, 0o644)
    if (mode === 'symlink') { selected = join(directory, 'link'); await symlink(file, selected) }
    const result = await cli('approvals', 'notify', 'destinations', '--notifications-file', selected, '--data-dir', state)
    expect(result.exit).toBe(1); expect(result.error.code).toBe('invalid-command')
    expect(JSON.stringify(result.error)).not.toMatch(/PRIVATE|config.json/)
    await expect(stat(state)).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('uses explicit PostgreSQL configuration and refuses selected-owner overrides without fallback', async () => {
    const file = '/missing-configuration-must-not-be-read'
    expect((await cli('approvals', 'notify', 'destinations', '--storage', 'postgres', '--database-file', file)).exit).toBe(1)
    for (const values of [{ runtime: 'docker' }, { endpoint: 'https://owner.example', 'token-file': file }])
      expect(() => operationSelection({ ...values, 'notifications-file': file })).toThrow()
    const target: any = { storage: 'postgres', runtime: { notificationDestinations: () => [] } }
    expect(await dispatchOperation(target, { operation: 'notifications.destinations' }, 'host')).toEqual({ schemaVersion: 1, destinations: [] })
    expect(operationCapabilities('postgres').approvalNotifications).toMatchObject({ available: true, scope: 'management-owner' })
    await expect(localRuntimeOptions({ 'notifications-file': true })).rejects.toHaveProperty('code', 'invalid-command')
  })

  it('keeps preview unavailable but permits explicitly configured exact-release notification routes without sending', async () => {
    const f = await fixture()
    await expect(startRuntimeService({ runtime: { dataDirectory: f.dataDirectory, notifications: f.notifications },
      token: f.token, actor: 'host', preview: { source: yaml } })).rejects.toHaveProperty('code', 'invalid-command')
    const owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory })
    let release
    try {
      const project = owner.editProject({ operation: 'create', title: 'Fixture', yaml, actor: 'host' })
      release = owner.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
        version: '1.0.0', actor: 'host', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
      const session = new ReleaseSession({ storage: 'sqlite', runtime: owner }, release.snapshot, 'host')
      expect(await session.operation({ operation: 'notifications.destinations', releaseSha256: release.sha256 })).toEqual({ schemaVersion: 1, destinations: [] })
      expect(await session.operation({ operation: 'notifications.list', page: {}, releaseSha256: release.sha256 })).toMatchObject({ deliveries: [], nextCursor: null })
      expect(session.capabilities().operations).toContain('notifications.send')
    } finally { await owner.close() }
    const service = await startRuntimeService({ runtime: { dataDirectory: f.dataDirectory, notifications: f.notifications },
      token: f.token, actor: 'host', release: { snapshot: release.snapshot } })
    await service.close()
    expect(f.received).toHaveLength(0)
  })
})
