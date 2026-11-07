import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { AsyncRunClient } from '../src/http/index.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const token = 'a'.repeat(64), instanceId = randomUUID(), id = randomUUID()
const pin = { id: randomUUID(), sha256: 'b'.repeat(64), revision: 'c'.repeat(64) }
const project = { id: randomUUID(), generation: 3, revision: pin.revision }
const request = { kind: 'workflow' as const, id, yaml: 'reviewed source', input: 'PRIVATE_INPUT' }
function receipt(observation = 'created') {
  return { format: 'jevable.ai/async-run', schemaVersion: 1, instanceId, observation,
    run: { id, revision: pin.revision, status: 'paused', createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z' } }
}
function respond(res: ServerResponse, value: unknown, status = 202, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION,
    ...(status === 202 ? { Location: '/v1/async-runs/' + id } : {}), ...headers }); res.end(JSON.stringify(value))
}
// Deliberately a wire peer, not a workflow runtime or evidence of durable creation.
async function peer(reply: (res: ServerResponse) => void) {
  const calls: any[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    calls.push({ path: req.url, method: req.method, headers: req.headers,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined }); reply(res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture address')
  const endpoint = `http://127.0.0.1:${address.port}`
  return { calls, endpoint, client: new AsyncRunClient(endpoint, token, instanceId, { timeoutMs: 1000, maxResponseBytes: 4096 }) }
}

describe('strict owner async wire client', () => {
  it('submits once with the explicit instance and parent; reads only metadata without discovery or automatic polling', async () => {
    let read = false
    const f = await peer(res => respond(res, receipt(read ? 'read' : 'created'), read ? 200 : 202))
    const parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
    expect(await f.client.start(request, parent)).toEqual(receipt())
    read = true; expect(await f.client.show(id)).toEqual(receipt('read'))
    expect(f.calls).toHaveLength(2)
    expect(f.calls[0]).toMatchObject({ path: '/v1/async-runs', method: 'POST', body: request,
      headers: { authorization: `Bearer ${token}`, 'x-jevable-instance': instanceId, traceparent: parent } })
    expect(f.calls[1]).toMatchObject({ path: '/v1/async-runs/' + id, method: 'GET' })
    expect(f.calls[1].headers.traceparent).toBeUndefined(); expect(f.calls[1].body).toBeUndefined()
    expect(JSON.stringify(f.calls.map(call => call.body))).not.toContain(token)
  })

  it('accepts only 200 retained observations or 202 created receipts with their exact relative Location', async () => {
    let value: any = receipt('retained'), status = 200, location = '/v1/async-runs/' + id
    const f = await peer(res => respond(res, value, status, { Location: location }))
    expect(await f.client.start(request)).toEqual(value)
    for (const [code, observation] of [[200, 'created'], [202, 'retained'], [201, 'created'], [204, 'retained'], [202, 'read']] as const) {
      status = code; value = receipt(observation)
      await expect(f.client.start(request)).rejects.toHaveProperty('code', 'invalid-response')
    }
    status = 202; value = receipt()
    for (const wrong of ['https://foreign.example/v1/async-runs/' + id, '/v1/async-runs/' + randomUUID(), '/v1/async-runs/' + id + '?token=PRIVATE']) {
      location = wrong; await expect(f.client.start(request)).rejects.toHaveProperty('code', 'invalid-response')
    }
    expect(f.calls).toHaveLength(9)
  })

  it.each(['instance', 'id', 'wrapper', 'input', 'output', 'source', 'completion', 'actor', 'test', 'project', 'release',
    'status', 'time', 'version', 'trigger', 'paused'])('refuses damaged %s receipts without exposing their private values', async damage => {
    const value: any = receipt()
    if (damage === 'instance') value.instanceId = randomUUID()
    if (damage === 'id') value.run.id = randomUUID()
    if (damage === 'wrapper') value.extra = 'PRIVATE_RESPONSE'
    if (['input', 'output', 'source', 'completion', 'actor'].includes(damage)) value.run[damage] = 'PRIVATE_RESPONSE'
    if (damage === 'test') value.run.test = { id: randomUUID(), generation: 1, sha256: pin.sha256 }
    if (damage === 'project') value.run.project = { id: project.id, generation: 3 }
    if (damage === 'release') value.run.release = { id: pin.id, sha256: pin.sha256 }
    if (damage === 'status') value.run.status = 'PRIVATE_RESPONSE'
    if (damage === 'time') value.run.updatedAt = '2026-10-05T00:00:00.000Z'
    if (damage === 'version') value.schemaVersion = 2
    if (damage === 'trigger') value.run.triggerMode = 'api'
    if (damage === 'paused') value.run.startedPaused = true
    const f = await peer(res => respond(res, value))
    await expect(f.client.start(request)).rejects.toMatchObject({ code: 'invalid-response', message: expect.not.stringContaining('PRIVATE_RESPONSE') })
    expect(f.calls).toHaveLength(1)
  })

  it('refuses absent and duplicate Location headers', async () => {
    const missing = await peer(res => respond(res, receipt(), 200))
    await expect(missing.client.start(request)).rejects.toHaveProperty('code', 'invalid-response')
    const duplicate = await peer(res => respond(res, receipt(), 202, { Location: ['/v1/async-runs/' + id, '/v1/async-runs/' + id] }))
    await expect(duplicate.client.start(request)).rejects.toHaveProperty('code', 'invalid-response')
  })

  it('checks project generation/revision and original paused/API policy rather than trusting syntactically valid metadata', async () => {
    let value: any = receipt(); value.run.project = { id: project.id, generation: 3 }
    value.run.startedPaused = true; value.run.triggerMode = 'api'
    const f = await peer(res => respond(res, value))
    const command = { kind: 'project' as const, id, project, input: {}, paused: true, triggerMode: 'api' as const }
    expect(await f.client.start(command)).toEqual(value)
    value.run.project.generation = 4; await expect(f.client.start(command)).rejects.toHaveProperty('code', 'invalid-response')
    value.run.project.generation = 3; value.run.revision = 'd'.repeat(64)
    await expect(f.client.start(command)).rejects.toHaveProperty('code', 'invalid-response')
  })

  it('retains an owned exact-release pin, sends its hash for reads and rejects foreign admission before I/O', async () => {
    let value: any = receipt(), read = false; value.run.release = { id: pin.id, sha256: pin.sha256 }
    const f = await peer(res => respond(res, value, read ? 200 : 202)), ownedPin = { ...pin }
    const client = new AsyncRunClient(f.endpoint, token, instanceId, { release: ownedPin })
    ownedPin.sha256 = 'd'.repeat(64)
    const command = { kind: 'release' as const, id, input: {}, release: pin }
    expect(await client.start(command)).toEqual(value)
    read = true; value.observation = 'read'; expect(await client.show(id)).toEqual(value)
    expect(f.calls[1].headers['x-jevable-release-sha256']).toBe(pin.sha256)
    await expect(client.start(request)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(client.start({ ...command, release: ownedPin })).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.calls).toHaveLength(2)
    value.run.release.sha256 = 'd'.repeat(64)
    await expect(client.show(id)).rejects.toHaveProperty('code', 'invalid-response')
  })

  it('accepts UUID case differences from a backend but not a substituted run', async () => {
    const value = receipt()
    const f = await peer(res => respond(res, value))
    expect(await f.client.start({ ...request, id: id.toUpperCase() })).toEqual(value)
    expect(f.calls[0].body.id).toBe(id.toUpperCase())
  })

  it('rejects malformed, widened, cyclic and excessive commands before I/O', async () => {
    const f = await peer(res => respond(res, receipt())), cyclic: any = {}; cyclic.self = cyclic
    for (const value of [{}, { ...request, id: 'invalid' }, { ...request, actor: 'forged' }, { ...request, input: cyclic },
      { ...request, input: 'x'.repeat(4_000_001) }, { ...request, paused: 'true' }, { ...request, triggerMode: 'manual' }])
      await expect(f.client.start(value as never)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.client.start(request, 'invalid')).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.client.show('../health')).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.calls).toHaveLength(0)
  })

  it('refuses mismatched status/read contracts and private status payloads', async () => {
    let value: any = receipt(), status = 200
    const f = await peer(res => respond(res, value, status))
    await expect(f.client.show(id)).rejects.toHaveProperty('code', 'invalid-response')
    value.observation = 'read'; status = 202
    await expect(f.client.show(id)).rejects.toHaveProperty('code', 'invalid-response')
    status = 200; value.run.output = 'PRIVATE_RESPONSE'
    await expect(f.client.show(id)).rejects.toHaveProperty('code', 'invalid-response')
  })

  it('never retries transport loss, timeout, server refusal or redirects', async () => {
    const lost = await peer(res => res.socket!.destroy())
    await expect(lost.client.start(request)).rejects.toHaveProperty('code', 'transport-uncertain')
    expect(lost.calls).toHaveLength(1)
    const slow = await peer(() => {})
    const client = new AsyncRunClient(slow.endpoint, token, instanceId, { timeoutMs: 25 })
    await expect(client.start(request)).rejects.toHaveProperty('code', 'request-timeout'); expect(slow.calls).toHaveLength(1)
    const refused = await peer(res => respond(res, { code: 'conflict' }, 409))
    await expect(refused.client.start(request)).rejects.toMatchObject({ code: 'conflict', status: 409 }); expect(refused.calls).toHaveLength(1)
    const redirect = await peer(res => respond(res, {}, 307, { Location: lost.endpoint }))
    await expect(redirect.client.start(request)).rejects.toHaveProperty('code', 'redirect-refused'); expect(redirect.calls).toHaveLength(1)
    expect(lost.calls).toHaveLength(1)
  })

  it('requires owner authentication, known instance and strict bounded client settings', async () => {
    const endpoint = 'http://127.0.0.1:12345'
    for (const options of [null, [], { extra: true }, { timeoutMs: 0 }, { timeoutMs: null }, { maxResponseBytes: null },
      { maxResponseBytes: 1 }, { release: {} }, { ca: 'bad' }])
      expect(() => new AsyncRunClient(endpoint, token, instanceId, options as never)).toThrow()
    expect(() => new AsyncRunClient(endpoint, 'grant-secret', instanceId)).toThrow()
    expect(() => new AsyncRunClient(endpoint, token, 'unknown')).toThrow()
    expect(() => new AsyncRunClient('http://remote.example:12345', token, instanceId)).toThrow()
  })
})
