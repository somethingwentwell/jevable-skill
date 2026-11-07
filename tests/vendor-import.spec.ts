import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ProjectLedger } from '../src/projects/ledger.ts'
import { previewVendorImport, vendorImportViewSchema, type VendorImportCommand } from '../src/projects/vendor-import.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { PostgresProjectStore } from '../src/projects/postgres-store.ts'
import type { PostgresJournal, JournalBatch } from '../src/storage/postgres.ts'
import { RuntimeClient, startRuntimeService } from '../src/http/index.ts'
import { main } from '../src/cli.ts'
import { parseWorkflow } from '../src/workflow/index.ts'

const source = JSON.stringify({ name: 'Private import fixture', privateMemo: 'UPLOAD-ONLY-MARKER',
  nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }], connections: {} })
const limits = DEFAULT_COMPILER_LIMITS.source
const request = (uploaded = source): VendorImportCommand => {
  const preview = previewVendorImport(uploaded, limits)
  return { id: randomUUID(), title: 'Reviewed vendor project', actor: 'local:importer', source: uploaded, yaml: preview.yaml,
    reviewedSourceSha256: preview.sourceSha256, reviewedConversionSha256: preview.conversionSha256, reviewedRevision: preview.conversionRevision }
}
const ledger = () => new ProjectLedger(limits, 4_000_000)
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const directory = () => mkdtemp(join(tmpdir(), 'jevable-vendor-import-'))
async function runtime() {
  const dataDirectory = await directory(), owner = await LocalRuntime.open({ dataDirectory })
  cleanup.push(() => owner.close()); return { owner, dataDirectory }
}
const cli = async (args: string[]) => { let out = '', err = ''; const code = await main(args, { out: x => out += x, err: x => err += x }); return { code, out, err } }

describe('standalone retained vendor-import provenance', () => {
  it.each(['n8n-triage.json', 'dify-support.yml', 'coze-intent.json', 'zapier-support.json', 'make-support.json', 'power-automate-tickets.json'])(
    'retains the owned conversion identity for %s without running or caller-provided reports', async filename => {
      const upload = await readFile(new URL(`workflow/fixtures/import/${filename}`, import.meta.url), 'utf8')
      const core = ledger(), command = request(upload), before = structuredClone(command), result = core.createVendorImport(command)
      const view = core.vendorImport(result.record, true)!
      expect(view.privatePayloads).toBe('included')
      if (view.privatePayloads !== 'included') throw Error('Expected private view')
      expect(view.record.source).toBe(upload)
      expect(view.record.conversion.sourceSha256).toBe(command.reviewedSourceSha256)
      expect(view.record.conversion.conversionSha256).toBe(command.reviewedConversionSha256)
      expect(result.project.generation).toBe(1); expect(result.project.changes[0]!.actor).toBe(command.actor)
      expect(command).toEqual(before)
    })
  it('canonicalizes reviewed YAML but allows an explicitly reviewed edit with the same workflow identity', () => {
    const core = ledger(), command = request(), parsed = JSON.parse(JSON.stringify(core.createVendorImport(command).project))
    const doc = previewVendorImport(source, limits).yaml.replace('Private import fixture', 'Reviewed display title')
    const revision = parseWorkflow(doc, limits).revision
    const result = core.createVendorImport({ ...command, id: randomUUID(), yaml: doc, reviewedRevision: revision })
    expect(result.project.acceptedRevision).toBe(revision)
    expect(core.vendorImport(result.record)!.conversionRevision).toBe(command.reviewedRevision)
    expect(parsed.id).toBe(command.id)
  })
  it.each(['reviewedSourceSha256', 'reviewedConversionSha256', 'reviewedRevision'] as const)('refuses changed %s with no project creation', async field => {
    const { owner } = await runtime(), command = request()
    expect(() => owner.createVendorImport({ ...command, [field]: '0'.repeat(64) })).toThrow('conflict')
    expect(owner.projects()).toEqual([]); expect(owner.list()).toEqual([])
  })
  it.each([{ id: 'not-a-uuid' }, { origin: 'desktop' }, { report: {} }, { actor: '' }, { source: '\ud800' }, { source: '\0' }])(
    'refuses malformed/forged command case %#', patch => {
      expect(() => ledger().createVendorImport({ ...request(), ...patch } as never)).toThrow('invalid-command')
    })
  it('refuses recognizable embedded credentials and over-budget uploads/drafts', () => {
    expect(() => request(source.replace('"connections":{}', '"connections":{},"apiKey":"private-key"'))).toThrow('secret-values')
    expect(() => ledger().createVendorImport({ ...request(), source: ' '.repeat(limits.maxSourceBytes + 1) })).toThrow('limit')
    expect(() => ledger().createVendorImport({ ...request(), yaml: ' '.repeat(limits.maxSourceBytes + 1) })).toThrow('limit')
    expect(() => new ProjectLedger(limits, 1024).createVendorImport(request())).toThrow('limit')
  })
  it('replays original creation after edits/reopen without overwriting current state or adding runs', async () => {
    const dataDirectory = await directory(), command = request(); let owner = await LocalRuntime.open({ dataDirectory })
    const created = owner.createVendorImport(command), original = owner.vendorImport(created.id, true)
    owner.editProject({ operation: 'rename', id: created.id, expectedGeneration: 1, title: 'Later title', actor: 'local:editor' })
    await owner.close(); owner = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => owner.close())
    expect(owner.createVendorImport(command)).toEqual(created)
    expect(owner.project(created.id).title).toBe('Later title'); expect(owner.project(created.id).generation).toBe(2)
    expect(owner.vendorImport(created.id, true)).toEqual(original); expect(owner.projects()).toHaveLength(1); expect(owner.list()).toEqual([])
    for (const patch of [{ title: 'different' }, { actor: 'different' }, { source: source + '\n' }])
      expect(() => owner.createVendorImport({ ...command, ...patch })).toThrow('conflict')
  })
  it('keeps original upload private across ordinary reads/history exports/duplicate/project transfer', async () => {
    const { owner } = await runtime(), command = request(), project = owner.createVendorImport(command)
    expect(JSON.stringify(owner.projects())).not.toContain('UPLOAD-ONLY-MARKER')
    expect(JSON.stringify(owner.project(project.id))).not.toContain('UPLOAD-ONLY-MARKER')
    const view = owner.vendorImport(project.id)!
    expect(view.privatePayloads).toBe('excluded'); expect(JSON.stringify(view)).not.toContain('UPLOAD-ONLY-MARKER')
    expect(vendorImportViewSchema.safeParse({ ...view, record: { source } }).success).toBe(false)
    const copy = owner.editProject({ operation: 'duplicate', id: project.id, expectedGeneration: 1,
      revision: project.acceptedRevision, title: 'Copy', actor: 'local:copy' })
    expect(owner.vendorImport(copy.id)).toBeNull()
    const bundle = owner.exportProject(project.id, 1, project.acceptedRevision, true), json = JSON.stringify(bundle)
    expect(json).not.toContain('UPLOAD-ONLY-MARKER'); expect(bundle.history).not.toHaveProperty('vendorImport')
    const imported = owner.importProject(json, owner.inspectProjectImport(json).sha256, 'local:transfer')
    expect(owner.vendorImport(imported.id)).toBeNull()
    const forged = { ...bundle, history: { ...bundle.history, vendorImport: ledger().createVendorImport(command).record.vendorImport } }
    expect(() => owner.inspectProjectImport(JSON.stringify(forged))).toThrow('invalid-command')
  })
  it.each(['source', 'conversion', 'actor', 'at', 'revision', 'requestSha256'] as const)('detects retained %s corruption', field => {
    const core = ledger(), result = core.createVendorImport(request()), forged = structuredClone(result.record)
    const value = forged.vendorImport!
    if (field === 'conversion') value.conversion.mappings[0]!.kind = 'unsupported'
    else if (field === 'at') value.at = '2025-01-01T00:00:00.000Z'
    else value[field] += 'changed'
    expect(() => core.decode(JSON.stringify(forged), result.project.id, 1)).toThrow('corrupt')
  })
  it('rolls back the complete SQLite creation when the project write fails', async () => {
    const dataDirectory = await directory(), owner = await LocalRuntime.open({ dataDirectory }); await owner.close()
    const db = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    try { db.exec("CREATE TRIGGER deny_project BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT,'fixture write refusal'); END;") } finally { db.close() }
    const reopened = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => reopened.close())
    expect(() => reopened.createVendorImport(request())).toThrow('fixture write refusal')
    expect(reopened.projects()).toEqual([]); expect(reopened.list()).toEqual([])
  })
  it('implements a single atomic PostgreSQL record commit and replay in a journal double', async () => {
    const rows = new Map<string, { key: string; version: string; value: unknown; deleted: boolean }>(), batches: JournalBatch[] = []
    const journal = { signal: new AbortController().signal, async get(_collection: string, key: string) { return rows.get(key) },
      async count() { return rows.size }, async commit(batch: JournalBatch) {
        batches.push(structuredClone(batch)); const change = batch.changes[0]!
        if (change.operation !== 'put') throw Error('Expected put')
        rows.set(change.key, { key: change.key, version: '1', value: change.value, deleted: false })
      } } as unknown as PostgresJournal
    const store = new PostgresProjectStore(journal, limits), command = request(), project = await store.createVendorImport(command)
    expect(batches).toHaveLength(1); expect(batches[0]!.changes).toHaveLength(1)
    expect(JSON.stringify(batches[0]!.changes[0])).toContain('UPLOAD-ONLY-MARKER')
    expect(await store.createVendorImport(command)).toEqual(project); expect(batches).toHaveLength(1)
    expect((await store.vendorImport(project.id, true))?.privatePayloads).toBe('included')
    await expect(store.createVendorImport({ ...command, title: 'different' })).rejects.toThrow('conflict')
  })
  it('uses fixed authenticated HTTP attribution and refuses private-actor overrides/unauthorized reads', async () => {
    const dataDirectory = await directory(), service = await startRuntimeService({ token: 'd'.repeat(64), actor: 'local:service', runtime: { dataDirectory } })
    cleanup.push(() => service.close()); const client = new RuntimeClient(service.url, 'd'.repeat(64)), command = request()
    const { actor: _actor, ...body } = command
    const result = await client.operation({ operation: 'projects.import.vendor', command: body }) as { result: { id: string } }
    expect(result.result.id).toBe(command.id)
    const inspected = await client.operation({ operation: 'projects.import.vendor.show', id: command.id, inspect: true }) as { result: { record: { actor: string; source: string } } }
    expect(inspected.result.record.actor).toBe('local:service'); expect(inspected.result.record.source).toBe(source)
    await expect(client.operation({ operation: 'projects.import.vendor', command } as never)).rejects.toMatchObject({ code: 'invalid-command' })
    await expect(new RuntimeClient(service.url, 'e'.repeat(64)).operation({ operation: 'projects.import.vendor.show', id: command.id })).rejects.toThrow()
  })
  it('executes preview/create/show through separate CLI owners and never executes the workflow', async () => {
    const cwd = await directory(), upload = join(cwd, 'vendor.json'), yaml = join(cwd, 'draft.yaml'), data = join(cwd, 'state')
    await writeFile(upload, source)
    const preview = await cli(['import', 'preview', upload, '--output', yaml, '--json']); expect(preview.code).toBe(0)
    const review = JSON.parse(preview.out), id = randomUUID(), args = ['import', 'vendor', upload, '--file', yaml, '--title', 'CLI import', '--id', id,
      '--reviewed-source-sha256', review.sourceSha256, '--reviewed-conversion-sha256', review.conversionSha256,
      '--reviewed-revision', review.conversionRevision, '--data-dir', data, '--json']
    const created = await cli(args); expect(created.code, created.err).toBe(0); expect((await cli(args)).out).toBe(created.out)
    const meta = await cli(['import', 'show', id, '--data-dir', data, '--json']); expect(meta.code).toBe(0); expect(meta.out).not.toContain('UPLOAD-ONLY-MARKER')
    const privateView = await cli(['import', 'show', id, '--inspect', '--data-dir', data, '--json']); expect(privateView.code).toBe(0); expect(privateView.out).toContain('UPLOAD-ONLY-MARKER')
    expect(JSON.parse((await cli(['runs', 'list', '--data-dir', data, '--json'])).out).runs).toEqual([])
  })
  it('validates missing review/ID/hash/owner choices before opening files, credentials or storage', async () => {
    const call = vi.spyOn(LocalRuntime, 'open')
    const invalid = await cli(['import', 'vendor', 'never-read', '--file', 'never-read', '--title', 'Fixture', '--id', 'invalid'])
    expect(invalid.code).not.toBe(0); expect(call).not.toHaveBeenCalled(); expect(invalid.err).not.toContain('ENOENT')
    const badShow = await cli(['import', 'show', 'invalid', '--data-dir', 'never-created'])
    expect(badShow.code).not.toBe(0); expect(call).not.toHaveBeenCalled()
  })
})
