import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { CallerClient } from '../src/http/client.ts'
import { prepareGrantToken } from '../src/access/grants.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const token = prepareGrantToken(randomUUID()).token, instanceId = randomUUID(), id = randomUUID()
const pin = { id: randomUUID(), sha256: 'a'.repeat(64), revision: 'b'.repeat(64) }
const request = { input: 'private input', options: { id } }
const cancellation = { requestId: randomUUID() }
const control = { requestId: randomUUID(), expectedCheckpointSha256: 'c'.repeat(64), mode: 'step' as const }
const checkpointReceipt = () => ({ ...valid(), result: { ...valid().result, checkpointSha256: 'c'.repeat(64) } })
const controlReceipt = () => ({ ...checkpointReceipt(), result: { ...checkpointReceipt().result,
  requestId: control.requestId, mode: control.mode, requestedAt: '2026-10-03T00:00:00.000Z' } })
const cancellationReceipt = (status = 'cancelled') => ({ ...valid(), result: { ...valid().result, status,
  requestId: cancellation.requestId, requestedAt: '2026-10-03T00:00:00.000Z',
  externalEffects: 'not-reverted; unsettled attempts may have unknown outcomes' } })
const valid = () => ({ schemaVersion: 1, instanceId, result: { schemaVersion: 1, id, revision: pin.revision,
  release: { id: pin.id, sha256: pin.sha256 }, createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z', status: 'completed' } })
// Wire peer only, not authority/storage qualification.
async function peer(reply: (res: ServerResponse) => void) {
  const calls: any[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    calls.push({ path: req.url, method: req.method, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); reply(res)
  })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => { server.off('error', no); yes() }) })
  cleanups.push(() => new Promise<void>((yes, no) => { server.close(error => error ? no(error) : yes()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture listener')
  const endpoint = `http://127.0.0.1:${address.port}`
  return { calls, endpoint, client: new CallerClient(endpoint, token, instanceId, pin, 2000, 4096) }
}
function respond(res: ServerResponse, value: unknown, status = 200, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION, ...headers }); res.end(JSON.stringify(value))
}
describe('caller strict wire client (not workflow authority)', () => {
  it('sends canonical pinned checkpoint/control requests with no discovery, retry or owner handshake', async () => {
    let value: unknown = checkpointReceipt()
    const f = await peer(res => respond(res, value))
    expect(await f.client.checkpoint(id.toUpperCase())).toEqual(checkpointReceipt())
    expect(f.calls[0].body).toEqual({ operation: 'checkpoint', id, release: pin })
    value = controlReceipt()
    expect(await f.client.control(id.toUpperCase(), { ...control, requestId: control.requestId.toUpperCase() })).toEqual(controlReceipt())
    expect(f.calls[1].body).toEqual({ operation: 'control', id, release: pin, request: control })
    expect(f.calls).toHaveLength(2)
  })
  it.each(['checkpoint', 'control'] as const)('refuses strict %s receipt substitutions', async action => {
    const damages = ['instance', 'id', 'release', 'hash', 'revision', 'checkpoint', 'missing-checkpoint', 'output', 'input', 'actor', 'delegation', 'wrapper', 'updated-before',
      ...(action === 'control' ? ['request', 'missing-request', 'mode', 'requested-before', 'requested-after'] : ['request', 'mode'])]
    let value: any
    const f = await peer(res => respond(res, value))
    for (const damage of damages) {
      value = action === 'control' ? controlReceipt() : checkpointReceipt()
      if (damage === 'instance') value.instanceId = randomUUID()
      if (damage === 'id') value.result.id = randomUUID()
      if (damage === 'release') value.result.release.id = randomUUID()
      if (damage === 'hash') value.result.release.sha256 = 'd'.repeat(64)
      if (damage === 'revision') value.result.revision = 'd'.repeat(64)
      if (damage === 'checkpoint') value.result.checkpointSha256 = 'invalid'
      if (damage === 'missing-checkpoint') delete value.result.checkpointSha256
      if (['output', 'input', 'actor', 'delegation'].includes(damage)) value.result[damage] = 'PRIVATE_RESPONSE'
      if (damage === 'wrapper') value.private = 'PRIVATE_RESPONSE'
      if (damage === 'updated-before') value.result.updatedAt = '2026-10-02T00:00:00.000Z'
      if (damage === 'request') value.result.requestId = randomUUID()
      if (damage === 'missing-request') delete value.result.requestId
      if (damage === 'mode') value.result.mode = 'continue'
      if (damage === 'requested-before') value.result.requestedAt = '2026-10-02T00:00:00.000Z'
      if (damage === 'requested-after') value.result.requestedAt = '2026-10-04T00:00:00.000Z'
      await expect(action === 'control' ? f.client.control(id, control) : f.client.checkpoint(id)).rejects.toMatchObject({ code: 'invalid-response', message: expect.not.stringContaining('PRIVATE_RESPONSE') })
    }
    expect(f.calls).toHaveLength(damages.length)
  })
  it('refuses malformed, forged, cyclic or excessive control requests before wire I/O', async () => {
    const f = await peer(res => respond(res, controlReceipt())), cyclic: any = {}; cyclic.self = cyclic
    for (const value of [{}, { ...control, requestId: 'wrong' }, { ...control, mode: 'resume' }, { ...control, expectedCheckpointSha256: 'wrong' },
      { ...control, actor: 'forged' }, { ...control, delegation: {} }, { ...control, breakpoints: Array(129).fill('node') }, cyclic])
      await expect(f.client.control(id, value as never)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.client.control('invalid', control)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.client.control(id, control, 'invalid')).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.client.checkpoint('invalid')).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.client.checkpoint(id, 'invalid')).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.calls).toHaveLength(0)
  })
  it('reports lost control/checkpoint responses as uncertainty without retry', async () => {
    const f = await peer(res => res.socket!.destroy())
    await expect(f.client.control(id, control)).rejects.toHaveProperty('code', 'transport-uncertain')
    expect(f.calls).toHaveLength(1)
    await expect(f.client.checkpoint(id)).rejects.toHaveProperty('code', 'transport-uncertain')
    expect(f.calls).toHaveLength(2)
  })
  it.each(['cancelled', 'paused', 'waiting', 'executing'])('returns a strictly pinned %s cancellation receipt without discovery or retry', async status => {
    const f = await peer(res => respond(res, cancellationReceipt(status))), parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
    expect(await f.client.cancel(id, cancellation, parent)).toEqual(cancellationReceipt(status))
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({ path: '/v1/caller/operations', method: 'POST',
      body: { operation: 'cancel', release: pin, id, request: cancellation },
      headers: { authorization: `Bearer ${token}`, 'x-jevable-instance': instanceId, traceparent: parent } })
  })
  it.each(['request', 'missing-request', 'instance', 'id', 'release', 'hash', 'revision', 'output', 'input', 'actor', 'delegation',
    'effects', 'requested-before', 'requested-after', 'updated-before', 'wrapper', 'version'])('refuses damaged %s cancellation receipts', async damage => {
    const value: any = cancellationReceipt()
    if (damage === 'request') value.result.requestId = randomUUID()
    if (damage === 'missing-request') delete value.result.requestId
    if (damage === 'instance') value.instanceId = randomUUID()
    if (damage === 'id') value.result.id = randomUUID()
    if (damage === 'release') value.result.release.id = randomUUID()
    if (damage === 'hash') value.result.release.sha256 = 'c'.repeat(64)
    if (damage === 'revision') value.result.revision = 'c'.repeat(64)
    if (['output', 'input', 'actor', 'delegation'].includes(damage)) value.result[damage] = 'PRIVATE_RESPONSE'
    if (damage === 'effects') value.result.externalEffects = 'rolled back'
    if (damage === 'requested-before') value.result.requestedAt = '2026-10-02T00:00:00.000Z'
    if (damage === 'requested-after') value.result.requestedAt = '2026-10-04T00:00:00.000Z'
    if (damage === 'updated-before') value.result.updatedAt = '2026-10-02T00:00:00.000Z'
    if (damage === 'wrapper') value.private = 'PRIVATE_RESPONSE'
    if (damage === 'version') value.schemaVersion = 2
    const f = await peer(res => respond(res, value))
    await expect(f.client.cancel(id, cancellation)).rejects.toMatchObject({ code: 'invalid-response', message: expect.not.stringContaining('PRIVATE_RESPONSE') })
    expect(f.calls).toHaveLength(1)
  })
  it('refuses malformed, unbounded and forged cancellation requests before wire I/O', async () => {
    const f = await peer(res => respond(res, cancellationReceipt())), cyclic: any = {}; cyclic.self = cyclic
    for (const value of [{}, { requestId: 'invalid' }, { ...cancellation, actor: 'forged' }, { ...cancellation, delegation: {} },
      { ...cancellation, input: 'x'.repeat(5000) }, cyclic])
      await expect(f.client.cancel(id, value as never)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.client.cancel('invalid', cancellation)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.client.cancel(id, cancellation, 'invalid')).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.calls).toHaveLength(0)
  })
  it('uses one pinned request and only header bearer; no owner handshake or retries', async () => {
    const f = await peer(res => respond(res, valid())), parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
    expect(await f.client.start(request, parent)).toEqual(valid())
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({ path: '/v1/caller/operations', method: 'POST', body: { operation: 'start', release: pin, ...request },
      headers: { authorization: `Bearer ${token}`, 'x-jevable-instance': instanceId, traceparent: parent } })
    expect(JSON.stringify(f.calls[0].body)).not.toContain(token)
  })
  it.each(['instance', 'id', 'release', 'hash', 'revision', 'output', 'private', 'status', 'time', 'wrapper', 'version'])('refuses damaged %s start response', async damage => {
    const value: any = valid()
    if (damage === 'instance') value.instanceId = randomUUID()
    if (damage === 'id') value.result.id = randomUUID()
    if (damage === 'release') value.result.release.id = randomUUID()
    if (damage === 'hash') value.result.release.sha256 = 'c'.repeat(64)
    if (damage === 'revision') value.result.revision = 'c'.repeat(64)
    if (damage === 'output') value.result.output = 'PRIVATE_RESPONSE'
    if (damage === 'private') value.result.actor = 'PRIVATE_RESPONSE'
    if (damage === 'status') value.result.status = 'PRIVATE_RESPONSE'
    if (damage === 'time') value.result.updatedAt = '2026-10-02T00:00:00.000Z'
    if (damage === 'wrapper') value.private = 'PRIVATE_RESPONSE'
    if (damage === 'version') value.result.schemaVersion = 2
    const f = await peer(res => respond(res, value))
    await expect(f.client.start(request)).rejects.toMatchObject({ code: 'invalid-response', message: expect.not.stringContaining('PRIVATE_RESPONSE') })
    expect(f.calls).toHaveLength(1)
  })
  it('admits completed read output, but refuses absent completed output or output before completion', async () => {
    const value: any = valid(); value.result.output = { public: 'result' }
    const f = await peer(res => respond(res, value))
    expect((await f.client.read(id)).result).toHaveProperty('output', value.result.output)
    value.result.status = 'paused'
    await expect(f.client.read(id)).rejects.toHaveProperty('code', 'invalid-response')
    delete value.result.output
    expect((await f.client.read(id)).result.status).toBe('paused')
    value.result.status = 'completed'
    await expect(f.client.read(id)).rejects.toHaveProperty('code', 'invalid-response')
  })
  it('refuses cycles, excessive depth, forged fields and parents before any wire request', async () => {
    const f = await peer(res => respond(res, valid())), cycle: any = {}; cycle.self = cycle
    let deep: any = {}; for (let i = 0; i < 70; i++) deep = { child: deep }
    for (const input of [cycle, deep]) await expect(f.client.start({ ...request, input })).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.client.start({ ...request, actor: 'forged' } as never)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.client.start(request, 'invalid')).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.client.read('invalid')).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.calls).toHaveLength(0)
  })
  it.each(['redirect', 'protocol', 'mime', 'encoding', 'bytes', 'lost'])('refuses %s without redirecting or retrying', async damage => {
    const f = await peer(res => {
      if (damage === 'lost') { res.socket!.destroy(); return }
      respond(res, damage === 'bytes' ? { data: 'x'.repeat(4200) } : valid(), damage === 'redirect' ? 307 : 200,
        damage === 'redirect' ? { Location: 'http://127.0.0.1:9' } : damage === 'protocol' ? { 'X-Jevable-Protocol': 'wrong' }
          : damage === 'mime' ? { 'Content-Type': 'text/html' } : damage === 'encoding' ? { 'Content-Encoding': 'gzip' } : {})
    })
    const code = damage === 'lost' ? 'transport-uncertain' : damage === 'redirect' ? 'redirect-refused' : damage === 'protocol' ? 'protocol-mismatch'
      : damage === 'bytes' ? 'response-limit' : 'invalid-response'
    await expect(f.client.start(request)).rejects.toHaveProperty('code', code)
    expect(f.calls).toHaveLength(1)
    await expect(f.client.cancel(id, cancellation)).rejects.toHaveProperty('code', code)
    expect(f.calls).toHaveLength(2)
  })
  it('times out one cancellation wait without issuing a second request', async () => {
    const f = await peer(() => {})
    const client = new CallerClient(f.endpoint, token, instanceId, pin, 30)
    await expect(client.cancel(id, cancellation)).rejects.toHaveProperty('code', 'request-timeout')
    expect(f.calls).toHaveLength(1)
  })
})
