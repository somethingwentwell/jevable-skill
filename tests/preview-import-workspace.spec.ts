import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Script } from 'node:vm'
import { renderPreview, renderVendorImportPreview } from '../src/preview/index.ts'

// Actual serialized viewer and compiled Animate UI shell, not a replacement UI.
// DOM tests do not qualify browser layout, assistive technology or layperson usability.
const upload = await readFile(new URL('../examples/import-support/n8n.json', import.meta.url), 'utf8')
const windows: JSDOM[] = []
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close() })
async function fixture(source = upload) {
  const result = renderVendorImportPreview(source)
  const dom = new JSDOM(result.html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:3000/' })
  windows.push(dom)
  Object.assign(dom.window, { TextEncoder, TextDecoder,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) })
  const network = vi.fn(() => { throw Error('Offline review attempted network access') })
  Object.assign(dom.window, { fetch: network, XMLHttpRequest: network, WebSocket: network })
  const document = dom.window.document
  const originals = new Map([...document.querySelectorAll('[id]')].map(element => [element.id, element]))
  const scripts = [...document.querySelectorAll('script:not([type])')].map(element => element.textContent!)
  for (const script of scripts) dom.window.eval(script)
  await vi.waitFor(() => expect(document.querySelector('#tab-conversion')).not.toBeNull())
  const click = async (value: string) => {
    document.querySelector<HTMLButtonElement>(`#tab-${value}`)!.click()
    await vi.waitFor(() => expect(document.querySelector(`#panel-${value}`)?.hasAttribute('hidden')).toBe(false))
  }
  return { ...result, dom, document, originals, scripts, network, click }
}
describe('offline Animate UI import review', () => {
  it('starts with truthful conversion warnings and preserves every original DOM identity once', async () => {
    const f = await fixture()
    expect(f.document.querySelector('#import-original')?.hasAttribute('hidden')).toBe(true)
    expect(f.document.querySelector('#panel-conversion')?.hasAttribute('hidden')).toBe(false)
    expect(f.document.querySelector('#panel-diagram')?.hasAttribute('hidden')).toBe(true)
    expect(f.document.querySelector('.import-context')?.textContent).toContain('needs fixes before it can run')
    expect(f.document.querySelector('.import-context')?.textContent).toContain('nothing has run')
    expect(f.document.querySelector('#panel-conversion')?.textContent).toContain('Custom code does not execute')
    for (const value of ['diagram', 'import-details', 'conversion']) await f.click(value)
    for (const [id, element] of f.originals) {
      expect(f.document.getElementById(id)).toBe(element)
      expect([...f.document.querySelectorAll('[id]')].filter(node => node.id === id)).toHaveLength(1)
    }
    expect(f.document.querySelector('#graph')?.getAttribute('data-initial-view')).toBe('readable')
    expect(f.document.querySelector('#graph-view-status')?.textContent).toContain('Readable view')
    expect(f.document.querySelector('#graph-view-status')?.textContent).toContain('diagram only')
    expect(f.document.querySelectorAll('#graph [data-node]')).toHaveLength(f.data.graphs[0]!.nodes.length)
    expect(f.document.querySelectorAll('#graph [aria-pressed=true]')).toHaveLength(0)
    expect(f.network).not.toHaveBeenCalled()
  })
  it('reuses the logo and linked keyboard tabs; skip focuses the original graph without selecting a step', async () => {
    const f = await fixture(), logo = f.document.querySelector('.workspace-brand svg.brand-mark')!
    expect(logo.getAttribute('viewBox')).toBe('0 0 40 40')
    expect(logo.getAttribute('aria-hidden')).toBe('true')
    expect(logo.querySelector('rect')?.getAttribute('fill')).toBe('#111827')
    expect(logo.querySelector('path')?.getAttribute('d')).toBe('M26 13.5V23a7 7 0 0 1-7 7h-3')
    expect(logo.querySelectorAll('circle')).toHaveLength(2)
    for (const tab of f.document.querySelectorAll('[role=tab]')) {
      expect(f.document.getElementById(tab.getAttribute('aria-controls')!)?.getAttribute('aria-labelledby')).toBe(tab.id)
    }
    const tab = f.document.getElementById('tab-conversion')!
    tab.focus(); tab.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await vi.waitFor(() => expect(f.document.activeElement?.id).toBe('tab-import-details'))
    expect(f.document.querySelector('#panel-import-details')?.hasAttribute('hidden')).toBe(false)
    f.document.querySelector<HTMLAnchorElement>('.skip-link')!.click()
    await vi.waitFor(() => expect(f.document.activeElement).toBe(f.originals.get('graph')))
    expect(f.document.querySelector('#panel-diagram')?.hasAttribute('hidden')).toBe(false)
    expect(f.document.querySelector('#detail-title')?.textContent).toBe('Inspect a node')
    expect(f.network).not.toHaveBeenCalled()
  })
  it('retains unavailable custom configuration as escaped text, never executable markup', async () => {
    const source = JSON.parse(upload), hostile = '</script><img src=x onerror="globalThis.pwned=1">&'
    // n8n routes use names, so retain the actual path while making the label hostile.
    source.nodes[1].name = hostile
    source.connections.Start.main[0][0].node = hostile
    source.connections[hostile] = source.connections.Classify
    delete source.connections.Classify
    const f = await fixture(JSON.stringify(source))
    expect(f.document.querySelector('#import-review')?.textContent).toContain(hostile)
    await f.click('diagram')
    const custom = [...f.document.querySelectorAll<HTMLButtonElement>('#node-list button')].find(button => button.textContent?.includes('Custom · execution unavailable'))!
    custom.click()
    expect(f.document.querySelector('#detail-kind')?.textContent).toContain('execution unavailable')
    expect(f.document.querySelector('#detail-body')?.textContent).toContain('config')
    expect(f.document.querySelectorAll('img, form, input[type=password], input[type=file]')).toHaveLength(0)
    expect((f.dom.window as unknown as { pwned?: unknown }).pwned).toBeUndefined()
    expect(f.network).not.toHaveBeenCalled()
  })
  it('pins both complete offline scripts and styles without relaxing CSP or loading CDN assets', async () => {
    const f = await fixture(), csp = f.document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!
    expect(f.scripts).toHaveLength(2)
    for (const code of f.scripts) { expect(() => new Script(code)).not.toThrow(); expect(csp).toContain(`sha256-${createHash('sha256').update(code).digest('base64')}`) }
    const styles = f.document.querySelectorAll('style'); expect(styles).toHaveLength(1)
    expect(csp).toContain(`sha256-${createHash('sha256').update(styles[0]!.textContent!).digest('base64')}`)
    expect(csp).toContain("connect-src 'none'"); expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https:/)
    expect(f.document.querySelectorAll('script[src], link[href], svg image')).toHaveLength(0)
    expect(f.scripts[1]).toContain('Commons Clause')
  })
  it('leaves the plain offline preview without an import shell, second script or readable override', async () => {
    const result = renderPreview(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'))
    const dom = new JSDOM(result.html); windows.push(dom)
    expect(dom.window.document.querySelectorAll('script:not([type])')).toHaveLength(1)
    expect(dom.window.document.querySelector('#import-workspace-root')).toBeNull()
    expect(dom.window.document.querySelector('#graph')?.hasAttribute('data-initial-view')).toBe(false)
  })
})
