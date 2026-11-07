import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { livePreviewBrowser, renderLivePage } from '../src/preview/live-page.ts'

// Execute the real serialized controller in DOM fixtures, never a permitted-browser substitute.
const instance = '00000000-0000-4000-8000-000000000000', protocol = 'jevable/v1alpha1'
const bootstrapKey = 'a'.repeat(64), sessionKey = 'b'.repeat(64)
const windows: JSDOM[] = []
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close() })
const settle = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)) }
function reply(result: unknown, status = 200) {
  return new Response(JSON.stringify({ instanceId: instance, ...(status === 200 ? { result } : { code: 'unauthorized' }) }), {
    status, headers: { 'content-type': 'application/json', 'x-jevable-protocol': protocol },
  })
}
function fixture(respond: (path: string, options: RequestInit) => Promise<Response>, retained?: object) {
  const dom = new JSDOM(renderLivePage(instance, protocol, 'preview').html, { runScripts: 'outside-only', url: 'http://127.0.0.1:3000/' })
  windows.push(dom)
  const get = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T
  const fetch = vi.fn(respond)
  Object.assign(dom.window, { fetch, TextDecoder })
  if (retained) dom.window.sessionStorage.setItem(`jevable.preview.${instance}`, JSON.stringify(retained))
  dom.window.eval(`(${livePreviewBrowser.toString()})(() => ({}), ${JSON.stringify(instance)}, ${JSON.stringify(protocol)})`)
  const enter = (isComposing = false) => get('live-token').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing, bubbles: true, cancelable: true }))
  return { dom, get, fetch, enter, input: get<HTMLInputElement>('live-token'), button: get<HTMLButtonElement>('live-connect') }
}
const bootstrap = { token: sessionKey, expiresAt: '2099-01-01T00:00:00.000Z' }
const view = { project: { id: instance, generation: 1, revision: 'c'.repeat(64) }, preview: {}, inputSchema: {}, sample: 'Synthetic input',
  entry: { local: true, api: false }, readiness: { runtimeReadiness: 'ready' } }

describe('private preview connection interaction (DOM, not real-browser acceptance)', () => {
  it('explains a missing key locally without a request or retained credential', async () => {
    const f = fixture(async () => reply({}))
    f.button.click(); await settle()
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.get('live-connect-error').textContent).toContain('before connecting')
    expect(f.input.value).toBe(''); expect(f.dom.window.sessionStorage.length).toBe(0)
    expect(f.dom.window.document.activeElement).toBe(f.input)
  })
  it.each(['', 'PRIVATE_MALFORMED_KEY', bootstrapKey])('identifies the new key problem after expiry and preserves retained work (key=%s)', async key => {
    const saved = { token: sessionKey, expiresAt: '2000-01-01T00:00:00.000Z', runId: instance, reconnectRequired: true }
    const f = fixture(async () => reply({}, 401), saved)
    await settle(); expect(f.fetch).not.toHaveBeenCalled()
    f.input.value = key; f.button.click(); await settle()
    expect(f.get('live-connect-error').textContent).toContain(key === '' ? 'before connecting' : key === bootstrapKey ? 'not accepted' : 'incomplete or invalid')
    expect(f.fetch).toHaveBeenCalledTimes(key === bootstrapKey ? 1 : 0)
    expect(f.fetch.mock.calls.every(([path]) => path === '/v1/preview/bootstrap')).toBe(true)
    expect(JSON.parse(f.dom.window.sessionStorage.getItem(`jevable.preview.${instance}`)!)).toEqual(saved)
    expect(f.get('preview-workspace').hidden).toBe(true); expect(f.get<HTMLButtonElement>('live-run').disabled).toBe(true)
    expect(f.input.value).toBe(''); expect(f.button.disabled).toBe(false)
    expect(f.dom.window.document.body.textContent).not.toContain('PRIVATE_MALFORMED_KEY')
    expect(f.dom.window.document.body.textContent).not.toContain(bootstrapKey)
  })
  it('opens without a request and names the protected key and inline help for assistive tools', () => {
    const f = fixture(async () => reply({}))
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.dom.window.document.querySelector('label[for=live-token]')?.textContent).toBe('Or paste your preview access key')
    expect(f.dom.window.document.querySelector('label[for=live-token-file]')?.textContent).toBe('Choose access-key file')
    expect(f.input.type).toBe('password')
    expect(f.input.getAttribute('aria-describedby')).toBe('live-connect-help live-connect-error')
    expect(f.get('live-connect-error').getAttribute('role')).toBe('alert')
    expect(f.get('live-login').getAttribute('aria-busy')).toBe('false')
  })
  it('supports Enter and gates all duplicate activations while awaiting the original bootstrap', async () => {
    let resolve!: (response: Response) => void
    const f = fixture(() => new Promise(done => { resolve = done }))
    f.input.value = bootstrapKey; expect(f.enter()).toBe(false)
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(f.button.disabled).toBe(true); expect(f.input.disabled).toBe(true)
    expect(f.get<HTMLInputElement>('live-token-file').disabled).toBe(true)
    expect(f.button.textContent).toBe('Connecting…')
    expect(f.get('live-login').getAttribute('aria-busy')).toBe('true')
    expect(f.input.value).toBe('')
    f.button.click(); f.enter(); f.button.dispatchEvent(new f.dom.window.Event('click'))
    expect(f.fetch).toHaveBeenCalledTimes(1)
    resolve(reply({}, 401)); await settle()
    expect(f.button.disabled).toBe(false); expect(f.input.disabled).toBe(false)
    expect(f.get<HTMLInputElement>('live-token-file').disabled).toBe(false)
    expect(f.get('live-login').getAttribute('aria-busy')).toBe('false')
    expect(f.button.textContent).toBe('Connect')
    expect(f.dom.window.document.activeElement).toBe(f.input)
    expect(f.get('live-connect-error').textContent).toContain('Could not connect')
  })
  it('rejects an invalid key locally, clears it and offers an inline correction without disclosing it', async () => {
    const f = fixture(async () => reply({})); f.input.value = 'PRIVATE_INVALID_ACCESS_KEY'; f.enter(); await settle()
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.input.value).toBe('')
    expect(f.get('live-connect-error').textContent).toContain('choose its access-key file or paste the key again')
    expect(f.dom.window.document.body.textContent).not.toContain('PRIVATE_INVALID_ACCESS_KEY')
    expect(f.dom.window.document.activeElement).toBe(f.input)
  })
  it('reads a selected File through the serialized controller and waits for a separate explicit Connect', async () => {
    const f = fixture(async (path, options) => {
      if (path === '/v1/preview/bootstrap') return reply(bootstrap)
      const command = JSON.parse(String(options.body))
      return reply(command.operation === 'view' ? view : { runs: [] })
    })
    // JSDOM lacks Blob.text; exercise its real File/slice bytes through its native FileReader.
    Object.defineProperty(f.dom.window.Blob.prototype, 'text', { value: function(this: Blob) {
      return new Promise<string>((resolve, reject) => {
        const reader = new f.dom.window.FileReader()
        reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error)
        reader.readAsText(this)
      })
    } })
    const picker = f.get<HTMLInputElement>('live-token-file')
    const file = new f.dom.window.File([bootstrapKey + '\r\n'], 'PRIVATE_KEY_FILENAME', { type: 'text/plain' })
    Object.defineProperty(picker, 'files', { value: [file] })
    picker.dispatchEvent(new f.dom.window.Event('change'))
    await vi.waitFor(() => expect(f.input.value).toBe(bootstrapKey))
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.dom.window.sessionStorage.length).toBe(0)
    expect(picker.value).toBe(''); expect(f.dom.window.document.activeElement).toBe(f.button)
    expect(f.dom.window.document.body.textContent).not.toContain('PRIVATE_KEY_FILENAME')
    expect(f.dom.window.document.body.textContent).not.toContain(bootstrapKey)
    expect(f.get('live-key-file-status').textContent).toContain('Choose Connect')
    f.button.click(); await settle()
    expect(f.fetch.mock.calls.map(([path, options]) => [path, JSON.parse(String(options.body))])).toEqual([
      ['/v1/preview/bootstrap', {}], ['/v1/preview/operations', { operation: 'view' }], ['/v1/preview/operations', { operation: 'runs' }],
    ])
    expect(f.input.value).toBe(''); expect(f.get('live-login').hidden).toBe(true)
    expect(JSON.parse(f.dom.window.sessionStorage.getItem(`jevable.preview.${instance}`)!)).toEqual(bootstrap)
  })
  it('does not retry a refused bootstrap; a new attempt needs another explicit key submission', async () => {
    const f = fixture(async () => reply({}, 401))
    f.input.value = bootstrapKey; f.button.click(); await settle()
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(f.dom.window.sessionStorage.length).toBe(0)
    expect(f.get('live-session').hidden).toBe(true)
    f.input.value = bootstrapKey; f.enter(); await settle()
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(f.fetch.mock.calls.every(([path]) => path === '/v1/preview/bootstrap')).toBe(true)
  })
  it('connects through bootstrap and read-only view/history only, never execution or approval', async () => {
    const f = fixture(async (path, options) => {
      if (path === '/v1/preview/bootstrap') return reply(bootstrap)
      const command = JSON.parse(String(options.body))
      return reply(command.operation === 'view' ? view : { runs: [] })
    })
    f.input.value = bootstrapKey; f.enter(); await settle()
    expect(f.fetch.mock.calls.map(([path, options]) => [path, JSON.parse(String(options.body))])).toEqual([
      ['/v1/preview/bootstrap', {}], ['/v1/preview/operations', { operation: 'view' }], ['/v1/preview/operations', { operation: 'runs' }],
    ])
    expect(f.get('live-login').hidden).toBe(true); expect(f.get('live-session').hidden).toBe(false)
    expect(f.get<HTMLButtonElement>('live-run').disabled).toBe(false)
    expect(f.input.value).toBe(''); expect(f.get('live-connect-error').textContent).toBe('')
    expect(JSON.parse(f.dom.window.sessionStorage.getItem(`jevable.preview.${instance}`)!)).toEqual(bootstrap)
    expect(f.dom.window.document.body.textContent).not.toContain(bootstrapKey)
    expect(f.dom.window.document.body.textContent).not.toContain(sessionKey)
  })
  it('gates retained-session reconnection too, without creating a replacement bootstrap or clearing saved identity', async () => {
    let resolve!: (response: Response) => void
    const f = fixture(() => new Promise(done => { resolve = done }), bootstrap)
    expect(f.button.disabled).toBe(true)
    f.input.value = bootstrapKey; f.enter(); f.button.dispatchEvent(new f.dom.window.Event('click'))
    expect(f.fetch.mock.calls.map(([path, options]) => [path, JSON.parse(String(options.body))])).toEqual([
      ['/v1/preview/operations', { operation: 'view' }],
    ])
    resolve(reply({}, 401)); await settle()
    expect(JSON.parse(f.dom.window.sessionStorage.getItem(`jevable.preview.${instance}`)!)).toEqual({ ...bootstrap, reconnectRequired: true })
    expect(f.get('live-connect-error').textContent).toContain('expired or was closed')
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.button.disabled).toBe(false)
  })
  it('ignores Enter while the user is composing text', async () => {
    const f = fixture(async () => reply({})); f.input.value = bootstrapKey
    expect(f.enter(true)).toBe(true); await settle()
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.input.value).toBe(bootstrapKey)
  })
  it('contains a connection transport failure without automatic retries or secret-bearing inline errors', async () => {
    const f = fixture(async () => { throw Error('PRIVATE_TRANSPORT_FAILURE') })
    f.input.value = bootstrapKey; f.enter(); await settle()
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.button.disabled).toBe(false)
    expect(f.get('live-connect-error').textContent).not.toContain('PRIVATE_TRANSPORT_FAILURE')
    expect(f.dom.window.document.body.textContent).not.toContain('PRIVATE_TRANSPORT_FAILURE')
    expect(f.dom.window.sessionStorage.length).toBe(0)
  })
})
