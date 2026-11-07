import { describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { prepareEvidenceDownload } from '../src/preview/evidence-download.ts'
import { prepareEvidenceDownload as coreEvidenceDownload } from '../src/evidence/download.ts'
import { liveEvidenceControls } from '../src/preview/evidence-controls.ts'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const expected = { runId: randomUUID(), revision: 'a'.repeat(64) }
function evidence(privateData = false, schemaVersion = 1) {
  const snapshot: any = { schemaVersion, format: 'jevable.ai/run-evidence', run: { id: expected.runId, revision: expected.revision, status: 'waiting' },
    privacy: { payloads: privateData ? 'included' : 'excluded', actors: privateData ? 'included' : 'excluded', credentialStore: 'excluded' },
    journal: [{ sequence: schemaVersion === 2 ? '9007199254740993' : 1 }] }
  if (privateData) snapshot.private = { run: { id: expected.runId, revision: expected.revision, input: 'PRIVATE_INPUT' }, journal: [] }
  return { schemaVersion, snapshot, checksum: { algorithm: 'sha256', encoding: 'JSON.stringify(snapshot)', value: digest(JSON.stringify(snapshot)) } }
}

describe('evidence download admission', () => {
  it('keeps the preview entry point identical to the presentation-independent core helper', () => {
    expect(prepareEvidenceDownload).toBe(coreEvidenceDownload)
  })
  it.each([1, 2])('preserves exact v%i envelope, sequence identities and independent snapshot/file digests', async version => {
    const source = evidence(false, version), artifact = await prepareEvidenceDownload(expected, source)
    expect(JSON.parse(artifact.contents)).toEqual(source)
    expect(artifact.contents).toBe(JSON.stringify(source) + '\n')
    expect(artifact.bytes).toBe(Buffer.byteLength(artifact.contents)); expect(artifact.sha256).toBe(digest(artifact.contents))
    expect(artifact.snapshotSha256).toBe(source.checksum.value); expect(artifact.workflowStatus).toBe('waiting')
    expect(artifact.filename).toBe(`jevable-run-${expected.runId}-metadata-${artifact.sha256.slice(0, 12)}.json`)
  })
  it('requires explicit private consent and pins both public and private run identities', async () => {
    const source = evidence(true)
    await expect(prepareEvidenceDownload(expected, source)).rejects.toThrow()
    const artifact = await prepareEvidenceDownload(expected, source, true)
    expect(artifact.contents).toContain('PRIVATE_INPUT'); expect(artifact.filename).toContain('-private-')
    await expect(prepareEvidenceDownload(expected, evidence(), true)).rejects.toThrow()
    source.snapshot.private.run.id = randomUUID(); source.checksum.value = digest(JSON.stringify(source.snapshot))
    await expect(prepareEvidenceDownload(expected, source, true)).rejects.toThrow()
  })
  it.each(['checksum', 'run', 'revision', 'privacy', 'actors', 'credentials', 'private', 'format', 'version', 'status', 'extra-envelope', 'extra-checksum'])('refuses %s mismatch without producing an artifact', async field => {
    const source: any = evidence()
    if (field === 'checksum') source.checksum.value = '0'.repeat(64)
    if (field === 'run') source.snapshot.run.id = randomUUID()
    if (field === 'revision') source.snapshot.run.revision = 'b'.repeat(64)
    if (field === 'privacy') source.snapshot.privacy.payloads = 'included'
    if (field === 'actors') source.snapshot.privacy.actors = 'included'
    if (field === 'credentials') source.snapshot.privacy.credentialStore = 'included'
    if (field === 'private') source.snapshot.private = null
    if (field === 'format') source.snapshot.format = 'other'
    if (field === 'version') source.schemaVersion = 3
    if (field === 'status') source.snapshot.run.status = 'success'
    if (field === 'extra-envelope') source.token = 'PRIVATE_TOKEN'
    if (field === 'extra-checksum') source.checksum.token = 'PRIVATE_TOKEN'
    if (field !== 'checksum') source.checksum.value = digest(JSON.stringify(source.snapshot))
    await expect(prepareEvidenceDownload(expected, source)).rejects.toThrow()
  })
  it('does not admit invalid filenames, oversized envelopes, circular or missing values', async () => {
    await expect(prepareEvidenceDownload({ ...expected, runId: '../../file' }, evidence())).rejects.toThrow()
    const large: any = evidence(); large.snapshot.padding = 'x'.repeat(16_000_000)
    await expect(prepareEvidenceDownload(expected, large)).rejects.toThrow()
    large.snapshot.padding = large
    await expect(prepareEvidenceDownload(expected, large)).rejects.toThrow()
    await expect(prepareEvidenceDownload(expected, undefined)).rejects.toThrow()
  })
  it('detaches its snapshot before asynchronous verification', async () => {
    const source = evidence(), original = JSON.stringify(source), pending = prepareEvidenceDownload(expected, source)
    source.snapshot.run.status = 'failed'; source.snapshot.private = 'PRIVATE_LATE_MUTATION'
    expect((await pending).contents).toBe(original + '\n')
  })
})

/** No browser or DOM implementation: verifies serialized controller intent and URL lifecycle only. */
class Element {
  hidden = false; disabled = false; checked = false; textContent = ''; href = ''; download = ''
  listeners = new Map<string, () => void>()
  addEventListener(event: string, listener: () => void) { this.listeners.set(event, listener) }
  removeAttribute(name: string) { if (name === 'href') this.href = ''; if (name === 'download') this.download = '' }
  click() { this.listeners.get('click')?.() }
}
function fixture(request = vi.fn(async (_command: unknown): Promise<unknown> => evidence())) {
  const elements = new Map<string, Element>(), events = new Map<string, () => void>(), blobs: Blob[] = []
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)! }
  let current: typeof expected | undefined = { ...expected }
  const createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return `blob:fixture-${blobs.length}` }), revokeObjectURL = vi.fn()
  const controller = runInNewContext(`(${liveEvidenceControls.toString()})(ctx, ${prepareEvidenceDownload.toString()})`, {
    ctx: { current: () => current, request }, document: { getElementById: get }, window: { addEventListener: (name: string, fn: () => void) => events.set(name, fn) },
    URL: { createObjectURL, revokeObjectURL }, Blob, TextEncoder, crypto: webcrypto,
  }) as ReturnType<typeof liveEvidenceControls>
  return { get, request, blobs, createObjectURL, revokeObjectURL, controller, events, select(value?: typeof expected) { current = value; controller.observe() } }
}
describe('serialized evidence controls (not browser qualification)', () => {
  it('does not fetch until explicit preparation, never clicks the download and clears on disconnect', async () => {
    const f = fixture(); f.controller.observe(); expect(f.request).not.toHaveBeenCalled()
    expect(f.get('evidence-download').hidden).toBe(true)
    f.get('evidence-prepare').click(); f.get('evidence-prepare').click()
    await vi.waitFor(() => expect(f.get('evidence-prepare').disabled).toBe(false))
    expect(f.request).toHaveBeenCalledExactlyOnceWith({ operation: 'evidence', id: expected.runId })
    expect(f.blobs).toHaveLength(1); expect(await f.blobs[0]!.text()).toBe(JSON.stringify(evidence()) + '\n')
    expect(f.get('evidence-download').href).toBe('blob:fixture-1'); expect(f.get('evidence-download').hidden).toBe(false)
    expect(f.get('evidence-message').textContent).toContain('not confirmation of a saved file')
    f.select(); expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1')
    expect(f.get('evidence-download').href).toBe(''); expect(f.get('evidence-receipt').textContent).toBe('')
    expect(f.get('evidence-prepare').disabled).toBe(true)
  })
  it('consumes private opt-in once, replaces old object URLs and revokes on pagehide', async () => {
    const request = vi.fn(async (command: any) => evidence(command.includePrivate === true)), f = fixture(request)
    f.get('evidence-private').checked = true; f.get('evidence-prepare').click()
    expect(f.get('evidence-private').checked).toBe(false)
    await vi.waitFor(() => expect(f.get('evidence-prepare').disabled).toBe(false))
    expect(request.mock.calls[0]![0]).toEqual({ operation: 'evidence', id: expected.runId, includePrivate: true })
    expect(f.get('evidence-receipt').textContent).toContain('PRIVATE payloads')
    f.get('evidence-prepare').click(); expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-1')
    await vi.waitFor(() => expect(f.get('evidence-prepare').disabled).toBe(false))
    expect(request.mock.calls[1]![0]).not.toHaveProperty('includePrivate')
    f.events.get('pagehide')!(); expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-2')
    expect(f.get('evidence-download').hidden).toBe(true)
  })
  it.each(['selection', 'disconnect', 'clear', 'pagehide'])('discards an in-flight response after %s', async action => {
    const pending = Promise.withResolvers<unknown>(), f = fixture(vi.fn(() => pending.promise))
    f.get('evidence-prepare').click()
    if (action === 'selection') { f.select({ ...expected, runId: randomUUID() }); f.select({ ...expected }) }
    if (action === 'disconnect') f.select()
    if (action === 'clear') f.get('evidence-clear').click()
    if (action === 'pagehide') f.events.get('pagehide')!()
    pending.resolve(evidence()); await new Promise(resolve => setImmediate(resolve))
    expect(f.createObjectURL).not.toHaveBeenCalled(); expect(f.get('evidence-download').hidden).toBe(true)
  })
  it('rejects invalid evidence and sanitized request errors without any automatic retry', async () => {
    const request = vi.fn(async () => { throw Error('PRIVATE_PROVIDER_FAILURE') }), f = fixture(request)
    f.get('evidence-prepare').click(); await vi.waitFor(() => expect(f.get('evidence-prepare').disabled).toBe(false))
    expect(f.get('evidence-message').textContent).not.toContain('PRIVATE_PROVIDER_FAILURE')
    expect(f.createObjectURL).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce()
    request.mockImplementation(async () => { const value = evidence(); value.checksum.value = '0'.repeat(64); return value as never })
    f.get('evidence-prepare').click(); await vi.waitFor(() => expect(f.get('evidence-prepare').disabled).toBe(false))
    expect(f.createObjectURL).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2)
  })
})
