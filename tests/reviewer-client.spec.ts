import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { ReviewerClient, RuntimeClient } from '../src/http/client.ts'
import { prepareGrantToken } from '../src/runtime/index.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const instanceId = randomUUID(), token = prepareGrantToken(randomUUID()).token
const request = { requestId: randomUUID(), action: 'approve' as const, pauseAfter: true }
const valid = () => ({ schemaVersion: 1, instanceId, result: { schemaVersion: 1, requestId: request.requestId,
  runId: randomUUID(), attemptId: randomUUID(), revision: 'a'.repeat(64), action: 'approve',
  at: '2026-10-03T00:00:00.000Z', pauseAfter: true, status: 'paused' } })

// This peer tests wire parsing only. It is deliberately not a workflow/grant authority fixture.
async function peer(reply: (req: IncomingMessage, res: ServerResponse) => void) {
  const calls: { path: string | undefined; method: string | undefined; headers: IncomingMessage['headers']; body: unknown }[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    calls.push({ path: req.url, method: req.method, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
    reply(req, res)
  })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => { server.off('error', no); yes() }) })
  cleanup.push(() => new Promise<void>((yes, no) => { server.close(error => error ? no(error) : yes()); server.closeAllConnections() }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture listener')
  const endpoint = `http://127.0.0.1:${address.port}`, client = new ReviewerClient(endpoint, token, instanceId, 2000)
  return { endpoint, client, calls }
}
const respond = (res: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Jevable-Protocol': PROTOCOL_VERSION, ...headers })
  res.end(JSON.stringify(value))
}

describe('reviewer client strict private-free wire contract (not workflow authority qualification)', () => {
  it('sends one exact pinned decision with bearer only in the header and no owner handshake', async () => {
    const value = valid(), f = await peer((_, res) => respond(res, value)), parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
    expect(await f.client.decide(request, parent)).toEqual(value)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({ path: '/v1/reviewer/decisions', method: 'POST', body: request,
      headers: { authorization: `Bearer ${token}`, 'x-jevable-instance': instanceId, 'x-jevable-protocol': PROTOCOL_VERSION, traceparent: parent } })
    expect(JSON.stringify(f.calls[0]!.body)).not.toContain(token)
    expect(f.client).not.toHaveProperty('operation'); expect(f.client).not.toHaveProperty('health')
  })
  it.each(['foreign-instance', 'foreign-request', 'changed-action', 'changed-pause', 'private-output', 'private-actor', 'unknown-status',
    'invalid-run', 'invalid-attempt', 'invalid-revision', 'invalid-time', 'unknown-wrapper', 'wrong-version'])('refuses %s response without exposing its private body', async damage => {
    const value: any = valid()
    if (damage === 'foreign-instance') value.instanceId = randomUUID()
    if (damage === 'foreign-request') value.result.requestId = randomUUID()
    if (damage === 'changed-action') value.result.action = 'reject'
    if (damage === 'changed-pause') value.result.pauseAfter = false
    if (damage === 'private-output') value.result.output = 'PRIVATE_RESPONSE'
    if (damage === 'private-actor') value.result.actor = 'PRIVATE_RESPONSE'
    if (damage === 'unknown-status') value.result.status = 'PRIVATE_RESPONSE'
    if (damage === 'invalid-run') value.result.runId = 'PRIVATE_RESPONSE'
    if (damage === 'invalid-attempt') value.result.attemptId = 'PRIVATE_RESPONSE'
    if (damage === 'invalid-revision') value.result.revision = 'PRIVATE_RESPONSE'
    if (damage === 'invalid-time') value.result.at = 'PRIVATE_RESPONSE'
    if (damage === 'unknown-wrapper') value.private = 'PRIVATE_RESPONSE'
    if (damage === 'wrong-version') value.schemaVersion = 2
    const f = await peer((_, res) => respond(res, value))
    await expect(f.client.decide(request)).rejects.toMatchObject({ code: 'invalid-response', message: expect.not.stringContaining('PRIVATE_RESPONSE') })
    expect(f.calls).toHaveLength(1)
  })
  it.each(['redirect', 'protocol', 'mime', 'encoding', 'invalid-utf8', 'oversized'])('refuses %s transport without redirecting or retrying', async damage => {
    const f = await peer((_, res) => {
      if (damage === 'redirect') return respond(res, {}, 307, { Location: 'http://127.0.0.1:9/' })
      if (damage === 'protocol') return respond(res, valid(), 200, { 'X-Jevable-Protocol': 'wrong' })
      if (damage === 'mime') return respond(res, valid(), 200, { 'Content-Type': 'text/html' })
      if (damage === 'encoding') return respond(res, valid(), 200, { 'Content-Encoding': 'gzip' })
      if (damage === 'oversized') return respond(res, { private: 'x'.repeat(17000) })
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION }); res.end(Buffer.from([0xff]))
    })
    const code = damage === 'redirect' ? 'redirect-refused' : damage === 'protocol' ? 'protocol-mismatch' : damage === 'oversized' ? 'response-limit' : 'invalid-response'
    await expect(f.client.decide(request)).rejects.toHaveProperty('code', code)
    expect(f.calls).toHaveLength(1)
  })
  it('reports a lost HTTP response as uncertain, keeps the retained request, and never retries itself', async () => {
    const f = await peer(req => req.socket.destroy())
    await expect(f.client.decide(request)).rejects.toHaveProperty('code', 'transport-uncertain')
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.body).toEqual(request)
  })
  it('refuses malformed targets, owner tokens and forged inputs before any wire request', async () => {
    const f = await peer((_, res) => respond(res, valid()))
    for (const endpoint of ['http://example.invalid:80', f.endpoint + '/private', f.endpoint + '?token=private', 'ftp://127.0.0.1:9'])
      expect(() => new ReviewerClient(endpoint, token, instanceId)).toThrow()
    expect(() => new ReviewerClient(f.endpoint, 'a'.repeat(64), instanceId)).toThrow()
    expect(() => new ReviewerClient(f.endpoint, token, 'not-a-uuid')).toThrow()
    expect(() => new RuntimeClient(f.endpoint, token)).toThrow()
    for (const field of ['runId', 'attemptId', 'actor', 'token', 'revision', 'scope'])
      await expect(f.client.decide({ ...request, [field]: 'forged' } as never)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.client.decide(request, 'invalid-parent')).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.calls).toHaveLength(0)
  })
})
