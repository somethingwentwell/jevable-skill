import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { readFile } from 'node:fs/promises'
import { renderPreview } from '../src/preview/index.ts'

const source = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const windows: JSDOM[] = []
afterEach(() => windows.splice(0).forEach(dom => dom.window.close()))
function fixture(width = 720, height = 500, initial = false, context?: 'live-workspace') {
  const { html } = renderPreview(source)
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true }); windows.push(dom)
  const get = (id: string) => dom.window.document.getElementById(id)!
  const graph = get('graph'), selected = vi.fn(), qualified = vi.fn(), fetch = vi.fn()
  if (initial) graph.dataset.initialView = 'readable'
  let rect = { width, height }
  graph.getBoundingClientRect = () => rect as DOMRect
  let resized: (() => void) | undefined
  Object.assign(dom.window, { fetch, selectionOptions: { context, onSelect: selected, onNodeSelect: qualified },
    ResizeObserver: class { constructor(callback: () => void) { resized = callback } observe() {} } })
  const script = [...dom.window.document.querySelectorAll('script')].find(item => item.type !== 'application/json')!.textContent!
  dom.window.eval(script.replace("JSON.parse(document.getElementById('preview-data').textContent)",
    "JSON.parse(document.getElementById('preview-data').textContent), window.selectionOptions"))
  selected.mockClear(); qualified.mockClear()
  const box = () => graph.getAttribute('viewBox')!.split(' ').map(Number)
  const click = (id: string) => (get(id) as HTMLButtonElement).click()
  return { get, graph, dom, selected, qualified, fetch, box, click,
    resize(w: number, h: number) { rect = { width: w, height: h }; resized?.() } }
}
describe('readable graph views are presentation only', () => {
  it('ships discoverable overview, readable and earlier/later controls without runtime authority', () => {
    const f = fixture()
    expect(f.get('read-steps')?.textContent).toBe('Read steps')
    expect(f.get('graph-earlier')?.getAttribute('aria-label')).toBe('View earlier steps')
    expect(f.get('graph-later')?.getAttribute('aria-label')).toBe('View later steps')
    expect(f.get('graph-view-status')?.textContent).toContain('Whole workflow')
    for (const id of ['read-steps', 'graph-earlier', 'graph-later']) expect(f.get(id)?.getAttribute('type')).toBe('button')
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([360, 720, 1280])('reads labels at normal scale in a %s-pixel graph viewport without selection or private loading', width => {
    const f = fixture(width); f.click('read-steps')
    const [, , w, h] = f.box()
    expect(width / w!).toBeCloseTo(.9); expect(500 / h!).toBeCloseTo(.9)
    expect(f.get('graph-view-status').textContent).toContain('1 of 3')
    expect(f.selected).not.toHaveBeenCalled(); expect(f.qualified).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('moves through diagram layout without selecting a route, requesting execution or wrapping at boundaries', () => {
    const f = fixture(); f.click('read-steps'); const first = f.box()
    expect((f.get('graph-earlier') as HTMLButtonElement).disabled).toBe(true)
    f.click('graph-later'); const second = f.box()
    expect(second[0]).toBeGreaterThan(first[0]!)
    expect(second.slice(2)).toEqual(first.slice(2))
    f.click('graph-later'); const last = f.box()
    expect((f.get('graph-later') as HTMLButtonElement).disabled).toBe(true)
    f.click('graph-later'); expect(f.box()).toEqual(last)
    f.click('graph-earlier'); expect(f.box()).toEqual(second)
    expect(f.selected).not.toHaveBeenCalled(); expect(f.qualified).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('keeps keyboard focus on an enabled navigation control when a boundary disables the activated button', () => {
    const f = fixture(); f.click('read-steps')
    const earlier = f.get('graph-earlier') as HTMLButtonElement, later = f.get('graph-later') as HTMLButtonElement
    later.focus(); later.click(); expect(f.dom.window.document.activeElement).toBe(later)
    later.click(); expect(later.disabled).toBe(true)
    expect(f.dom.window.document.activeElement).toBe(earlier)
    earlier.click(); expect(f.dom.window.document.activeElement).toBe(earlier)
    earlier.click(); expect(earlier.disabled).toBe(true)
    expect(f.dom.window.document.activeElement).toBe(later)
    expect(f.selected).not.toHaveBeenCalled(); expect(f.qualified).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('keeps overview as the portable default and restores its exact view on Fit graph', () => {
    const f = fixture(), overview = f.box(); f.click('read-steps')
    expect(f.box()).not.toEqual(overview); f.click('fit'); expect(f.box()).toEqual(overview)
    expect(f.get('graph-view-status').textContent).toContain('Whole workflow')
    expect(f.get('graph-view-status').textContent).toContain('choose Read steps to read labels')
    f.click('read-steps'); expect(f.get('graph-view-status').textContent).toContain('Readable view')
  })
  it.each([undefined, 'live-workspace'] as const)('describes %s navigation without changing selection, data or runtime authority', context => {
    const f = fixture(720, 500, true, context)
    const dataBefore = f.get('preview-data').textContent
    const caption = context ? 'exploring does not run steps' : 'diagram only'
    const check = (view: string) => {
      expect(f.get('graph-view-status').textContent).toContain(view)
      expect(f.get('graph-view-status').textContent).toContain(caption)
      if (context) expect(f.get('graph-view-status').textContent).not.toContain('diagram only')
    }
    check('Readable view')
    f.click('graph-later'); check('2 of 3')
    f.click('fit'); check('Whole workflow')
    f.click('zoom-in'); check('Custom view')
    f.click('read-steps'); check('Readable view')
    f.graph.querySelector<SVGGElement>('[data-node="result"]')!.dispatchEvent(new f.dom.window.FocusEvent('focus'))
    check('3 of 3')
    expect(f.get('preview-data').textContent).toBe(dataBefore)
    expect(f.selected).not.toHaveBeenCalled(); expect(f.qualified).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
    expect(f.get('execution-overlay').hidden).toBe(true)
  })
  it('uses readable initial mode only when the host explicitly selects it and follows viewport resizing', () => {
    const f = fixture(720, 500, true)
    expect(720 / f.box()[2]!).toBeCloseTo(.9)
    f.click('graph-later'); const x = f.box()[0]
    f.resize(360, 420)
    expect(f.box()[0]).toBe(x); expect(360 / f.box()[2]!).toBeCloseTo(.9); expect(420 / f.box()[3]!).toBeCloseTo(.9)
    expect(f.selected).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('does not overwrite explicit overview or manual zoom when a viewport resizes', () => {
    const f = fixture(720, 500, true); f.click('fit'); const overview = f.box()
    f.resize(360, 420); expect(f.box()).toEqual(overview)
    f.click('read-steps'); f.click('zoom-in'); const zoomed = f.box()
    f.resize(720, 500); expect(f.box()).toEqual(zoomed)
  })
})
