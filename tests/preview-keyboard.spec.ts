import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { renderPreview, projectPreviewExecution } from '../src/preview/index.ts'
import { renderTemplate } from '../src/templates/index.ts'
import { workspaceCss } from '../src/preview/workspace-style.ts'

// Actual serialized viewer in JSDOM: DOM focus/event/cascade and viewBox math,
// not native keyboard delivery, rendered pixels, screen readers or enforced CSP.
const windows: JSDOM[] = []
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close() })
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
function fixture(source = echo, workspace = false) {
  const { html, data } = renderPreview(source)
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://jevable-fixture.invalid/' })
  windows.push(dom)
  const document = dom.window.document
  const selected = vi.fn(), qualified = vi.fn(), fetch = vi.fn(() => { throw Error('Viewer must never fetch') })
  Object.assign(dom.window, { fetch, selectionOptions: { onSelect: selected, onNodeSelect: qualified } })
  const script = [...document.querySelectorAll('script')].find(script => script.type !== 'application/json')!.textContent!
  // Use the exact emitted function, with explicit presentation observers only.
  dom.window.eval('window.controller = ' + script.replace('JSON.parse(document.getElementById(\'preview-data\').textContent)',
    'JSON.parse(document.getElementById(\'preview-data\').textContent), window.selectionOptions'))
  if (workspace) {
    const stage = document.createElement('div'); stage.id = 'preview-workspace'
    const canvas = document.querySelector('.canvas')!; canvas.replaceWith(stage); stage.append(canvas)
    const style = document.createElement('style'); style.textContent = workspaceCss; document.head.append(style)
  }
  selected.mockClear(); qualified.mockClear()
  const get = (id: string) => document.getElementById(id)!
  const graph = get('graph') as unknown as SVGSVGElement
  const node = (id: string) => [...graph.querySelectorAll<SVGElement>('[data-node]')].find(node => node.getAttribute('data-node') === id)!
  const key = (target: Element, value: string, options: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })
    target.dispatchEvent(event); return event
  }
  const box = () => graph.getAttribute('viewBox')!.split(' ').map(Number) as [number, number, number, number]
  const position = (id: string) => node(id).getAttribute('transform')!.match(/translate\((\d+) (\d+)\)/)!.slice(1).map(Number)
  const assertVisible = (id: string) => {
    const [x, y] = position(id), [vx, vy, w, h] = box()
    expect(x! - 20).toBeGreaterThanOrEqual(vx); expect(x! + 240).toBeLessThanOrEqual(vx + w)
    expect(y! - 20).toBeGreaterThanOrEqual(vy); expect(y! + 160).toBeLessThanOrEqual(vy + h)
  }
  return { dom, document, data, get, graph, node, key, box, position, selected, qualified, fetch, assertVisible,
    controller: (dom.window as any).controller as ReturnType<typeof import('../src/preview/viewer.ts').previewViewer> }
}
const branching = () => JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'keyboard', name: 'Branch inspection' },
  spec: { inputSchema: { type: 'boolean' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } }, choose: { type: 'rule', config: { mode: 'ifElse', condition: '${{ inputs }}' } },
    upper: { type: 'output', config: { value: 'Upper' } }, lower: { type: 'output', config: { value: 'Lower' } } },
    edges: [{ from: 'start', to: 'choose' }, { from: 'choose', port: 'true', to: 'upper' }, { from: 'choose', port: 'false', to: 'lower' }] } })

describe('standalone graph keyboard presentation', () => {
  it('leaves focus, selection and all authority alone on initial mount', () => {
    const f = fixture()
    expect(f.document.activeElement).toBe(f.document.body)
    expect(f.graph.getAttribute('aria-describedby')).toBe('graph-keyboard-help')
    expect(f.get('graph-keyboard-help').textContent).toContain('Navigation never runs')
    expect(f.get('graph-back').hidden).toBe(true)
    expect(f.selected).not.toHaveBeenCalled(); expect(f.qualified).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('moves across columns with real bubbling events, without panning the background or selecting steps', () => {
    const f = fixture(), original = f.box()
    f.node('start').focus()
    expect(f.key(f.node('start'), 'ArrowRight').defaultPrevented).toBe(true)
    expect(f.document.activeElement).toBe(f.node('result')); expect(f.box()).toEqual(original)
    f.key(f.node('result'), 'ArrowLeft'); expect(f.document.activeElement).toBe(f.node('start'))
    expect(f.selected).not.toHaveBeenCalled(); expect(f.qualified).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
    expect(f.get('detail-title').textContent).toBe('Inspect a node')
  })
  it('uses up/down for rows in the same column and nearest-row movement across columns, not inferred routes', () => {
    const f = fixture(branching()), before = JSON.stringify(f.data)
    const [first, second] = ['upper', 'lower'].sort((a, b) => f.position(a)[1]! - f.position(b)[1]!) as [string, string]
    expect(f.position(first)[0]).toBe(f.position(second)[0]); expect(f.position(first)[1]).toBeLessThan(f.position(second)[1]!)
    f.node(first).focus(); f.key(f.node(first), 'ArrowDown')
    expect(f.document.activeElement).toBe(f.node(second))
    f.key(f.node(second), 'ArrowLeft'); expect(f.document.activeElement).toBe(f.node('choose'))
    f.key(f.node('choose'), 'ArrowRight'); expect(f.document.activeElement).toBe(f.node(first))
    f.node(second).focus(); f.key(f.node(second), 'ArrowUp'); expect(f.document.activeElement).toBe(f.node(first))
    expect(JSON.stringify(f.data)).toBe(before); expect(f.selected).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('reaches the first/last visual step with Home/End and does not wrap at a boundary', () => {
    const f = fixture(branching())
    const last = ['upper', 'lower'].sort((a, b) => f.position(a)[1]! - f.position(b)[1]!).at(-1)!
    f.node('choose').focus(); f.key(f.node('choose'), 'End'); expect(f.document.activeElement).toBe(f.node(last))
    for (const key of ['ArrowRight', 'ArrowDown']) {
      expect(f.key(f.node(last), key).defaultPrevented).toBe(true); expect(f.document.activeElement).toBe(f.node(last))
    }
    f.key(f.node(last), 'Home'); expect(f.document.activeElement).toBe(f.node('start'))
    for (const key of ['ArrowLeft', 'ArrowUp']) { f.key(f.node('start'), key); expect(f.document.activeElement).toBe(f.node('start')) }
    expect(f.selected).not.toHaveBeenCalled()
  })
  it.each(['Enter', ' '])('selects details only on explicit %j, not on focus movement', key => {
    const f = fixture()
    f.node('start').focus(); f.key(f.node('start'), 'ArrowRight')
    expect(f.selected).not.toHaveBeenCalled()
    expect(f.key(f.node('result'), key).defaultPrevented).toBe(true)
    expect(f.selected).toHaveBeenCalledExactlyOnceWith('result')
    expect(f.qualified).toHaveBeenCalledExactlyOnceWith({ nodeId: 'result', graphScope: 'workflow' })
    expect(f.node('result').getAttribute('aria-pressed')).toBe('true'); expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }])(
    'leaves modified/IME keyboard events untouched: %j', options => {
      const f = fixture(), box = f.box(); f.node('start').focus()
      for (const key of ['ArrowRight', 'Enter', 'Escape', 'Home']) expect(f.key(f.node('start'), key, options).defaultPrevented).toBe(false)
      expect(f.document.activeElement).toBe(f.node('start')); expect(f.box()).toEqual(box); expect(f.selected).not.toHaveBeenCalled()
      f.graph.focus(); expect(f.key(f.graph, 'ArrowRight', options).defaultPrevented).toBe(false); expect(f.box()).toEqual(box)
    })
  it('respects an event already consumed by another keyboard handler', () => {
    const f = fixture(); f.node('start').focus()
    const event = new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    event.preventDefault(); f.node('start').dispatchEvent(event)
    expect(f.document.activeElement).toBe(f.node('start')); expect(f.selected).not.toHaveBeenCalled()
  })
  it('keeps native Tab navigation untouched', () => {
    const f = fixture(); f.node('start').focus()
    expect(f.key(f.node('start'), 'Tab').defaultPrevented).toBe(false)
    expect(f.key(f.node('start'), 'Tab', { shiftKey: true }).defaultPrevented).toBe(false)
    expect([...f.graph.querySelectorAll('[data-node]')].every(node => node.getAttribute('tabindex') === '0')).toBe(true)
    expect(f.selected).not.toHaveBeenCalled()
  })
  it('allows a physical Shift-plus on the background while leaving platform zoom shortcuts alone', () => {
    const f = fixture(); f.graph.focus(); const before = f.box()
    f.key(f.graph, '+', { shiftKey: true }); expect(f.box()[2]).toBeCloseTo(before[2] * .8)
    const zoomed = f.box(); f.key(f.graph, '+', { ctrlKey: true }); f.key(f.graph, '+', { metaKey: true })
    expect(f.box()).toEqual(zoomed); expect(f.selected).not.toHaveBeenCalled()
  })
  it('reveals off-view keyboard focus with bounded viewBox changes and no selection', () => {
    const f = fixture(), before = JSON.stringify(f.data)
    f.graph.focus(); for (let index = 0; index < 12; index++) f.key(f.graph, 'ArrowLeft')
    const panned = f.box(); f.node('result').focus()
    expect(f.box()).not.toEqual(panned); expect(f.box().slice(2)).toEqual(panned.slice(2)); f.assertVisible('result')
    expect(f.selected).not.toHaveBeenCalled(); expect(JSON.stringify(f.data)).toBe(before)
  })
  it('enlarges an over-zoomed view only enough to contain the complete focused step and labels', () => {
    const f = fixture()
    for (let index = 0; index < 60; index++) (f.get('zoom-in') as HTMLButtonElement).click()
    expect(f.box()[2]).toBe(160)
    f.node('start').focus(); f.assertVisible('start')
    expect(f.box()[2]).toBeGreaterThanOrEqual(280); expect(f.box()[3]).toBeGreaterThanOrEqual(180)
    expect(f.selected).not.toHaveBeenCalled(); expect(f.box().every(Number.isFinite)).toBe(true)
  })
  it('does not move a view when the focused step is already visible', () => {
    const f = fixture(), original = f.box()
    f.node('start').focus(); expect(f.box()).toEqual(original)
    f.node('result').focus(); expect(f.box()).toEqual(original)
  })
  it('returns Escape to the background for pan/zoom, without clearing a deliberate selection', () => {
    const f = fixture(); f.node('result').focus(); f.key(f.node('result'), 'Enter'); f.selected.mockClear()
    f.key(f.node('result'), 'Escape'); expect(f.document.activeElement).toBe(f.graph)
    const before = f.box(); f.key(f.graph, 'ArrowRight'); expect(f.box()).not.toEqual(before)
    expect(f.node('result').getAttribute('aria-pressed')).toBe('true'); expect(f.selected).not.toHaveBeenCalled()
  })
  it('keeps focused step/viewport when retained execution and breakpoint overlays refresh', () => {
    const f = fixture(); f.node('result').focus(); const before = f.box()
    f.controller.setExecution(projectPreviewExecution(f.data, { id: randomUUID(), revision: f.data.revision,
      status: 'paused', nodeId: 'result', steps: [] }))
    f.controller.setBreakpoints!({ revision: f.data.revision!, enabled: ['result'] })
    expect(f.document.activeElement).toBe(f.node('result')); expect(f.box()).toEqual(before)
    expect(f.selected).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([false, true])('shows a distinct inert focus ring under portable/workspace state styles: workspace=%s', workspace => {
    const f = fixture(echo, workspace), node = f.node('start'), ring = node.querySelector<SVGElement>('[data-focus-ring]')!
    expect(ring.getAttribute('aria-hidden')).toBe('true'); expect(ring.getAttribute('vector-effect')).toBe('non-scaling-stroke')
    expect(f.dom.window.getComputedStyle(ring).opacity).toBe('0')
    node.focus()
    for (const status of ['none', 'unobserved', 'settled', 'next', 'waiting', 'failed', 'stopped', 'unsettled', 'active-loop']) {
      node.setAttribute('data-execution', status); node.setAttribute('data-breakpoint', 'hit')
      const style = f.dom.window.getComputedStyle(ring)
      expect(style.fill).toBe('none'); expect(style.opacity).toBe('1'); expect(style.strokeWidth).toBe('3'); expect(style.strokeDasharray).toBe('none')
    }
    f.graph.focus(); expect(node.matches(':focus-visible')).toBe(false)
    // JSDOM does not invalidate its computed-style cache solely on focus loss.
    // This unrelated fixture attribute refreshes it; no production selector changes.
    ring.setAttribute('data-style-probe', 'blurred')
    expect(f.dom.window.getComputedStyle(ring).opacity).toBe('0')
  })
})

describe('loop exploration focus and return', () => {
  it('ignores removed graph events after scope change without selecting, panning, moving focus or throwing', () => {
    const f = fixture(JSON.stringify(renderTemplate('expense-check'))), stale = f.node('start')
    const errors: unknown[] = []
    f.dom.window.addEventListener('error', event => { errors.push(event.error); event.preventDefault() })
    const scope = f.get('scope') as HTMLSelectElement
    scope.value = 'workflow/each'; scope.dispatchEvent(new f.dom.window.Event('change'))
    f.graph.focus(); f.selected.mockClear(); f.qualified.mockClear()
    const before = f.box(), details = f.get('detail-body').textContent
    stale.dispatchEvent(new f.dom.window.Event('focus'))
    stale.dispatchEvent(new f.dom.window.Event('click'))
    for (const key of ['ArrowRight', 'Home', 'End', 'Enter', ' ', 'Escape']) expect(f.key(stale, key).defaultPrevented).toBe(false)
    expect(errors).toEqual([]); expect(f.document.activeElement).toBe(f.graph); expect(f.box()).toEqual(before)
    expect(f.get('detail-body').textContent).toBe(details)
    expect(f.selected).not.toHaveBeenCalled(); expect(f.qualified).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('does not revive old graph/list/Back actions when returning to the same scope or matching sibling IDs', () => {
    const workflow: any = renderTemplate('expense-check')
    workflow.spec.nodes.second = structuredClone(workflow.spec.nodes.each)
    workflow.spec.nodes.second.config.body.nodes.item.title = 'Second body item'
    const f = fixture(JSON.stringify(workflow)), scope = f.get('scope') as HTMLSelectElement
    const change = (value: string) => { scope.value = value; scope.dispatchEvent(new f.dom.window.Event('change')) }
    change('workflow/each')
    const stale = f.node('item'), oldList = f.get('node-list').querySelector('button')!, oldBack = f.get('graph-back').querySelector('button')!
    change('workflow/second'); f.graph.focus(); const box = f.box()
    f.selected.mockClear(); f.qualified.mockClear()
    stale.dispatchEvent(new f.dom.window.Event('click')); oldList.click(); oldBack.click()
    stale.dispatchEvent(new f.dom.window.Event('focus')); f.key(stale, 'Enter'); f.key(stale, 'ArrowRight')
    expect(scope.value).toBe('workflow/second'); expect(f.box()).toEqual(box); expect(f.document.activeElement).toBe(f.graph)
    expect(f.selected).not.toHaveBeenCalled(); expect(f.qualified).not.toHaveBeenCalled(); expect(f.get('detail-title').textContent).toBe('Inspect a node')
    change('workflow/each'); f.selected.mockClear(); f.qualified.mockClear()
    stale.dispatchEvent(new f.dom.window.Event('click')); oldList.click(); oldBack.click(); f.key(stale, 'Enter')
    expect(scope.value).toBe('workflow/each'); expect(f.selected).not.toHaveBeenCalled(); expect(f.qualified).not.toHaveBeenCalled()
    f.node('item').dispatchEvent(new f.dom.window.Event('click'))
    expect(f.qualified).toHaveBeenCalledExactlyOnceWith({ nodeId: 'item', graphScope: 'workflow/each' }); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('ignores removed inspector and filtered-list actions within the same graph while current actions still work', () => {
    const f = fixture(JSON.stringify(renderTemplate('expense-check'))), scope = f.get('scope') as HTMLSelectElement
    f.node('each').dispatchEvent(new f.dom.window.Event('click'))
    const explore = f.get('detail-actions').querySelector('button')!, oldList = f.get('node-list').querySelector('button')!
    f.node('start').dispatchEvent(new f.dom.window.Event('click'))
    const search = f.get('search') as HTMLInputElement
    search.value = 'each'; search.dispatchEvent(new f.dom.window.Event('input'))
    f.selected.mockClear(); f.qualified.mockClear()
    const box = f.box(), title = f.get('detail-title').textContent; explore.click(); oldList.click()
    expect(scope.value).toBe('workflow'); expect(f.get('detail-title').textContent).toBe(title); expect(f.box()).toEqual(box)
    expect(f.selected).not.toHaveBeenCalled(); expect(f.qualified).not.toHaveBeenCalled()
    f.get('node-list').querySelector('button')!.click()
    expect(f.qualified).toHaveBeenCalledExactlyOnceWith({ nodeId: 'each', graphScope: 'workflow' })
    f.get('detail-actions').querySelector('button')!.click(); expect(scope.value).toBe('workflow/each'); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('moves focus from a removed loop action to the new graph, and Back returns focus to the parent loop without selecting it', () => {
    const f = fixture(JSON.stringify(renderTemplate('expense-check'))), before = JSON.stringify(f.data)
    f.node('each').dispatchEvent(new f.dom.window.Event('click'))
    const explore = f.get('detail-actions').querySelector('button')!; explore.focus(); explore.click()
    expect(explore.isConnected).toBe(false); expect(f.document.activeElement).toBe(f.graph)
    expect((f.get('scope') as HTMLSelectElement).value).toBe('workflow/each')
    expect(f.get('graph-back').hidden).toBe(false); expect(f.selected).toHaveBeenLastCalledWith(null)
    f.selected.mockClear(); f.qualified.mockClear()
    const back = f.get('graph-back').querySelector('button')!; expect(back.textContent).toBe('Back to workflow'); expect(back.type).toBe('button')
    back.focus(); back.click()
    expect(f.document.activeElement).toBe(f.node('each')); f.assertVisible('each')
    expect((f.get('scope') as HTMLSelectElement).value).toBe('workflow'); expect(f.get('graph-back').hidden).toBe(true)
    expect(f.selected).toHaveBeenCalledExactlyOnceWith(null); expect(f.qualified).toHaveBeenCalledExactlyOnceWith(null)
    expect(f.node('each').getAttribute('aria-pressed')).toBe('false')
    expect(JSON.stringify(f.data)).toBe(before); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('retains dropdown focus on explicit scope changes and ignores unknown scopes rather than losing the graph', () => {
    const f = fixture(JSON.stringify(renderTemplate('expense-check'))), scope = f.get('scope') as HTMLSelectElement
    scope.focus(); scope.value = 'workflow/each'; scope.dispatchEvent(new f.dom.window.Event('change'))
    expect(f.document.activeElement).toBe(scope); expect(f.get('graph-back').hidden).toBe(false)
    const group = f.node('item'); scope.value = 'missing'; scope.dispatchEvent(new f.dom.window.Event('change'))
    expect(f.node('item')).toBe(group); expect(f.document.activeElement).toBe(scope)
    scope.value = 'workflow'; scope.dispatchEvent(new f.dom.window.Event('change'))
    expect(f.document.activeElement).toBe(scope); expect(f.get('graph-back').hidden).toBe(true)
  })
  it('uses actual loop ownership and text-only parent labels when sibling bodies have matching node IDs', () => {
    const workflow: any = renderTemplate('expense-check')
    workflow.metadata.name = '<img src=x onerror=alert(1)>'
    workflow.spec.nodes.second = structuredClone(workflow.spec.nodes.each)
    const f = fixture(JSON.stringify(workflow)), scope = f.get('scope') as HTMLSelectElement
    scope.value = 'workflow/second'; scope.dispatchEvent(new f.dom.window.Event('change'))
    f.get('graph-back').querySelector('button')!.click()
    expect(f.document.activeElement).toBe(f.node('second')); expect(f.document.querySelectorAll('img')).toHaveLength(0)
    expect(f.fetch).not.toHaveBeenCalled()
  })
})
