import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { discoverConfiguredModels } from '../src/providers/discovery.ts'
import { type ProviderConnectionRecord } from '../src/providers/config.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RuntimeClient, startRuntimeService } from '../src/http/index.ts'
import { main } from '../src/cli.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const record = (endpoint = 'http://127.0.0.1:1/v1'): ProviderConnectionRecord => ({ generation: 1, updatedAt: new Date().toISOString(),
  connection: { id: 'fixture', provider: 'fixture', protocol: 'openai-compatible', endpoint, allowedModels: ['approved'],
    authentication: { kind: 'bearer', credentialRef: 'fixture/key' }, tokenParameter: 'max_tokens',
    maxRequestBytes: 10000, maxResponseBytes: 100000, maxStreamEvents: 100, maxTimeoutSeconds: 1, tracePropagation: 'w3c' } })
const store = (route = record(), signal?: AbortSignal) => ({ connection: vi.fn(async () => route),
  credential: vi.fn(async () => 'fixture-private-key'), ...(signal ? { signal } : {}) })
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const list = { object: 'list', data: [{ id: 'unapproved', owned_by: 'private-extra' }, { id: 'approved' }] }
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const requests: IncomingMessage[] = [], server = createServer((request, response) => { requests.push(request); handler(request, response) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Expected private listener')
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, requests }
}
describe('explicit standalone provider discovery', () => {
  it('snapshots configuration, sorts advisory IDs, discards extras and sends no execution headers', async () => {
    const s = store(), fetcher = vi.fn(async () => reply(list)); vi.stubGlobal('fetch', fetcher)
    const result = await discoverConfiguredModels(s, 'fixture')
    expect(result).toMatchObject({ connection: { id: 'fixture', generation: 1, provider: 'fixture', protocol: 'openai-compatible' },
      models: [{ id: 'approved', allowed: true }, { id: 'unapproved', allowed: false }], permissions: 'unchanged' })
    expect(JSON.stringify(result)).not.toMatch(/private-extra|fixture-private-key|credentialRef|endpoint/u)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]).toEqual(['http://127.0.0.1:1/v1/models', expect.objectContaining({ method: 'GET', redirect: 'manual',
      headers: { accept: 'application/json', authorization: 'Bearer fixture-private-key' } })])
  })
  it('allows a complete empty catalogue without inventing approved entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ data: [], has_more: false })))
    expect((await discoverConfiguredModels(store(), 'fixture')).models).toEqual([])
  })
  it.each([
    { data: [{ id: 'same' }, { id: 'same' }] }, { data: [{ id: ' padded' }] }, { data: [{ id: 'bad\nname' }] },
    { data: [{ id: '' }] }, { data: [{ id: 'a'.repeat(257) }] }, { data: [{ id: 1 }] },
    { data: [], has_more: true }, { object: 'wrong', data: [] }, { data: 'not-an-array' },
    { data: Array.from({ length: 1001 }, (_, n) => ({ id: String(n) })) },
  ])('refuses malformed or incomplete model list case %# without retry', async value => {
    const fetcher = vi.fn(async () => reply(value)); vi.stubGlobal('fetch', fetcher)
    await expect(discoverConfiguredModels(store(), 'fixture')).rejects.toMatchObject({ code: 'invalid-response' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([302, 401, 429, 503])('refuses HTTP %i without redirect or retry or response exposure', async status => {
    const fetcher = vi.fn(async () => new Response('private-error-body', { status, headers: { location: 'https://not-followed.invalid' } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(discoverConfiguredModels(store(), 'fixture')).rejects.toMatchObject({ code: 'http-error', message: 'Jevable provider operation failed: http-error.' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([
    () => new Response('<html>private</html>'),
    () => new Response('{bad-json', { headers: { 'content-type': 'application/json' } }),
    () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
  ])('refuses non-JSON/malformed/invalid-UTF8 replies', async make => {
    vi.stubGlobal('fetch', vi.fn(async () => make()))
    await expect(discoverConfiguredModels(store(), 'fixture')).rejects.toMatchObject({ code: 'invalid-response' })
  })
  it('bounds actual streamed bytes, not the advertised Content-Length', async () => {
    const s = store(); s.connection.mockResolvedValue({ ...record(), connection: { ...record().connection, maxResponseBytes: 1024 } })
    let cancelled = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1025)) }, cancel() { cancelled++ } }),
      { headers: { 'content-type': 'application/json', 'content-length': '1' } })))
    await expect(discoverConfiguredModels(s, 'fixture')).rejects.toMatchObject({ code: 'response-too-large' }); expect(cancelled).toBe(1)
  })
  it('preserves owner loss instead of reporting a retryable provider error', async () => {
    const owner = new AbortController(), failure = Object.assign(new Error('owner lost'), { code: 'ownership-lost' }), s = store(record(), owner.signal)
    vi.stubGlobal('fetch', vi.fn(async () => { owner.abort(failure); throw Error('private transport') }))
    await expect(discoverConfiguredModels(s, 'fixture')).rejects.toBe(failure)
  })
  it('caps a long connection timeout at 30 seconds including body reading', async () => {
    vi.useFakeTimers()
    const route = record(); route.connection.maxTimeoutSeconds = 3600
    let reached!: () => void; const started = new Promise<void>(r => { reached = r })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => new Response(new ReadableStream({
      start(controller) { options.signal!.addEventListener('abort', () => controller.error(Error('aborted'))); reached() },
    }), { headers: { 'content-type': 'application/json' } })))
    const work = discoverConfiguredModels(store(route), 'fixture'), outcome = expect(work).rejects.toMatchObject({ code: 'timeout' })
    await started; await vi.advanceTimersByTimeAsync(30000); await outcome
  })
  it('uses a cloned observed route despite caller mutation during asynchronous credential lookup', async () => {
    const route = record(), s = store(route)
    s.credential.mockImplementation(async () => { route.connection.endpoint = 'https://not-contacted.invalid'; route.generation = 2; route.connection.allowedModels = ['unapproved']; return 'fixture-private-key' })
    const fetcher = vi.fn(async () => reply(list)); vi.stubGlobal('fetch', fetcher)
    const result = await discoverConfiguredModels(s, 'fixture')
    expect(result.connection.generation).toBe(1); expect(result.models[0]).toEqual({ id: 'approved', allowed: true })
    expect(fetcher.mock.calls[0]).toEqual(['http://127.0.0.1:1/v1/models', expect.any(Object)])
  })
  it('refuses unknown/unsupported/missing credentials before contacting any endpoint', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const missing = { connection: vi.fn(async () => undefined), credential: vi.fn(async () => undefined) }
    await expect(discoverConfiguredModels(missing, 'fixture')).rejects.toMatchObject({ code: 'missing-connection' })
    await expect(discoverConfiguredModels({ ...store(), credential: vi.fn(async () => undefined) }, 'fixture')).rejects.toMatchObject({ code: 'missing-credential' })
    const { tokenParameter: _token, maxStreamEvents: _stream, ...fields } = record().connection as Extract<ProviderConnectionRecord['connection'], { protocol: 'openai-compatible' }>
    const native: ProviderConnectionRecord = { ...record(), connection: { ...fields, provider: 'jev', protocol: 'systemone' } }
    await expect(discoverConfiguredModels(store(native), 'fixture')).rejects.toMatchObject({ code: 'unsupported-settings' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects malformed IDs and option overrides before storage or transport', async () => {
    const s = store(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    for (const id of ['../fixture', ' bad', '']) await expect(discoverConfiguredModels(s, id)).rejects.toMatchObject({ code: 'invalid-config' })
    await expect(discoverConfiguredModels(s, 'fixture', { endpoint: 'https://not-contacted.invalid' } as any)).rejects.toMatchObject({ code: 'invalid-config' })
    await expect(discoverConfiguredModels(s, 'fixture', { signal: {} } as any)).rejects.toMatchObject({ code: 'invalid-config' })
    expect(s.connection).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it('refuses a pre-aborted signal without reading credentials', async () => {
    const signal = AbortSignal.abort(), s = store()
    await expect(discoverConfiguredModels(s, 'fixture', { signal })).rejects.toMatchObject({ code: 'cancelled' })
    expect(s.connection).not.toHaveBeenCalled(); expect(s.credential).not.toHaveBeenCalled()
  })
  it('has no bearer header or credential read for explicit unauthenticated routes', async () => {
    const r = record(); r.connection.authentication = { kind: 'none' }
    const s = store(r), fetcher = vi.fn(async () => reply(list)); vi.stubGlobal('fetch', fetcher)
    await discoverConfiguredModels(s, 'fixture')
    expect(s.credential).not.toHaveBeenCalled()
    expect(fetcher.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ headers: { accept: 'application/json' } })])
  })
  it('holds owner guards through actual body reading and cancellation without changing durable state', async () => {
    let reached!: () => void; const started = new Promise<void>(r => { reached = r })
    const f = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"data":['); reached() })
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-discovery-')), runtime = await LocalRuntime.open({ dataDirectory })
    cleanup.push(() => runtime.close()); runtime.configureConnection(record(f.endpoint).connection, 0, 'local:test')
    runtime.setCredential('fixture/key', 'fixture-private-key', 0, 'local:test')
    const audit = runtime.providerAudit(), controller = new AbortController(), work = runtime.discoverModels('fixture', { signal: controller.signal })
    await started
    expect(() => runtime.configureConnection(record(f.endpoint).connection, 1, 'local:test')).toThrowError(/busy/u)
    expect(() => runtime.setCredential('fixture/key', 'changed', 1, 'local:test')).toThrowError(/busy/u)
    await expect(runtime.close()).rejects.toMatchObject({ code: 'busy' })
    controller.abort(); await expect(work).rejects.toMatchObject({ code: 'cancelled' })
    expect(runtime.providerAudit()).toEqual(audit); expect(runtime.list()).toEqual([])
    const db = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM model_calls').get()).toEqual({ n: 0 }) } finally { db.close() }
    expect(f.requests).toHaveLength(1)
  })
  it('expires an actual response-body wait and never retries', async () => {
    const f = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"data":[') })
    await expect(discoverConfiguredModels(store(record(f.endpoint)), 'fixture')).rejects.toMatchObject({ code: 'timeout' })
    expect(f.requests).toHaveLength(1)
  })
  it('discovers explicitly through CLI and authenticated HTTP without changing the allowlist', async () => {
    const f = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(list)) })
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-discovery-cli-')), runtime = await LocalRuntime.open({ dataDirectory })
    runtime.configureConnection(record(f.endpoint).connection, 0, 'local:test'); runtime.setCredential('fixture/key', 'fixture-private-key', 0, 'local:test')
    await runtime.close()
    let out = '', err = ''
    expect(await main(['providers', 'discover', 'fixture', '--data-dir', dataDirectory], { out: x => { out += x }, err: x => { err += x } })).toBe(0)
    expect(err).toBe(''); expect(JSON.parse(out).models).toEqual([{ id: 'approved', allowed: true }, { id: 'unapproved', allowed: false }])
    const service = await startRuntimeService({ token: 'd'.repeat(64), actor: 'local:owner', runtime: { dataDirectory } })
    cleanup.push(() => service.close()); const client = new RuntimeClient(service.url, 'd'.repeat(64))
    expect(f.requests).toHaveLength(1)
    expect(await client.operation({ operation: 'providers.discover', id: 'fixture' })).toMatchObject({ result: { permissions: 'unchanged', models: [{ id: 'approved', allowed: true }, { id: 'unapproved', allowed: false }] } })
    await expect(client.operation({ operation: 'providers.discover', id: 'fixture', endpoint: f.endpoint } as any)).rejects.toMatchObject({ code: 'invalid-command' })
    expect(await client.operation({ operation: 'providers.list' })).toMatchObject({ result: { connections: [{ generation: 1, connection: { allowedModels: ['approved'] } }] } })
    expect(f.requests).toHaveLength(2)
    expect(f.requests.every(r => r.method === 'GET' && r.url === '/v1/models' && r.headers.authorization === 'Bearer fixture-private-key')).toBe(true)
  })
})
