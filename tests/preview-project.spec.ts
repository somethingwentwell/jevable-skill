import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { LocalRuntime } from '../src/runtime/local.ts'
import { dispatchOperation, type RuntimeOperation } from '../src/http/operations.ts'
import { PreviewSession } from '../src/preview/session.ts'
import * as packages from '../src/packages/project-zip.ts'
import { prepareProjectDownload } from '../src/preview/project-download.ts'
import { liveProjectExportControls } from '../src/preview/project-controls.ts'

const source = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = [], sha = (value: string) => createHash('sha256').update(value).digest('hex')
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) await owner.close() })
async function owner() { const runtime = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-preview-project-')) }); owners.push(runtime); return runtime }
async function fixture() {
  const runtime = await owner(), call = vi.fn((command: RuntimeOperation) => dispatchOperation({ storage: 'sqlite', runtime }, command, 'fixture'))
  const session = await PreviewSession.create({ call }, source)
  const draft: any = await session.operation({ operation: 'tests.create', id: randomUUID(), title: 'PRIVATE_CASE', input: { message: 'PRIVATE_INPUT' }, expectations: [{ kind: 'status', value: 'waiting' }] })
  const accepted: any = await session.operation({ operation: 'tests.accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256 })
  const result: any = await session.operation({ operation: 'tests.run', test: { id: accepted.id, generation: accepted.generation, sha256: accepted.sha256 }, runId: randomUUID() })
  const selection = { schemaVersion: 1, runs: [{ id: result.run.id, revision: result.run.revision }] }
  call.mockClear()
  return { runtime, call, session, result, selection }
}
describe('scoped editable project export', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('exports history=%s tests=%s without changing the source or accepting imported tests', async (history, tests) => {
    const f = await fixture(), options = { history: history!, tests: tests! }, before = await f.runtime.events(f.result.run.id)
    const response: any = await f.session.operation({ operation: 'project.export', ...options })
    const artifact = await prepareProjectDownload({ project: f.session.pin, options }, response)
    const parsed = await packages.readProjectZip(artifact.bytes), target = await owner(), inspected = target.inspectProjectImport(parsed.json)
    expect(artifact.bundleSha256).toBe(sha(parsed.json)); expect(parsed.evidence).toBeUndefined()
    expect(Boolean(inspected.bundle.history)).toBe(history); expect(inspected.bundle.version).toBe(tests ? 2 : 1)
    const project = target.importProject(parsed.json, inspected.sha256, 'importer')
    expect(project.id).not.toBe(f.session.pin.id); expect(target.list()).toEqual([]); expect(target.connections()).toEqual([])
    expect(target.testCases()).toHaveLength(tests ? 1 : 0)
    expect(target.testCases().every(item => item.status === 'draft')).toBe(true)
    expect(await f.runtime.events(f.result.run.id)).toEqual(before)
    expect(f.call.mock.calls.map(([c]) => c.operation)).toEqual(['projects.export'])
  })
  it.each([false, true])('attaches exactly reviewed evidence with private=%s and never restores it', async includePrivate => {
    const f = await fixture(), bundle: any = await f.session.operation({ operation: 'evidence.bundle', selection: f.selection, includePrivate })
    const response = await f.session.operation({ operation: 'project.export', tests: true, evidence: { selection: f.selection, sha256: bundle.sha256, includePrivate } })
    const artifact = await prepareProjectDownload({ project: f.session.pin, options: { history: false, tests: true } }, response,
      { sha256: bundle.sha256, selectionSha256: bundle.selectionSha256, privacy: bundle.privacy })
    const parsed = await packages.readProjectZip(artifact.bytes), target = await owner(), inspected = target.inspectProjectImport(parsed.json)
    expect(parsed.evidence?.attachment.sha256).toBe(bundle.sha256); expect(parsed.evidence?.inspection.runs[0]?.assessment).toBe('passed')
    expect(parsed.evidence?.inspection.runs[0]?.workflowStatus).toBe('waiting')
    target.importProject(parsed.json, inspected.sha256, 'importer')
    expect(target.list()).toEqual([]); expect(target.testCases()).toHaveLength(1); expect(target.testCases()[0]!.status).toBe('draft')
  })
  it('keeps latest editable test definitions distinct from attached historical passing assessments', async () => {
    const f = await fixture(), bundle: any = await f.session.operation({ operation: 'evidence.bundle', selection: f.selection, includePrivate: true })
    const old = f.runtime.testCases()[0]!
    await f.session.operation({ operation: 'tests.edit', id: old.id, expectedGeneration: old.generation, title: 'Revised private case',
      input: { message: 'NEW_INPUT' }, expectations: [{ kind: 'status', value: 'completed' }] })
    const response = await f.session.operation({ operation: 'project.export', tests: true,
      evidence: { selection: f.selection, sha256: bundle.sha256, includePrivate: true } })
    const artifact = await prepareProjectDownload({ project: f.session.pin, options: { history: false, tests: true } }, response,
      { sha256: bundle.sha256, selectionSha256: bundle.selectionSha256, privacy: bundle.privacy })
    const parsed = await packages.readProjectZip(artifact.bytes), content = JSON.parse(parsed.json)
    expect(content.tests.cases[0].source.generation).toBe(old.generation + 1)
    expect(content.tests.cases[0].status).toBe('draft'); expect(content.tests.cases[0].definition.expectations[0].value).toBe('completed')
    expect(parsed.evidence!.inspection.runs[0]).toMatchObject({ assessment: 'passed', workflowStatus: 'waiting' })
    expect(parsed.evidence!.attachment.sha256).toBe(bundle.sha256)
  })
  it.each(['checksum', 'private-consent', 'foreign-run', 'stale-project'] as const)('refuses %s without project export side effects', async mode => {
    const f = await fixture(), bundle: any = await f.session.operation({ operation: 'evidence.bundle', selection: f.selection, includePrivate: true })
    const command: any = { operation: 'project.export', evidence: { selection: f.selection, sha256: bundle.sha256, includePrivate: true } }
    if (mode === 'checksum') command.evidence.sha256 = '0'.repeat(64)
    if (mode === 'private-consent') command.evidence.includePrivate = false
    if (mode === 'foreign-run') {
      const run = await f.runtime.run(source, { message: 'foreign' }); command.evidence.selection = { schemaVersion: 1, runs: [{ id: run.id, revision: run.revision }] }
    }
    if (mode === 'stale-project') f.runtime.editProject({ operation: 'rename', id: f.session.pin.id, expectedGeneration: 1, title: 'Changed', actor: 'fixture' })
    const before = await f.runtime.events(f.result.run.id), projects = f.runtime.projects(); f.call.mockClear()
    await expect(f.session.operation(command)).rejects.toThrow()
    expect(await f.runtime.events(f.result.run.id)).toEqual(before); expect(f.runtime.projects()).toEqual(projects)
    if (mode === 'foreign-run') expect(f.call.mock.calls.some(([c]) => c.operation === 'runs.export')).toBe(false)
    expect(f.call.mock.calls.some(([c]) => c.operation === 'projects.import')).toBe(false)
  })
  it.each([{ id: randomUUID() }, { actor: 'spoof' }, { tests: 'yes' }, { history: 1 }, { revision: '0'.repeat(64) }])('rejects request override %j before owner access', async overrides => {
    const f = await fixture(); await expect(f.session.operation({ operation: 'project.export', ...overrides })).rejects.toMatchObject({ code: 'invalid-command' })
    expect(f.call).not.toHaveBeenCalled()
  })
  it.each(['history', 'tests', 'project'] as const)('refuses an owner response with unrequested %s data', async mode => {
    const f = await fixture(), value: any = f.runtime.exportProject(f.session.pin.id, 1, f.session.pin.revision, mode === 'history', mode === 'tests')
    if (mode === 'project') value.source.id = randomUUID()
    f.call.mockResolvedValue(value)
    await expect(f.session.operation({ operation: 'project.export' })).rejects.toMatchObject({ code: 'corrupt' })
  })
  it('bounds the ZIP before transport publication', async () => {
    const f = await fixture(); vi.spyOn(packages, 'createProjectZip').mockReturnValue(Buffer.alloc(12_000_001))
    await expect(f.session.operation({ operation: 'project.export' })).rejects.toMatchObject({ code: 'limit' })
  })
})
describe('project browser receipt verification', () => {
  it.each(['project', 'options', 'tests', 'evidence', 'hash', 'base64', 'size', 'runnable', 'restoration', 'extra'] as const)('rejects mismatched %s', async mode => {
    const f = await fixture(), value: any = await f.session.operation({ operation: 'project.export' })
    if (mode === 'project') value.project.generation++
    if (mode === 'options') value.options.tests = true
    if (mode === 'tests') value.tests.count = 1
    if (mode === 'evidence') value.evidence = { sha256: '0'.repeat(64), selectionSha256: '0'.repeat(64), privacy: 'private-execution-data' }
    if (mode === 'hash') value.sha256 = '0'.repeat(64)
    if (mode === 'base64') value.base64 += '!'
    if (mode === 'size') value.bytes++
    if (mode === 'runnable') value.runnableRelease = true
    if (mode === 'restoration') value.executionStateRestoration = 'supported'
    if (mode === 'extra') value.secret = 'private'
    await expect(prepareProjectDownload({ project: f.session.pin, options: { history: false, tests: false } }, value)).rejects.toThrow()
  })
  it('detaches the options, pin and bytes before asynchronous hashing', async () => {
    const f = await fixture(), value: any = await f.session.operation({ operation: 'project.export' }), expected = { project: f.session.pin, options: { history: false, tests: false } }
    const bytes = Buffer.from(value.base64, 'base64'), pending = prepareProjectDownload(expected, value)
    expected.project.id = randomUUID(); expected.options.tests = true; value.base64 = ''
    expect(Buffer.from((await pending).bytes)).toEqual(bytes)
  })
})
class Element {
  hidden = false; disabled = false; checked = false; textContent = ''; href = ''; download = ''
  listeners = new Map<string, () => void>()
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, fn) }
  removeAttribute(name: string) { if (name === 'href') this.href = ''; if (name === 'download') this.download = '' }
  click() { this.listeners.get('click')?.() }
}
async function controllerFixture() {
  const f = await fixture(), elements = new Map<string, Element>(), events = new Map<string, () => void>(), blobs: Blob[] = []
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)! }
  let scope: string | undefined = 'scope', evidence: any
  const request = vi.fn((command: any) => f.session.operation(command)), createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return `blob:project-${blobs.length}` }), revokeObjectURL = vi.fn()
  const controls = runInNewContext(`(${liveProjectExportControls.toString()})(ctx, ${prepareProjectDownload.toString()})`, {
    ctx: { request, scope: () => scope, project: () => f.session.pin, evidence: () => evidence }, document: { getElementById: get },
    window: { addEventListener: (name: string, fn: () => void) => events.set(name, fn) }, URL: { createObjectURL, revokeObjectURL }, Blob, TextEncoder, crypto: webcrypto, atob, btoa,
  }) as ReturnType<typeof liveProjectExportControls>
  return { ...f, request, get, events, controls, blobs, createObjectURL, revokeObjectURL,
    scope: (value?: string) => { scope = value; controls.observe() },
    evidence: async (includePrivate = false) => { const value: any = await f.session.operation({ operation: 'evidence.bundle', selection: f.selection, includePrivate });
      evidence = { selection: f.selection, sha256: value.sha256, selectionSha256: value.selectionSha256, privacy: value.privacy }; controls.observe(); return evidence },
  }
}
describe('serialized project export controls, not browser qualification', () => {
  it.each(['history', 'tests', 'attach'] as const)('removes the ready announcement and old link when %s changes', async option => {
    const f = await controllerFixture()
    f.get('project-export-prepare').click()
    await vi.waitFor(() => expect(f.createObjectURL).toHaveBeenCalledOnce())
    expect(f.get('project-export-message').textContent).toContain('ZIP ready')
    f.get('project-export-private').checked = true
    f.get(`project-export-${option}`).checked = true
    f.get(`project-export-${option}`).listeners.get('change')!()
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:project-1')
    expect(f.get('project-export-download').hidden).toBe(true)
    expect(f.get('project-export-download').href).toBe('')
    expect(f.get('project-export-download').download).toBe('')
    expect(f.get('project-export-receipt').textContent).toBe('')
    expect(f.get('project-export-private').checked).toBe(false)
    expect(f.get('project-export-message').textContent).toContain('Export options changed')
    expect(f.get('project-export-message').textContent).not.toContain('ZIP ready')
    expect(f.get('project-export-prepare').disabled).toBe(option === 'attach')
  })
  it.each(['scope', 'evidence', 'pagehide'] as const)('clears stale successful feedback with the download after %s invalidation', async mode => {
    const f = await controllerFixture()
    f.get('project-export-prepare').click()
    await vi.waitFor(() => expect(f.createObjectURL).toHaveBeenCalledOnce())
    if (mode === 'scope') f.scope()
    if (mode === 'evidence') await f.evidence()
    if (mode === 'pagehide') f.events.get('pagehide')!()
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:project-1')
    expect(f.get('project-export-download').hidden).toBe(true)
    expect(f.get('project-export-download').href).toBe('')
    expect(f.get('project-export-receipt').textContent).toBe('')
    expect(f.get('project-export-message').textContent).toBe('')
  })
  it('keeps the verified ready announcement and link during unchanged observations', async () => {
    const f = await controllerFixture()
    f.get('project-export-prepare').click()
    await vi.waitFor(() => expect(f.createObjectURL).toHaveBeenCalledOnce())
    const ready = f.get('project-export-message').textContent, receipt = f.get('project-export-receipt').textContent
    f.controls.observe(); f.controls.observe()
    expect(f.get('project-export-message').textContent).toBe(ready)
    expect(f.get('project-export-receipt').textContent).toBe(receipt)
    expect(f.get('project-export-download').hidden).toBe(false)
    expect(f.revokeObjectURL).not.toHaveBeenCalled()
    expect(f.request).toHaveBeenCalledOnce()
  })
  it('keeps an in-flight preparation visible on observation, but not after an explicit option change', async () => {
    const f = await controllerFixture(), original = f.request.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.request.mockImplementationOnce(async command => { const value = await original(command); await gate; return value })
    f.get('project-export-prepare').click()
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
    const preparing = f.get('project-export-message').textContent
    expect(preparing).toContain('Preparing editable')
    f.controls.observe(); expect(f.get('project-export-message').textContent).toBe(preparing)
    f.get('project-export-tests').checked = true; f.get('project-export-tests').listeners.get('change')!()
    const changed = f.get('project-export-message').textContent
    release(); await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.get('project-export-message').textContent).toBe(changed)
    expect(changed).not.toContain('ZIP ready')
    expect(f.createObjectURL).not.toHaveBeenCalled()
    expect(f.request).toHaveBeenCalledOnce()
  })
  it('only exports explicitly chosen options and never imports, executes or automatically saves', async () => {
    const f = await controllerFixture(); expect(f.request).not.toHaveBeenCalled()
    f.get('project-export-tests').checked = true; f.get('project-export-prepare').click()
    await vi.waitFor(() => expect(f.createObjectURL).toHaveBeenCalledOnce())
    expect(f.request).toHaveBeenCalledExactlyOnceWith({ operation: 'project.export', history: false, tests: true })
    const artifact = await packages.readProjectZip(new Uint8Array(await f.blobs[0]!.arrayBuffer()))
    expect(JSON.parse(artifact.json).tests.cases).toHaveLength(1)
    f.scope(); expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:project-1'); expect(f.get('project-export-tests').checked).toBe(false)
  })
  it('requires private consent separately from bundle preparation and consumes it once', async () => {
    const f = await controllerFixture(), evidence = await f.evidence(true); f.get('project-export-attach').checked = true
    f.get('project-export-prepare').click(); expect(f.request).not.toHaveBeenCalled()
    f.get('project-export-private').checked = true; f.get('project-export-prepare').click(); expect(f.get('project-export-private').checked).toBe(false)
    await vi.waitFor(() => expect(f.createObjectURL).toHaveBeenCalledOnce())
    expect(f.request.mock.calls[0]![0].evidence).toEqual({ selection: evidence.selection, sha256: evidence.sha256, includePrivate: true })
    f.get('project-export-prepare').click(); expect(f.request).toHaveBeenCalledOnce()
  })
  it.each(['scope', 'options', 'evidence', 'pagehide'] as const)('discards delayed download after %s change', async mode => {
    const f = await controllerFixture(), original = f.request.getMockImplementation()!; let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.request.mockImplementationOnce(async command => { const value = await original(command); await gate; return value })
    f.get('project-export-prepare').click(); await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
    if (mode === 'scope') f.scope()
    if (mode === 'options') { f.get('project-export-tests').checked = true; f.get('project-export-tests').listeners.get('change')!() }
    if (mode === 'evidence') await f.evidence()
    if (mode === 'pagehide') f.events.get('pagehide')!()
    release(); await new Promise(resolve => setTimeout(resolve, 20)); expect(f.createObjectURL).not.toHaveBeenCalled()
  })
})
