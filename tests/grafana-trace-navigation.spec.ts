import { describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { traceNavigationTools, type GrafanaTempoViewerConfig } from '../src/telemetry/navigation.ts'
import { traceViewerConfigSchema } from '../src/telemetry/navigation-schema.ts'
import { prepareTraceNavigation } from '../src/preview/trace-navigation.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { createPreview } from '../src/preview/index.ts'
import { showSchema } from '../src/contracts.ts'

const viewer: GrafanaTempoViewerConfig = { schemaVersion: 2, kind: 'grafana-tempo-explore', origin: 'https://grafana.example',
  datasourceUid: 'tempo-reviewed_1', orgId: 3, range: { from: '1760000000000', to: '1760003600000' } }
const tools = traceNavigationTools(), id = randomUUID(), attempt = randomUUID(), revision = 'a'.repeat(64)
const trace = { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 0 as const }
function envelope(version = 1) {
  const snapshot = { schemaVersion: version, format: 'jevable.ai/run-evidence', run: { id, revision, status: 'completed',
    traceSegments: [{ operation: 'run', trace }] }, steps: [{ nodeId: 'PRIVATE_NODE', attemptId: attempt, trace }],
    journal: [{ sequence: version === 1 ? 1 : '9007199254740993', kind: 'node-intent', trace }],
    privacy: { payloads: 'excluded', actors: 'excluded', credentialStore: 'excluded' }, unknown: 'PRIVATE_PAYLOAD' }
  return { schemaVersion: version, snapshot, checksum: { algorithm: 'sha256', encoding: 'JSON.stringify(snapshot)',
    value: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') } }
}
function pane(url: string) {
  const u = new URL(url)
  expect([...u.searchParams.keys()]).toEqual(['schemaVersion', 'panes', 'orgId'])
  expect(u.searchParams.get('schemaVersion')).toBe('1'); expect(u.searchParams.get('orgId')).toBe('3')
  return JSON.parse(u.searchParams.get('panes')!)
}

describe('explicit Grafana Tempo trace viewer', () => {
  it.each(['https://grafana.example', 'https://grafana.example/', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
    'normalizes and independently captures %s', origin => {
      const input = { ...viewer, origin, range: { ...viewer.range } }, expected = structuredClone(input)
      const result = tools.config(input)
      input.range.from = '0'; input.datasourceUid = 'changed'
      expect(result).toEqual({ ...expected, origin: new URL(origin).origin })
      expect(traceViewerConfigSchema.safeParse(expected).success).toBe(true)
    })
  it.each(['s', 'm', 'h', 'd', 'w'])('admits only an explicitly chosen bounded relative %s range', unit => {
    expect(tools.config({ ...viewer, range: { from: 'now-24' + unit, to: 'now' } })).toMatchObject({ range: { from: 'now-24' + unit, to: 'now' } })
  })
  it.each(['/grafana', '/tools/grafana-1.2'])('encodes an explicit subpath %s without changing authority', pathPrefix => {
    const result = tools.project(envelope().snapshot, { ...viewer, pathPrefix })
    const target = new URL(result.references[0]!.url!)
    expect(target.origin).toBe(viewer.origin); expect(target.pathname).toBe(pathPrefix + '/explore')
    expect(pane(target.href)).toMatchObject({ a: { range: viewer.range } })
  })
  const invalid = [
    { kind: 'other' }, { schemaVersion: 3 }, { range: undefined }, { orgId: 0 }, { orgId: -1 }, { orgId: 1.5 },
    { orgId: Number.MAX_SAFE_INTEGER + 1 }, { orgId: '1' }, { datasourceUid: '' }, { datasourceUid: 'x'.repeat(41) },
    { datasourceUid: '../tempo' }, { datasourceUid: 'tempo?auth=PRIVATE' }, { datasourceUid: 'tempo uid' },
    { origin: 'http://remote.example' }, { origin: 'http://localhost:3000' }, { origin: 'http://127.1:3000' },
    { origin: 'http://2130706433:3000' }, { origin: 'http://0x7f000001:3000' }, { origin: 'http://0177.0.0.1:3000' },
    { origin: 'http://[0:0:0:0:0:0:0:1]:3000' }, { origin: 'https://user:PRIVATE@grafana.example' },
    { origin: 'https://grafana.example/path' }, { origin: 'https://grafana.example?auth=PRIVATE' },
    { token: 'PRIVATE' }, { headers: {} }, { query: 'PRIVATE' }, { pathTemplate: '/trace/{traceId}' }, { spanParameter: 'spanID' },
    ...['/', '//evil', '/a/', '/a//b', '/a/../b', '/a/./b', '/%2e%2e', '/a?auth=PRIVATE', '/a#b', '/a\\b', '/a b'].map(pathPrefix => ({ pathPrefix })),
    ...[
      { from: '0', to: '0' }, { from: '2', to: '1' }, { from: '01', to: '2' }, { from: '-1', to: '2' },
      { from: '1.5', to: '2' }, { from: '0', to: '8640000000000001' }, { from: 0, to: '2' },
      { from: 'now-0h', to: 'now' }, { from: 'now-01h', to: 'now' }, { from: 'now-1000000h', to: 'now' },
      { from: 'now-1M', to: 'now' }, { from: 'now-1h/h', to: 'now' }, { from: 'now-1h', to: 'now+1h' },
      { from: 'now-1h', to: '2' }, { from: '0', to: 'now' }, { from: 'now-1h', to: 'now', auth: 'PRIVATE' },
    ].map(range => ({ range })),
  ]
  it.each(invalid.map((patch, index) => ({ patch, index })))('refuses unsafe/missing/mixed configuration $index', ({ patch }) => {
    const value = { ...viewer, ...patch }
    expect(() => tools.config(value)).toThrow('Invalid trace viewer')
    expect(traceViewerConfigSchema.safeParse(value).success).toBe(false)
  })
  it('preserves the exact Date range boundary and organization maximum without clock inference', () => {
    expect(tools.config({ ...viewer, orgId: Number.MAX_SAFE_INTEGER, range: { from: '0', to: '8640000000000000' } }))
      .toMatchObject({ orgId: Number.MAX_SAFE_INTEGER, range: { from: '0', to: '8640000000000000' } })
  })
  it.each([1, 2])('projects verified v%i evidence to a single fixed pane with trace/span but no payload/authority', async version => {
    const result = await prepareTraceNavigation({ runId: id, revision }, envelope(version), viewer)
    expect(result.execution).toBe('not-started-or-resumed'); expect(result.availability).toBe('delivery-unverified')
    expect(result.references).toHaveLength(3)
    for (const reference of result.references) {
      const target = new URL(reference.url!)
      expect(target.origin).toBe(viewer.origin); expect(target.pathname).toBe('/explore')
      expect(pane(target.href)).toEqual({ a: { datasource: viewer.datasourceUid,
        queries: [{ refId: 'A', datasource: { uid: viewer.datasourceUid, type: 'tempo' }, queryType: 'traceql', query: trace.traceId }],
        range: viewer.range, panelsState: { trace: { spanId: trace.spanId } } } })
      for (const privateValue of [id, revision, attempt, 'PRIVATE_NODE', 'PRIVATE_PAYLOAD']) expect(reference.url).not.toContain(privateValue)
    }
    expect(result.references.every(ref => ref.traceFlags === 0)).toBe(true)
  })
  it('keeps checksum/privacy admission and no-destination behavior unchanged', async () => {
    const source = envelope(); source.checksum.value = '0'.repeat(64)
    await expect(prepareTraceNavigation({ runId: id, revision }, source, viewer)).rejects.toThrow()
    const privateSource = envelope(); privateSource.snapshot.privacy.payloads = 'included'
    privateSource.checksum.value = createHash('sha256').update(JSON.stringify(privateSource.snapshot)).digest('hex')
    await expect(prepareTraceNavigation({ runId: id, revision }, privateSource, viewer)).rejects.toThrow()
    const result = await prepareTraceNavigation({ runId: id, revision }, envelope())
    expect(result.destination).toBeNull(); expect(result.references.every(ref => ref.url === null)).toBe(true)
  })
  it('runs the exact import-free browser projection without a clock, network, process or credentials', () => {
    const isolated = runInNewContext(`(${traceNavigationTools.toString()})()`, { URL })
    expect(JSON.parse(JSON.stringify(isolated.project(envelope().snapshot, viewer)))).toEqual(tools.project(envelope().snapshot, viewer))
    expect(tools.project(envelope().snapshot, viewer)).toEqual(tools.project(envelope().snapshot, viewer))
    const legacy = tools.project(envelope().snapshot, { schemaVersion: 1, origin: 'https://traces.example', pathTemplate: '/trace/{traceId}', spanParameter: 'spanID' })
    expect(legacy.references[0]!.url).toBe(`https://traces.example/trace/${trace.traceId}?spanID=${trace.spanId}`)
  })
  it('discovers the actual consuming structural schema without claiming semantic admission', () => {
    const schema = showSchema('trace-viewer')
    const check = new Ajv2020({ strict: false }).compile(schema.schema)
    expect(check(viewer)).toBe(true)
    expect(check({ ...viewer, token: 'PRIVATE' })).toBe(false)
    const backwards = { ...viewer, range: { from: '2', to: '1' } }
    expect(check(backwards)).toBe(true); expect(traceViewerConfigSchema.safeParse(backwards).success).toBe(false)
    expect(schema.limits).toContain('browser/backend qualification')
  })
  it('pins nested preview range before asynchronous admission and detaches each view', async () => {
    const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
    const admission = Promise.withResolvers<unknown>(), original = structuredClone(viewer)
    const owner = { call: vi.fn(async (command: any) => command.operation === 'projects.command' ? admission.promise : {}) }
    const pending = PreviewSession.create(owner, source, undefined, undefined, original)
    original.range.from = '0'; original.datasourceUid = 'changed'
    admission.resolve({ id: randomUUID(), generation: 1, acceptedRevision: createPreview(source).revision })
    const session = await pending
    const first = await session.operation({ operation: 'view' }) as { traceViewer: GrafanaTempoViewerConfig }
    expect(first.traceViewer).toEqual(viewer); first.traceViewer.range.from = '1'
    expect((await session.operation({ operation: 'view' }) as typeof first).traceViewer).toEqual(viewer)
    expect(owner.call.mock.calls.every(([command]) => !['run', 'projects.run'].includes(command.operation))).toBe(true)
  })
})
