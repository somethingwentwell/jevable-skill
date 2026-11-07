import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime, prepareGrantToken } from '../src/runtime/index.ts'
import { startRuntimeService, RuntimeClient, ReviewerClient } from '../src/http/index.ts'
import { main } from '../src/cli.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const source = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(enabled = true) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-reviewer-http-')), token = randomBytes(32).toString('hex')
  const owner = await LocalRuntime.open({ dataDirectory })
  const run = await owner.run(source, { message: 'PRIVATE_REVIEW_HTTP_INPUT' })
  if (run.state.status !== 'waiting') throw Error('expected reviewer wait')
  const prepared = prepareGrantToken(randomUUID())
  await owner.issueGrant({ id: prepared.id, tokenSha256: prepared.tokenSha256, actor: 'PRIVATE_ISSUER',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), scope: { kind: 'reviewer', runId: run.id, revision: run.revision,
      attemptId: run.state.attempt.id, decisions: ['approve', 'reject'] } })
  const before = await owner.events(run.id); await owner.close()
  const options = { runtime: { dataDirectory }, token, actor: 'owner:transport', reviewerDecisions: enabled }
  const service = await startRuntimeService(options)
  cleanup.push(async () => { await service.close(); await service.closed })
  const client = new RuntimeClient(service.url, token)
  const request = { requestId: randomUUID(), action: 'approve' as const, pauseAfter: true }
  const raw = (body: unknown = request, headers: Record<string, string> = {}, path = '/v1/reviewer/decisions', method = 'POST') =>
    fetch(service.url + path, { method, headers: { Authorization: `Bearer ${prepared.token}`, 'Content-Type': 'application/json',
      'X-Jevable-Protocol': PROTOCOL_VERSION, 'X-Jevable-Instance': service.instanceId, ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
  const inspect = async () => (await client.operation({ operation: 'runs.inspect', id: run.id }) as any).result
  return { dataDirectory, token, prepared, service, request, raw, inspect, before, run, client }
}

describe('opt-in management reviewer decision transport', () => {
  it('uses a separate reviewer client and protected-file CLI with no owner capability handshake', async () => {
    const f = await fixture(), client = new ReviewerClient(f.service.url, f.prepared.token, f.service.instanceId)
    expect(client).not.toHaveProperty('capabilities'); expect(client).not.toHaveProperty('operation')
    const first = await client.decide(f.request)
    const tokenFile = join(f.dataDirectory, 'reviewer.token'), requestFile = join(f.dataDirectory, 'decision.json')
    await writeFile(tokenFile, f.prepared.token + '\n', { mode: 0o600 })
    await writeFile(requestFile, JSON.stringify(f.request), { mode: 0o600 })
    let stdout = '', stderr = ''
    const before = await f.inspect()
    const code = await main(['reviewer', 'decide', requestFile, '--endpoint', f.service.url, '--instance-id', f.service.instanceId,
      '--token-file', tokenFile], { out: s => { stdout += s }, err: s => { stderr += s } })
    expect(code, stderr).toBe(0); expect(JSON.parse(stdout)).toEqual(first)
    expect(await f.inspect()).toEqual(before)
    expect(stdout + stderr).not.toContain(f.prepared.token)
    await expect(client.decide({ ...f.request, actor: 'forged' } as never)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(client.decide(f.request, 'forged')).rejects.toHaveProperty('code', 'invalid-command')
    expect(() => new RuntimeClient(f.service.url, f.prepared.token)).toThrow()
    expect(() => new ReviewerClient(f.service.url, f.token, f.service.instanceId)).toThrow()
    expect(() => client.pinInstance(randomUUID())).toThrow()
    await expect(new ReviewerClient(f.service.url, f.prepared.token, randomUUID()).decide(f.request)).rejects.toHaveProperty('code', 'instance-mismatch')
  })
  it('refuses mixed targets or malformed requests before opening secrets, state or an endpoint', async () => {
    const invoke = async (extra: string[], file = 'does-not-exist.json') => {
      let stderr = ''
      const code = await main(['reviewer', 'decide', file, '--endpoint', 'http://127.0.0.1:9', '--instance-id', randomUUID(),
        '--token-file', 'not-read.token', ...extra], { out: () => {}, err: s => { stderr += s } })
      expect(code).not.toBe(0); expect(stderr).not.toContain('not-read.token')
      expect(stderr).not.toContain('transport-uncertain')
    }
    for (const extra of [['--data-dir', 'not-created'], ['--runtime', 'docker'], ['--storage', 'postgres'], ['--ca-file', 'not-read.pem']]) await invoke(extra)
    const directory = await mkdtemp(join(tmpdir(), 'jevable-reviewer-invalid-')), file = join(directory, 'decision.json')
    await writeFile(file, JSON.stringify({ requestId: randomUUID(), action: 'approve', actor: 'forged' }))
    await invoke([], file)
  })
  it('bounds reviewer bodies independently of owner payloads and rejects proxy/browser context', async () => {
    const f = await fixture()
    expect((await f.raw({ ...f.request, padding: 'x'.repeat(4096) })).status).toBe(413)
    for (const headers of [{ Origin: 'https://unreviewed.invalid' }, { 'X-Forwarded-For': '127.0.0.1' }, { 'Sec-Fetch-Site': 'cross-site' }])
      expect((await f.raw(f.request, headers)).status).not.toBe(200)
    expect((await f.inspect()).run.state.status).toBe('waiting')
  })
  it('admits only grant-derived decisions and returns a private-free receipt; exact retry never writes or continues', async () => {
    const f = await fixture(), response = await f.raw(), value = await response.json()
    expect(response.status).toBe(200)
    expect(value).toMatchObject({ schemaVersion: 1, instanceId: f.service.instanceId, result: { requestId: f.request.requestId,
      runId: f.run.id, attemptId: f.run.state.status === 'waiting' ? f.run.state.attempt.id : undefined, status: 'paused' } })
    expect(Object.keys(value.result).sort()).toEqual(['schemaVersion', 'requestId', 'runId', 'attemptId', 'revision', 'action', 'at', 'pauseAfter', 'status'].sort())
    expect(JSON.stringify(value)).not.toContain('PRIVATE_'); expect(JSON.stringify(value)).not.toContain(f.prepared.id)
    const before = await f.inspect(), retry = await f.raw()
    expect(await retry.json()).toEqual(value); expect(await f.inspect()).toEqual(before)
    const inspection = before.run.state.steps.find((s: any) => s.nodeId === 'review').inspection.approval
    expect(inspection.actor).toBe(`grant:${f.prepared.id}`); expect(inspection.delegation.requestId).toBe(f.request.requestId)
  })
  it.each(['approve', 'reject'])('supports explicit %s without substituting the owner actor', async action => {
    const f = await fixture(), response = await f.raw({ ...f.request, action, pauseAfter: false })
    expect(response.status).toBe(200)
    expect((await response.json()).result).toMatchObject({ action, status: action === 'approve' ? 'completed' : 'failed' })
    expect(JSON.stringify(await f.inspect())).toContain(`grant:${f.prepared.id}`)
  })
  it('requires exact service-instance and protocol pins before a decision is admitted', async () => {
    const f = await fixture()
    for (const headers of [{ 'X-Jevable-Instance': '' }, { 'X-Jevable-Instance': randomUUID() }, { 'X-Jevable-Protocol': 'invalid' }]) {
      expect((await f.raw(f.request, headers)).status).not.toBe(200)
    }
    expect((await f.inspect()).run.state.status).toBe('waiting')
    expect((await f.raw({}, {}, '/v1/reviewer/decisions', 'GET')).status).toBe(405)
  })
  it('refuses owner/unissued tokens and target, actor, scope and credential overrides with unchanged evidence', async () => {
    const f = await fixture()
    expect((await f.raw(f.request, { Authorization: `Bearer ${f.token}` })).status).toBe(401)
    expect((await f.raw(f.request, { Authorization: `Bearer ${prepareGrantToken(randomUUID()).token}` })).status).toBe(404)
    for (const key of ['runId', 'attemptId', 'revision', 'actor', 'scope', 'token', 'authorization']) {
      expect((await f.raw({ ...f.request, [key]: 'forged' })).status).toBe(400)
    }
    expect((await f.inspect()).run.state.status).toBe('waiting')
    for (const path of ['/v1/operations', '/v1/health', '/v1/capabilities', '/v1/preview/operations'])
      expect((await f.raw({}, {}, path, path === '/v1/health' || path === '/v1/capabilities' ? 'GET' : 'POST')).status).toBe(401)
  })
  it('is disabled by default and cannot be used to obtain capability or owner access', async () => {
    const f = await fixture(false)
    expect((await f.raw()).status).not.toBe(200)
    const caps = await f.client.capabilities() as any
    expect(caps.api.endpoints).not.toContain('/v1/reviewer/decisions')
    expect((await f.inspect()).run.state.status).toBe('waiting')
  })
  it('advertises an enabled metadata-only endpoint to the owner without changing owner operation admission', async () => {
    const f = await fixture(), caps = await f.client.capabilities() as any
    expect(caps.api.endpoints).toContain('/v1/reviewer/decisions')
    expect((await f.raw({ operation: 'runs.list' })).status).toBe(400)
  })
})
