import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { createServer } from 'node:http'
import { traceNavigationTools, type TraceViewerConfig } from '../src/telemetry/navigation.ts'
import { prepareTraceNavigation } from '../src/preview/trace-navigation.ts'
import { prepareEvidenceDownload } from '../src/preview/evidence-download.ts'
import { liveTraceControls } from '../src/preview/trace-controls.ts'
import { LocalRuntime } from '../src/runtime/index.ts'
import { startRuntimeService } from '../src/http/service.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { main } from '../src/cli.ts'

const config: TraceViewerConfig = { schemaVersion: 1, origin: 'https://traces.example', pathTemplate: '/jaeger/trace/{traceId}', spanParameter: 'spanID' }
const expected = { runId: randomUUID(), revision: 'a'.repeat(64) }, attemptId = randomUUID(), tryId = randomUUID()
const trace = { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 0 as const }
const tools = traceNavigationTools()
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function evidence(version = 1) {
  const snapshot: any = { schemaVersion: version, format: 'jevable.ai/run-evidence', run: { id: expected.runId, revision: expected.revision, status: 'waiting',
    traceSegments: [{ operation: 'run', trace, parent: { ...trace, spanId: '3'.repeat(16) } }], attempt: { id: attemptId, nodeId: 'gate', trace } },
    steps: [{ index: 0, nodeId: '<private-node>', attemptId, scope: { loop: 'loop', index: 2 }, trace }],
    journal: [{ sequence: version === 2 ? '9007199254740993' : 1, kind: 'node-intent', nodeId: 'node', attemptId, trace }],
    models: { format: 'jevable.model-history/v1', source: 'configured-model-store', calls: [{ nodeId: 'model', attemptId, tries: [{ id: tryId, number: 1, trace }] }] },
    privacy: { payloads: 'excluded', actors: 'excluded', credentialStore: 'excluded' }, unknown: 'PRIVATE_SECRET_NOT_PROJECTED' }
  return { schemaVersion: version, snapshot, checksum: { algorithm: 'sha256', encoding: 'JSON.stringify(snapshot)',
    value: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') } }
}

describe('credential-free trace route configuration', () => {
  it.each(['https://traces.example', 'https://traces.example/', 'http://127.0.0.1:16686', 'http://[::1]:16686'])('accepts explicit origin %s and clones configuration', origin => {
    const source = { ...config, origin }, result = tools.config(source); source.pathTemplate = '/changed/{traceId}'
    if (result.schemaVersion !== 1) throw Error('Expected legacy viewer')
    expect(result.origin).toBe(new URL(origin).origin); expect(result.pathTemplate).toBe(config.pathTemplate)
  })
  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', 'http://remote.example', 'https://user:pass@traces.example',
    'https://@traces.example', 'https://traces.example?token=SECRET', 'https://traces.example#SECRET', 'https://traces.example/path',
    'https://traces.example\\@evil.example', 'https://traces.example\n', 'https:traces.example', 'https://tracés.example',
    'http://127.1:3000', 'http://2130706433:3000', 'http://0x7f000001:3000', 'http://0177.0.0.1:3000',
    'http://[0:0:0:0:0:0:0:1]:3000'])('refuses origin %s', origin => {
    expect(() => tools.config({ ...config, origin })).toThrow('Invalid trace viewer')
  })
  it.each(['//evil.example/{traceId}', '/trace/{traceId}?token=SECRET', '/trace/{traceId}#fragment', '/trace/{runId}',
    '/trace/{traceId}/{traceId}', '/a/../{traceId}', '/a/%2e%2e/{traceId}', '/trace/{traceId}/', '/trace//{traceId}', '/trace/{traceId}/<script>'])('refuses path %s', pathTemplate => {
    expect(() => tools.config({ ...config, pathTemplate })).toThrow()
  })
  it('rejects credential fields and arbitrary query values/keys', () => {
    for (const extra of [{ token: 'SECRET' }, { headers: {} }, { spanParameter: 'access_token' }, { query: { auth: 'SECRET' } }])
      expect(() => tools.config({ ...config, ...extra })).toThrow()
  })
})

describe('retained trace navigation admission', () => {
  it.each([1, 2])('projects cancellation admission and separate settlement causes in v%i without network or invented authority', version => {
    const snapshot = evidence(version).snapshot, requestId = randomUUID()
    snapshot.run.cancellation = { id: requestId, traceParent: trace }
    snapshot.run.traceSegments[0] = { operation: 'cancel', trace, cause: { kind: 'cancellation', requestId, parent: trace } }
    snapshot.journal = [{ sequence: version === 2 ? '9007199254740993' : 1, kind: 'cancellation-requested', requestId, traceParent: trace },
      { sequence: version === 2 ? '9007199254740994' : 2, kind: 'execution-segment', operation: 'cancel', trace,
        cause: { kind: 'cancellation', requestId, parent: trace } }]
    const expectedSources = ['cancellation-admission', 'segment-cause', 'journal-cancellation-admission', 'journal-cause']
    const projected = tools.project(snapshot, config)
    expect(projected.references.filter(ref => ref.requestId).map(ref => ref.source)).toEqual(expectedSources)
    for (const ref of projected.references.filter(ref => ref.requestId)) {
      expect(ref).toMatchObject({ ...trace, requestId }); expect(ref.url).not.toContain(requestId)
    }
    const serialized = runInNewContext(`(${traceNavigationTools.toString()})()`, { URL })
    expect(JSON.parse(JSON.stringify(serialized.project(snapshot, config)))).toEqual(projected)
    expect(projected.availability).toBe('delivery-unverified')
  })
  it.each(['kind', 'request', 'parent', 'flags', 'operation', 'missing-admission', 'journal-kind', 'authority'])(
    'refuses cancellation cause %s substitutions in the metadata projector', damage => {
      const snapshot = evidence().snapshot, requestId = randomUUID()
      snapshot.run.cancellation = { id: requestId, traceParent: trace }
      const cause = { kind: 'cancellation', requestId, parent: { ...trace } } as any
      snapshot.run.traceSegments[0] = { operation: 'cancel', trace, cause }
      if (damage === 'kind') cause.kind = 'approval'
      if (damage === 'request') cause.requestId = randomUUID()
      if (damage === 'parent') cause.parent.spanId = '4'.repeat(16)
      if (damage === 'flags') cause.parent.traceFlags = 1
      if (damage === 'operation') snapshot.run.traceSegments[0].operation = 'run'
      if (damage === 'missing-admission') delete snapshot.run.cancellation
      if (damage === 'journal-kind') snapshot.journal[0] = { sequence: 1, kind: 'run-created', requestId, traceParent: trace }
      if (damage === 'authority') cause.actor = 'owner:forged'
      expect(() => tools.project(snapshot)).toThrow()
    })
  it.each([1, 2])('links all supported metadata locations from verified v%i evidence, never payload fields', async version => {
    const source = evidence(version), result = await prepareTraceNavigation(expected, source, config)
    expect(result.references.map(ref => ref.source)).toEqual(['segment-trace', 'segment-parent', 'pending-attempt', 'settled-step', 'journal-trace', 'model-try'])
    expect(result.references[3]).toMatchObject({ nodeId: '<private-node>', loop: 'loop', iteration: 2, attemptId })
    expect(result.references[4]!.sequence).toBe(version === 2 ? '9007199254740993' : '1')
    expect(result.references[5]).toMatchObject({ tryId, index: 1, attemptId })
    for (const ref of result.references) {
      expect(ref.url).toBe(`${config.origin}/jaeger/trace/${ref.traceId}?spanID=${ref.spanId}`)
      expect(ref.url).not.toContain('private-node'); expect(ref.url).not.toContain(attemptId)
    }
    expect(result.availability).toBe('delivery-unverified'); expect(result.execution).toBe('not-started-or-resumed')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET_NOT_PROJECTED')
  })
  it('preserves unsampled IDs without invented URLs and distinguishes missing trace context', async () => {
    const result = await prepareTraceNavigation(expected, evidence())
    expect(result.destination).toBeNull(); expect(result.references.every(ref => ref.url === null && ref.traceFlags === 0)).toBe(true)
    const snapshot = evidence().snapshot; delete snapshot.run.traceSegments; delete snapshot.run.attempt
    snapshot.steps = []; snapshot.journal = []; delete snapshot.models
    expect(tools.project(snapshot, config)).toMatchObject({ availability: 'trace-context-not-recorded', references: [] })
  })
  it('verifies identity, privacy and checksums before projecting', async () => {
    const source = evidence(); source.snapshot.run.id = randomUUID()
    await expect(prepareTraceNavigation(expected, source, config)).rejects.toThrow()
    const privateData = evidence(); privateData.snapshot.private = {}
    await expect(prepareTraceNavigation(expected, privateData, config)).rejects.toThrow()
    const corrupt = evidence(); corrupt.checksum.value = '0'.repeat(64)
    await expect(prepareTraceNavigation(expected, corrupt, config)).rejects.toThrow()
  })
  it.each([{ traceId: '0'.repeat(32) }, { spanId: '0'.repeat(16) }, { traceFlags: 2 }, { traceId: 'x'.repeat(32) }])('refuses malformed trace metadata %j', extra => {
    const snapshot = evidence().snapshot; snapshot.steps[0].trace = { ...trace, ...extra }
    expect(() => tools.project(snapshot, config)).toThrow()
  })
  it('preserves failed attempts and rejects malformed scopes, event identities and oversized lists', () => {
    const snapshot = evidence().snapshot
    snapshot.run.status = 'failed'; snapshot.run.nodeId = 'bad'; snapshot.run.failedAttempt = { attemptId, trace }
    expect(tools.project(snapshot).references.find(ref => ref.source === 'failed-attempt')).toMatchObject({ nodeId: 'bad', attemptId })
    snapshot.steps[0].scope.index = -1; expect(() => tools.project(snapshot)).toThrow()
    snapshot.steps = []; snapshot.journal[0].sequence = Number.MAX_SAFE_INTEGER + 1; expect(() => tools.project(snapshot)).toThrow()
    snapshot.journal = []; snapshot.steps = Array(50001).fill({}); expect(() => tools.project(snapshot)).toThrow()
  })
})

class Element {
  hidden = false; disabled = false; textContent = ''; href = ''; target = ''; rel = ''; referrerPolicy = ''
  children: Element[] = []; listeners = new Map<string, () => void>()
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, fn) }
  append(child: Element) { this.children.push(child) }
  replaceChildren() { this.children = [] }
  click() { this.listeners.get('click')?.() }
}
function controllerFixture(request = vi.fn(async (): Promise<unknown> => evidence())) {
  const elements = new Map<string, Element>(), get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)! }
  let current: typeof expected | undefined = expected
  const controller = runInNewContext(`(${liveTraceControls.toString()})(ctx, (${traceNavigationTools.toString()})(), ${prepareEvidenceDownload.toString()})`, {
    ctx: { request, current: () => current, viewer: config }, document: { getElementById: get, createElement: () => new Element() },
    URL, TextEncoder, crypto: webcrypto,
  }) as ReturnType<typeof liveTraceControls>
  return { get, request, controller, select(value?: typeof expected) { current = value; controller.observe() } }
}
describe('serialized trace panel (not browser qualification)', () => {
  it('reads only on explicit load and creates credential-free inert links with referrer/opener isolation', async () => {
    const f = controllerFixture(); expect(f.request).not.toHaveBeenCalled()
    f.get('trace-load').click(); f.get('trace-load').click()
    await vi.waitFor(() => expect(f.get('trace-load').disabled).toBe(false))
    expect(f.request).toHaveBeenCalledExactlyOnceWith({ operation: 'evidence', id: expected.runId })
    const links = f.get('trace-references').children.flatMap(row => row.children).filter(child => child.href)
    expect(links).toHaveLength(6)
    expect(links.every(link => link.href.startsWith(config.origin) && link.target === '_blank' && link.rel === 'noopener noreferrer' && link.referrerPolicy === 'no-referrer')).toBe(true)
    expect(f.get('trace-message').textContent).toContain('availability, delivery and expiry are unknown')
    f.controller.observe(); expect(f.request).toHaveBeenCalledOnce()
    f.select(); expect(f.get('trace-references').children).toEqual([]); expect(f.get('trace-load').disabled).toBe(true)
  })
  it('drops stale reads across selection changes and sanitizes errors', async () => {
    const pending = Promise.withResolvers<unknown>(), f = controllerFixture(vi.fn(() => pending.promise))
    f.get('trace-load').click(); f.select({ ...expected, runId: randomUUID() }); f.select(expected)
    pending.resolve(evidence()); await new Promise(resolve => setImmediate(resolve)); expect(f.get('trace-references').children).toEqual([])
    f.request.mockRejectedValue(Error('PRIVATE_TRANSPORT_ERROR')); f.get('trace-load').click()
    await vi.waitFor(() => expect(f.get('trace-load').disabled).toBe(false))
    expect(f.get('trace-message').textContent).not.toContain('PRIVATE_TRANSPORT_ERROR'); expect(f.request).toHaveBeenCalledTimes(2)
  })
  it('paginates locally without fetching more evidence or contacting a trace viewer', async () => {
    const source = evidence(); source.snapshot.steps = Array.from({ length: 30 }, (_, index) => ({ nodeId: `node-${index}`, trace }))
    source.checksum.value = createHash('sha256').update(JSON.stringify(source.snapshot)).digest('hex')
    const f = controllerFixture(vi.fn(async () => source)); f.get('trace-load').click()
    await vi.waitFor(() => expect(f.get('trace-load').disabled).toBe(false))
    expect(f.get('trace-references').children).toHaveLength(25); f.get('trace-next').click()
    expect(f.get('trace-summary').textContent).toContain('26–35 of 35'); expect(f.request).toHaveBeenCalledOnce()
    f.get('trace-prev').click(); expect(f.get('trace-summary').textContent).toContain('1–25 of 35')
  })
})

describe('standalone CLI and preview trace configuration', () => {
  it.each([1, 2])('reads real retained traces through CLI with v%i viewer after shutdown without contacting it or rewriting history', async version => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-trace-navigation-')), file = join(directory, 'viewer.json')
    let viewerRequests = 0
    const viewer = createServer((_req, res) => { viewerRequests++; res.end() })
    await new Promise<void>(resolve => viewer.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => viewer.close(() => resolve())))
    const origin = `http://127.0.0.1:${(viewer.address() as { port: number }).port}`
    const destination = version === 1 ? { ...config, origin } : { schemaVersion: 2, kind: 'grafana-tempo-explore', origin,
      datasourceUid: 'tempo', orgId: 1, range: { from: 'now-24h', to: 'now' } }
    await writeFile(file, JSON.stringify(destination), { mode: 0o600 })
    const runtime = await LocalRuntime.open({ dataDirectory: join(directory, 'state'), telemetry: { endpoint: origin + '/collector',
      authentication: { kind: 'none' }, sampleRatio: 0, intervalMs: 60000, timeoutMs: 20, flushTimeoutMs: 30 } })
    let run, before
    try { run = await runtime.run(echo, 'PRIVATE_RUN_INPUT'); before = await runtime.events(run.id) } finally { await runtime.close() }
    const out = vi.fn(), err = vi.fn()
    expect(await main(['runs', 'traces', run.id, '--data-dir', join(directory, 'state'), '--trace-viewer-file', file], { out, err })).toBe(0)
    const result = JSON.parse(out.mock.calls[0]![0]); expect(result.references.length).toBeGreaterThan(0)
    expect(result.references.every((ref: any) => ref.url.startsWith(origin) && ref.traceFlags === 0)).toBe(true)
    if (version === 2) for (const ref of result.references) {
      const query = JSON.parse(new URL(ref.url).searchParams.get('panes')!).a
      expect(query.queries[0].query).toBe(ref.traceId); expect(query.panelsState.trace.spanId).toBe(ref.spanId)
      expect(query.range).toEqual(destination.range)
    }
    expect(JSON.stringify(result)).not.toContain('PRIVATE_RUN_INPUT'); expect(viewerRequests).toBe(0)
    const reopened = await LocalRuntime.open({ dataDirectory: join(directory, 'state') })
    try { expect(await reopened.events(run.id)).toEqual(before) } finally { await reopened.close() }
  })
  it('rejects invalid viewer config before opening storage, and rejects it for portable HTML', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-invalid-viewer-')), file = join(directory, 'viewer.json'), source = join(directory, 'echo.yaml')
    await writeFile(file, JSON.stringify({ ...config, token: 'PRIVATE_SECRET' })); await writeFile(source, echo)
    const out = vi.fn(), err = vi.fn(), before = await readdir(directory)
    expect(await main(['runs', 'traces', expected.runId, '--data-dir', join(directory, 'state'), '--trace-viewer-file', file], { out, err })).toBe(2)
    expect(await readdir(directory)).toEqual(before); expect(JSON.stringify(err.mock.calls)).not.toContain('PRIVATE_SECRET')
    expect(await main(['preview', source, '--output', join(directory, 'out.html'), '--trace-viewer-file', file], { out, err })).toBe(2)
  })
  it('validates session configuration before creating a project and pins it through asynchronous admission', async () => {
    const owner = { call: vi.fn(async (command: any) => command.operation === 'projects.command'
      ? { id: randomUUID(), generation: 1, acceptedRevision: (await import('../src/preview/index.ts')).createPreview(echo).revision }
      : command.operation === 'projects.show' ? {} : {}) }
    await expect(PreviewSession.create(owner, echo, undefined, undefined, { ...config, origin: 'javascript:x' })).rejects.toHaveProperty('code', 'invalid-command')
    expect(owner.call).not.toHaveBeenCalled()
    const directory = await mkdtemp(join(tmpdir(), 'jevable-viewer-start-')), original = { ...config }
    const pending = startRuntimeService({ runtime: { dataDirectory: directory }, token: 'a'.repeat(64), actor: 'fixture', preview: { source: echo, traceViewer: original } })
    original.origin = 'https://changed.example'
    const service = await pending; cleanup.push(() => service.close())
    const { PROTOCOL_VERSION } = await import('../src/capabilities.ts')
    const request = async (path: string, token: string, command: unknown) => (await (await fetch(service.url + path, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION }, body: JSON.stringify(command) })).json() as any).result
    const session = await request('/v1/preview/bootstrap', 'a'.repeat(64), {})
    const view = await request('/v1/preview/operations', session.token, { operation: 'view' })
    expect(view.traceViewer).toEqual(config)
    expect((await (await fetch(service.url)).text())).not.toContain(config.origin)
  })
})
