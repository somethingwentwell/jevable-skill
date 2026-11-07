import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync, unzipSync } from 'fflate'
import { ProjectLedger } from '../src/projects/ledger.ts'
import { previewVendorImport, vendorImportViewSchema } from '../src/projects/vendor-import.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { createVendorOriginZip, inspectVendorOriginZip, VENDOR_ORIGIN_LIMITS } from '../src/packages/index.ts'
import { main } from '../src/cli.ts'
import { readProjectZip } from '../src/packages/project-zip.ts'
import { parseWorkflow } from '../src/workflow/index.ts'
import { RuntimeClient, startRuntimeService } from '../src/http/index.ts'
import { createTlsFixture, fixturePort } from '../scripts/tls-fixture.mjs'

const source = JSON.stringify({ name: 'Origin fixture', privateMemo: 'PRIVATE-ORIGINAL-UPLOAD',
  nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }], connections: {} })
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function command(upload = source) {
  const preview = previewVendorImport(upload, DEFAULT_COMPILER_LIMITS.source)
  return { id: randomUUID(), title: 'Reviewed import', actor: 'local:PRIVATE-IMPORT-ACTOR', source: upload, yaml: preview.yaml,
    reviewedSourceSha256: preview.sourceSha256, reviewedConversionSha256: preview.conversionSha256, reviewedRevision: preview.conversionRevision }
}
function fixture(upload = source) {
  const ledger = new ProjectLedger(DEFAULT_COMPILER_LIMITS.source, 4_000_000), c = command(upload), created = ledger.createVendorImport(c)
  const view = ledger.vendorImport(created.record, true)!
  return { ledger, c, created, view, options: { projectId: c.id, reviewedOriginSha256: view.sha256, includePrivate: true as const } }
}
function rewrite(bytes: Uint8Array, mutate: (files: Record<string, Uint8Array>, manifest: any) => void, repin = true) {
  const files = unzipSync(bytes), manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString('utf8'))
  mutate(files, manifest)
  if (repin) for (const file of manifest.files) {
    const bytes = files[file.path]
    if (bytes) { file.bytes = bytes.byteLength; file.sha256 = hash(bytes) }
  }
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest))
  return zipSync(files)
}
const cli = async (args: string[]) => { let out = '', err = ''; const code = await main(args, { out: s => out += s, err: s => err += s }); return { code, out, err } }
afterEach(() => vi.restoreAllMocks())

describe('explicit standalone private vendor-origin evidence', () => {
  it.each(['n8n-triage.json', 'dify-support.yml', 'coze-intent.json', 'zapier-support.json', 'make-support.json', 'power-automate-tickets.json'])(
    'round-trips bounded original evidence for %s without restoring authority', async file => {
      const upload = await readFile(new URL(`workflow/fixtures/import/${file}`, import.meta.url), 'utf8'), f = fixture(upload), before = structuredClone(f.view)
      const result = createVendorOriginZip(f.view, f.options), files = unzipSync(result.bytes)
      expect(Object.keys(files).sort()).toEqual(['README.txt', 'conversion-report.json', 'conversion.yaml', 'manifest.json', 'origin.json', 'source.txt'])
      expect(Buffer.from(files['source.txt']!).toString('utf8')).toBe(upload)
      expect(createVendorOriginZip(f.view, f.options).bytes).toEqual(result.bytes)
      const inspected = await inspectVendorOriginZip(result.bytes, hash(result.bytes))
      expect(inspected).toMatchObject({ status: 'consistent', projectId: f.c.id, originSha256: f.view.sha256, revision: f.c.reviewedRevision,
        privatePayloads: 'included-but-not-displayed', authenticity: 'checksums-only; not-signed', restoration: 'not-supported', execution: 'not-run' })
      expect(inspected).not.toHaveProperty('record'); expect(inspected).not.toHaveProperty('source')
      expect(f.view).toEqual(before)
      await expect(readProjectZip(result.bytes)).rejects.toThrow('invalid-package')
    })
  it('retains the original converter draft independently of a reviewed edited creation draft', async () => {
    const core = new ProjectLedger(DEFAULT_COMPILER_LIMITS.source, 4_000_000), c = command()
    c.yaml = c.yaml.replace('Origin fixture', 'Reviewed creation title'); c.reviewedRevision = parseWorkflow(c.yaml, DEFAULT_COMPILER_LIMITS.source).revision
    const created = core.createVendorImport(c), view = core.vendorImport(created.record, true)!, bundle = createVendorOriginZip(view,
      { projectId: c.id, reviewedOriginSha256: view.sha256, includePrivate: true })
    const inspected = await inspectVendorOriginZip(bundle.bytes)
    expect(inspected.revision).toBe(c.reviewedRevision); expect(inspected.conversionRevision).not.toBe(inspected.revision)
    expect(Buffer.from(unzipSync(bundle.bytes)['conversion.yaml']!).toString()).not.toBe(c.yaml)
  })
  it('does not substitute default execution budgets for a valid retained larger-owner conversion', async () => {
    const limits = { ...DEFAULT_COMPILER_LIMITS.source, maxNodes: 1000, maxEdges: 2000 }
    const nodes = Array.from({ length: 510 }, (_, i) => ({ name: `Node${i}`, type: i ? 'n8n-nodes-base.noOp' : 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }))
    const upload = JSON.stringify({ name: 'Larger conversion', nodes, connections: Object.fromEntries(nodes.slice(0, -1)
      .map((node, i) => [node.name, { main: [[{ node: nodes[i + 1]!.name, type: 'main', index: 0 }]] }])) })
    const converted = previewVendorImport(upload, limits), core = new ProjectLedger(limits, 4_000_000)
    const c = { id: randomUUID(), title: 'Larger import', actor: 'local:fixture', source: upload, yaml: converted.yaml,
      reviewedSourceSha256: converted.sourceSha256, reviewedConversionSha256: converted.conversionSha256, reviewedRevision: converted.conversionRevision }
    const project = core.createVendorImport(c), view = core.vendorImport(project.record, true)!
    expect(parseWorkflow(converted.yaml, limits).order.length).toBeGreaterThan(500)
    const exported = createVendorOriginZip(view, { projectId: c.id, reviewedOriginSha256: view.sha256, includePrivate: true })
    expect((await inspectVendorOriginZip(exported.bytes)).conversionRevision).toBe(converted.conversionRevision)
  })
  it.each([{ includePrivate: false }, { includePrivate: undefined }, { reviewedOriginSha256: '' }, { reviewedOriginSha256: 'A'.repeat(64) },
    { projectId: 'bad' }, { actor: 'forged' }])('refuses missing consent/invalid export options %#', patch => {
    const f = fixture(); expect(() => createVendorOriginZip(null, { ...f.options, ...patch } as never)).toThrow('invalid-command')
  })
  it('refuses foreign project, stale origin hash and metadata-only input', () => {
    const f = fixture()
    expect(() => createVendorOriginZip(f.view, { ...f.options, projectId: randomUUID() })).toThrow('conflict')
    expect(() => createVendorOriginZip(f.view, { ...f.options, reviewedOriginSha256: 'a'.repeat(64) })).toThrow('conflict')
    expect(() => createVendorOriginZip(f.ledger.vendorImport(f.created.record), f.options)).toThrow('invalid-package')
  })
  it.each(['source', 'metadata', 'conversion', 'revision'])('refuses inconsistent private %s', field => {
    const f = fixture(), view = structuredClone(f.view)
    if (view.privatePayloads !== 'included') throw Error('private fixture required')
    if (field === 'source') view.record.source += 'changed'
    else if (field === 'conversion') view.record.conversion.mappings[0]!.kind = 'unsupported'
    else if (field === 'revision') view.record.revision = 'a'.repeat(64)
    else view.sourceSha256 = 'a'.repeat(64)
    expect(() => createVendorOriginZip(view, f.options)).toThrow('checksum-mismatch')
  })
  it('inspects metadata without exposing upload, actor or request attribution', async () => {
    const f = fixture(), result = await inspectVendorOriginZip(createVendorOriginZip(f.view, f.options).bytes)
    const text = JSON.stringify(result)
    expect(text).not.toContain('PRIVATE-ORIGINAL-UPLOAD'); expect(text).not.toContain('PRIVATE-IMPORT-ACTOR')
    expect(result).not.toHaveProperty('requestSha256'); expect(result).not.toHaveProperty('at')
  })
  it.each(['projectId', 'revision', 'originSha256', 'sourceSha256', 'conversionSha256'])('refuses substituted manifest %s', field => {
    const f = fixture(), bytes = createVendorOriginZip(f.view, f.options).bytes
    const changed = rewrite(bytes, (_files, m) => { m[field] = field === 'projectId' ? randomUUID() : 'a'.repeat(64) })
    return expect(inspectVendorOriginZip(changed)).rejects.toThrow('checksum-mismatch')
  })
  it.each(['source.txt', 'conversion.yaml', 'conversion-report.json'])('refuses %s substitution even after repinning file bytes', async path => {
    const f = fixture(), bytes = createVendorOriginZip(f.view, f.options).bytes
    await expect(inspectVendorOriginZip(rewrite(bytes, files => { files[path] = Buffer.from(path.endsWith('.json') ? '{}' : 'changed') }))).rejects.toThrow('checksum-mismatch')
  })
  it('refuses stale archive pin, bad ZIP, extra files, duplicate manifest entries and changed bytes', async () => {
    const f = fixture(), bytes = createVendorOriginZip(f.view, f.options).bytes
    await expect(inspectVendorOriginZip(bytes, 'a'.repeat(64))).rejects.toThrow('conflict')
    await expect(inspectVendorOriginZip(bytes, 'A'.repeat(64))).rejects.toThrow('invalid-command')
    await expect(inspectVendorOriginZip(Buffer.from('not a ZIP'))).rejects.toThrow('invalid-package')
    await expect(inspectVendorOriginZip(rewrite(bytes, files => { files['unexpected.txt'] = Buffer.from('hidden') }))).rejects.toThrow()
    await expect(inspectVendorOriginZip(rewrite(bytes, (_files, m) => { m.files[1] = m.files[0] }))).rejects.toThrow('invalid-package')
    await expect(inspectVendorOriginZip(rewrite(bytes, files => { files['source.txt'] = Buffer.from('changed') }, false))).rejects.toThrow('checksum-mismatch')
  })
  it('refuses oversized artifacts and owns the admitted bytes across async inspection', async () => {
    await expect(inspectVendorOriginZip(Buffer.alloc(VENDOR_ORIGIN_LIMITS.archiveBytes + 1))).rejects.toThrow('package-limit')
    const f = fixture(), input = createVendorOriginZip(f.view, f.options).bytes, sha = hash(input)
    const result = inspectVendorOriginZip(input, sha); input.fill(0)
    expect((await result).artifactSha256).toBe(sha)
  })
  it('writes a private deterministic CLI ZIP and inspects offline without opening an owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-origin-cli-')), data = join(directory, 'state'), output = join(directory, 'origin.zip')
    const owner = await LocalRuntime.open({ dataDirectory: data }), c = command(), project = owner.createVendorImport(c), view = owner.vendorImport(project.id)!
    await owner.close()
    const args = ['import', 'export-origin', project.id, '--reviewed-origin-sha256', view.sha256, '--include-private', '--output', output, '--data-dir', data, '--json']
    const result = await cli(args); expect(result.code, result.err).toBe(0)
    expect(result.out).not.toContain('PRIVATE-ORIGINAL-UPLOAD'); expect(result.out).not.toContain('PRIVATE-IMPORT-ACTOR')
    expect(JSON.parse(result.out)).toMatchObject({ status: 'written', projectId: project.id, privatePayloads: 'included', execution: 'not-run' })
    expect((await stat(output)).mode & 0o777).toBe(0o600)
    const bytes = await readFile(output), before = await readdir(directory), open = vi.spyOn(LocalRuntime, 'open')
    const inspected = await cli(['import', 'inspect-origin', output, '--reviewed-sha256', hash(bytes), '--json'])
    expect(inspected.code, inspected.err).toBe(0); expect(open).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual(before)
    expect(inspected.out).not.toContain('PRIVATE-ORIGINAL-UPLOAD')
    open.mockRestore()
    const refused = await cli(args); expect(refused.code).toBe(1); expect(JSON.parse(refused.err).code).toBe('operation-failed')
    expect(await readFile(output)).toEqual(bytes)
    expect((await cli([...args, '--overwrite'])).code).toBe(0); expect(await readFile(output)).toEqual(bytes)
    const check = await LocalRuntime.open({ dataDirectory: data })
    try { expect(check.list()).toEqual([]); expect(check.project(project.id)).toEqual(project); expect(check.vendorImport(project.id)).toEqual(view) }
    finally { await check.close() }
  })
  it.each([
    { flags: [] }, { flags: ['--include-private'] }, { flags: ['--reviewed-origin-sha256', 'bad', '--include-private'] },
  ])('refuses missing consent/pins before opening storage %#', async ({ flags }) => {
    const open = vi.spyOn(LocalRuntime, 'open'), result = await cli(['import', 'export-origin', randomUUID(), '--output', 'never-written', ...flags])
    expect(result.code).toBe(2); expect(open).not.toHaveBeenCalled()
  })
  it('does not read private origin after a stale metadata pin and never exports an ordinary project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-origin-refusal-')), data = join(directory, 'state'), owner = await LocalRuntime.open({ dataDirectory: data })
    const c = command(); let imported, ordinary
    try {
      imported = owner.createVendorImport(c)
      ordinary = owner.editProject({ operation: 'create', yaml: c.yaml, title: 'ordinary', actor: 'local:fixture' })
    } finally { await owner.close() }
    const read = vi.spyOn(LocalRuntime.prototype, 'vendorImport')
    for (const id of [imported.id, ordinary.id]) {
      const result = await cli(['import', 'export-origin', id, '--reviewed-origin-sha256', 'a'.repeat(64), '--include-private',
        '--output', join(directory, 'never-created.zip'), '--data-dir', data])
      expect(result.code).toBe(1)
    }
    expect(read.mock.calls.every(([, inspect]) => !inspect)).toBe(true)
    expect(await readdir(directory)).toEqual(['state'])
  })
  it('exports from an explicitly selected verified-TLS owner without local storage or execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-origin-https-')), tls = await createTlsFixture(directory), port = await fixturePort()
    const token = 'a'.repeat(64), tokenFile = join(directory, 'token'), output = join(directory, 'origin.zip')
    await writeFile(tokenFile, token, { mode: 0o600 })
    const service = await startRuntimeService({ token, actor: 'remote:origin-export-fixture', runtime: { dataDirectory: join(directory, 'server-state') }, port,
      tls: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: '127.0.0.1', certificateFile: tls.cert, privateKeyFile: tls.key } })
    try {
      const client = new RuntimeClient(service.url, token, 3000, 20_000_000, { ca: tls.ca, expectedInstanceId: service.instanceId }), c = command()
      const { actor: _actor, ...creation } = c
      await client.operation({ operation: 'projects.import.vendor', command: creation })
      const response = await client.operation({ operation: 'projects.import.vendor.show', id: c.id }) as { result: unknown }
      const view = vendorImportViewSchema.parse(response.result), open = vi.spyOn(LocalRuntime, 'open')
      const flags = ['--endpoint', service.url, '--instance-id', service.instanceId, '--token-file', tokenFile, '--ca-file', tls.cert]
      const result = await cli(['import', 'export-origin', c.id, '--reviewed-origin-sha256', view.sha256, '--include-private', '--output', output, ...flags, '--json'])
      expect(result.code, result.err).toBe(0); expect(open).not.toHaveBeenCalled()
      expect((await inspectVendorOriginZip(await readFile(output))).originSha256).toBe(view.sha256)
      const retained = await client.operation({ operation: 'projects.import.vendor.show', id: c.id }) as { result: unknown }
      expect(retained.result).toEqual(view)
      expect((await client.operation({ operation: 'runs.list' }) as { result: { runs: unknown[] } }).result.runs).toEqual([])
      const rejected = await cli(['import', 'export-origin', c.id, '--reviewed-origin-sha256', view.sha256, '--include-private',
        '--output', join(directory, 'never-created.zip'), ...flags, '--data-dir', join(directory, 'never-created-local')])
      expect(rejected.code).toBe(2); expect(open).not.toHaveBeenCalled()
      expect(await readdir(directory)).not.toContain('never-created-local')
    } finally { await service.close(); await service.closed }
  }, 20000)
})
