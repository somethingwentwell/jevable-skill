import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, chmod, symlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { LocalRuntime, type ModelCalls } from '../src/runtime/index.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { RunStore } from '../src/runtime/store.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { SignedWebhookVerifier, SignedReleaseWebhookSession, releaseMessageRunId, WEBHOOK_LIMITS } from '../src/releases/index.ts'
import { startRuntimeService, AsyncRunClient } from '../src/http/index.ts'
import { startPostgresRuntimeService } from '../src/http/postgres.ts'
import { readReleaseWebhookFile } from '../src/http/webhook-options.ts'
import { runReleaseApp, type ReleaseBackend } from '../src/releases/app.ts'
import { main } from '../src/cli.ts'
import { httpObservationLedgerSchema } from '../src/telemetry/http-verification.ts'
import { observeHttpRequest } from '../src/telemetry/http.ts'
import { AsyncLocalStorage } from 'node:async_hooks'

const api = await readFile(new URL('../examples/api-echo.yaml', import.meta.url), 'utf8')
const manual = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = (await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')).replace('modes: [manual]', 'modes: [api]')
const key = 'whsec_' + Buffer.alloc(32, 9).toString('base64'), rotated = 'whsec_' + Buffer.alloc(32, 10).toString('base64')
const config = { source: 'orders/tenant-a', keys: [key] }
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })
const directory = () => mkdtemp(join(tmpdir(), 'jevable-signed-webhook-'))
const signed = (input: unknown = 'PRIVATE_INPUT', id = 'evt_001', offset = 0, signingKey = key) => {
  const timestamp = String(Math.floor(Date.now() / 1000) + offset), body = Buffer.from(JSON.stringify(input))
  const signature = 'v1,' + createHmac('sha256', Buffer.from(signingKey.slice(6), 'base64')).update(`${id}.${timestamp}.`).update(body).digest('base64')
  return { id, timestamp, signature, body }
}
async function releaseFor(source = api) {
  const runtime = await LocalRuntime.open({ dataDirectory: await directory() })
  try {
    const project = runtime.editProject({ operation: 'create', yaml: source, title: 'Webhook', actor: 'fixture:owner' })
    return runtime.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
      version: '1.0.0', actor: 'fixture:owner', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  } finally { await runtime.close() }
}
async function wire(source = api, models?: ModelCalls, enabled = true, rateLimits?: any) {
  const artifact = await releaseFor(source), dataDirectory = await directory(), token = randomBytes(32).toString('hex')
  const service = await startRuntimeService({ runtime: { dataDirectory, ...(models ? { models } : {}) }, token, actor: 'fixture:owner',
    release: { snapshot: artifact.snapshot }, asyncRuns: { maxConcurrentRuns: 1 }, ...(enabled ? { webhooks: config } : {}), ...(rateLimits ? { rateLimits } : {}) })
  cleanups.push(async () => { await service.close(); await service.closed })
  const pin = { id: artifact.snapshot.id, sha256: artifact.sha256, revision: artifact.snapshot.workflow.revision }
  const runId = (messageId = 'evt_001') => releaseMessageRunId({ release: pin, source: config.source, messageId })
  const owner = new AsyncRunClient(service.url, token, service.instanceId, { release: pin })
  const post = (value = signed(), headers: Record<string, string> = {}, path = '/v1/webhooks') => fetch(service.url + path, { method: 'POST',
    headers: { 'content-type': 'application/json', 'webhook-id': value.id, 'webhook-timestamp': value.timestamp,
      'webhook-signature': value.signature, ...headers }, body: value.body })
  return { service, pin, runId, owner, post, token, artifact, dataDirectory }
}

describe('bounded Standard Webhooks HMAC admission', () => {
  it('shares the static webhook route with the pure SDK evidence reader without admitting message-ID labels', () => {
    const ownerId = randomUUID(), id = randomUUID(), base = { schemaVersion: 1, ownerAttribute: 'service.instance.id',
      owners: [ownerId], clockDomain: 'shared-unix-milliseconds', settlements: [],
      intents: [{ id, ownerId, startedMs: 1, method: 'POST', route: '/v1/webhooks' }] }
    expect(httpObservationLedgerSchema.safeParse(base).success).toBe(true)
    expect(httpObservationLedgerSchema.safeParse({ ...base, intents: [{ ...base.intents[0], route: '/v1/webhooks/PRIVATE_MESSAGE' }] }).success).toBe(false)
    const attributes: any[] = [], span = { spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
      setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn() }
    const tracer = { startSpan: vi.fn((_name, options) => { attributes.push(options.attributes); return span }) }
    const settled = vi.fn(), observation = observeHttpRequest(tracer as any, new AsyncLocalStorage(), 'POST', '/v1/webhooks', settled)
    observation.run(undefined, () => {}); observation.end(202, true)
    expect(attributes).toEqual([{ 'http.request.method': 'POST', 'http.route': '/v1/webhooks' }])
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ 'http.route': '/v1/webhooks', 'http.response.status_code': 202 }),
      expect.any(Number), span.spanContext(), false)
  })
  it('verifies exact UTF-8 bytes before parsing and detaches the admitted input', () => {
    const verifier = new SignedWebhookVerifier(config), request = signed({ title: 'é PRIVATE' })
    const result = verifier.verify(request); request.body.fill(0)
    expect(result).toEqual({ messageId: 'evt_001', input: { title: 'é PRIVATE' } })
    verifier.close(); expect(() => verifier.verify(signed())).toThrow('closed')
  })
  it('pins an independently computed raw-body signature including newline and whitespace', () => {
    const timestamp = String(Math.floor(Date.now() / 1000)), body = Buffer.from(' { "a": 1 }\n')
    const signature = 'v1,' + createHmac('sha256', Buffer.alloc(32, 9)).update(Buffer.concat([Buffer.from(`evt_raw.${timestamp}.`), body])).digest('base64')
    const verifier = new SignedWebhookVerifier(config)
    expect(verifier.verify({ id: 'evt_raw', timestamp, signature, body }).input).toEqual({ a: 1 })
    expect(() => verifier.verify({ id: 'evt_raw', timestamp, signature, body: Buffer.from('{"a":1}') })).toThrow('webhook-unauthorized')
    verifier.close()
  })
  it('accepts bounded old/new signing keys and signatures without changing message identity', () => {
    const verifier = new SignedWebhookVerifier({ ...config, keys: [key, rotated] })
    const a = signed(), b = signed('PRIVATE_INPUT', 'evt_001', 0, rotated)
    expect(verifier.verify({ ...a, signature: a.signature + ' ' + b.signature })).toEqual(verifier.verify(b))
    const oldOnly = new SignedWebhookVerifier(config)
    expect(() => oldOnly.verify(b)).toThrow('webhook-unauthorized')
    verifier.close(); oldOnly.close()
  })
  it.each([
    { id: 'contains.dot' }, { id: 'has space' }, { id: 'x'.repeat(257) }, { id: 'é' },
    { timestamp: '01' }, { timestamp: '1.2' }, { timestamp: '-1' }, { timestamp: '999999999999999' },
    { signature: '' }, { signature: 'v1,invalid' }, { signature: 'v1a,' + 'a'.repeat(44) }, { extra: true },
  ])('refuses ambiguous or unsupported wire metadata without echoing it %#', mutation => {
    const verifier = new SignedWebhookVerifier(config)
    expect(() => verifier.verify({ ...signed(), ...mutation } as any)).toThrow('webhook-unauthorized'); verifier.close()
  })
  it.each([-301, 301])('refuses expired or future signed delivery %#', offset => {
    const verifier = new SignedWebhookVerifier(config)
    expect(() => verifier.verify(signed('PRIVATE_INPUT', 'evt_001', offset))).toThrow('webhook-unauthorized'); verifier.close()
  })
  it('bounds bodies/signature fanout and refuses noncanonical base64 and malformed authenticated JSON', () => {
    const verifier = new SignedWebhookVerifier(config), request = signed()
    expect(() => verifier.verify({ ...request, body: Buffer.alloc(WEBHOOK_LIMITS.bodyBytes + 1) })).toThrow('webhook-unauthorized')
    expect(() => verifier.verify({ ...request, signature: Array(9).fill(request.signature).join(' ') })).toThrow('webhook-unauthorized')
    const last = request.signature.at(-2)!, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const alias = request.signature.slice(0, -2) + alphabet[alphabet.indexOf(last) | 1] + '='
    expect(() => verifier.verify({ ...request, signature: alias })).toThrow('webhook-unauthorized')
    const body = Buffer.from('{'), signature = 'v1,' + createHmac('sha256', Buffer.alloc(32, 9)).update(`${request.id}.${request.timestamp}.`).update(body).digest('base64')
    expect(() => verifier.verify({ ...request, body, signature })).toThrow('invalid-command'); verifier.close()
  })
  it.each([{ ...config, extra: true }, { ...config, keys: [] }, { ...config, keys: [key, key] }, { ...config, source: ' invalid' },
    { ...config, keys: ['whsec_' + Buffer.alloc(23).toString('base64')] }, { ...config, keys: ['whsec_' + Buffer.alloc(65).toString('base64')] },
    { ...config, keys: ['raw-key'] }])('refuses unsafe startup key configuration %#', value => {
    expect(() => new SignedWebhookVerifier(value as any)).toThrow('invalid-command')
  })
  it('requires a private regular config file and keeps failures sanitized', async () => {
    const dir = await directory(), file = join(dir, 'keys.json')
    await writeFile(file, JSON.stringify(config), { mode: 0o600 })
    expect(await readReleaseWebhookFile(file)).toEqual(config)
    await symlink(file, join(dir, 'link'))
    await expect(readReleaseWebhookFile(join(dir, 'link'))).rejects.toThrow('invalid-command')
    await chmod(file, 0o644); await expect(readReleaseWebhookFile(file)).rejects.toThrow('invalid-command')
    expect(await readReleaseWebhookFile(undefined)).toBeUndefined()
  })
})

describe('owned signed release SDK and wire service', () => {
  it('admits the authenticated SDK event, preserves identity on rotation, and never automatically approves', async () => {
    const artifact = await releaseFor(approval), runtime = await LocalRuntime.open({ dataDirectory: await directory() })
    cleanups.push(() => runtime.close())
    const session = new SignedReleaseWebhookSession(runtime, artifact.snapshot, config)
    const request = signed({ message: 'PRIVATE_REVIEW' }), created = await session.start(request)
    expect((await created.completion).state.status).toBe('waiting')
    const events = await runtime.events(created.run.id); session.close()
    const next = new SignedReleaseWebhookSession(runtime, artifact.snapshot, { ...config, keys: [rotated] })
    const retained = await next.start(signed({ message: 'PRIVATE_REVIEW' }, request.id, 0, rotated))
    expect(retained.observation).toBe('retained'); expect(retained.run.id).toBe(created.run.id)
    expect(await runtime.events(created.run.id)).toEqual(events); next.close()
    await expect(session.start(request)).rejects.toThrow('closed')
  })
  it('rejects unsigned/changed bytes, exposes only metadata, and cannot authenticate owner APIs', async () => {
    const f = await wire(), request = signed()
    expect((await f.post({ ...request, body: Buffer.from('"changed"') })).status).toBe(401)
    expect((await f.post(request, { 'webhook-signature': '' })).status).toBe(401)
    const response = await f.post(request), receipt = await response.json()
    expect(response.status).toBe(202); expect(response.headers.get('location')).toBe('/v1/async-runs/' + f.runId())
    expect(receipt).toMatchObject({ observation: 'created', run: { id: f.runId(), release: { id: f.pin.id }, triggerMode: 'api' } })
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|whsec_|source|output|steps|completion/u)
    expect(await f.owner.show(f.runId())).toMatchObject({ run: { status: 'completed' } })
    const retained = await f.post(request)
    expect(retained.status).toBe(200); expect(await retained.json()).toMatchObject({ observation: 'retained' })
    expect((await f.post(signed('changed'))).status).toBe(409)
    expect((await f.post(request, {}, '/v1/operations')).status).toBe(401)
    expect((await fetch(f.service.url + '/v1/async-runs/' + f.runId())).status).toBe(401)
  })
  it('keeps intake disabled by default and refuses every mixed-authority/context header', async () => {
    const disabled = await wire(api, undefined, false)
    expect((await disabled.post()).status).toBe(401)
    const f = await wire()
    for (const header of ['authorization', 'traceparent', 'baggage', 'x-jevable-protocol', 'x-jevable-instance', 'x-jevable-release-sha256'])
      expect((await f.post(signed(), { [header]: 'PRIVATE_CONTEXT' })).status).toBe(400)
    expect((await f.post(signed(), { 'x-forwarded-for': '127.0.0.1' })).status).toBe(403)
    expect((await f.post(signed(), { origin: 'https://foreign.example' })).status).toBe(403)
    expect((await f.post(signed(), {}, '/v1/webhooks?key=PRIVATE')).status).toBe(400)
    await expect(f.owner.show(f.runId())).rejects.toHaveProperty('code', 'not-found')
  })
  it('refuses invalid startup and non-api graphs before SQLite or PostgreSQL ownership', async () => {
    const a = await releaseFor(manual), localOpen = vi.spyOn(LocalRuntime, 'open'), pgOpen = vi.spyOn(PostgresRuntime, 'open')
    const dataDirectory = join(await directory(), 'not-created')
    for (const patch of [{}, { release: { snapshot: a.snapshot }, asyncRuns: { maxConcurrentRuns: 1 } },
      { release: { snapshot: a.snapshot } }, { release: { snapshot: a.snapshot }, asyncRuns: { maxConcurrentRuns: 1 }, webhooks: { ...config, keys: [] } }]) {
      await expect(startRuntimeService({ runtime: { dataDirectory }, token: 'a'.repeat(64), actor: 'fixture', webhooks: config, ...patch } as any)).rejects.toThrow('invalid-command')
      await expect(startPostgresRuntimeService({ runtime: {} as any, token: 'a'.repeat(64), actor: 'fixture', webhooks: config, ...patch } as any)).rejects.toThrow('invalid-command')
    }
    expect(localOpen).not.toHaveBeenCalled(); expect(pgOpen).not.toHaveBeenCalled()
    await expect(readdir(dataDirectory)).rejects.toHaveProperty('code', 'ENOENT')
  })
  it('preserves a committed lost acknowledgement as a paused original run; same message never redispatches', async () => {
    const f = await wire(), original = RunStore.prototype.save
    const lost = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, ...args) {
      original.apply(this, args); if (args[1] === 'run-created') throw Error('PRIVATE_LOST_ACK')
    })
    const response = await f.post(); expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('PRIVATE_LOST_ACK'); lost.mockRestore()
    expect(await f.owner.show(f.runId())).toMatchObject({ run: { status: 'paused' } })
    expect(await (await f.post()).json()).toMatchObject({ observation: 'retained', run: { status: 'paused', id: f.runId() } })
    await f.service.close(); await f.service.closed
    const runtime = await LocalRuntime.open({ dataDirectory: f.dataDirectory })
    expect((await runtime.events(f.runId())).map(event => event.kind)).toEqual(['run-created']); await runtime.close()
  })
  it('shares pending/background capacity with owner async requests and drains after client response loss', async () => {
    const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(), admission = Promise.withResolvers<void>(), execution = Promise.withResolvers<void>()
    const models: ModelCalls = { async admit() { ready.resolve(); await admission.promise },
      execute: vi.fn(async () => { entered.resolve(); await execution.promise; return { output: 'PRIVATE_RESULT', usage: { tries: 1 } } }), async verify() {} }
    const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'signed-model', name: 'Signed model' },
      spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['api'] } },
        write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
          prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false }, historyScope: 'none', execution: { timeoutSeconds: 60, maxAttempts: 1 } } },
        end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } }, edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
    const f = await wire(source, models)
    cleanups.push(async () => { admission.resolve(); execution.resolve() })
    const value = signed(), request = httpRequest(f.service.url + '/v1/webhooks', { method: 'POST', headers: {
      'content-type': 'application/json', 'webhook-id': value.id, 'webhook-timestamp': value.timestamp, 'webhook-signature': value.signature } })
    const disconnected = new Promise<void>(resolve => request.once('close', resolve)); request.on('error', () => {})
    request.end(value.body); await ready.promise
    expect((await f.post(signed('PRIVATE_INPUT', 'evt_002'))).status).toBe(429)
    await expect(f.owner.start({ kind: 'release', id: randomUUID(), release: f.pin, input: 'PRIVATE_INPUT', triggerMode: 'api' }))
      .rejects.toHaveProperty('code', 'async-concurrency-limit')
    request.destroy(); await disconnected; admission.resolve(); await entered.promise
    expect((await f.service.close(5)).status).toBe('draining')
    execution.resolve(); await f.service.closed
    const runtime = await LocalRuntime.open({ dataDirectory: f.dataDirectory, models })
    expect((await runtime.show(f.runId())).state.status).toBe('completed'); expect(models.execute).toHaveBeenCalledTimes(1)
    const replacement = new SignedReleaseWebhookSession(runtime, f.artifact.snapshot, config)
    expect((await replacement.start(signed())).observation).toBe('retained'); expect(models.execute).toHaveBeenCalledTimes(1)
    replacement.close(); await runtime.close()
  })
  it('uses only ordinary rate credit; invalid signatures cannot debit authenticated credit', async () => {
    const f = await wire(api, undefined, true, { requests: { capacity: 1, refillTokens: 1, refillIntervalMs: 3600000 }, controls: { capacity: 4, refillTokens: 1, refillIntervalMs: 3600000 } })
    expect((await f.post({ ...signed(), signature: 'bad' })).status).toBe(401)
    expect((await f.post()).status).toBe(202)
    const refused = await f.post(signed('PRIVATE_INPUT', 'evt_002'))
    expect(refused.status).toBe(429); expect(await refused.json()).toMatchObject({ code: 'rate-limit', execution: 'not-dispatched' })
    expect(await f.owner.show(f.runId())).toMatchObject({ run: { status: 'completed' } })
  })
  it('refuses reuse of owner bearer bytes as signing material before storage ownership', async () => {
    const artifact = await releaseFor(), opened = vi.spyOn(LocalRuntime, 'open')
    await expect(startRuntimeService({ runtime: { dataDirectory: await directory() }, token: '09'.repeat(32), actor: 'fixture',
      release: { snapshot: artifact.snapshot }, asyncRuns: { maxConcurrentRuns: 1 }, webhooks: config })).rejects.toThrow('invalid-command')
    expect(opened).not.toHaveBeenCalled()
  })
  it('refuses duplicate signature headers, compressed bodies and declared oversized signed payloads without creation', async () => {
    const f = await wire(), value = signed()
    const duplicate = await new Promise<number>(resolve => {
      const request = httpRequest(f.service.url + '/v1/webhooks', { method: 'POST', headers: {
        'content-type': 'application/json', 'webhook-id': value.id, 'webhook-timestamp': value.timestamp,
        'webhook-signature': [value.signature, value.signature] } }, response => { response.resume(); resolve(response.statusCode!) })
      request.end(value.body)
    })
    expect(duplicate).toBe(400)
    expect((await f.post(value, { 'content-encoding': 'gzip' })).status).toBe(415)
    const oversized = signed('x'.repeat(WEBHOOK_LIMITS.bodyBytes))
    // Admission rejects its declared length before reading or authenticating.
    // Sending the entire body races Connection: close and can surface a client
    // reset rather than the expected 413 under load.
    const limit = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(f.service.url + '/v1/webhooks', { method: 'POST', headers: {
        'content-type': 'application/json', 'content-length': oversized.body.byteLength,
        'webhook-id': oversized.id, 'webhook-timestamp': oversized.timestamp,
        'webhook-signature': oversized.signature,
      } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)) })
      request.once('error', reject); request.end()
    })
    expect(limit).toBe(413)
    await expect(f.owner.show(f.runId())).rejects.toHaveProperty('code', 'not-found')
  })
  it('returns only waiting metadata to a producer and retains the original approval gate on redelivery', async () => {
    const f = await wire(approval), value = signed({ message: 'PRIVATE_REVIEW' })
    expect((await f.post(value)).status).toBe(202)
    expect(await f.owner.show(f.runId())).toMatchObject({ run: { status: 'waiting' } })
    const response = await f.post(value), body = await response.text()
    expect(response.status).toBe(200); expect(JSON.parse(body)).toMatchObject({ observation: 'retained', run: { status: 'waiting' } })
    expect(body).not.toMatch(/PRIVATE|attempt|action|input|output/u)
  })
  it('exposes CLI startup contracts without opening files or a service, and refuses unsupported managed Docker staging', async () => {
    let out = '', err = ''
    expect(await main(['help', 'runtime', 'serve', '--json'], { out: text => { out += text }, err: text => { err += text } })).toBe(0)
    const help = JSON.parse(out)
    expect(help.startupContracts).toEqual([expect.objectContaining({ id: 'release-webhooks', flag: 'webhooks-file',
      validation: 'structural-input-projection-only', references: ['references/webhooks.md'] })])
    expect(JSON.stringify(help)).not.toContain(key)
    const open = vi.spyOn(LocalRuntime, 'open')
    expect(await main(['runtime', 'serve', '--token-file', 'not-read', '--webhooks-file', 'not-read'], { out() {}, err() {} })).toBe(2)
    expect(open).not.toHaveBeenCalled()
    expect(await main(['runtime', 'start', '--runtime', 'docker', '--webhooks-file', 'not-read'], { out() {}, err() {} })).toBe(2)
  })
  it('reads exact-release app signing config before owner startup and refuses missing shared capacity', async () => {
    const artifact = await releaseFor(), dir = await directory(), file = join(dir, 'webhooks.json'), tokenFile = join(dir, 'token')
    await writeFile(file, JSON.stringify(config), { mode: 0o600 }); await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 })
    const serve = vi.fn(async () => { throw Error('fixture does not launch service') }), open = vi.fn()
    const backend: ReleaseBackend = { storage: 'sqlite', serve, open }
    const io = { out() {}, err() {} }
    expect(await runReleaseApp(backend, artifact.snapshot, ['serve', '--token-file', tokenFile, '--webhooks-file', file], dir, io)).toBe(2)
    expect(serve).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
    await expect(runReleaseApp(backend, artifact.snapshot, ['serve', '--token-file', tokenFile, '--webhooks-file', file, '--async-concurrency', '1'], dir, io))
      .rejects.toThrow('fixture does not launch service')
    expect(serve).toHaveBeenCalledWith(expect.anything(), dir, expect.objectContaining({ webhooks: config, asyncRuns: { maxConcurrentRuns: 1 } }))
    expect(open).not.toHaveBeenCalled()
  })
})
