import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { livePreviewBrowser } from '../src/preview/live-page.ts'
import { liveTestControls } from '../src/preview/test-controls.ts'
import { liveModelHistoryControls } from '../src/preview/model-history-controls.ts'
import { createPreview, projectPreviewModelHistory } from '../src/preview/index.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import { liveInputControls } from '../src/preview/input-controls.ts'
import { schemaInputTools } from '../src/preview/input-model.ts'
import { liveEvidenceControls } from '../src/preview/evidence-controls.ts'
import { prepareEvidenceDownload } from '../src/preview/evidence-download.ts'
import { liveTraceControls } from '../src/preview/trace-controls.ts'
import { traceNavigationTools } from '../src/telemetry/navigation.ts'
import { liveEvidenceBundleControls } from '../src/preview/evidence-bundle-controls.ts'
import { liveReleaseControls } from '../src/preview/release-controls.ts'
import { previewReleaseTools } from '../src/preview/release-download.ts'
import { liveProjectExportControls } from '../src/preview/project-controls.ts'

/** A deliberately small controller test double, not a DOM engine, browser or visual/CSP qualification. */
class Element {
  value = ''; textContent = ''; hidden = false; disabled = false; checked = false; id = ''; type = ''; spellcheck = false
  files?: { size: number; slice: (start: number, end: number) => { text: () => Promise<string> } }[]
  focus = vi.fn()
  constructor(readonly tagName = 'DIV') {}
  attributes = new Map<string, string>()
  setAttribute(key: string, value: string) { this.attributes.set(key, value) }
  href = ''; download = ''
  removeAttribute(key: string) { this.attributes.delete(key); if (key === 'href') this.href = ''; if (key === 'download') this.download = '' }
  children: Element[] = []; listeners = new Map<string, (() => void)[]>()
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]) }
  append(child: Element) { this.children.push(child) }
  replaceChildren(...children: Element[]) { this.children = children }
  click() { for (const fn of this.listeners.get('click') ?? []) fn() }
}
afterEach(() => { vi.unstubAllGlobals() })
const admittedPreview = createPreview(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'))
function fixture(retainedRun?: string, withTests = false, holdRead = false, withModelHistory = false, inputType?: 'string' | 'number', withEvidence = false, withTraces = false, withBundles = false, withRelease = false, withProject = false) {
  const instance = randomUUID(), key = `jevable.preview.${instance}`, token = 'e'.repeat(64), ownerToken = 'f'.repeat(64)
  const elements = new Map<string, Element>(), storage = new Map<string, string>(), calls: { path: string; command: any; auth: string }[] = []
  const project = withRelease || withProject ? { id: randomUUID(), generation: 1, revision: admittedPreview.revision! } : { id: 'project', generation: 1, revision: 'revision' }
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)! }
  if (retainedRun) storage.set(key, JSON.stringify({ token, expiresAt: new Date(Date.now() + 60000).toISOString(), runId: retainedRun }))
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, value: string) => storage.set(k, value), removeItem: (k: string) => storage.delete(k) })
  vi.stubGlobal('document', { getElementById: get, querySelector: () => get('notice'), createElement: (tag: string) => new Element(tag.toUpperCase()) })
  const reload = vi.fn(); vi.stubGlobal('location', { reload })
  vi.stubGlobal('window', { addEventListener: vi.fn(), ...(withBundles ? { jevableEvidenceArchive: async (_bytes: Uint8Array,
    selection: { runs: { id: string; revision: string }[] }) => ({ files: [{ path: 'manifest.json', content: '{}' }],
      runs: [{ id: selection.runs[0]!.id, revision: selection.runs[0]!.revision, workflowStatus: 'completed' }] }) } : {}) })
  const persistedBeforeDispatch: string[] = []
  let releaseRead!: () => void, privateReads = 0
  const readGate = new Promise<void>(resolve => { releaseRead = resolve })
  vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
    const command = JSON.parse(String(options.body)), auth = (options.headers as Record<string, string>).Authorization!
    calls.push({ path, command, auth })
    let result: unknown
    if (path.endsWith('bootstrap')) result = { token, expiresAt: new Date(Date.now() + 60000).toISOString() }
    else if (path.endsWith('logout')) result = { status: 'disconnected' }
    else if (command.operation === 'view') result = { project, preview: withModelHistory || withEvidence || withTraces || withBundles || withRelease || withProject ? admittedPreview : {},
      ...(withTraces ? { traceViewer: { schemaVersion: 1, origin: 'https://traces.example', pathTemplate: '/trace/{traceId}' } } : {}),
      entry: { local: true, api: false }, inputSchema: { type: inputType ?? 'string' }, sample: inputType === 'number' ? 1 : 'sample', readiness: { runtimeReadiness: 'ready' } }
    else if (command.operation === 'runs') result = { runs: [] }
    else if (command.operation === 'evidence.bundle') result = { controllerFixture: true }
    else if (command.operation === 'release.create') result = { schemaVersion: 1, format: 'jevable.ai/preview-release', id: command.id,
      releaseSha256: 'a'.repeat(64), project, version: command.version, storage: command.storage, runtime: { version: 'fixture', sha256: 'b'.repeat(64) }, execution: 'not-run' }
    else if (command.operation === 'release.export') result = { controllerFixture: true }
    else if (command.operation === 'project.export') result = { controllerFixture: true }
    else if (command.operation === 'show') { if (holdRead) await readGate; result = { id: command.id, status: 'completed' } }
    else if (command.operation === 'inspect') result = { id: command.id, input: 'PRIVATE_INPUT',
      state: { status: 'completed', output: `PRIVATE_OUTPUT_${++privateReads}` } }
    else if (command.operation === 'evidence') {
      const snapshot = { schemaVersion: 1, format: 'jevable.ai/run-evidence', run: { id: command.id, revision: admittedPreview.revision, status: 'completed' },
        privacy: { payloads: 'excluded', actors: 'excluded', credentialStore: 'excluded' },
        steps: [{ nodeId: 'start', trace: { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 } }], journal: [],
        models: { format: 'jevable.model-history/v1', source: 'configured-model-store', calls: [] } }
      result = { schemaVersion: 1, snapshot, checksum: { algorithm: 'sha256', encoding: 'JSON.stringify(snapshot)',
        value: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') } }
    }
    else if (command.operation === 'tests.list') result = { tests: [] }
    else if (command.operation === 'tests.show') result = { id: command.id, generation: 2, sha256: 'a'.repeat(64), status: 'accepted',
      definition: { title: 'Accepted case', input: 'case input', expectations: [{ kind: 'status', value: 'completed' }] } }
    else if (command.operation === 'tests.run') {
      persistedBeforeDispatch.push(JSON.parse(storage.get(key)!).runId)
      result = { run: { id: command.runId, status: 'completed' }, assessment: 'passed', workflowStatus: 'completed', terminal: true }
    } else if (command.operation === 'run') {
      persistedBeforeDispatch.push(JSON.parse(storage.get(key)!).runId)
      result = { id: command.id, status: 'completed', output: command.input }
    } else throw Error('Unexpected mutation in controller fixture')
    return new Response(JSON.stringify({ instanceId: instance, result }), { headers: { 'content-type': 'application/json', 'x-jevable-protocol': PROTOCOL_VERSION } })
  }))
  const viewer = vi.fn(); livePreviewBrowser(viewer, instance, PROTOCOL_VERSION, withTests ? liveTestControls : undefined, undefined,
    withModelHistory ? liveModelHistoryControls : undefined, withModelHistory ? projectPreviewModelHistory : undefined,
    inputType ? liveInputControls : undefined, inputType ? schemaInputTools : undefined,
    withEvidence ? liveEvidenceControls : undefined, withEvidence || withTraces ? prepareEvidenceDownload : undefined,
    withTraces ? liveTraceControls : undefined, withTraces ? traceNavigationTools : undefined, undefined, undefined,
    withBundles ? liveEvidenceBundleControls : undefined, withBundles ? async expected => ({ bytes: new Uint8Array([80, 75, 3, 4]),
      sha256: 'a'.repeat(64), selectionSha256: 'b'.repeat(64), runs: 1,
      summary: [{ id: expected.runs[0]!.id, workflowStatus: 'completed', assessment: undefined }],
      privacy: 'metadata-only' as const, filename: 'test-double.zip' }) : undefined,
    withRelease ? liveReleaseControls : undefined, withRelease ? () => ({ ...previewReleaseTools(),
      download: async () => ({ bytes: new Uint8Array([80, 75, 3, 4]), sha256: 'c'.repeat(64), filename: 'release-double.zip' }) }) : undefined,
    withProject ? liveProjectExportControls : undefined, withProject ? async () => ({ bytes: new Uint8Array([80, 75, 3, 4]),
      sha256: 'd'.repeat(64), bundleSha256: 'e'.repeat(64), tests: { included: true, count: 1, excludedOtherRevisions: 0 }, filename: 'project-double.zip' }) : undefined)
  return { calls, get, storage, key, ownerToken, token, persistedBeforeDispatch, reload, viewer, releaseRead }
}

describe('live controller intent and retention (test doubles only)', () => {
  it('keeps connected runtime status after the graph viewer initializes', async () => {
    const f = fixture(randomUUID())
    f.viewer.mockImplementation(() => {
      f.get('validation').textContent = 'Compilation passed · Runtime not checked · Not run'
      return { setExecution: vi.fn() }
    })
    await vi.waitFor(() => expect(f.viewer).toHaveBeenCalledTimes(1))
    expect(f.get('validation').textContent).toBe('Compilation passed · Runtime ready · Execution is recorded separately below')
    expect(f.get('validation').textContent).not.toContain('Not run')
  })
  it('hides loaded Results values without changing retained identity or dispatching another operation', async () => {
    const f = fixture(randomUUID())
    await vi.waitFor(() => expect(f.get('live-private').disabled).toBe(false))
    expect(f.get('live-private-clear').disabled).toBe(true)
    f.get('live-private').click()
    await vi.waitFor(() => expect(f.get('live-private-result').textContent).toContain('PRIVATE_OUTPUT_1'))
    const calls = f.calls.length, retained = f.storage.get(f.key)
    expect(f.get('live-private-clear').disabled).toBe(false)
    f.get('live-message').textContent = 'Inspect the original request before any retry.'
    f.get('live-private-clear').click()
    expect(f.get('live-private-result').textContent).toBe('')
    expect(f.get('live-private-status').textContent).toContain('not been deleted')
    expect(f.get('live-private-clear').disabled).toBe(true)
    expect(f.get('live-message').textContent).toBe('Inspect the original request before any retry.')
    expect(f.calls).toHaveLength(calls); expect(f.storage.get(f.key)).toBe(retained)
    expect([...f.storage.values()].join('')).not.toContain('PRIVATE_OUTPUT')
  })
  it.each(['reply', 'failure'] as const)('fences a late private %s after Hide values', async kind => {
    const f = fixture(randomUUID()); await vi.waitFor(() => expect(f.get('live-private').disabled).toBe(false))
    const original = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void, settled = false
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const response = await original(...args)
      if (JSON.parse(String(args[1]!.body)).operation === 'inspect') {
        await gate; settled = true
        if (kind === 'failure') throw Error('PRIVATE_READ_FAILURE')
      }
      return response
    })
    f.get('live-private').click()
    await vi.waitFor(() => expect(f.calls.filter(c => c.command.operation === 'inspect')).toHaveLength(1))
    expect(f.get('live-private-clear').disabled).toBe(false)
    f.get('live-private-clear').click(); release()
    await vi.waitFor(() => expect(settled).toBe(true)); await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.get('live-private-result').textContent).toBe('')
    expect(f.get('live-private-status').textContent).toContain('Values hidden')
    expect(f.get('live-message').textContent).not.toContain('PRIVATE_READ_FAILURE')
    expect(f.calls.filter(c => ['run', 'decide', 'cancel', 'advance'].includes(c.command.operation))).toEqual([])
  })
  it('keeps only the newest explicitly requested private read', async () => {
    const f = fixture(randomUUID()); await vi.waitFor(() => expect(f.get('live-private').disabled).toBe(false))
    const original = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void, held = false, settled = false
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const response = await original(...args)
      if (JSON.parse(String(args[1]!.body)).operation === 'inspect' && !held) { held = true; await gate; settled = true }
      return response
    })
    f.get('live-private').click(); await vi.waitFor(() => expect(held).toBe(true))
    f.get('live-private').click()
    await vi.waitFor(() => expect(f.get('live-private-result').textContent).toContain('PRIVATE_OUTPUT_2'))
    release(); await vi.waitFor(() => expect(settled).toBe(true)); await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.get('live-private-result').textContent).toContain('PRIVATE_OUTPUT_2')
    expect(f.get('live-private-result').textContent).not.toContain('PRIVATE_OUTPUT_1')
  })
  it('clears/fences Results on pagehide and does not reload values on pageshow', async () => {
    const f = fixture(randomUUID()); await vi.waitFor(() => expect(f.get('live-private').disabled).toBe(false))
    f.get('live-private').click(); await vi.waitFor(() => expect(f.get('live-private-result').textContent).toContain('PRIVATE_OUTPUT_1'))
    const handler = (name: string) => vi.mocked(window.addEventListener).mock.calls.find(([event]) => event === name)![1] as () => void
    const calls = f.calls.length
    handler('pagehide')()
    expect(f.get('live-private-result').textContent).toBe(''); expect(f.get('live-private').disabled).toBe(true)
    f.get('live-private').click(); expect(f.calls).toHaveLength(calls)
    handler('pageshow')()
    expect(f.get('live-private').disabled).toBe(false); expect(f.get('live-private-clear').disabled).toBe(true)
    expect(f.calls).toHaveLength(calls)
  })
  it('keeps current private-read errors local and excludes raw failure text', async () => {
    const f = fixture(randomUUID()); await vi.waitFor(() => expect(f.get('live-private').disabled).toBe(false))
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (JSON.parse(String(args[1]!.body)).operation === 'inspect') throw Error('PRIVATE_READ_FAILURE')
      return original(...args)
    })
    f.get('live-message').textContent = 'Inspect the original request before any retry.'
    f.get('live-private').click()
    await vi.waitFor(() => expect(f.get('live-private-status').textContent).toContain('Saved values unavailable'))
    expect(f.get('live-private-status').textContent).not.toContain('PRIVATE_READ_FAILURE')
    expect(f.get('live-message').textContent).toBe('Inspect the original request before any retry.')
  })
  it('clears loaded Results immediately when logout is pending', async () => {
    const f = fixture(randomUUID()); await vi.waitFor(() => expect(f.get('live-private').disabled).toBe(false))
    f.get('live-private').click(); await vi.waitFor(() => expect(f.get('live-private-result').textContent).toContain('PRIVATE_OUTPUT_1'))
    const original = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const response = await original(...args)
      if (String(args[0]).endsWith('/logout')) await gate
      return response
    })
    f.get('live-logout').click()
    expect(f.get('live-private-result').textContent).toBe('')
    expect(f.get('live-private').disabled).toBe(true)
    expect(f.reload).not.toHaveBeenCalled()
    release(); await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce())
  })
  it('does not restore a pending private read after pagehide and pageshow', async () => {
    const f = fixture(randomUUID()); await vi.waitFor(() => expect(f.get('live-private').disabled).toBe(false))
    const original = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void, settled = false
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const response = await original(...args)
      if (JSON.parse(String(args[1]!.body)).operation === 'inspect') { await gate; settled = true }
      return response
    })
    f.get('live-private').click(); await vi.waitFor(() => expect(f.calls.filter(c => c.command.operation === 'inspect')).toHaveLength(1))
    const handler = (name: string) => vi.mocked(window.addEventListener).mock.calls.find(([event]) => event === name)![1] as () => void
    handler('pagehide')(); handler('pageshow')(); release()
    await vi.waitFor(() => expect(settled).toBe(true)); await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.get('live-private-result').textContent).toBe('')
    expect(f.calls.filter(c => c.command.operation === 'inspect')).toHaveLength(1)
  })
  it('clears a stale private loading notice when status refresh invalidates the read', async () => {
    const f = fixture(randomUUID()); await vi.waitFor(() => expect(f.get('live-private').disabled).toBe(false))
    const original = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void, settled = false
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const response = await original(...args)
      if (JSON.parse(String(args[1]!.body)).operation === 'inspect') { await gate; settled = true }
      return response
    })
    f.get('live-private').click(); await vi.waitFor(() => expect(f.calls.filter(c => c.command.operation === 'inspect')).toHaveLength(1))
    f.get('live-inspect').click(); await vi.waitFor(() => expect(f.get('live-private-status').textContent).toBe(''))
    release(); await vi.waitFor(() => expect(settled).toBe(true)); await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.get('live-private-result').textContent).toBe(''); expect(f.get('live-private-status').textContent).toBe('')
    expect(f.get('live-private-clear').disabled).toBe(true)
  })
  it('reads a user-selected small key file locally without connecting, uploading, storing or displaying it', async () => {
    const f = fixture(), key = 'a'.repeat(64), name = 'PRIVATE_FILENAME'
    const text = vi.fn(async () => key + '\r\n'), slice = vi.fn(() => ({ text }))
    const picker = f.get('live-token-file'); picker.value = name; picker.files = [{ size: 66, slice }]
    for (const change of picker.listeners.get('change') ?? []) change()
    await vi.waitFor(() => expect(f.get('live-token').value).toBe(key))
    expect(slice).toHaveBeenCalledExactlyOnceWith(0, 257); expect(text).toHaveBeenCalledOnce()
    expect(picker.value).toBe(''); expect(picker.disabled).toBe(false)
    expect(f.get('live-key-file-status').textContent).toBe('Key loaded. Choose Connect to open your workflow.')
    expect(f.get('live-connect').focus).toHaveBeenCalledOnce()
    expect(f.get('live-connect-error').textContent).toBe('')
    expect(f.calls).toEqual([]); expect(f.storage.size).toBe(0)
    expect(JSON.stringify([...f.storage])).not.toContain(key)
    expect(f.get('live-key-file-status').textContent + f.get('live-connect-error').textContent).not.toMatch(/PRIVATE_FILENAME|a{64}/)
    // Loading never bootstraps. A separate explicit Connect uses the existing protocol once.
    f.get('live-connect').click()
    await vi.waitFor(() => expect(f.viewer).toHaveBeenCalledOnce())
    expect(f.viewer.mock.calls[0]?.[1]).toMatchObject({ initialView: 'readable', context: 'live-workspace' })
    expect(f.calls.filter(call => call.path.endsWith('bootstrap'))).toEqual([
      { path: '/v1/preview/bootstrap', command: {}, auth: `Bearer ${key}` },
    ])
    expect(f.calls.map(call => call.command.operation).filter(Boolean)).toEqual(['view', 'runs'])
    expect(f.get('live-token').value).toBe('')
    expect([...f.storage.values()].join('')).not.toContain(key)
  })
  it('captures the selected file before clearing a live file list', async () => {
    const f = fixture(), picker = f.get('live-token-file'), token = 'c'.repeat(64)
    const files = [{ size: 64, slice: () => ({ text: async () => token }) }]
    picker.files = files
    Object.defineProperty(picker, 'value', { get: () => '', set: () => { files.splice(0) } })
    for (const change of picker.listeners.get('change') ?? []) change()
    await vi.waitFor(() => expect(f.get('live-token').value).toBe(token))
    expect(files).toEqual([]); expect(f.calls).toEqual([]); expect(f.storage.size).toBe(0)
  })
  it.each([0, 63, 257, 16_000_000, NaN, 64.5])('refuses a key file size of %s without reading, connecting or retaining its contents', async size => {
    const f = fixture(), slice = vi.fn(), picker = f.get('live-token-file')
    f.get('live-token').value = 'OLD_KEY'; picker.files = [{ size, slice }]
    for (const change of picker.listeners.get('change') ?? []) change()
    await vi.waitFor(() => expect(f.get('live-connect-error').textContent).toContain('could not be used'))
    expect(slice).not.toHaveBeenCalled(); expect(f.calls).toEqual([]); expect(f.storage.size).toBe(0)
    expect(f.get('live-token').value).toBe(''); expect(f.get('live-key-file-status').textContent).toBe('')
    expect(f.get('live-token').disabled).toBe(false); expect(f.get('live-connect').disabled).toBe(false)
    expect(f.get('live-login').attributes.get('aria-busy')).toBe('false')
  })
  it.each(['PRIVATE_NOT_A_KEY', 'a'.repeat(65), 'A'.repeat(64), '<script>PRIVATE_HTML</script>'])('refuses malformed selected key contents without echoing them', async contents => {
    const f = fixture(), picker = f.get('live-token-file')
    picker.files = [{ size: 100, slice: () => ({ text: async () => contents }) }]
    for (const change of picker.listeners.get('change') ?? []) change()
    await vi.waitFor(() => expect(f.get('live-connect-error').textContent).toContain('could not be used'))
    expect(f.get('live-connect-error').textContent).not.toContain(contents)
    expect(f.get('live-token').value).toBe(''); expect(f.calls).toEqual([]); expect(f.storage.size).toBe(0)
  })
  it('handles a failed key-file read without exposing the exception or leaving controls busy', async () => {
    const f = fixture(), picker = f.get('live-token-file')
    picker.files = [{ size: 64, slice: () => ({ text: async () => { throw Error('PRIVATE_PATH_AND_CONTENT') } }) }]
    for (const change of picker.listeners.get('change') ?? []) change()
    await vi.waitFor(() => expect(f.get('live-connect-error').textContent).toContain('could not be used'))
    expect(f.get('live-connect-error').textContent).not.toContain('PRIVATE_')
    expect(picker.disabled).toBe(false); expect(f.get('live-token').focus).toHaveBeenCalledOnce()
    expect(f.calls).toEqual([]); expect(f.storage.size).toBe(0)
  })
  it('preserves pasted text on picker cancellation and refuses multiple files without reading them', async () => {
    const f = fixture(), picker = f.get('live-token-file'), slice = vi.fn()
    f.get('live-token').value = 'PASTED_KEY'; picker.files = []
    for (const change of picker.listeners.get('change') ?? []) change()
    expect(f.get('live-token').value).toBe('PASTED_KEY'); expect(f.get('live-token').focus).not.toHaveBeenCalled()
    picker.files = [{ size: 64, slice }, { size: 64, slice }]
    for (const change of picker.listeners.get('change') ?? []) change()
    await vi.waitFor(() => expect(f.get('live-connect-error').textContent).toContain('could not be used'))
    expect(slice).not.toHaveBeenCalled(); expect(f.calls).toEqual([]); expect(f.storage.size).toBe(0)
  })
  it('blocks Connect, duplicate selection and editing while a key file is reading', async () => {
    const f = fixture(), picker = f.get('live-token-file'), secondRead = vi.fn()
    let finish!: (value: string) => void
    picker.files = [{ size: 64, slice: () => ({ text: () => new Promise(resolve => { finish = resolve }) }) }]
    for (const change of picker.listeners.get('change') ?? []) change()
    expect(picker.disabled).toBe(true); expect(f.get('live-token').disabled).toBe(true)
    expect(f.get('live-connect').disabled).toBe(true); expect(f.get('live-login').attributes.get('aria-busy')).toBe('true')
    f.get('live-connect').click() // Deliberately bypass native disabled behavior: the controller also guards it.
    picker.files = [{ size: 64, slice: secondRead }]
    for (const change of picker.listeners.get('change') ?? []) change()
    expect(secondRead).not.toHaveBeenCalled(); expect(f.calls).toEqual([])
    finish('b'.repeat(64))
    await vi.waitFor(() => expect(f.get('live-token').value).toBe('b'.repeat(64)))
    expect(f.calls).toEqual([]); expect(f.storage.size).toBe(0)
    expect(f.get('live-connect').disabled).toBe(false); expect(picker.disabled).toBe(false)
  })
  it('does not read another selected key while a retained connection is pending', async () => {
    const f = fixture(randomUUID(), false, true), picker = f.get('live-token-file'), slice = vi.fn()
    await vi.waitFor(() => expect(f.calls.some(call => call.command.operation === 'show')).toBe(true))
    expect(picker.disabled).toBe(true); picker.files = [{ size: 64, slice }]
    for (const change of picker.listeners.get('change') ?? []) change()
    expect(slice).not.toHaveBeenCalled(); expect(f.calls.some(call => call.path.endsWith('bootstrap'))).toBe(false)
    f.releaseRead()
    await vi.waitFor(() => expect(picker.disabled).toBe(false))
    expect(f.get('live-token').value).toBe('')
  })
  it('wires project export to scoped read-only requests and revokes it when selected evidence changes', async () => {
    const f = fixture(randomUUID(), false, false, false, undefined, false, false, true, false, true)
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    f.get('project-export-tests').checked = true; f.get('project-export-prepare').click()
    await vi.waitFor(() => expect(f.get('project-export-download').hidden).toBe(false))
    const exported = f.calls.find(c => c.command.operation === 'project.export')!
    expect(exported.path).toBe('/v1/preview/operations'); expect(exported.command).toEqual({ operation: 'project.export', history: false, tests: true })
    expect(f.storage.get(f.key)).not.toContain('project-double.zip')
    f.get('bundle-add').click(); f.get('bundle-prepare').click()
    await vi.waitFor(() => expect(f.get('bundle-download').hidden).toBe(false))
    expect(f.get('project-export-download').hidden).toBe(true)
    f.get('live-logout').click(); await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce())
    expect(f.get('project-export-tests').checked).toBe(false)
  })
  it('wires scoped release preparation, retains creation identity and clears ZIP/request on logout', async () => {
    const f = fixture(randomUUID(), false, false, false, undefined, false, false, true, true)
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    await vi.waitFor(() => expect(f.get('release-create').disabled).toBe(false))
    f.get('release-version').value = '1.0.0'; f.get('release-storage').value = 'sqlite'; f.get('release-create').click()
    await vi.waitFor(() => expect(f.get('release-prepare').disabled).toBe(false))
    const created = f.calls.find(c => c.command.operation === 'release.create')!
    expect(JSON.parse(f.storage.get(`${f.key}.release`)!).id).toBe(created.command.id)
    expect(created.path).toBe('/v1/preview/operations'); expect(created.auth).toBe(`Bearer ${f.token}`)
    f.get('release-prepare').click(); await vi.waitFor(() => expect(f.get('release-download').hidden).toBe(false))
    expect(f.calls.some(c => c.command.operation === 'run')).toBe(false)
    f.get('live-logout').click(); await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce())
    expect(f.storage.has(`${f.key}.release`)).toBe(false); expect(f.get('release-download').href).toBe('')
  })
  it('wires selected ZIP controls to explicit scoped requests and clears local selection/downloads on logout', async () => {
    const id = randomUUID(), f = fixture(id, false, false, false, undefined, false, false, true)
    await vi.waitFor(() => expect(f.get('live-login').hidden).toBe(true))
    await vi.waitFor(() => expect(f.get('bundle-add').disabled).toBe(false))
    expect(f.get('live-evidence-bundle').hidden).toBe(false)
    expect(f.calls.some(call => call.command.operation === 'evidence.bundle')).toBe(false)
    f.get('bundle-add').click(); f.get('bundle-prepare').click()
    await vi.waitFor(() => expect(f.get('bundle-download').hidden).toBe(false))
    const selected = f.calls.filter(call => call.command.operation === 'evidence.bundle')
    expect(selected).toHaveLength(1); expect(selected[0]!.path).toBe('/v1/preview/operations')
    expect(selected[0]!.command).toEqual({ operation: 'evidence.bundle', selection: { schemaVersion: 1, runs: [{ id, revision: admittedPreview.revision }] } })
    expect(f.storage.get(f.key)).not.toContain('bundle'); expect(f.storage.get(f.key)).not.toContain('zip')
    f.get('live-logout').click()
    await vi.waitFor(() => expect(f.get('bundle-download').hidden).toBe(true))
    expect(f.get('bundle-selection').value).toBe(''); expect(f.get('bundle-download').href).toBe('')
  })
  it('connects the trace panel to scoped evidence only on demand, with no URL in tab storage and no link after logout', async () => {
    const f = fixture(randomUUID(), false, false, false, undefined, false, true)
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    expect(f.get('live-traces').hidden).toBe(false); expect(f.calls.some(call => call.command.operation === 'evidence')).toBe(false)
    f.get('trace-load').click(); await vi.waitFor(() => expect(f.get('trace-load').disabled).toBe(false))
    const links = f.get('trace-references').children.flatMap(row => row.children).filter(child => child.href)
    expect(links).toHaveLength(1); expect(links[0]!.href).toBe(`https://traces.example/trace/${'1'.repeat(32)}`)
    expect(f.storage.get(f.key)).not.toContain('traces.example')
    f.get('live-logout').click(); await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce())
    expect(f.get('trace-references').children).toHaveLength(0)
  })
  it('stages evidence only on explicit preparation and clears its link on disconnect without retaining payloads', async () => {
    const f = fixture(randomUUID(), false, false, false, undefined, true)
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    expect(f.get('live-evidence').hidden).toBe(false)
    expect(f.calls.some(call => call.command.operation === 'evidence')).toBe(false)
    f.get('evidence-prepare').click()
    await vi.waitFor(() => expect(f.get('evidence-download').hidden).toBe(false))
    expect(f.get('evidence-download').href).toMatch(/^blob:/)
    expect(f.storage.get(f.key)).not.toContain('checksum'); expect(f.storage.get(f.key)).not.toContain('blob:')
    f.get('live-inspect').click()
    await vi.waitFor(() => expect(f.calls.filter(call => call.command.operation === 'show')).toHaveLength(2))
    expect(f.calls.filter(call => call.command.operation === 'evidence')).toHaveLength(1)
    f.get('live-logout').click(); await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce())
    expect(f.get('evidence-download').href).toBe(''); expect(f.get('evidence-receipt').textContent).toBe('')
  })
  it('submits the active field editor only on Run and never retains its payload in tab storage', async () => {
    const f = fixture(undefined, true, false, false, 'string')
    f.get('live-token').value = f.ownerToken; f.get('live-connect').click()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    const field = f.get('input-fields').children[0]!.children.find(node => node.tagName === 'TEXTAREA')!
    field.value = 'PRIVATE_FIELD_INPUT'
    expect(f.calls.some(call => call.command.operation === 'run')).toBe(false)
    f.get('test-copy-input').click()
    await vi.waitFor(() => expect(JSON.parse(f.get('test-editor').value).input).toBe('PRIVATE_FIELD_INPUT'))
    expect(f.calls.some(call => ['tests.create', 'tests.accept', 'tests.run', 'run'].includes(call.command.operation))).toBe(false)
    f.get('live-run').click()
    await vi.waitFor(() => expect(f.calls.filter(call => call.command.operation === 'run')).toHaveLength(1))
    expect(f.calls.find(call => call.command.operation === 'run')!.command.input).toBe('PRIVATE_FIELD_INPUT')
    expect(f.storage.get(f.key)).not.toContain('PRIVATE_FIELD_INPUT')
    await vi.waitFor(() => expect(f.get('live-run').disabled).toBe(false))
  })
  it('does not allocate or submit a run for a blank numeric draft and preserves edits across reconnect', async () => {
    const f = fixture(undefined, false, false, false, 'number')
    f.get('live-token').value = f.ownerToken; f.get('live-connect').click()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    const field = f.get('input-fields').children[0]!.children.find(node => node.tagName === 'INPUT')!
    field.value = ''; f.get('live-run').click()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('blank is not zero'))
    expect(JSON.parse(f.storage.get(f.key)!)).not.toHaveProperty('runId')
    expect(f.calls.some(call => call.command.operation === 'run')).toBe(false)
    field.value = '42'; f.get('live-message').textContent = ''; f.get('live-token').value = f.ownerToken; f.get('live-connect').click()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    expect(f.calls.filter(call => call.command.operation === 'view')).toHaveLength(2)
    expect(field.value).toBe('42'); expect(f.get('input-fields').children[0]!.children).toContain(field)
  })
  it('connects with the history panel but no selected run, without fetching evidence or execution', async () => {
    const f = fixture(undefined, false, false, true)
    f.get('live-token').value = f.ownerToken; f.get('live-connect').click()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    expect(f.get('model-history').hidden).toBe(false)
    expect(f.get('model-history-load').disabled).toBe(true)
    expect(f.calls.map(call => call.command.operation)).toEqual([undefined, 'view', 'runs'])
  })
  it('loads history only explicitly, refreshes status without reloading it, and clears the snapshot on logout', async () => {
    const id = randomUUID(), f = fixture(id, false, false, true)
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    expect(f.get('model-history-load').disabled).toBe(false)
    expect(f.calls.map(call => call.command.operation)).toEqual(['view', 'runs', 'show'])
    f.get('model-history-load').click()
    await vi.waitFor(() => expect(f.get('model-history-range').textContent).toContain('No model-node intents'))
    f.get('live-inspect').click()
    await vi.waitFor(() => expect(f.calls.filter(call => call.command.operation === 'show')).toHaveLength(2))
    expect(f.calls.filter(call => call.command.operation === 'evidence').map(call => call.command)).toEqual([{ operation: 'evidence', id }])
    expect(f.storage.get(f.key)).not.toContain('checksum')
    f.get('live-logout').click(); await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce())
    expect(f.get('model-history-summary').textContent).toBe('')
    expect(f.get('model-history-load').disabled).toBe(true)
  })
  it('does not admit another run while the restored run is still being inspected', async () => {
    const f = fixture(randomUUID(), false, true)
    await vi.waitFor(() => expect(f.calls.some(call => call.command.operation === 'show')).toBe(true))
    expect(f.get('live-run').disabled).toBe(true)
    f.get('live-run').click()
    expect(f.calls.some(call => call.command.operation === 'run')).toBe(false)
    f.releaseRead()
    await vi.waitFor(() => expect(f.get('live-run').disabled).toBe(false))
  })

  it('routes an explicit accepted-case run through the shared retained-UUID path', async () => {
    const f = fixture(undefined, true)
    f.get('live-token').value = f.ownerToken; f.get('live-connect').click()
    await vi.waitFor(() => expect(f.calls.some(call => call.command.operation === 'tests.list')).toBe(true))
    expect(f.calls.some(call => call.command.operation === 'tests.run')).toBe(false)
    const id = randomUUID(); f.get('test-list').value = id
    for (const handler of f.get('test-list').listeners.get('change') ?? []) handler()
    await vi.waitFor(() => expect(f.get('test-run').disabled).toBe(false))
    f.get('test-run').click()
    await vi.waitFor(() => expect(f.get('test-report').textContent).toContain('passed'))
    const command = f.calls.find(call => call.command.operation === 'tests.run')!.command
    expect(command.test).toEqual({ id, generation: 2, sha256: 'a'.repeat(64) })
    expect(f.persistedBeforeDispatch).toEqual([command.runId])
    expect(JSON.parse(f.storage.get(f.key)!).runId).toBe(command.runId)
    expect(f.get('live-status').textContent).toContain('completed')
    const before = f.calls.filter(call => call.command.operation === 'tests.run').length
    f.get('test-editor').value = 'PRIVATE_CASE_INPUT'; f.get('test-authorize').checked = true
    f.get('live-logout').click(); await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce())
    expect(f.get('test-report').textContent).toBe(''); expect(f.get('test-review').textContent).toBe('')
    expect(f.get('test-editor').value).not.toContain('PRIVATE_CASE_INPUT'); expect(f.get('test-authorize').checked).toBe(false)
    expect(f.get('test-result').disabled).toBe(true)
    expect(f.calls.filter(call => call.command.operation === 'tests.run')).toHaveLength(before)
  })

  it('refreshes a retained session using only reads and never replays the saved run', async () => {
    const id = randomUUID(), f = fixture(id)
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('completed'))
    expect(f.calls.map(call => call.command.operation)).toEqual(['view', 'runs', 'show'])
    expect(f.calls.every(call => call.auth === `Bearer ${f.token}`)).toBe(true)
    expect(f.viewer).toHaveBeenCalledOnce()
    expect(JSON.parse(f.storage.get(f.key)!).runId).toBe(id)
  })

  it('exchanges the owner token without persisting it and stores a run UUID before the explicit Run request', async () => {
    const f = fixture()
    expect(f.calls).toEqual([])
    f.get('live-token').value = f.ownerToken; f.get('live-connect').click()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    expect(f.get('live-token').value).toBe('')
    expect(f.storage.get(f.key)).not.toContain(f.ownerToken)
    expect(f.calls.some(call => call.command.operation === 'run')).toBe(false)
    f.get('live-input').value = JSON.stringify('explicit input'); f.get('live-run').click()
    await vi.waitFor(() => expect(f.get('live-status').textContent).toContain('completed'))
    const requests = f.calls.filter(call => call.command.operation === 'run')
    expect(requests).toHaveLength(1)
    expect(f.persistedBeforeDispatch).toEqual([requests[0]!.command.id])
    expect(requests[0]!.command.input).toBe('explicit input')
    expect(f.storage.get(f.key)).not.toContain('explicit input')
    f.get('live-logout').click(); await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce())
    expect(f.storage.has(f.key)).toBe(false)
  })
})
