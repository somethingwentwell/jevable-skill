import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { runInNewContext } from 'node:vm'
import { createHash, webcrypto } from 'node:crypto'
import { liveReleaseControls, releaseControlsHtml } from '../src/preview/release-controls.ts'
import { previewReleaseTools } from '../src/preview/release-download.ts'
import { renderLivePage } from '../src/preview/live-page.ts'
import { workspaceScript } from '../src/preview/workspace.generated.ts'

// Real DOM + serialized controller/helper, not visual or layperson acceptance.
const windows: JSDOM[] = []
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close() })
function fixture(options: { retained?: string; request?: (command: any) => Promise<any> } = {}) {
  const dom = new JSDOM(releaseControlsHtml, { url: 'http://127.0.0.1:3000/' }); windows.push(dom)
  const document = dom.window.document, get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
  const project = { id: '00000000-0000-4000-8000-000000000001', generation: 1, revision: 'a'.repeat(64) }
  let scope: string | undefined = 'session', saved: any
  const bytes = Buffer.from([80, 75, 3, 4]), sha256 = createHash('sha256').update(bytes).digest('hex')
  const request = vi.fn(options.request ?? (async (command: any) => {
    if (command.operation === 'release.create') {
      saved = { schemaVersion: 1, format: 'jevable.ai/preview-release', id: command.id, releaseSha256: 'b'.repeat(64), project,
        version: command.version, runtime: { version: '0.1.0-alpha.1', sha256: 'c'.repeat(64) }, storage: command.storage,
        execution: 'not-run', ...(command.notes === undefined ? {} : { notes: command.notes }) }
    }
    if (command.operation === 'release.export') return { schemaVersion: 1, format: 'jevable.ai/preview-release-zip', release: saved,
      bytes: bytes.length, sha256, base64: bytes.toString('base64'), evidence: null, execution: 'not-run', restoration: 'unsupported' }
    return saved
  }))
  const createObjectURL = vi.fn(() => 'blob:synthetic-publish'), revokeObjectURL = vi.fn()
  const ctx = { request, storageKey: 'publish-test', scope: () => scope, project: () => project, evidence: () => undefined }
  if (options.retained) dom.window.sessionStorage.setItem(ctx.storageKey, options.retained)
  const setup = () => runInNewContext(`(${liveReleaseControls.toString()})(ctx, (${previewReleaseTools.toString()})())`, {
    ctx, document, window: dom.window, sessionStorage: dom.window.sessionStorage, TextEncoder, crypto: webcrypto,
    URL: { createObjectURL, revokeObjectURL }, Blob, atob, btoa,
  }) as ReturnType<typeof liveReleaseControls>
  const controls = setup()
  const create = async () => { get<HTMLButtonElement>('release-create').click(); await vi.waitFor(() => expect(get<HTMLButtonElement>('release-prepare').disabled).toBe(false)) }
  return { dom, document, get, request, setup, controls, create, createObjectURL, revokeObjectURL,
    disconnect: () => { scope = undefined; controls.observe() } }
}
describe('Publish progressive disclosure and verified summaries', () => {
  it('keeps identifiers and evidence collapsed, main actions and status outside disclosure', () => {
    const f = fixture()
    for (const id of ['release-details', 'release-evidence-options', 'release-file-details']) expect(f.get<HTMLDetailsElement>(id).open).toBe(false)
    for (const id of ['release-identity', 'release-receipt']) expect(f.get(id).closest('details')?.id).toBe('release-details')
    for (const id of ['release-summary', 'release-message', 'release-create', 'release-inspect', 'release-prepare', 'release-download'])
      expect(f.get(id).closest('details')).toBeNull()
    expect(f.get('release-message').getAttribute('role')).toBe('status')
    expect(f.get<HTMLInputElement>('release-attach').checked).toBe(false)
    expect(f.get<HTMLInputElement>('release-private').checked).toBe(false)
    expect(f.request).not.toHaveBeenCalled()
  })
  it.each(['sqlite', 'postgres'])('shows an admitted %s release without putting note text into the summary', async storage => {
    const f = fixture(), notes = '<script>never execute</script> private-looking plain text'
    f.get<HTMLSelectElement>('release-storage').value = storage; f.get<HTMLTextAreaElement>('release-notes').value = notes
    await f.create()
    expect(f.get('release-summary').textContent).toContain(`Version 1.0.0 saved · ${storage === 'sqlite' ? 'Local SQLite' : 'PostgreSQL'}`)
    expect(f.get('release-summary').textContent).not.toContain(notes)
    expect(f.get('release-receipt').querySelector('script')).toBeNull()
    expect(JSON.parse(f.get('release-receipt').textContent!).notes).toBe(notes)
    expect(f.get('release-summary').textContent).toContain('Nothing has been run or deployed')
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.create'])
  })
  it('does not label a mismatched receipt as saved or make packaging available', async () => {
    const f = fixture(), original = f.request.getMockImplementation()!
    f.request.mockImplementationOnce(async command => ({ ...await original(command), releaseSha256: 'invalid' }))
    f.get<HTMLButtonElement>('release-create').click()
    await vi.waitFor(() => expect(f.get('release-message').textContent).toContain('result unavailable'))
    expect(f.get('release-summary').textContent).toContain('requested')
    expect(f.get('release-summary').textContent).not.toContain('saved ·')
    expect(f.get<HTMLButtonElement>('release-prepare').disabled).toBe(true)
    expect(f.get('release-receipt').textContent).toBe('')
  })
  it('restores only a request on reload, then changes summary after explicit read-only inspection', async () => {
    const f = fixture(); await f.create(); f.request.mockClear()
    // A reload replaces the document/listeners, not just the controller closure.
    const reloaded = fixture({ retained: f.dom.window.sessionStorage.getItem('publish-test')!, request: f.request })
    expect(reloaded.get('release-summary').textContent).toContain('requested')
    expect(reloaded.get<HTMLButtonElement>('release-prepare').disabled).toBe(true)
    expect(f.request).not.toHaveBeenCalled()
    reloaded.get<HTMLButtonElement>('release-inspect').click()
    await vi.waitFor(() => expect(reloaded.get('release-summary').textContent).toContain('Ready to package'))
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.show'])
  })
  it('changes summary only after explicit verified ZIP preparation and clears it on disconnect', async () => {
    const f = fixture(); await f.create()
    expect(f.createObjectURL).not.toHaveBeenCalled()
    expect(f.get<HTMLAnchorElement>('release-download').hidden).toBe(true)
    f.get<HTMLButtonElement>('release-prepare').click()
    await vi.waitFor(() => expect(f.get('release-summary').textContent).toContain('ZIP ready to download'))
    expect(f.get<HTMLAnchorElement>('release-download').hidden).toBe(false)
    expect(f.get('release-file').textContent).toContain('ZIP SHA-256')
    expect(f.get<HTMLDetailsElement>('release-file-details').open).toBe(false)
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.create', 'release.export'])
    f.disconnect()
    expect(f.get('release-summary').textContent).not.toContain('saved ·')
    expect(f.get<HTMLAnchorElement>('release-download').hidden).toBe(true)
    expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-publish')
  })
  it('mounts original controls once inside Animate UI, including the collapsed editing-only transfer', async () => {
    const dom = new JSDOM(renderLivePage('00000000-0000-4000-8000-000000000002', 'jevable/v1alpha1').html,
      { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:3000/' }); windows.push(dom)
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) })
    const release = dom.window.document.getElementById('live-release'), transfer = dom.window.document.getElementById('live-project-export')
    dom.window.eval(workspaceScript)
    await vi.waitFor(() => expect(release?.closest('#panel-publish')).not.toBeNull())
    expect(dom.window.document.querySelectorAll('#live-release')).toHaveLength(1)
    expect(dom.window.document.getElementById('live-release')).toBe(release)
    expect(dom.window.document.getElementById('live-project-export')).toBe(transfer)
    expect((transfer?.closest('details') as HTMLDetailsElement).open).toBe(false)
    expect(transfer?.closest('details')?.textContent).toContain('not a runnable app')
  })
  it.each(['sqlite', 'postgres'])('shows independent startup guidance only after verified %s packaging', async storage => {
    const f = fixture()
    const panel = f.get('release-next-steps'), handoff = f.get<HTMLTextAreaElement>('release-agent-handoff')
    expect(panel.hidden).toBe(true); expect(handoff.value).toBe(''); expect(handoff.readOnly).toBe(true)
    f.get<HTMLSelectElement>('release-storage').value = storage
    f.get<HTMLTextAreaElement>('release-notes').value = 'PRIVATE_NOTES_NOT_FOR_HANDOFF'
    await f.create(); expect(panel.hidden).toBe(true)
    f.get<HTMLButtonElement>('release-prepare').click()
    await vi.waitFor(() => expect(panel.hidden).toBe(false))
    const receipt = JSON.parse(f.get('release-receipt').textContent!)
    expect(handoff.value).toContain(f.get<HTMLAnchorElement>('release-download').download)
    expect(handoff.value).toContain(receipt.id); expect(handoff.value).toContain(receipt.releaseSha256)
    expect(handoff.value).toContain(f.get('release-file').textContent!.split('ZIP SHA-256: ')[1])
    expect(handoff.value).toContain(`Storage: ${storage}`)
    expect(handoff.value).toContain('do not assume it was saved')
    expect(handoff.value).toContain('Ask me to confirm the input, provider costs and external effects before running')
    expect(handoff.value).not.toContain('PRIVATE_NOTES_NOT_FOR_HANDOFF')
    expect(f.get('release-start-prerequisites').textContent).toContain(storage === 'sqlite' ? 'SQLite saves state locally' : 'configure a PostgreSQL database')
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.create', 'release.export'])
    handoff.dispatchEvent(new f.dom.window.Event('focus')); handoff.dispatchEvent(new f.dom.window.Event('select'))
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.dom.window.sessionStorage.getItem('publish-test')).not.toContain('Expected ZIP SHA-256')
  })
  it.each(['disconnect', 'pagehide', 'options', 'new-version'])('clears startup pins on %s without execution', async action => {
    const f = fixture(); await f.create(); f.get<HTMLButtonElement>('release-prepare').click()
    await vi.waitFor(() => expect(f.get('release-next-steps').hidden).toBe(false))
    if (action === 'disconnect') f.disconnect()
    if (action === 'pagehide') f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'))
    if (action === 'options') f.get('release-attach').dispatchEvent(new f.dom.window.Event('change'))
    if (action === 'new-version') f.get<HTMLButtonElement>('release-new').click()
    expect(f.get('release-next-steps').hidden).toBe(true)
    expect(f.get<HTMLTextAreaElement>('release-agent-handoff').value).toBe('')
    expect(f.get('release-start-prerequisites').textContent).toBe('')
    expect(f.request.mock.calls.map(([c]) => c.operation)).toEqual(['release.create', 'release.export'])
  })
  it('does not expose handoff pins for a corrupted ZIP or a stale preparation response', async () => {
    const f = fixture(); await f.create(); const original = f.request.getMockImplementation()!
    f.request.mockImplementationOnce(async command => ({ ...await original(command), sha256: 'd'.repeat(64) }))
    f.get<HTMLButtonElement>('release-prepare').click()
    await vi.waitFor(() => expect(f.get('release-message').textContent).toContain('verification failed'))
    expect(f.get('release-next-steps').hidden).toBe(true)
    expect(f.get<HTMLTextAreaElement>('release-agent-handoff').value).toBe('')
    let finish!: (value: unknown) => void
    f.request.mockImplementationOnce(command => new Promise(resolve => { finish = resolve; void command }))
    f.get<HTMLButtonElement>('release-prepare').click(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    f.disconnect(); finish(await original({ operation: 'release.export' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.get('release-next-steps').hidden).toBe(true)
    expect(f.get<HTMLTextAreaElement>('release-agent-handoff').value).toBe('')
    expect(f.createObjectURL).not.toHaveBeenCalled()
  })
})
