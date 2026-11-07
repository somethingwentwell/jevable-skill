import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { JSDOM, VirtualConsole } from 'jsdom'
import { startRuntimeService } from '../src/http/service.ts'
import { startRuntimeServer } from '../src/http/server.ts'
import { previewSelection, portablePreviewSelection, startPreviewFromCli } from '../src/cli/preview.ts'
import { livePreviewBrowser, renderLivePage } from '../src/preview/live-page.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import { createHash } from 'node:crypto'
import { Script } from 'node:vm'

const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
async function fixture(auto = true) {
  const token = randomBytes(32).toString('hex'), dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-auto-connect-'))
  const service = await startRuntimeService({ runtime: { dataDirectory }, token, actor: 'local:synthetic-test', preview: { source }, previewAutoConnect: auto })
  cleanup.push(() => service.close())
  const post = (path: string, command: unknown = {}, headers: Record<string, string | undefined> = {}, method = 'POST') => {
    const merged = { Origin: service.url, 'Sec-Fetch-Site': 'same-origin', 'X-Jevable-Instance': service.instanceId,
      'X-Jevable-Protocol': PROTOCOL_VERSION, 'Content-Type': 'application/json', ...headers }
    return fetch(service.url + path, { method, headers: Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ...(method === 'GET' ? {} : { body: JSON.stringify(command) }) })
  }
  return { service, post, token }
}
describe('explicit environment token selection', () => {
  it('admits one named env source for a local preview only, without I/O', () => {
    expect(previewSelection({ 'token-env': 'JEVABLE_PREVIEW_TOKEN', 'auto-connect': true })).toEqual({ selection: 'sqlite', port: 0 })
    for (const values of [{}, { 'token-file': 'never-read', 'token-env': 'TOKEN' }, { 'token-env': 'a'.repeat(64) + '-' },
      { 'token-env': 'TOKEN', endpoint: 'https://never-connect.invalid' }, { 'token-env': 'TOKEN', runtime: 'docker' },
      { 'token-file': 'never-read', 'auto-connect': true, runtime: 'docker' }]) expect(() => previewSelection(values)).toThrow()
    expect(() => portablePreviewSelection({ 'token-env': 'TOKEN' })).toThrow()
    expect(() => portablePreviewSelection({ 'auto-connect': true })).toThrow()
  })
  it.each([undefined, '', 'PRIVATE_INVALID_VALUE', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '\n'])('refuses an absent or malformed env token before opening state', async value => {
    vi.stubEnv('JEVABLE_SYNTHETIC_TOKEN', value)
    const dir = await mkdtemp(join(tmpdir(), 'jevable-env-refusal-')), state = join(dir, 'never-created')
    await expect(startPreviewFromCli(source, { 'token-env': 'JEVABLE_SYNTHETIC_TOKEN', 'data-dir': state }))
      .rejects.toThrow('selected token environment variable must contain exactly 64 lowercase hexadecimal characters')
    await expect(access(state)).rejects.toThrow()
  })
  it('uses an explicitly selected env credential without embedding it in HTML or readiness', async () => {
    const token = randomBytes(32).toString('hex'); vi.stubEnv('JEVABLE_SYNTHETIC_TOKEN', token)
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-env-preview-'))
    const service = await startPreviewFromCli(source, { 'token-env': 'JEVABLE_SYNTHETIC_TOKEN', 'auto-connect': true, 'data-dir': dataDirectory })
    cleanup.push(() => service.close())
    expect((await fetch(service.url + '/')).status).toBe(200)
    expect(await (await fetch(service.url + '/')).text()).not.toContain(token)
    expect(JSON.stringify(service.preview)).not.toContain(token)
    expect((await fetch(service.url + '/v1/capabilities', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
  })
})
describe('local bootstrap is project-scoped, same-origin and disabled by default', () => {
  it('mints a separate bounded session without execution or management access', async () => {
    const f = await fixture(), response = await f.post('/v1/preview/local-bootstrap')
    expect(response.status).toBe(200)
    const session = (await response.json() as any).result
    expect(session.scope).toBe('this-preview-project-only'); expect(session.token).not.toBe(f.token)
    expect(Date.parse(session.expiresAt) - Date.now()).toBeLessThanOrEqual(3_600_000)
    const auth = { Authorization: `Bearer ${session.token}` }
    const runs = await f.post('/v1/preview/operations', { operation: 'runs' }, auth)
    expect((await runs.json() as any).result).toEqual({ runs: [] })
    expect((await f.post('/v1/operations', { operation: 'projects.list' }, auth)).status).toBe(401)
    expect((await f.post('/v1/operations', { operation: 'projects.list' })).status).toBe(401)
    expect((await f.post('/v1/preview/operations', { operation: 'show', id: randomUUID() }, auth)).status).toBe(404)
    expect((await f.post('/v1/preview/logout', {}, auth)).status).toBe(200)
    expect((await f.post('/v1/preview/operations', { operation: 'runs' }, auth)).status).toBe(401)
  })
  it('does not allow local bootstrap by default; ordinary bootstrap still requires the owner token', async () => {
    const f = await fixture(false)
    expect((await f.post('/v1/preview/local-bootstrap')).status).toBe(401)
    expect((await f.post('/v1/preview/bootstrap')).status).toBe(401)
    expect((await f.post('/v1/preview/bootstrap', {}, { Authorization: `Bearer ${f.token}` })).status).toBe(200)
  })
  it.each([
    [{ Origin: undefined }, 403], [{ Origin: 'https://cross-origin.invalid' }, 403],
    [{ 'Sec-Fetch-Site': 'cross-site' }, 403], [{ 'Sec-Fetch-Site': 'same-site' }, 403], [{ 'Sec-Fetch-Site': 'none' }, 403],
    [{ 'X-Jevable-Instance': undefined }, 400], [{ 'X-Jevable-Instance': randomUUID() }, 409],
    [{ 'X-Jevable-Protocol': 'invalid' }, 409], [{ Authorization: 'Bearer unused' }, 403],
    [{ Forwarded: 'for=127.0.0.1' }, 403],
  ] as const)('rejects invalid bootstrap headers %j', async (headers, status) => {
    const f = await fixture(); expect((await f.post('/v1/preview/local-bootstrap', {}, headers)).status).toBe(status)
  })
  it('rejects an actual wrong Host and duplicate Fetch Metadata headers on the wire', async () => {
    const f = await fixture(), url = new URL(f.service.url)
    // Node fetch replaces Host; raw HTTP is required to send these exact wire headers.
    const raw = (host: string, sites: string[]) => new Promise<number>((resolve, reject) => {
      const headers = ['Host', host, 'Origin', f.service.url, 'Content-Type', 'application/json',
        'X-Jevable-Protocol', PROTOCOL_VERSION, 'X-Jevable-Instance', f.service.instanceId,
        ...sites.flatMap(site => ['Sec-Fetch-Site', site])]
      const req = request(f.service.url + '/v1/preview/local-bootstrap', { method: 'POST', headers }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode!))
      })
      req.on('error', reject); req.end('{}')
    })
    expect(await raw('localhost:1234', ['same-origin'])).toBe(403)
    expect(await raw(url.host, ['same-origin', 'same-origin'])).toBe(400)
    expect(await raw(url.host, ['same-origin', 'cross-site'])).toBe(400)
  })
  it('retains method, strict-body, path and active-session limits', async () => {
    const f = await fixture()
    expect((await f.post('/v1/preview/local-bootstrap', {}, {}, 'GET')).status).toBe(405)
    expect((await f.post('/v1/preview/local-bootstrap', { projectId: randomUUID() })).status).toBe(400)
    expect((await f.post('/v1/preview/local-bootstrap?token=unused')).status).toBe(400)
    for (let i = 0; i < 8; i++) expect((await f.post('/v1/preview/local-bootstrap')).status).toBe(200)
    expect((await f.post('/v1/preview/local-bootstrap')).status).toBe(413)
  })
  it('rejects auto-connect on a non-preview service before storage opens, and TLS before host opens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-auto-scope-')), state = join(dir, 'never-created')
    await expect(startRuntimeService({ token: 'a'.repeat(64), actor: 'local:test', runtime: { dataDirectory: state }, previewAutoConnect: true })).rejects.toThrow()
    await expect(access(state)).rejects.toThrow()
    const open = vi.fn()
    await expect(startRuntimeServer({ token: 'a'.repeat(64), actor: 'local:test', previewAutoConnect: true, port: 8443,
      tls: { publicOrigin: 'https://never-connect.invalid:8443', bindAddress: '127.0.0.1', certificateFile: 'never-read', privateKeyFile: 'never-read' } }, open)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
})

async function browserFixture(retained?: string, disconnected = false, fail = false) {
  const instance = randomUUID(), key = `jevable.preview.${instance}`
  const dom = new JSDOM(renderLivePage(instance, PROTOCOL_VERSION, 'owner', true).html,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:3000/', virtualConsole: new VirtualConsole() })
  cleanup.push(() => dom.window.close()); Object.assign(dom.window, { TextEncoder, TextDecoder })
  if (retained) dom.window.sessionStorage.setItem(key, retained)
  if (disconnected) dom.window.sessionStorage.setItem(`${key}.auto-connect-disabled`, 'true')
  const calls: { path: string; command: any; headers: any }[] = []
  dom.window.fetch = vi.fn(async (path: unknown, init: RequestInit) => {
    const command = JSON.parse(String(init.body)); calls.push({ path: String(path), command, headers: init.headers })
    if (fail) throw new dom.window.Error('Synthetic unavailable preview')
    const result = path === '/v1/preview/local-bootstrap' ? { token: 'e'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() }
      : command.operation === 'view' ? { project: { id: randomUUID(), generation: 1 }, preview: {}, entry: { local: true, api: false }, readiness: { runtimeReadiness: 'ready' }, sample: 'sample' }
      : command.operation === 'runs' ? { runs: [] } : { status: 'disconnected' }
    return new Response(JSON.stringify({ instanceId: instance, result }), { headers: { 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION } })
  }) as typeof dom.window.fetch
  const args = ['()=>undefined', JSON.stringify(instance), JSON.stringify(PROTOCOL_VERSION), ...Array(25).fill('undefined'), 'true']
  dom.window.eval(`(${livePreviewBrowser.toString()})(${args.join(',')})`)
  const get = (id: string) => dom.window.document.getElementById(id) as HTMLElement
  return { dom, key, calls, get }
}
describe('automatic browser connection never implies execution', () => {
  it('connects the complete serialized controller and bundled workspace to a real synthetic runtime', async () => {
    const f = await fixture(), html = await (await fetch(f.service.url + '/')).text()
    const browserErrors: string[] = [], virtualConsole = new VirtualConsole()
    virtualConsole.on('jsdomError', error => browserErrors.push(String((error as Error & { detail?: Error }).detail?.stack ?? error)))
    virtualConsole.on('error', error => browserErrors.push(String(error?.stack ?? error)))
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: f.service.url + '/', virtualConsole })
    cleanup.push(() => dom.window.close()); Object.assign(dom.window, { TextEncoder, TextDecoder,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) })
    const commands: any[] = [], responses: { path: string; status: number; body: unknown }[] = []
    dom.window.fetch = (async (path: string, init: RequestInit) => {
      commands.push(JSON.parse(String(init.body)))
      // Node fetch and JSDOM each require their own realm's AbortSignal. Bridge
      // cancellation without replacing the DOM types used by Animate UI.
      const controller = new AbortController(), abort = () => controller.abort(init.signal?.reason)
      if (init.signal?.aborted) abort()
      else init.signal?.addEventListener('abort', abort, { once: true })
      try {
        const response = await fetch(f.service.url + path, { ...init, signal: controller.signal,
          headers: { ...init.headers, Origin: f.service.url, 'Sec-Fetch-Site': 'same-origin' } })
        responses.push({ path, status: response.status, body: await response.clone().json() })
        return response
      } finally { init.signal?.removeEventListener('abort', abort) }
    }) as typeof dom.window.fetch
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(match => match[1]!)
    const csp = renderLivePage(f.service.instanceId, PROTOCOL_VERSION, 'owner', true).csp
    expect(scripts).toHaveLength(2)
    for (const script of scripts) {
      expect(() => new Script(script)).not.toThrow()
      expect(csp).toContain(`sha256-${createHash('sha256').update(script).digest('base64')}`)
      dom.window.eval(script)
    }
    await vi.waitFor(() => expect(dom.window.document.getElementById('live-login')?.getAttribute('aria-busy')).toBe('false'))
    expect(responses.filter(response => response.status !== 200)).toEqual([])
    expect(dom.window.document.getElementById('live-connect-error')?.textContent).toBe('')
    expect(browserErrors).toEqual([])
    await vi.waitFor(() => {
      expect(browserErrors).toEqual([])
      expect(dom.window.document.querySelector('.connection-state')?.textContent).toBe('Session open')
    })
    // Connected presentation precedes the read-only saved-case refresh. Drain the
    // full connection attempt before closing this synthetic DOM in afterEach.
    await vi.waitFor(() => expect(dom.window.document.getElementById('live-login')?.getAttribute('aria-busy')).toBe('false'))
    expect(dom.window.document.getElementById('graph')?.querySelectorAll('.node').length).toBeGreaterThan(0)
    const graphStatus = dom.window.document.getElementById('graph-view-status')!
    expect(graphStatus.textContent).toContain('Readable view')
    expect(graphStatus.textContent).toContain('exploring does not run steps')
    expect(graphStatus.textContent).not.toContain('diagram only')
    const beforeNavigation = [...commands]
    dom.window.document.getElementById('fit')!.click()
    expect(graphStatus.textContent).toContain('Whole workflow')
    dom.window.document.getElementById('zoom-in')!.click()
    expect(graphStatus.textContent).toContain('Custom view')
    expect(graphStatus.textContent).toContain('exploring does not run steps')
    expect(commands).toEqual(beforeNavigation)
    expect(commands.some(c => ['run', 'tests.run', 'tests.accept', 'decide', 'advance'].includes(c.operation))).toBe(false)
    const retained = JSON.parse(dom.window.sessionStorage.getItem(`jevable.preview.${f.service.instanceId}`)!)
    expect(retained.token).not.toBe(f.token); expect(html).not.toContain(f.token)
  })
  it('makes the actual workspace skip link focus Connect, never a hidden key input', async () => {
    const f = await browserFixture(undefined, true)
    Object.assign(f.dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) })
    const scripts = [...renderLivePage('fixture', PROTOCOL_VERSION, 'owner', true).html.matchAll(/<script>([\s\S]*?)<\/script>/gu)]
    f.dom.window.eval(scripts[1]![1]!)
    await vi.waitFor(() => expect(f.dom.window.document.querySelector<HTMLAnchorElement>('.skip-link')?.getAttribute('href')).toBe('#live-connect'))
    f.dom.window.document.querySelector<HTMLAnchorElement>('.skip-link')!.click()
    await vi.waitFor(() => expect(f.dom.window.document.activeElement?.id).toBe('live-connect'))
    expect(f.calls).toEqual([])
  })
  it('connects once with no owner bearer and retains only the scoped session', async () => {
    const f = await browserFixture()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    expect(f.get('live-key-fields').hidden).toBe(true)
    expect(f.calls.map(c => c.path)).toEqual(['/v1/preview/local-bootstrap', '/v1/preview/operations', '/v1/preview/operations'])
    expect(f.calls[0]!.headers.Authorization).toBeUndefined(); expect(f.calls[0]!.headers['X-Jevable-Instance']).toBeTruthy()
    expect(f.calls.slice(1).map(c => c.command.operation)).toEqual(['view', 'runs'])
    expect(JSON.parse(f.dom.window.sessionStorage.getItem(f.key)!)).toMatchObject({ token: 'e'.repeat(64) })
    f.get('live-logout').click()
    await vi.waitFor(() => expect(f.dom.window.sessionStorage.getItem(f.key)).toBeNull())
    expect(f.dom.window.sessionStorage.getItem(`${f.key}.auto-connect-disabled`)).toBe('true')
  })
  it('refreshes an unexpired session without acquiring another token', async () => {
    const f = await browserFixture(JSON.stringify({ token: 'e'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() }))
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    expect(f.calls.map(c => c.command.operation)).toEqual(['view', 'runs'])
  })
  it('honors an explicit disconnect on refresh and reconnects only on a click', async () => {
    const f = await browserFixture(undefined, true)
    expect(f.calls).toEqual([]); expect((f.get('live-run') as HTMLButtonElement).disabled).toBe(true)
    f.get('live-connect').click()
    await vi.waitFor(() => expect(f.get('live-message').textContent).toContain('Session open'))
    expect(f.dom.window.sessionStorage.getItem(`${f.key}.auto-connect-disabled`)).toBeNull()
  })
  it('reports failed auto-connect with visible keyboard focus and no automatic retry', async () => {
    const f = await browserFixture(undefined, false, true)
    await vi.waitFor(() => expect(f.get('live-connect-error').textContent).toContain('Could not connect'))
    expect(f.dom.window.document.activeElement?.id).toBe('live-connect'); expect(f.calls).toHaveLength(1)
    expect((f.get('live-run') as HTMLButtonElement).disabled).toBe(true)
  })
})
