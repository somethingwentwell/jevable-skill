import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { LocalRuntime } from '../src/runtime/local.ts'
import { dispatchOperation } from '../src/http/operations.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { inspectEvidenceZip } from '../src/evidence/inspect.ts'
import * as packages from '../src/evidence/package.ts'
import { prepareEvidenceBundleDownload } from '../src/preview/evidence-bundle-download.ts'
import { inspectPreviewEvidenceArchive } from '../src/preview/evidence-archive-view.ts'
import { liveEvidenceBundleControls } from '../src/preview/evidence-bundle-controls.ts'
import type { RuntimeOperation } from '../src/http/operations.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) await owner.close() })
async function fixture() {
  const runtime = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-preview-bundle-')) }); owners.push(runtime)
  const call = vi.fn((command: RuntimeOperation) => dispatchOperation({ storage: 'sqlite', runtime }, command, 'fixture'))
  const session = await PreviewSession.create({ call }, echo)
  const first = await session.operation({ operation: 'run', id: randomUUID(), input: 'PRIVATE_NORMAL_INPUT' }) as any
  const draft = await session.operation({ operation: 'tests.create', id: randomUUID(), title: 'PRIVATE_CASE_TITLE', input: 'PRIVATE_TEST_INPUT',
    expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'PRIVATE_EXPECTED' }] }) as any
  const accepted = await session.operation({ operation: 'tests.accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256 }) as any
  const tested = await session.operation({ operation: 'tests.run', test: { id: accepted.id, generation: accepted.generation, sha256: accepted.sha256 }, runId: randomUUID() }) as any
  const selection = { schemaVersion: 1 as const, runs: [first, tested.run].map(run => ({ id: run.id, revision: run.revision })) }
  const command = { operation: 'evidence.bundle' as const, selection }
  call.mockClear()
  return { runtime, call, session, selection, command, first, tested }
}

describe('project-scoped preview ZIP protocol (not a browser)', () => {
  it.each([false, true])('exports only selected retained runs and historical tests, private=%s', async includePrivate => {
    const f = await fixture(), before = await f.runtime.events(f.tested.run.id)
    const value = await f.session.operation({ ...f.command, includePrivate }) as any
    const verified = await prepareEvidenceBundleDownload(f.selection, value, includePrivate)
    const inspected = await inspectEvidenceZip(verified.bytes, verified.sha256)
    const browser = await inspectPreviewEvidenceArchive(verified.bytes, f.selection, verified.sha256, verified.privacy)
    expect(browser.runs.map(run => run.id)).toEqual(f.selection.runs.map(run => run.id))
    expect(browser.files.map(file => file.path)).toEqual(expect.arrayContaining(['manifest.json', 'selection.json', 'README.txt',
      `runs/${f.first.id}.json`, `runs/${f.tested.run.id}.json`, `tests/${f.tested.run.id}.json`]))
    const visible = browser.files.map(file => file.content).join('\n')
    expect(visible.includes('PRIVATE_TEST_INPUT')).toBe(includePrivate)
    expect(visible.includes('PRIVATE_EXPECTED')).toBe(includePrivate)
    expect(inspected.runs.map(run => run.id)).toEqual(f.selection.runs.map(run => run.id))
    expect(inspected.runs[1]).toMatchObject({ assessment: 'failed', workflowStatus: 'completed' })
    expect(verified.summary).toEqual([
      { id: f.first.id, workflowStatus: 'completed', assessment: undefined },
      { id: f.tested.run.id, workflowStatus: 'completed', assessment: 'failed' },
    ])
    expect(JSON.stringify(verified.summary)).not.toContain('PRIVATE_')
    expect(value.privacy).toBe(includePrivate ? 'private-execution-data' : 'metadata-only')
    expect(value.runs).toHaveLength(2); expect(value.restoration).toBe('unsupported')
    expect(await f.runtime.events(f.tested.run.id)).toEqual(before)
    expect(f.call.mock.calls.every(([command]) => ['runs.show', 'runs.export', 'tests.result'].includes(command.operation))).toBe(true)
    expect(f.call.mock.calls.filter(([command]) => command.operation === 'runs.export').every(([command]: any) => command.includePrivate === includePrivate)).toBe(true)
    expect(f.call.mock.calls.filter(([command]) => command.operation === 'tests.result').every(([command]: any) => command.inspect === includePrivate)).toBe(true)
    expect(JSON.stringify(value.runs)).not.toContain('PRIVATE_')
    const { unzipSync } = await import('fflate'), files = unzipSync(verified.bytes)
    const body = Object.values(files).map(bytes => Buffer.from(bytes).toString('utf8')).join('\n')
    expect(body.includes('PRIVATE_TEST_INPUT')).toBe(includePrivate); expect(body.includes('PRIVATE_EXPECTED')).toBe(includePrivate)
  })

  it('preflights all project pins before exporting any private data, even for the first allowed run', async () => {
    const f = await fixture(), foreign = await f.runtime.run(echo, 'FOREIGN_SECRET')
    const selection = { ...f.selection, runs: [...f.selection.runs, { id: foreign.id, revision: foreign.revision }] }
    await expect(f.session.operation({ ...f.command, selection, includePrivate: true })).rejects.toMatchObject({ code: 'not-found' })
    expect(f.call.mock.calls.every(([command]) => command.operation === 'runs.show')).toBe(true)
  })

  it.each(['revision', 'duplicate', 'empty', 'too-many', 'actor', 'privacy', 'unknown'] as const)('refuses malformed %s before owner reads', async mode => {
    const f = await fixture(), command: any = structuredClone(f.command)
    if (mode === 'revision') command.selection.runs[0].revision = '0'.repeat(64)
    if (mode === 'duplicate') command.selection.runs[1] = command.selection.runs[0]
    if (mode === 'empty') command.selection.runs = []
    if (mode === 'too-many') command.selection.runs = Array.from({ length: 101 }, () => ({ id: randomUUID(), revision: f.session.pin.revision }))
    if (mode === 'actor') command.actor = 'spoofed'
    if (mode === 'privacy') command.includePrivate = 'true'
    if (mode === 'unknown') command.selection.extra = 'foreign'
    await expect(f.session.operation(command)).rejects.toMatchObject({ code: mode === 'revision' ? 'not-found' : 'invalid-command' })
    expect(f.call).not.toHaveBeenCalled()
  })

  it('rechecks scope before capture and rejects a mismatched owner read without exporting', async () => {
    const f = await fixture(); let reads = 0
    f.call.mockImplementation(async command => {
      const value: any = await dispatchOperation({ storage: 'sqlite', runtime: f.runtime }, command, 'fixture')
      if (command.operation === 'runs.show' && ++reads > f.selection.runs.length) return { ...value, project: { id: randomUUID(), generation: 1 } }
      return value
    })
    await expect(f.session.operation(f.command)).rejects.toMatchObject({ code: 'not-found' })
    expect(f.call.mock.calls.some(([command]) => command.operation === 'runs.export')).toBe(false)
  })

  it('detaches caller selection and privacy before the first asynchronous scoped read', async () => {
    const f = await fixture(), command = { ...f.command, includePrivate: false }, original = structuredClone(f.selection)
    const pending = f.session.operation(command)
    command.selection.runs[0]!.id = randomUUID(); command.includePrivate = true
    const value: any = await pending
    expect(value.selection).toEqual(original); expect(value.privacy).toBe('metadata-only')
    await prepareEvidenceBundleDownload(original, value)
  })

  it('refuses archives above the preview transport cap without changing storage', async () => {
    const f = await fixture(), before = await f.runtime.events(f.first.id)
    vi.spyOn(packages, 'createEvidenceZip').mockResolvedValue({ bytes: Buffer.alloc(12_000_001) } as any)
    await expect(f.session.operation(f.command)).rejects.toMatchObject({ code: 'limit' })
    expect(await f.runtime.events(f.first.id)).toEqual(before)
  })
})

describe('browser-safe selected ZIP byte admission', () => {
  it.each(['checksum', 'selection-hash', 'selection', 'privacy', 'size', 'base64', 'status', 'restoration', 'extra',
    'evidence-path', 'test-path', 'assessment', 'test-identity', 'run-extra'] as const)('rejects %s mismatch', async mode => {
    const f = await fixture(), value: any = await f.session.operation(f.command)
    if (mode === 'checksum') value.sha256 = '0'.repeat(64)
    if (mode === 'selection-hash') value.selectionSha256 = '0'.repeat(64)
    if (mode === 'selection') value.selection.runs.reverse()
    if (mode === 'privacy') value.privacy = 'private-execution-data'
    if (mode === 'size') value.bytes++
    if (mode === 'base64') value.base64 = value.base64.slice(0, -1) + '!'
    if (mode === 'status') value.runs[0].workflowStatus = 'success'
    if (mode === 'restoration') value.restoration = 'supported'
    if (mode === 'extra') value.token = 'PRIVATE_TOKEN'
    if (mode === 'evidence-path') value.runs[0].evidencePath = 'runs/other.json'
    if (mode === 'test-path') value.runs[1].testPath = 'tests/other.json'
    if (mode === 'assessment') value.runs[1].assessment = 'invented'
    if (mode === 'test-identity') value.runs[1].test.generation = 0
    if (mode === 'run-extra') value.runs[0].privateInput = 'PRIVATE_TOKEN'
    await expect(prepareEvidenceBundleDownload(f.selection, value)).rejects.toThrow()
  })
  it('pins receipt bytes/selection across asynchronous digest', async () => {
    const f = await fixture(), value: any = await f.session.operation(f.command), original = Buffer.from(value.base64, 'base64')
    const pending = prepareEvidenceBundleDownload(f.selection, value)
    value.base64 = ''; value.sha256 = '0'.repeat(64); f.selection.runs[0]!.id = randomUUID()
    expect(Buffer.from((await pending).bytes)).toEqual(original)
  })
  it('refuses altered archive contents and unexpected paths before in-page display', async () => {
    const f = await fixture(), response: any = await f.session.operation(f.command)
    const verified = await prepareEvidenceBundleDownload(f.selection, response)
    const { unzipSync, zipSync } = await import('fflate')
    const files = unzipSync(verified.bytes)
    const runBytes = files[`runs/${f.first.id}.json`]!
    runBytes[0] = (runBytes[0] ?? 0) ^ 1
    const changed = zipSync(files), digest = (await import('node:crypto')).createHash('sha256').update(changed).digest('hex')
    await expect(inspectPreviewEvidenceArchive(changed, f.selection, digest, 'metadata-only')).rejects.toThrow()
    const original = unzipSync(verified.bytes)
    original['../outside.json'] = original['README.txt']!
    const extra = zipSync(original), extraDigest = (await import('node:crypto')).createHash('sha256').update(extra).digest('hex')
    await expect(inspectPreviewEvidenceArchive(extra, f.selection, extraDigest, 'metadata-only')).rejects.toThrow()
  })
})

/** Serialized controller intent only; these doubles do not qualify any browser. */
class Element {
  hidden = false; disabled = false; checked = false; textContent = ''; href = ''; download = ''; value = ''
  children: Element[] = []
  listeners = new Map<string, () => void>()
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, fn) }
  removeAttribute(name: string) { if (name === 'href') this.href = ''; if (name === 'download') this.download = '' }
  replaceChildren() { this.children = [] }
  append(child: Element) { this.children.push(child) }
  click() { this.listeners.get('click')?.() }
}
async function controllerFixture(showSaveFilePicker?: (options: any) => Promise<any>) {
  const f = await fixture(), elements = new Map<string, Element>(), events = new Map<string, () => void>(), blobs: Blob[] = []
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)! }
  let scope: string | undefined = 'session-one', current = { runId: f.first.id, revision: f.first.revision }
  const request = vi.fn((command: any): Promise<unknown> => f.session.operation(command))
  const createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return `blob:bundle-${blobs.length}` }), revokeObjectURL = vi.fn()
  const controller = runInNewContext(`(${liveEvidenceBundleControls.toString()})(ctx, ${prepareEvidenceBundleDownload.toString()})`, {
    ctx: { request, scope: () => scope, current: () => current }, document: { getElementById: get, createElement: () => new Element() },
    window: { addEventListener: (name: string, fn: () => void) => events.set(name, fn), showSaveFilePicker,
      jevableEvidenceArchive: (bytes: Uint8Array, selection: any, sha: string, privacy: any) =>
        inspectPreviewEvidenceArchive(new Uint8Array(bytes), selection, sha, privacy) },
    URL: { createObjectURL, revokeObjectURL }, Blob, TextEncoder, crypto: webcrypto, atob, btoa,
  }) as ReturnType<typeof liveEvidenceBundleControls>
  return { ...f, request, get, events, blobs, createObjectURL, revokeObjectURL, controller,
    select(value: typeof current) { current = value; controller.observe() }, scope(value?: string) { scope = value; controller.observe() } }
}
describe('serialized ZIP selection/download controls (not browser qualification)', () => {
  it('requires explicit additions, exports the exact selection, and never triggers a save', async () => {
    const f = await controllerFixture(); expect(f.request).not.toHaveBeenCalled(); expect(f.get('bundle-prepare').disabled).toBe(true)
    expect(f.get('bundle-save-file').hidden).toBe(true)
    f.get('bundle-add').click(); f.get('bundle-add').click()
    f.select({ runId: f.tested.run.id, revision: f.tested.run.revision }); f.get('bundle-add').click()
    f.get('bundle-prepare').click(); f.get('bundle-prepare').click()
    await vi.waitFor(() => expect(f.get('bundle-download').hidden).toBe(false))
    expect(f.request).toHaveBeenCalledExactlyOnceWith(f.command)
    const inspected = await inspectEvidenceZip(new Uint8Array(await f.blobs[0]!.arrayBuffer()))
    expect(inspected.runs).toHaveLength(2); expect(f.get('bundle-download').download).toMatch(/^jevable-evidence-[a-f0-9]{16}-metadata.zip$/)
    expect(f.get('bundle-review').hidden).toBe(false)
    expect(f.get('bundle-full-review').hidden).toBe(false)
    expect(f.get('bundle-full-list').children).toHaveLength(6)
    expect(f.get('bundle-review-list').children.map(row => row.textContent)).toEqual([
      `Run ${f.first.id.slice(0, 8)}… · Workflow: Completed · No saved test result`,
      `Run ${f.tested.run.id.slice(0, 8)}… · Workflow: Completed · Saved test: Failed`,
    ])
    expect(f.get('bundle-message').textContent).toContain('complete evidence is readable')
  })
  it('uses an explicit supported file picker to write the exact verified ZIP once', async () => {
    let saved: Uint8Array | undefined
    const write = vi.fn(async (bytes: Uint8Array) => { saved = new Uint8Array(bytes) })
    const close = vi.fn(async () => {}), abort = vi.fn(async () => {})
    const picker = vi.fn(async (_options: unknown) => ({ createWritable: async () => ({ write, close, abort }) }))
    const f = await controllerFixture(picker)
    f.get('bundle-add').click(); f.get('bundle-prepare').click()
    await vi.waitFor(() => expect(f.get('bundle-save-file').hidden).toBe(false))
    expect(picker).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
    f.get('bundle-save-file').click()
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(picker).toHaveBeenCalledExactlyOnceWith({ suggestedName: f.get('bundle-download').download,
      types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] })
    expect(saved).toEqual(new Uint8Array(await f.blobs[0]!.arrayBuffer()))
    expect((await inspectEvidenceZip(saved!)).runs).toHaveLength(1)
    expect(abort).not.toHaveBeenCalled(); expect(f.get('bundle-message').textContent).toContain('browser reported')
  })
  it('does not write after selection is cleared while the file picker is open', async () => {
    const pending = Promise.withResolvers<any>(), write = vi.fn(), createWritable = vi.fn()
    const f = await controllerFixture(() => pending.promise)
    f.get('bundle-add').click(); f.get('bundle-prepare').click()
    await vi.waitFor(() => expect(f.get('bundle-save-file').hidden).toBe(false))
    f.get('bundle-save-file').click(); f.get('bundle-clear').click()
    expect(f.get('bundle-add').disabled).toBe(false)
    pending.resolve({ createWritable }); await new Promise(resolve => setImmediate(resolve))
    expect(createWritable).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
    expect(f.get('bundle-save-file').hidden).toBe(true); expect(f.get('bundle-download').hidden).toBe(true)
  })
  it('keeps a new save locked while an invalidated old picker returns', async () => {
    const oldPicker = Promise.withResolvers<any>(), newPicker = Promise.withResolvers<any>()
    const oldWritable = vi.fn(), newWrite = vi.fn(async () => {}), newClose = vi.fn(async () => {})
    const picker = vi.fn().mockImplementationOnce(() => oldPicker.promise).mockImplementationOnce(() => newPicker.promise)
    const f = await controllerFixture(picker)
    f.get('bundle-add').click(); f.get('bundle-prepare').click()
    await vi.waitFor(() => expect(f.get('bundle-save-file').hidden).toBe(false))
    f.get('bundle-save-file').click(); f.get('bundle-clear').click()
    expect(f.get('bundle-add').disabled).toBe(false)
    f.get('bundle-add').click(); f.get('bundle-prepare').click()
    await vi.waitFor(() => expect(f.blobs).toHaveLength(2))
    f.get('bundle-save-file').click()
    expect(f.get('bundle-save-file').disabled).toBe(true)
    oldPicker.resolve({ createWritable: oldWritable }); await new Promise(resolve => setImmediate(resolve))
    expect(oldWritable).not.toHaveBeenCalled()
    expect(f.get('bundle-save-file').disabled).toBe(true)
    newPicker.resolve({ createWritable: async () => ({ write: newWrite, close: newClose, abort: vi.fn() }) })
    await vi.waitFor(() => expect(newClose).toHaveBeenCalledOnce())
    expect(newWrite).toHaveBeenCalledOnce()
    expect(f.get('bundle-save-file').disabled).toBe(false)
  })
  it('aborts an in-progress file write if the session changes before close', async () => {
    const pending = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
    const abort = vi.fn(async () => {}), close = vi.fn(async () => {})
    const f = await controllerFixture(async () => ({ createWritable: async () => ({
      write: async (_bytes: Uint8Array) => { started.resolve(); await pending.promise }, close, abort,
    }) }))
    f.get('bundle-add').click(); f.get('bundle-prepare').click()
    await vi.waitFor(() => expect(f.get('bundle-save-file').hidden).toBe(false))
    f.get('bundle-save-file').click(); await started.promise
    f.scope('session-two'); pending.resolve()
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce())
    expect(close).not.toHaveBeenCalled(); expect(f.get('bundle-download').hidden).toBe(true)
    expect(f.get('bundle-message').textContent).not.toContain('finished saving')
  })
  it('does not claim a save on picker cancellation or failed file write', async () => {
    const cancelled = await controllerFixture(async () => { throw Object.assign(Error('cancelled'), { name: 'AbortError' }) })
    cancelled.get('bundle-add').click(); cancelled.get('bundle-prepare').click()
    await vi.waitFor(() => expect(cancelled.get('bundle-save-file').hidden).toBe(false))
    cancelled.get('bundle-save-file').click()
    await vi.waitFor(() => expect(cancelled.get('bundle-message').textContent).toContain('Saving was cancelled'))
    const abort = vi.fn(async () => {})
    const failed = await controllerFixture(async () => ({ createWritable: async () => ({
      write: async () => { throw Error('PRIVATE_WRITE_ERROR') }, close: vi.fn(), abort,
    }) }))
    failed.get('bundle-add').click(); failed.get('bundle-prepare').click()
    await vi.waitFor(() => expect(failed.get('bundle-save-file').hidden).toBe(false))
    failed.get('bundle-save-file').click()
    await vi.waitFor(() => expect(failed.get('bundle-message').textContent).toContain('could not confirm saving'))
    expect(abort).toHaveBeenCalledOnce()
    expect(failed.get('bundle-message').textContent).not.toContain('PRIVATE_WRITE_ERROR')
  })
  it('consumes consent once and invalidates prepared bytes on edits or disconnect', async () => {
    const f = await controllerFixture(); f.get('bundle-add').click(); f.get('bundle-private').checked = true; f.get('bundle-prepare').click()
    expect(f.get('bundle-private').checked).toBe(false)
    await vi.waitFor(() => expect(f.get('bundle-download').hidden).toBe(false))
    expect(f.request.mock.calls[0]![0].includePrivate).toBe(true)
    f.get('bundle-remove').click(); expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:bundle-1'); expect(f.get('bundle-download').hidden).toBe(true)
    expect(f.get('bundle-review').hidden).toBe(true); expect(f.get('bundle-review-list').children).toHaveLength(0)
    expect(f.get('bundle-full-review').hidden).toBe(true); expect(f.get('bundle-full-list').children).toHaveLength(0)
    f.get('bundle-add').click(); f.get('bundle-prepare').click()
    await vi.waitFor(() => expect(f.blobs).toHaveLength(2))
    expect(f.request.mock.calls[1]![0].includePrivate).toBeUndefined()
    f.scope(); expect(f.get('bundle-selection').value).toBe(''); expect(f.get('bundle-download').href).toBe('')
    expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:bundle-2')
  })
  it.each(['clear', 'disconnect', 'scope', 'pagehide'])('discards an in-flight archive after %s', async action => {
    const f = await controllerFixture(), pending = Promise.withResolvers<unknown>()
    f.request.mockImplementation(() => pending.promise); f.get('bundle-add').click(); f.get('bundle-prepare').click()
    const command = f.request.mock.calls[0]![0]
    if (action === 'clear') f.get('bundle-clear').click()
    if (action === 'disconnect') f.scope()
    if (action === 'scope') f.scope('session-two')
    if (action === 'pagehide') f.events.get('pagehide')!()
    pending.resolve(await f.session.operation(command)); await new Promise(resolve => setImmediate(resolve))
    expect(f.createObjectURL).not.toHaveBeenCalled(); expect(f.get('bundle-download').hidden).toBe(true)
  })
  it('sanitizes errors without automatic retries or workflow actions', async () => {
    const f = await controllerFixture(); f.request.mockRejectedValue(Error('PRIVATE_FAILURE'))
    f.get('bundle-add').click(); f.get('bundle-prepare').click()
    await vi.waitFor(() => expect(f.get('bundle-prepare').disabled).toBe(false))
    expect(f.request).toHaveBeenCalledOnce(); expect(f.get('bundle-message').textContent).not.toContain('PRIVATE_FAILURE')
    expect(f.createObjectURL).not.toHaveBeenCalled()
  })
})
