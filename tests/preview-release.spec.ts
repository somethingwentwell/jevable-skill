import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { unzipSync } from 'fflate'
import { LocalRuntime } from '../src/runtime/local.ts'
import { dispatchOperation, type RuntimeOperation } from '../src/http/operations.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import * as zip from '../src/packages/release-zip.ts'
import { previewReleaseTools } from '../src/preview/release-download.ts'
import { liveReleaseControls } from '../src/preview/release-controls.ts'
import { inspectEvidenceZip } from '../src/evidence/inspect.ts'
import { inspectRelease, releaseNotesSchema } from '../src/releases/snapshot.ts'
import { WorkflowRuntimeError } from '../src/runtime/errors.ts'

const source = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = [], hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); vi.restoreAllMocks() })
async function fixture() {
  const runtime = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-preview-release-')) }); owners.push(runtime)
  // Protocol/unit fixture only; independent-package checks execute the actual installed runtime.
  const artifact = (storage: 'sqlite' | 'postgres' = 'sqlite') => {
    const bytes = Buffer.from(`export const fixture = ${JSON.stringify(storage)};`)
    return { bytes, storage, notices: Buffer.from('fixture runtime'), identity: { version: CORE_VERSION, sha256: hash(bytes) } }
  }
  vi.spyOn(zip, 'loadReleaseRuntime').mockImplementation(async storage => artifact(storage))
  vi.spyOn(zip, 'loadReleaseRuntimeForIdentity').mockImplementation(async identity => {
    const result = ['sqlite', 'postgres'].map(s => artifact(s as 'sqlite' | 'postgres')).find(a => a.identity.sha256 === identity.sha256)
    if (!result) throw Error('Unknown fixture runtime'); return result
  })
  const call = vi.fn((command: RuntimeOperation) => dispatchOperation({ storage: 'sqlite', runtime }, command, 'fixture'))
  const session = await PreviewSession.create({ call }, source)
  const run: any = await session.operation({ operation: 'run', id: randomUUID(), input: { message: 'PRIVATE_RELEASE_INPUT' } })
  const selection = { schemaVersion: 1, runs: [{ id: run.id, revision: run.revision }] }
  call.mockClear()
  return { runtime, call, session, run, selection, artifact,
    create: (storage = 'sqlite', version = '1.0.0', id = randomUUID(), notes?: string) => session.operation({ operation: 'release.create', id, version, storage,
      ...(notes === undefined ? {} : { notes }) }) as Promise<any> }
}
describe('preview release protocol: scoped packaging, no execution', () => {
  it('lists existing versions for the exact snapshot, omitting notes/source/actors and preserving the waiting run', async () => {
    const f = await fixture(), receipt = await f.create('sqlite', '1.0.0', randomUUID(), 'PRIVATE_NOTES')
    const before = await f.runtime.events(f.run.id); f.call.mockClear()
    const page: any = await f.session.operation({ operation: 'release.list' })
    expect(page).toMatchObject({ project: f.session.pin, nextCursor: null, execution: 'not-run' })
    expect(page.releases).toEqual([{ ...receipt, notes: undefined }].map(({ notes: _notes, ...r }) => r))
    expect(JSON.stringify(page)).not.toContain('PRIVATE_NOTES'); expect(JSON.stringify(page)).not.toContain('createdBy')
    expect(JSON.stringify(page)).not.toContain('PRIVATE_RELEASE_INPUT'); expect(JSON.stringify(page)).not.toContain('yaml')
    expect(previewReleaseTools().page(page, f.session.pin)).toEqual(page)
    expect(f.call.mock.calls.map(([c]) => c.operation)).toEqual(['releases.list', 'releases.show'])
    expect(await f.runtime.events(f.run.id)).toEqual(before); expect(f.runtime.releases()).toHaveLength(1)
  })
  it('keeps foreign release UUIDs inside opaque cursors and follows an empty matching page', async () => {
    const f = await fixture(), foreign = await PreviewSession.create({ call: f.call }, source)
    const ids: string[] = []
    for (let i = 1; i <= 25; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`; ids.push(id)
      await foreign.operation({ operation: 'release.create', id, version: `1.0.${i}`, storage: 'sqlite' })
    }
    const mine = await f.create('postgres', '1.0.0', 'ffffffff-ffff-4fff-8fff-ffffffffffff'); f.call.mockClear()
    const first: any = await f.session.operation({ operation: 'release.list' })
    expect(first.releases).toEqual([]); expect(first.nextCursor).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(first)).not.toContain(foreign.pin.id); for (const id of ids) expect(JSON.stringify(first)).not.toContain(id)
    expect(f.call.mock.calls).toHaveLength(1)
    const second: any = await f.session.operation({ operation: 'release.list', cursor: first.nextCursor })
    expect(second.releases).toEqual([mine]); expect(second.nextCursor).toBeNull()
    expect(f.call.mock.calls[1]![0]).toEqual({ operation: 'releases.list', page: { limit: 25, after: ids.at(-1) } })
    expect(f.call.mock.calls.filter(([c]) => c.operation === 'releases.show').map(([c]) => (c as any).id)).toEqual([mine.id])
  })
  it.each([{ cursor: 'a'.repeat(64) }, { cursor: 'not-a-cursor' }, { project: {} }, { page: { after: randomUUID() } }, { actor: 'spoof' }])('rejects foreign/invalid list authority %j before owner reads', async extra => {
    const f = await fixture(); f.call.mockClear()
    await expect(f.session.operation({ operation: 'release.list', ...extra })).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.call).not.toHaveBeenCalled()
  })
  it('rejects inconsistent paged owner metadata without exporting or creating', async () => {
    const f = await fixture(); await f.create(); const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async command => { const value: any = await original(command); return command.operation === 'releases.list'
      ? { ...value, releases: value.releases.map((r: any) => ({ ...r, sha256: '0'.repeat(64) })) } : value })
    f.call.mockClear(); await expect(f.session.operation({ operation: 'release.list' })).rejects.toHaveProperty('code', 'corrupt')
    expect(f.call.mock.calls.map(([c]) => c.operation)).toEqual(['releases.list', 'releases.show'])
  })
  it('shows unavailable historical runtime identities without substituting a current bundle', async () => {
    const f = await fixture(), current = await f.create()
    const old = f.runtime.createRelease({ id: randomUUID(), projectId: f.session.pin.id, expectedGeneration: 1,
      revision: f.session.pin.revision, version: '0.9.0', runtime: { version: CORE_VERSION, sha256: '0'.repeat(64) }, actor: 'fixture' })
    vi.spyOn(zip, 'loadReleaseRuntimeForIdentity').mockImplementation(async identity => {
      if (identity.sha256 === '0'.repeat(64)) throw new WorkflowRuntimeError('conflict')
      return f.artifact('sqlite')
    })
    const page: any = await f.session.operation({ operation: 'release.list' })
    expect(page.releases.find((r: any) => r.id === old.snapshot.id)).toMatchObject({ storage: null, runtime: old.snapshot.runtime })
    expect(page.releases.find((r: any) => r.id === current.id)).toEqual(current)
    expect(previewReleaseTools().page(page, f.session.pin)).toEqual(page)
    expect(() => previewReleaseTools().receipt(page.releases.find((r: any) => r.id === old.snapshot.id), f.session.pin, old.snapshot.id)).toThrow()
  })
  it('refuses expired cursors before reading the owner', async () => {
    const f = await fixture(), original = f.call.getMockImplementation()!, foreignId = randomUUID()
    f.call.mockImplementation(async command => command.operation === 'releases.list' ? {
      schemaVersion: 2, releases: [{ format: 'jevable.ai/release', schemaVersion: 1, id: foreignId, version: '1.0.0',
        createdAt: new Date().toISOString(), createdBy: 'foreign', project: { id: randomUUID(), generation: 1 },
        runtime: f.artifact().identity, sha256: 'a'.repeat(64) }], nextCursor: foreignId,
    } : original(command))
    const page: any = await f.session.operation({ operation: 'release.list' }), now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 15 * 60 * 1000 + 1); f.call.mockClear()
    await expect(f.session.operation({ operation: 'release.list', cursor: page.nextCursor })).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.call).not.toHaveBeenCalled()
  })
  it('retains the 10000-row scan limit even when every page belongs to other projects', async () => {
    const f = await fixture(), foreignProject = randomUUID(), original = f.call.getMockImplementation()!
    f.call.mockImplementation(async command => {
      if (command.operation !== 'releases.list') return original(command)
      const start = Number(command.page?.after?.slice(-12) ?? 0)
      const releases = Array.from({ length: 25 }, (_, i) => ({ format: 'jevable.ai/release', schemaVersion: 1,
        id: `00000000-0000-4000-8000-${String(start + i + 1).padStart(12, '0')}`, version: '1.0.0',
        createdAt: '2026-10-13T00:00:00.000Z', createdBy: 'foreign', project: { id: foreignProject, generation: 1 },
        runtime: f.artifact().identity, sha256: 'a'.repeat(64) }))
      return { schemaVersion: 2, releases, nextCursor: releases.at(-1)!.id }
    })
    let cursor: string | undefined
    for (let i = 0; i < 400; i++) {
      const page: any = await f.session.operation({ operation: 'release.list', ...(cursor ? { cursor } : {}) })
      expect(page.releases).toEqual([]); cursor = page.nextCursor
    }
    await expect(f.session.operation({ operation: 'release.list', cursor })).rejects.toHaveProperty('code', 'limit')
    expect(f.call.mock.calls.every(([c]) => c.operation === 'releases.list')).toBe(true)
  })
  it.each(['notes', 'actor', 'duplicate', 'foreign-project', 'invalid-cursor', 'wrong-execution'] as const)('serialized list parser refuses %s', async mode => {
    const f = await fixture(); await f.create(); const page: any = await f.session.operation({ operation: 'release.list' })
    if (mode === 'notes') page.releases[0].notes = 'PRIVATE_NOTES'
    if (mode === 'actor') page.releases[0].createdBy = 'PRIVATE_ACTOR'
    if (mode === 'duplicate') page.releases.push(page.releases[0])
    if (mode === 'foreign-project') page.project.id = randomUUID()
    if (mode === 'invalid-cursor') page.nextCursor = randomUUID()
    if (mode === 'wrong-execution') page.execution = 'completed'
    const tools = runInNewContext(`(${previewReleaseTools.toString()})()`, { TextEncoder, crypto: webcrypto, atob, btoa })
    expect(() => tools.page(page, f.session.pin)).toThrow()
  })
  it.each(['sqlite', 'postgres'])('preserves exact notes in scoped %s receipts/ZIP metadata without changing retained work', async storage => {
    const f = await fixture(), before = await f.runtime.events(f.run.id), notes = '\ufeff  保留审批 ✨\r\n\t<script>plain text</script>\n'
    const receipt = await f.create(storage, '1.0.0', randomUUID(), notes)
    expect(receipt.notes).toBe(notes)
    expect(f.call.mock.calls[0]![0]).toMatchObject({ operation: 'releases.create', notes })
    expect(await f.session.operation({ operation: 'release.show', id: receipt.id })).toEqual(receipt)
    const envelope = await f.session.operation({ operation: 'release.export', id: receipt.id, releaseSha256: receipt.releaseSha256 })
    const files = unzipSync((await previewReleaseTools().download(receipt, envelope)).bytes)
    expect(JSON.parse(Buffer.from(files['release.json']!).toString()).snapshot.notes).toBe(notes)
    expect(await f.runtime.events(f.run.id)).toEqual(before)
    expect((await f.runtime.show(f.run.id)).state.status).toBe('waiting')
  })
  it.each(['', ' \t\r\n', 'bad\u0000', 'bad\u001b', '\ud800', '😀'.repeat(4097), null, 1])('rejects invalid scoped notes before owner calls (case %#)', async notes => {
    const f = await fixture()
    await expect(f.session.operation({ operation: 'release.create', id: randomUUID(), version: '1.0.0', storage: 'sqlite', notes })).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.call).not.toHaveBeenCalled(); expect(f.runtime.releases()).toHaveLength(0)
  })
  it('refuses consistent-hash owner alteration of reviewed notes after retaining the actual release', async () => {
    const f = await fixture(), id = randomUUID(), original = f.call.getMockImplementation()!
    f.call.mockImplementation(async command => {
      const value: any = await original(command)
      return command.operation === 'releases.create' ? inspectRelease({ ...value.snapshot, notes: 'altered by owner' }) : value
    })
    await expect(f.create('sqlite', '1.0.0', id, 'reviewed')).rejects.toHaveProperty('code', 'corrupt')
    expect(f.runtime.release(id).snapshot.notes).toBe('reviewed')
    expect(await f.session.operation({ operation: 'release.show', id })).toMatchObject({ notes: 'reviewed' })
  })
  it.each(['sqlite', 'postgres'])('creates and exports a pinned %s app without evidence by default', async storage => {
    const f = await fixture(), before = await f.runtime.events(f.run.id), receipt = await f.create(storage)
    expect(receipt).toMatchObject({ project: f.session.pin, storage, execution: 'not-run' })
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_RELEASE_INPUT')
    expect(await f.session.operation({ operation: 'release.show', id: receipt.id })).toEqual(receipt)
    const response = await f.session.operation({ operation: 'release.export', id: receipt.id, releaseSha256: receipt.releaseSha256 })
    const result = await previewReleaseTools().download(receipt, response), files = unzipSync(result.bytes)
    expect(files['evidence.zip']).toBeUndefined(); expect(Buffer.from(files['runtime.mjs']!)).toEqual(f.artifact(storage as 'sqlite' | 'postgres').bytes)
    expect(JSON.parse(Buffer.from(files['release.json']!).toString()).sha256).toBe(receipt.releaseSha256)
    expect(await f.runtime.events(f.run.id)).toEqual(before); expect((await f.runtime.show(f.run.id)).state.status).toBe('waiting')
    expect(f.call.mock.calls.map(([c]) => c.operation)).toEqual(['releases.create', 'releases.show', 'releases.show'])
  })
  it.each([false, true])('attaches exact reviewed evidence; private=%s', async includePrivate => {
    const f = await fixture(), receipt = await f.create(), bundle: any = await f.session.operation({ operation: 'evidence.bundle', selection: f.selection, includePrivate })
    const before = await f.runtime.events(f.run.id)
    const response = await f.session.operation({ operation: 'release.export', id: receipt.id, releaseSha256: receipt.releaseSha256,
      evidence: { selection: f.selection, sha256: bundle.sha256, includePrivate } })
    const downloaded = await previewReleaseTools().download(receipt, response, { sha256: bundle.sha256, selectionSha256: bundle.selectionSha256, privacy: bundle.privacy })
    const files = unzipSync(downloaded.bytes), evidence = await inspectEvidenceZip(files['evidence.zip']!, bundle.sha256)
    expect(Buffer.from(files['evidence.zip']!)).toEqual(Buffer.from(bundle.base64, 'base64'))
    expect(evidence.runs[0]!.workflowStatus).toBe('waiting'); expect(await f.runtime.events(f.run.id)).toEqual(before)
    expect(Buffer.from(files['README.txt']!).toString()).toContain('includes evidence.zip, including any private payloads')
  })
  it.each(['release-hash', 'evidence-hash', 'privacy', 'foreign-run', 'foreign-release'] as const)('refuses %s without new execution or release mutation', async mode => {
    const f = await fixture(), receipt = await f.create(), bundle: any = await f.session.operation({ operation: 'evidence.bundle', selection: f.selection, includePrivate: true })
    const command: any = { operation: 'release.export', id: receipt.id, releaseSha256: receipt.releaseSha256,
      evidence: { selection: f.selection, sha256: bundle.sha256, includePrivate: true } }
    if (mode === 'release-hash') command.releaseSha256 = '0'.repeat(64)
    if (mode === 'evidence-hash') command.evidence.sha256 = '0'.repeat(64)
    if (mode === 'privacy') command.evidence.includePrivate = false
    if (mode === 'foreign-run') {
      const run = await f.runtime.run(source, { message: 'unrelated' }); command.evidence.selection = { schemaVersion: 1, runs: [{ id: run.id, revision: run.revision }] }
    }
    if (mode === 'foreign-release') {
      const other = await PreviewSession.create({ call: f.call }, source)
      const foreign: any = await other.operation({ operation: 'release.create', id: randomUUID(), version: '1.0.0', storage: 'sqlite' })
      command.id = foreign.id; command.releaseSha256 = foreign.releaseSha256
    }
    const before = await f.runtime.events(f.run.id), releases = f.runtime.releases(); f.call.mockClear()
    await expect(f.session.operation(command)).rejects.toThrow()
    expect(await f.runtime.events(f.run.id)).toEqual(before); expect(f.runtime.releases()).toEqual(releases)
    expect(f.call.mock.calls.some(([c]) => ['projects.run', 'runs.advance', 'approvals.decide', 'releases.create'].includes(c.operation))).toBe(false)
    if (mode === 'foreign-run' || mode === 'foreign-release') expect(f.call.mock.calls.some(([c]) => c.operation === 'runs.export')).toBe(false)
  })
  it('retains a committed release after response loss and exposes it through read-only inspection', async () => {
    const f = await fixture(), id = randomUUID(), original = f.call.getMockImplementation()!
    f.call.mockImplementation(async command => { const value = await original(command); if (command.operation === 'releases.create') throw Error('lost response'); return value })
    await expect(f.create('sqlite', '1.0.0', id)).rejects.toThrow('lost response')
    expect(await f.session.operation({ operation: 'release.show', id })).toMatchObject({ id, project: f.session.pin })
    expect(f.runtime.releases()).toHaveLength(1)
  })
  it('rejects evidence that changed since review without restoring the old approval state', async () => {
    const f = await fixture(), receipt = await f.create(), bundle: any = await f.session.operation({ operation: 'evidence.bundle', selection: f.selection })
    await f.session.operation({ operation: 'decide', id: f.run.id, attemptId: f.run.attemptId, action: 'approve' })
    const before = await f.runtime.events(f.run.id)
    await expect(f.session.operation({ operation: 'release.export', id: receipt.id, releaseSha256: receipt.releaseSha256,
      evidence: { selection: f.selection, sha256: bundle.sha256 } })).rejects.toMatchObject({ code: 'conflict' })
    expect(await f.runtime.events(f.run.id)).toEqual(before); expect((await f.runtime.show(f.run.id)).state.status).toBe('completed')
  })
  it('rejects a ZIP above the preview limit without returning partial data', async () => {
    const f = await fixture(), receipt = await f.create()
    vi.spyOn(zip, 'createReleaseZip').mockReturnValue(Buffer.alloc(12_000_001))
    await expect(f.session.operation({ operation: 'release.export', id: receipt.id, releaseSha256: receipt.releaseSha256 })).rejects.toMatchObject({ code: 'limit' })
    expect(f.runtime.releases()).toHaveLength(1)
  })
  it.each([{ storage: 'auto' }, { actor: 'spoof' }, { version: '../unsafe' }, { runtime: { sha256: '0'.repeat(64) } }])('rejects malformed creation %j before owner calls', async overrides => {
    const f = await fixture()
    await expect(f.session.operation({ operation: 'release.create', id: randomUUID(), version: '1.0.0', storage: 'sqlite', ...overrides })).rejects.toMatchObject({ code: 'invalid-command' })
    expect(f.call).not.toHaveBeenCalled()
  })
  it('refuses stale project generation before saving a release', async () => {
    const f = await fixture()
    f.runtime.editProject({ operation: 'rename', id: f.session.pin.id, expectedGeneration: 1, title: 'Changed', actor: 'fixture' })
    await expect(f.create()).rejects.toMatchObject({ code: 'conflict' }); expect(f.runtime.releases()).toHaveLength(0)
  })
})
describe('release download admission', () => {
  it.each(['added', 'changed', 'removed'] as const)('refuses %s notes in ZIP receipt before offering bytes', async mode => {
    const f = await fixture(), receipt = await f.create('sqlite', '1.0.0', randomUUID(), mode === 'added' ? undefined : 'reviewed')
    const response: any = await f.session.operation({ operation: 'release.export', id: receipt.id, releaseSha256: receipt.releaseSha256 })
    if (mode === 'removed') delete response.release.notes
    else response.release.notes = 'unreviewed'
    await expect(previewReleaseTools().download(receipt, response)).rejects.toThrow('Release verification failed')
  })
  it.each(['', ' \n', 'bad\u0000', '\ud800', '😀'.repeat(4097), null, 12, '😀'.repeat(4096), 'é'.repeat(8192), 'ordinary\r\n\ttext', '\ufeff  <script>text</script>  '])('serialized browser note validator matches the owned core policy (case %#)', notes => {
    const browser = runInNewContext(`(${previewReleaseTools.toString()})()`, { TextEncoder }) as ReturnType<typeof previewReleaseTools>
    const valid = releaseNotesSchema.safeParse(notes).success
    if (valid) expect(browser.noteText(notes)).toBe(notes)
    else expect(() => browser.noteText(notes)).toThrow('Release verification failed')
  })
  it.each(['identity', 'runtime', 'privacy', 'checksum', 'base64', 'size', 'execution', 'extra'] as const)('rejects %s mismatch', async mode => {
    const f = await fixture(), receipt = await f.create(), response: any = await f.session.operation({ operation: 'release.export', id: receipt.id, releaseSha256: receipt.releaseSha256 })
    if (mode === 'identity') response.release.id = randomUUID()
    if (mode === 'runtime') response.release.runtime.sha256 = '0'.repeat(64)
    if (mode === 'privacy') response.evidence = { sha256: '0'.repeat(64), selectionSha256: '0'.repeat(64), privacy: 'private-execution-data' }
    if (mode === 'checksum') response.sha256 = '0'.repeat(64)
    if (mode === 'base64') response.base64 += '!'
    if (mode === 'size') response.bytes++
    if (mode === 'execution') response.execution = 'completed'
    if (mode === 'extra') response.token = 'secret'
    await expect(previewReleaseTools().download(receipt, response)).rejects.toThrow()
  })
  it('detaches expected identity and bytes before asynchronous digest', async () => {
    const f = await fixture(), receipt = await f.create(), response: any = await f.session.operation({ operation: 'release.export', id: receipt.id, releaseSha256: receipt.releaseSha256 })
    const bytes = Buffer.from(response.base64, 'base64'), pending = previewReleaseTools().download(receipt, response)
    receipt.id = randomUUID(); response.base64 = ''; expect(Buffer.from((await pending).bytes)).toEqual(bytes)
  })
})

class Element {
  hidden = false; disabled = false; checked = false; textContent = ''; href = ''; download = ''; value = ''
  listeners = new Map<string, () => void>()
  children: Element[] = []
  replaceChildren(...children: Element[]) { this.children = children }
  append(child: Element) { this.children.push(child) }
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, fn) }
  removeAttribute(name: string) { if (name === 'href') this.href = ''; if (name === 'download') this.download = '' }
  click() { this.listeners.get('click')?.() }
  set innerHTML(_value: string) { throw Error('Release controls must not render note text as HTML') }
}
async function controllerFixture() {
  const f = await fixture(), elements = new Map<string, Element>(), events = new Map<string, () => void>(), storage = new Map<string, string>(), blobs: Blob[] = []
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)! }
  get('release-version').value = '1.0.0'; get('release-storage').value = 'sqlite'
  let scope: string | undefined = 'session', evidence: any
  const request = vi.fn((command: any) => { if (command.operation === 'release.create') {
    const retained = JSON.parse(storage.get('release-key')!)
    expect(retained.id).toBe(command.id); expect(retained.notes).toBe(command.notes)
  } return f.session.operation(command) })
  const createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return `blob:release-${blobs.length}` }), revokeObjectURL = vi.fn()
  const store = vi.fn((key: string, value: string) => storage.set(key, value))
  const environment = {
    ctx: { request, storageKey: 'release-key', scope: () => scope, project: () => f.session.pin, evidence: () => evidence },
    document: { getElementById: get, createElement: () => new Element() }, window: { addEventListener: (name: string, fn: () => void) => events.set(name, fn) },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: store, removeItem: (key: string) => storage.delete(key) },
    URL: { createObjectURL, revokeObjectURL }, Blob, TextEncoder, crypto: webcrypto, atob, btoa,
  }
  const setup = () => runInNewContext(`(${liveReleaseControls.toString()})(ctx, (${previewReleaseTools.toString()})())`, environment) as ReturnType<typeof liveReleaseControls>
  const controls = setup()
  const create = async () => { get('release-create').click(); await vi.waitFor(() => expect(get('release-prepare').disabled).toBe(false)) }
  return { ...f, get, events, request, storage, store, setup, blobs, controls, create, createObjectURL, revokeObjectURL,
    scope: (value?: string) => { scope = value; controls.observe() },
    evidence: async (privateData = false) => { const value: any = await f.session.operation({ operation: 'evidence.bundle', selection: f.selection, includePrivate: privateData });
      evidence = { selection: f.selection, sha256: value.sha256, selectionSha256: value.selectionSha256, privacy: value.privacy }; controls.observe(); return evidence },
  }
}
describe('serialized release controls, not actual browser qualification', () => {
  it('reopens an existing saved version in a fresh controller through explicit list/show, without creation/export', async () => {
    const f = await controllerFixture(), created: any = await f.session.operation({ operation: 'release.create', id: randomUUID(), version: '1.0.0', storage: 'sqlite' })
    f.request.mockClear()
    f.get('release-saved-load').click(); await vi.waitFor(() => expect(f.get('release-saved-choice').disabled).toBe(false))
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.list'])
    expect(f.get('release-prepare').disabled).toBe(true)
    f.get('release-saved-choice').value = created.id; f.get('release-saved-choice').listeners.get('change')!()
    expect(f.request).toHaveBeenCalledOnce()
    f.get('release-saved-open').click(); await vi.waitFor(() => expect(f.get('release-prepare').disabled).toBe(false))
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.list', 'release.show'])
    expect(JSON.parse(f.storage.get('release-key')!).releaseSha256).toBe(created.releaseSha256)
    expect(f.runtime.releases()).toHaveLength(1)
    expect(f.createObjectURL).not.toHaveBeenCalled()
  })
  it('keeps failed list reads retryable and never retries on its own', async () => {
    const f = await controllerFixture(); f.request.mockRejectedValueOnce(Error('read failed'))
    f.get('release-saved-load').click(); await vi.waitFor(() => expect(f.get('release-saved-message').textContent).toContain('unavailable'))
    expect(f.get('release-saved-load').disabled).toBe(false); expect(f.request).toHaveBeenCalledOnce()
    expect(f.get('release-saved-open').disabled).toBe(true); expect(f.get('release-prepare').disabled).toBe(true)
  })
  it('refuses a changed selected release hash and never makes a ZIP available', async () => {
    const f = await controllerFixture(), receipt: any = await f.session.operation({ operation: 'release.create', id: randomUUID(), version: '1.0.0', storage: 'sqlite' })
    f.get('release-saved-load').click(); await vi.waitFor(() => expect(f.get('release-saved-choice').disabled).toBe(false))
    f.get('release-saved-choice').value = receipt.id; f.get('release-saved-choice').listeners.get('change')!()
    const original = f.request.getMockImplementation()!
    f.request.mockImplementationOnce(async c => ({ ...await original(c) as Record<string, unknown>, releaseSha256: '0'.repeat(64) }))
    f.get('release-saved-open').click(); await vi.waitFor(() => expect(f.get('release-message').textContent).toContain('unavailable or changed'))
    expect(f.get('release-prepare').disabled).toBe(true); expect(f.get('release-download').hidden).toBe(true)
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.list', 'release.show'])
    expect(f.storage.size).toBe(0); expect(f.runtime.releases()).toHaveLength(1)
  })
  it('restores a selected release only through explicit hash-pinned inspection after reload', async () => {
    const f = await controllerFixture(), receipt: any = await f.session.operation({ operation: 'release.create', id: randomUUID(), version: '1.0.0', storage: 'sqlite', notes: 'saved notes' })
    f.get('release-saved-load').click(); await vi.waitFor(() => expect(f.get('release-saved-choice').disabled).toBe(false))
    f.get('release-saved-choice').value = receipt.id; f.get('release-saved-choice').listeners.get('change')!(); f.get('release-saved-open').click()
    await vi.waitFor(() => expect(f.get('release-prepare').disabled).toBe(false)); f.request.mockClear(); f.setup()
    expect(f.request).not.toHaveBeenCalled(); expect(f.get('release-prepare').disabled).toBe(true)
    expect(JSON.parse(f.storage.get('release-key')!).releaseSha256).toBe(receipt.releaseSha256)
    f.get('release-inspect').click(); await vi.waitFor(() => expect(f.get('release-prepare').disabled).toBe(false))
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.show'])
    expect(JSON.parse(f.get('release-receipt').textContent).notes).toBe('saved notes')
  })
  it('clears/fences list reads and selections on pagehide without automatic pageshow reads', async () => {
    const f = await controllerFixture(); let resolve!: (value: unknown) => void
    f.request.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    f.get('release-saved-load').click(); f.events.get('pagehide')!()
    resolve({ schemaVersion: 1, format: 'jevable.ai/preview-release-page', project: f.session.pin, releases: [], nextCursor: null, execution: 'not-run' })
    await new Promise(r => setImmediate(r)); expect(f.get('release-saved-open').disabled).toBe(true)
    expect(f.get('release-saved-load').disabled).toBe(true); expect(f.get('release-saved-choice').children).toHaveLength(0)
    f.events.get('pageshow')!(); expect(f.request).toHaveBeenCalledOnce(); expect(f.get('release-saved-load').disabled).toBe(false)
  })
  it('keeps blank notes omitted and preserves the legacy retained-request/receipt shape', async () => {
    const f = await controllerFixture(); await f.create()
    expect(JSON.parse(f.storage.get('release-key')!)).not.toHaveProperty('notes')
    expect(f.request.mock.calls[0]![0]).not.toHaveProperty('notes')
    expect(JSON.parse(f.get('release-receipt').textContent)).not.toHaveProperty('notes')
  })
  it('retains exact publishable text before dispatch, locks it and renders only plain receipt text', async () => {
    const f = await controllerFixture(), notes = '\ufeff  <script>alert("no execution")</script> ✨\r\n\t'
    f.get('release-notes').value = notes; f.get('release-notes').listeners.get('input')!()
    expect(f.get('release-notes-size').textContent).toContain(String(Buffer.byteLength(notes)))
    await f.create()
    expect(f.get('release-notes').disabled).toBe(true)
    expect(JSON.parse(f.get('release-receipt').textContent).notes).toBe(notes)
    expect(JSON.parse(f.storage.get('release-key')!).notes).toBe(notes)
    expect(f.request.mock.calls[0]![0].notes).toBe(notes)
    f.get('release-notes').value = 'programmatically changed while locked'
    f.get('release-inspect').click(); await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(f.get('release-prepare').disabled).toBe(false))
    expect(f.request.mock.calls[1]![0]).toEqual({ operation: 'release.show', id: f.request.mock.calls[0]![0].id })
    expect(JSON.parse(f.get('release-receipt').textContent).notes).toBe(notes)
  })
  it.each([' \r\n\t', 'bad\u001b', '\ud800', '😀'.repeat(4097)])('rejects invalid note entry before retaining UUID or sending a request (case %#)', async notes => {
    const f = await controllerFixture(); f.get('release-notes').value = notes; f.get('release-create').click()
    expect(f.store).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled(); expect(f.runtime.releases()).toHaveLength(0)
    expect(f.get('release-message').textContent).toContain('Nothing was created')
  })
  it('restores frozen notes/UUID after lost response and inspects without resubmitting text', async () => {
    const f = await controllerFixture(), notes = 'reviewed before sending', original = f.request.getMockImplementation()!
    f.get('release-notes').value = notes
    f.request.mockImplementationOnce(async command => { await original(command); throw Error('lost response') })
    f.get('release-create').click(); await vi.waitFor(() => expect(f.get('release-inspect').disabled).toBe(false))
    const retained = JSON.parse(f.storage.get('release-key')!)
    f.get('release-notes').value = 'different unsaved draft'; f.setup()
    expect(f.get('release-notes').value).toBe(notes); expect(f.get('release-notes').disabled).toBe(true)
    expect(f.request).toHaveBeenCalledOnce()
    f.get('release-inspect').click(); await vi.waitFor(() => expect(f.get('release-prepare').disabled).toBe(false))
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.create', 'release.show'])
    expect(f.request.mock.calls[1]![0]).toEqual({ operation: 'release.show', id: retained.id })
    expect(JSON.parse(f.get('release-receipt').textContent).notes).toBe(notes)
    expect(f.runtime.releases()).toHaveLength(1)
  })
  it.each([null, '', '\ud800', '😀'.repeat(4097)])('refuses invalid restored notes without inspection/recreation (case %#)', async notes => {
    const f = await controllerFixture(); await f.create(); f.request.mockClear()
    f.storage.set('release-key', JSON.stringify({ ...JSON.parse(f.storage.get('release-key')!), notes }))
    f.setup(); f.get('release-inspect').click(); f.get('release-create').click()
    expect(f.request).not.toHaveBeenCalled(); expect(f.get('release-create').disabled).toBe(true)
    expect(f.get('release-message').textContent).toContain('unavailable or invalid')
  })
  it('refuses valid-but-altered restored note text rather than exporting a different review', async () => {
    const f = await controllerFixture(); f.get('release-notes').value = 'reviewed'; await f.create(); f.request.mockClear()
    f.storage.set('release-key', JSON.stringify({ ...JSON.parse(f.storage.get('release-key')!), notes: 'storage tampered' }))
    f.setup(); f.get('release-inspect').click()
    await vi.waitFor(() => expect(f.get('release-message').textContent).toContain('result unavailable'))
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.show'])
    expect(f.get('release-prepare').disabled).toBe(true); expect(f.runtime.releases()).toHaveLength(1)
  })
  it('prepares another version only after receipt review, preserving the prior release and explicit note draft', async () => {
    const f = await controllerFixture(); f.get('release-notes').value = 'first reviewed draft'; await f.create()
    const original = f.runtime.releases()[0]!
    f.get('release-new').click(); expect(f.get('release-notes').disabled).toBe(false); expect(f.storage.size).toBe(0)
    expect(f.get('release-notes').value).toBe('first reviewed draft'); expect(f.runtime.release(original.snapshot.id)).toEqual(original)
    f.get('release-version').value = '2.0.0'; f.get('release-notes').value = 'separately reviewed'; await f.create()
    expect(f.runtime.releases()).toHaveLength(2)
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.create', 'release.create'])
  })
  it('does not send creation when tab identity retention fails', async () => {
    const f = await controllerFixture(); f.store.mockImplementationOnce(() => { throw Error('storage denied') })
    f.get('release-create').click(); expect(f.request).not.toHaveBeenCalled(); expect(f.runtime.releases()).toHaveLength(0)
    expect(f.get('release-message').textContent).toContain('Nothing was created')
  })
  it('restores only the request identity and requires explicit inspection after reload', async () => {
    const f = await controllerFixture(); await f.create(); f.request.mockClear(); f.setup()
    expect(f.request).not.toHaveBeenCalled(); expect(f.get('release-prepare').disabled).toBe(true); expect(f.get('release-create').disabled).toBe(true)
    f.get('release-inspect').click(); await vi.waitFor(() => expect(f.get('release-prepare').disabled).toBe(false))
    expect(f.request).toHaveBeenCalledOnce(); expect(f.request.mock.calls[0]![0].operation).toBe('release.show')
  })
  it('retains creation identity first, requires explicit ZIP preparation and never clicks download', async () => {
    const f = await controllerFixture(); expect(f.request).not.toHaveBeenCalled(); await f.create()
    expect(f.request).toHaveBeenCalledOnce(); expect(f.createObjectURL).not.toHaveBeenCalled()
    f.get('release-prepare').click(); await vi.waitFor(() => expect(f.createObjectURL).toHaveBeenCalledOnce())
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.create', 'release.export'])
    expect(f.get('release-download').download).toMatch(/^jevable-release-.*-no-evidence.zip$/)
    f.controls.disconnect(); expect(f.storage.size).toBe(0); expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:release-1')
  })
  it.each(['disconnect', 'pagehide', 'evidence-change'] as const)('clears an already prepared ZIP announcement after %s', async mode => {
    const f = await controllerFixture(); await f.create()
    f.get('release-prepare').click(); await vi.waitFor(() => expect(f.createObjectURL).toHaveBeenCalledOnce())
    expect(f.get('release-message').textContent).toContain('Runnable ZIP ready')
    if (mode === 'disconnect') f.scope()
    if (mode === 'pagehide') f.events.get('pagehide')!()
    if (mode === 'evidence-change') await f.evidence()
    expect(f.get('release-message').textContent).toBe('')
    expect(f.get('release-download').hidden).toBe(true)
    expect(f.get('release-download').href).toBe('')
    expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:release-1')
  })
  it('requires separate private attachment consent and consumes it once', async () => {
    const f = await controllerFixture(); await f.create(); const evidence = await f.evidence(true)
    f.get('release-attach').checked = true; f.get('release-prepare').click(); expect(f.request).toHaveBeenCalledOnce()
    f.get('release-private').checked = true; f.get('release-prepare').click(); expect(f.get('release-private').checked).toBe(false)
    await vi.waitFor(() => expect(f.createObjectURL).toHaveBeenCalledOnce())
    expect(f.request.mock.calls[1]![0].evidence).toEqual({ selection: evidence.selection, sha256: evidence.sha256, includePrivate: true })
    f.get('release-prepare').click(); expect(f.request).toHaveBeenCalledTimes(2)
  })
  it('handles a lost create response through explicit read-only inspection, never duplicate creation', async () => {
    const f = await controllerFixture(), original = f.request.getMockImplementation()!
    f.request.mockImplementationOnce(async command => { await original(command); throw Error('PRIVATE_FAILURE') })
    f.get('release-create').click(); await vi.waitFor(() => expect(f.get('release-inspect').disabled).toBe(false))
    expect(f.get('release-create').disabled).toBe(true); expect(f.get('release-message').textContent).not.toContain('PRIVATE_FAILURE')
    f.get('release-inspect').click(); await vi.waitFor(() => expect(f.get('release-prepare').disabled).toBe(false))
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.create', 'release.show']); expect(f.runtime.releases()).toHaveLength(1)
  })
  it.each(['disconnect', 'pagehide', 'evidence-change'] as const)('discards a late download after %s', async mode => {
    const f = await controllerFixture(); await f.create()
    const original = f.request.getMockImplementation()!; let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.request.mockImplementationOnce(async command => { const value = await original(command); await gate; return value })
    f.get('release-prepare').click(); await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2))
    if (mode === 'disconnect') f.scope()
    if (mode === 'pagehide') f.events.get('pagehide')!()
    if (mode === 'evidence-change') await f.evidence()
    release(); await new Promise(resolve => setTimeout(resolve, 20)); expect(f.createObjectURL).not.toHaveBeenCalled()
  })
})
